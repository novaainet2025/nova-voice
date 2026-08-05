import { isAllowedMetaCommand } from './command-catalog'
import { isLocalAiMetaPromptAvailable, rewriteWithLocalAiMetaPrompt } from './local-ai-meta-prompt'
import type { MetaPromptContext } from './local-ai-meta-prompt'
import {
  ncoRequestJson as requestJson,
  redactSecrets,
  resolveNcoBase,
  safeErrorMessage,
} from './nco-core-client'
import type { JsonRecord } from './nco-core-client'
import {
  invalidateProviderSnapshot,
  rankProviders,
  recordProviderOutcome,
  resolveAutoProvider,
} from './nco-provider-selector'
import { logInfo, logWarn } from './logger'
import type { NcoProviderRanking } from '../shared/types'

export type { MetaPromptContext } from './local-ai-meta-prompt'

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const TERMINAL_FAILURES = new Set([
  'failed',
  'timed_out',
  'cancelled',
  'canceled',
  'lease_expired',
  'waiting_preauth',
  'policy_denied',
  'requires_human',
  'blocked',
])
const SUBMIT_TIMEOUT_MS = 8_000
const STATUS_TIMEOUT_MS = 5_000
// Real NCO CLI providers can need more than a minute even for a short answer.
// Cutting them off at 30 seconds caused a valid provider task to be cancelled
// and replaced by the old deterministic template.
const TOTAL_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 650
// A short answer is often ready within a second, so the first polls are tight
// and only relax once the task is clearly a long one. The old fixed 650ms wait
// added up to two thirds of a second of pure latency to every fast answer.
const FAST_POLL_INTERVAL_MS = 150
const FAST_POLL_WINDOW_MS = 2_000
const MEDIUM_POLL_INTERVAL_MS = 350
const MEDIUM_POLL_WINDOW_MS = 8_000
const MAX_INPUT_LENGTH = 20_000
const MAX_OUTPUT_LENGTH = 50_000
const NCO_RETRY_DELAY_MS = 60_000
/** How many providers from the auto ranking one request may try. */
const MAX_AUTO_PROVIDER_ATTEMPTS = 3

let ncoRetryAfter = 0
let lastNcoFailure: string | undefined
let lastNcoProviderKey = 'auto'

/**
 * A meta-mode result is an instruction for whatever AI receives it, so it has to
 * read as a request. Prose that trails off in a declarative sentence is an
 * answer, which is what this mode replaced.
 */
const REQUEST_ENDING = /(?:[가-힣]{1,8}\s*(?:줘요?|주세요|주십시오|주시기\s*바랍니다|줄래요?)|하라|해라|하십시오|바랍니다|바래)[.!?]?["'’”)\]]?\s*$/

/** Validation failures are useless in a log without a glimpse of what came back. */
function rejectOutput(reason: string, output: string): never {
  const excerpt = output.replace(/\s+/g, ' ').trim().slice(0, 120)
  throw new Error(`${reason} — got: ${excerpt}`)
}

function pollDelayMs(elapsedMs: number): number {
  if (elapsedMs < FAST_POLL_WINDOW_MS) return FAST_POLL_INTERVAL_MS
  if (elapsedMs < MEDIUM_POLL_WINDOW_MS) return MEDIUM_POLL_INTERVAL_MS
  return POLL_INTERVAL_MS
}

export interface MetaPromptRewriteResult {
  text: string
  taskId: string
  /** Provider NOVA VOICE asked for (already resolved when auto-selected). */
  providerId: string
  /** Provider NCO reports as the one that actually ran the task. */
  assignedTo?: string
}

export interface ResolvedMetaPromptResult {
  text: string
  outcome: 'completed' | 'local-ai'
  provider: string
  taskId?: string
  ncoFailure?: string
}

export interface NcoMetaPromptStatus {
  available: boolean
  provider: 'NCO'
  source: 'NCO Core'
  endpoint: string
  ncoConnected: boolean
  localAvailable: boolean
  readyProviders?: string[]
  providers?: Array<{
    id: string
    name: string
    ready: boolean
    online: boolean
    status: 'ready' | 'idle' | 'working' | 'verification-required' | 'limited' | 'offline'
    inferenceVerified: boolean
    blockers: string[]
  }>
  agentsOnline?: number
  message?: string
  autoProvider?: string
  autoReason?: string
  autoRanking?: NcoProviderRanking[]
}

export const META_PROMPT_AI_UNAVAILABLE = 'META_PROMPT_AI_UNAVAILABLE'

export interface NcoMetaPromptPreferences {
  enabled?: boolean
  provider?: string
}

function sanitizeProvider(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() || 'auto'
  return /^(?:auto|[a-z0-9][a-z0-9-]{0,63})$/.test(normalized) ? normalized : 'auto'
}

function stripOutOfScopeRestoration(value: string): string {
  const restorationProposal = /(?:TTS|내장\s*AI\s*터미널).*(?:복원|재추가|다시\s*추가)/is
  if (!restorationProposal.test(value)) return value
  const sentences = value.match(/[^.!?\n]+[.!?]?/g) ?? [value]
  return sentences
    .filter((sentence) => !restorationProposal.test(sentence))
    .join(' ')
    .trim()
}

async function requestJsonWithRetry(route: string, timeoutMs: number): Promise<JsonRecord> {
  try {
    return await requestJson(route, {}, timeoutMs)
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250))
    return requestJson(route, {}, timeoutMs)
  }
}

function metaPromptInstruction(input: string, context: MetaPromptContext): string {
  const safeInput = redactSecrets(input.replace(/\u0000/g, '').trim()).slice(0, MAX_INPUT_LENGTH)
  if (!safeInput) throw new Error('Meta prompt input is empty')
  const includeTarget = /(?:이\s*앱|여기|현재\s*(?:앱|화면|창)|포커스|입력\s*위치|해당\s*(?:앱|화면|창))/i.test(safeInput)
  const includeRecent = /(?:방금|아까|앞서|이전|계속|그대로|그\s*부분|나머지|마저|이것|이거|그거|저것|후속)/i.test(safeInput)
  const includeCli = context.cliTarget === true
    && (includeTarget || /(?:CLI|터미널|명령어|슬래시|\/[a-z][a-z-]*)/i.test(safeInput))
  const recentContext = (includeRecent ? context.recentInputs ?? [] : [])
    .map((value) => redactSecrets(value.replace(/\s+/g, ' ').trim()).slice(0, 500))
    .filter(Boolean)
    .slice(0, 3)
  const commandCandidates = context.cliTarget === true
    ? (context.commandCandidates ?? []).slice(0, 6)
    : []
  const toolCandidates = context.cliTarget === true
    ? (context.toolCandidates ?? []).slice(0, 4)
    : []
  return [
    '[컨텍스트]',
    'NOVA VOICE가 한국어 음성 받아쓰기로 받은 거친 구어체 요청을, 다른 AI가 정확히 알아듣고 수행할 수 있는 프롬프트로 다듬는 중이다.',
    '아래 <user_input>은 사용자가 말로 한 요청이다. 너의 결과물은 사용자의 커서 위치에 그대로 붙여넣어져 그 자리의 AI에게 전달된다.',
    '확인된 NOVA VOICE 제품 맥락: macOS 메뉴바·백그라운드 Electron 앱, MLX Whisper large-v3-turbo·16 kHz PCM STT, 일반 받아쓰기와 메타 프롬프트 모드, 포커스 앱 자동 입력, 허용된 CLI slash command 라우팅을 지원한다.',
    ...(includeTarget ? [`프롬프트를 받을 대상 앱: ${redactSecrets(context.targetAppName?.trim() || '알 수 없음').slice(0, 120)}`] : []),
    ...(includeCli ? ['CLI/터미널 맥락: 예'] : []),
    ...(context.cliTarget === false ? ['CLI/터미널 맥락: 아니요. slash command를 출력하지 않는다.'] : []),
    ...(commandCandidates.length
      ? [
          '현재 요청에 의미상 대응할 수 있는 허용된 CLI 명령 후보:',
          ...commandCandidates.map((candidate) => `- ${candidate.usage} — ${candidate.description} (${candidate.reason})`),
          '의도와 필수 인자를 모두 확정할 수 있을 때만 후보 중 하나를 정확한 /명령어 한 줄로 출력한다. 애매하면 일반 프롬프트로 다듬고 후보 밖 명령은 만들지 않는다.',
        ]
      : []),
    ...(toolCandidates.length
      ? [
          '요청과 관련될 수 있는 NOVA-AX MCP 도구:',
          ...toolCandidates.map((candidate) => `- ${candidate.name} — ${candidate.description} (${candidate.reason})`),
          '도구를 직접 실행하지 않는다. 프롬프트 안에서 참고할 수단으로만 언급할 수 있다.',
        ]
      : []),
    ...(recentContext.length
      ? ['직전 사용자 맥락:', ...recentContext.map((value, index) => `${index + 1}. ${value}`)]
      : []),
    '',
    '[할 일]',
    '요청을 수행하지 말고, 요청을 수행할 AI가 받을 프롬프트를 작성한다.',
    '말로 하면서 생략된 목적·대상·범위·판단 기준을 원문에서 추론 가능한 범위 안에서 명시적으로 채워 넣어 요청을 풍부하게 만든다.',
    '모호한 지시어("이거", "저기", "적당히")는 원문 맥락으로 특정할 수 있으면 특정하고, 특정할 수 없으면 프롬프트 안에서 무엇을 확인해야 하는지로 바꾼다.',
    '요청이 이미 구체적이면 과하게 부풀리지 말고 필요한 만큼만 정돈한다.',
    '',
    '[제약]',
    '- 요청에 대한 답, 설명, 해설, 분석 결과를 쓰지 않는다. 결과물은 어디까지나 지시문이다.',
    '- 원문에 없는 사실, 경로, 파일명, 일정, 수치, 기술 선택을 지어내지 않는다. 근거가 없으면 프롬프트 안에서 확인 항목으로 남긴다.',
    '- 사용자의 원래 의도·대상·범위와 명시된 제약을 바꾸지 않는다. 범위를 임의로 넓히거나 좁히지 않는다.',
    '- 코드, 슬래시 명령, 제품명, 영문 기술 용어, 고유명사는 원문 그대로 보존한다.',
    '- 직전 사용자 맥락은 생략된 대상을 특정할 때만 쓰고 현재 입력을 최우선으로 한다.',
    '- 원문과 같은 언어로 쓴다.',
    '',
    '[출력 형식]',
    '붙여넣어 바로 쓸 프롬프트 본문만 출력한다. 머리말, "다음은 프롬프트입니다" 같은 안내, 따옴표, 코드 펜스는 출력하지 않는다.',
    '짧은 요청은 한두 문장으로, 복합 요청은 목적·대상·범위·제약·완료 기준 중 실제로 필요한 항목만 골라 자연스러운 문단이나 불릿으로 구성한다. 고정 틀을 기계적으로 반복하지 않는다.',
    '마지막은 수행을 요청하는 지시문으로 끝낸다. (예: "…를 분석해 줘", "…를 구현해 줘")',
    '',
    '<user_input>',
    safeInput,
    '</user_input>',
  ].join('\n')
}

function taskFromResponse(body: JsonRecord): JsonRecord {
  return body.task && typeof body.task === 'object' && !Array.isArray(body.task)
    ? body.task as JsonRecord
    : body
}

function cleanMetaPromptOutput(value: string, input: string, context: MetaPromptContext): string {
  let output = value.trim()
  const fenced = output.match(/^```(?:text|markdown)?\s*\n([\s\S]*?)\n```$/i)
  if (fenced) output = fenced[1].trim()
  output = output.replace(/^(?:다듬은\s*|재작성한\s*|최종\s*)?(?:프롬프트|prompt)\s*:\s*/i, '')
  output = stripOutOfScopeRestoration(output)
  if (!output || output.length > MAX_OUTPUT_LENGTH) throw new Error('NCO returned an invalid prompt')

  const compactInput = input.replace(/\s+/g, ' ').trim()
  const compactOutput = output.replace(/\s+/g, ' ').trim()

  // A slash command is already the most precise form of the request.
  if (compactOutput.startsWith('/')) {
    if (
      context.cliTarget !== true
      || output.includes('\n')
      || !isAllowedMetaCommand(compactOutput, context.commandCandidates)
    ) {
      throw new Error('NCO returned a slash command outside the allowed catalog candidates')
    }
    return compactOutput
  }

  if (compactOutput === compactInput) {
    rejectOutput('NCO returned the transcript unchanged instead of enriching it', output)
  }
  if (/^(?:네|아니(?:요|오)|예)[,.\s]/.test(compactOutput)
    || /^(?:다음은|아래는|이\s*(?:요청|프롬프트)(?:은|는))/.test(compactOutput)) {
    rejectOutput('NCO wrapped the prompt in a preamble instead of returning it directly', output)
  }
  if (/(?:재구성된\s*(?:prompt|프롬프트)|프롬프트를\s*작성했|다음과\s*같이\s*다듬)/i.test(compactOutput)) {
    rejectOutput('NCO described the rewrite instead of returning the prompt', output)
  }
  // Meta mode produces an instruction for another AI. Output that reports a
  // finished analysis or a completed change is an answer, which is the exact
  // failure this mode exists to avoid.
  if (/(?:하겠습니다|했습니다|완료했습니다|입니다\.\s*$|살펴본\s*결과|분석한\s*결과)/.test(compactOutput)) {
    rejectOutput('NCO answered the request instead of turning it into a prompt', output)
  }
  if (!REQUEST_ENDING.test(compactOutput)) {
    rejectOutput('NCO returned prose that does not read as a request', output)
  }

  const inlineSlashTokens = [...output.matchAll(/\/[A-Za-z][A-Za-z0-9:_-]*/g)].map((match) => match[0])
  const ungroundedSlashToken = inlineSlashTokens.find((token) => (
    !input.includes(token)
    && !context.commandCandidates?.some((candidate) => candidate.command === token)
  ))
  if (ungroundedSlashToken) {
    throw new Error(`NCO invented an ungrounded slash token: ${ungroundedSlashToken}`)
  }

  // The point of the mode is enrichment, so a prompt shorter than the sentence
  // the user actually said has lost information rather than added any.
  const minimumLength = Math.max(Math.round(compactInput.length * 1.15), 24)
  if (compactOutput.length < minimumLength) {
    rejectOutput('NCO returned a prompt that adds nothing to the transcript', output)
  }
  return output
}

async function cancelTask(taskId: string): Promise<void> {
  await requestJson(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }, 2_000).catch(() => undefined)
}

/** Runs one meta prompt against a single, already resolved provider. */
async function runNcoMetaPromptTask(
  input: string,
  projectDir: string,
  context: MetaPromptContext,
  signal: AbortSignal | undefined,
  providerId: string,
  allowProviderFailover: boolean,
  deadline: number,
): Promise<MetaPromptRewriteResult> {
  let taskId = ''
  try {
    const submission = await requestJson('/api/task', {
      method: 'POST',
      body: JSON.stringify({
        ai: providerId,
        prompt: metaPromptInstruction(input, context),
        priority: 1,
        callerAgentId: 'nova-voice',
        metadata: {
          allowProviderFailover,
          queuePriority: 1,
          queueWaitMaxMs: 10_000,
          projectDir,
          source: 'nova-voice',
          purpose: 'meta-prompt-final-answer',
        },
      }),
    }, SUBMIT_TIMEOUT_MS, signal)

    taskId = typeof submission.taskId === 'string' ? submission.taskId : ''
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error('NCO did not return a valid task ID')

    const startedAt = Date.now()
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error('Meta prompt cancelled')
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs(Date.now() - startedAt)))
      const body = taskFromResponse(await requestJson(
        `/api/task/${encodeURIComponent(taskId)}`,
        {},
        STATUS_TIMEOUT_MS,
        signal,
      ))
      const status = typeof body.status === 'string' ? body.status.toLowerCase() : 'unknown'
      if (status === 'completed' || status === 'complete' || status === 'done') {
        const response = typeof body.response === 'string'
          ? body.response
          : typeof body.output === 'string'
            ? body.output
            : ''
        const rewrittenText = cleanMetaPromptOutput(response, input, context)
        if (rewrittenText.replace(/\s+/g, ' ').trim() === input.replace(/\s+/g, ' ').trim()) {
          throw new Error('NCO returned the transcript unchanged')
        }
        return {
          text: rewrittenText,
          taskId,
          providerId,
          ...(typeof body.assigned_to === 'string' ? { assignedTo: body.assigned_to } : {}),
        }
      }
      if (TERMINAL_FAILURES.has(status)) {
        const detail = typeof body.error === 'string' ? `: ${body.error}` : ''
        throw new Error(`NCO meta prompt ${status}${detail}`)
      }
    }
    throw new Error('NCO meta prompt timed out')
  } catch (error) {
    if (taskId) await cancelTask(taskId)
    throw new Error(safeErrorMessage(error))
  }
}

export async function rewriteWithNcoMetaPrompt(
  input: string,
  projectDir: string,
  context: MetaPromptContext = {},
  signal?: AbortSignal,
  requestedProvider = 'auto',
): Promise<MetaPromptRewriteResult> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS

  if (requestedProvider !== 'auto') {
    const startedAt = Date.now()
    try {
      const result = await runNcoMetaPromptTask(
        input, projectDir, context, signal, requestedProvider, false, deadline,
      )
      recordProviderOutcome(requestedProvider, { ok: true, elapsedMs: Date.now() - startedAt })
      return result
    } catch (error) {
      if (!signal?.aborted) {
        recordProviderOutcome(requestedProvider, {
          ok: false,
          elapsedMs: Date.now() - startedAt,
          failure: safeErrorMessage(error),
        })
      }
      throw error
    }
  }

  // Auto mode: pick by measured speed and live NCO health, then walk the rest of
  // the ranking if the winner fails. Waiting out a cooldown for a provider that
  // just failed is the slowest possible answer.
  const decision = await resolveAutoProvider()
  const attempts = decision.ranked.slice(0, MAX_AUTO_PROVIDER_ATTEMPTS)
  logInfo('[MetaPrompt] Auto provider order', { attempts, reason: decision.reason })

  let lastError: unknown = new Error('No NCO provider was available')
  for (const providerId of attempts) {
    if (signal?.aborted) throw signal.reason ?? new Error('Meta prompt cancelled')
    if (Date.now() >= deadline) break
    const startedAt = Date.now()
    try {
      const result = await runNcoMetaPromptTask(
        input, projectDir, context, signal, providerId, true, deadline,
      )
      recordProviderOutcome(providerId, { ok: true, elapsedMs: Date.now() - startedAt })
      return result
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      lastError = error
      const failure = safeErrorMessage(error)
      recordProviderOutcome(providerId, { ok: false, elapsedMs: Date.now() - startedAt, failure })
      logWarn('[MetaPrompt] Auto provider attempt failed', { providerId, failure })
      // The failure very likely changed the provider's admission state.
      invalidateProviderSnapshot()
    }
  }
  throw new Error(safeErrorMessage(lastError))
}

export async function rewriteMetaPrompt(
  input: string,
  projectDir: string,
  context: MetaPromptContext = {},
  signal?: AbortSignal,
  preferences: NcoMetaPromptPreferences = {},
): Promise<ResolvedMetaPromptResult> {
  const localController = new AbortController()
  const ncoController = new AbortController()
  const abortChildren = () => {
    const reason = signal?.reason ?? new Error('Meta prompt cancelled')
    localController.abort(reason)
    ncoController.abort(reason)
  }
  if (signal?.aborted) abortChildren()
  else signal?.addEventListener('abort', abortChildren, { once: true })

  let localAiFailure: string | undefined
  const ncoEnabled = preferences.enabled !== false
  const requestedProvider = sanitizeProvider(preferences.provider)
  if (requestedProvider !== lastNcoProviderKey) {
    ncoRetryAfter = 0
    lastNcoFailure = undefined
    lastNcoProviderKey = requestedProvider
  }
  let currentNcoFailure = ncoEnabled && Date.now() < ncoRetryAfter ? lastNcoFailure : undefined

  const localCandidate = rewriteWithLocalAiMetaPrompt(input, context, localController.signal)
    .then((result) => ({ source: 'local' as const, result }))
    .catch((error) => {
      if (!localController.signal.aborted) localAiFailure = safeErrorMessage(error)
      throw error
    })

  const candidates: Array<Promise<
    | { source: 'local'; result: Awaited<ReturnType<typeof rewriteWithLocalAiMetaPrompt>> }
    | { source: 'nco'; result: Awaited<ReturnType<typeof rewriteWithNcoMetaPrompt>> }
  >> = [localCandidate]

  if (ncoEnabled && Date.now() >= ncoRetryAfter) {
    candidates.push(
      rewriteWithNcoMetaPrompt(input, projectDir, context, ncoController.signal, requestedProvider)
        .then((result) => ({ source: 'nco' as const, result }))
        .catch((error) => {
          if (!ncoController.signal.aborted) {
            currentNcoFailure = safeErrorMessage(error)
            lastNcoFailure = currentNcoFailure
            ncoRetryAfter = Date.now() + NCO_RETRY_DELAY_MS
          }
          throw error
        }),
    )
  }

  try {
    const winner = await Promise.any(candidates)
    if (winner.source === 'nco') {
      ncoRetryAfter = 0
      lastNcoFailure = undefined
      return {
        text: winner.result.text,
        outcome: 'completed',
        provider: `NCO · ${winner.result.assignedTo || winner.result.providerId}`,
        taskId: winner.result.taskId,
      }
    }
    return {
      text: winner.result.text,
      outcome: 'local-ai',
      provider: `Local AI · ${winner.result.model}`,
      ...(currentNcoFailure ? { ncoFailure: currentNcoFailure } : {}),
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    const failures = [currentNcoFailure && `NCO: ${currentNcoFailure}`, localAiFailure && `Local AI: ${localAiFailure}`]
      .filter(Boolean)
      .join(' · ')
    // Meta mode is an AI feature. Never disguise a deterministic template or
    // the raw transcript as a successful AI answer.
    throw new Error(`${META_PROMPT_AI_UNAVAILABLE}: ${failures || safeErrorMessage(error)}`)
  } finally {
    localController.abort(new Error('Another AI provider completed first'))
    ncoController.abort(new Error('Another AI provider completed first'))
    signal?.removeEventListener('abort', abortChildren)
  }
}

export async function getNcoMetaPromptStatus(): Promise<NcoMetaPromptStatus> {
  const endpoint = resolveNcoBase()
  const localAvailablePromise = isLocalAiMetaPromptAvailable()
  const rankingPromise = rankProviders().catch(() => ({ ranking: [] as NcoProviderRanking[] }))
  try {
    const [health, readiness, catalog, localAvailable] = await Promise.all([
      requestJsonWithRetry('/health', 3_000),
      requestJson('/api/ai-providers/readiness', {}, 3_000).catch((error) => ({
        readinessError: safeErrorMessage(error),
      })),
      requestJson('/api/ai-providers', {}, 3_000).catch((error) => ({
        catalogError: safeErrorMessage(error),
      })),
      localAvailablePromise,
    ])
    const runtime = health.runtime && typeof health.runtime === 'object' && !Array.isArray(health.runtime)
      ? health.runtime as JsonRecord
      : {}
    const connected = health.status === 'healthy' || health.status === 'ok'
    const readinessRecord: JsonRecord = readiness
    const readinessProviders = Array.isArray(readinessRecord.providers)
      ? readinessRecord.providers.filter((provider): provider is JsonRecord => Boolean(
        provider
        && typeof provider === 'object'
        && !Array.isArray(provider)
        && typeof provider.providerId === 'string',
      ))
      : []
    const readinessById = new Map(readinessProviders.map((provider) => [provider.providerId as string, provider]))
    const catalogRecord: JsonRecord = catalog
    const catalogProviders = Array.isArray(catalogRecord.providers)
      ? catalogRecord.providers.filter((provider): provider is JsonRecord => Boolean(
        provider
        && typeof provider === 'object'
        && !Array.isArray(provider)
        && typeof provider.id === 'string',
      ))
      : []
    // NCO Core's readiness route describes model discovery, not admission, so
    // `readyForNewWork` is absent on current builds. The selector's ranking is
    // the authoritative eligibility signal; readiness is honoured when present.
    const { ranking } = await rankingPromise
    const eligibleIds = new Set(ranking.filter((item) => item.eligible).map((item) => item.id))
    const providers = catalogProviders.map((provider) => {
      const id = provider.id as string
      const readinessProvider = readinessById.get(id)
      const runtime = provider.runtime && typeof provider.runtime === 'object' && !Array.isArray(provider.runtime)
        ? provider.runtime as JsonRecord
        : {}
      const healthRecord = provider.health && typeof provider.health === 'object' && !Array.isArray(provider.health)
        ? provider.health as JsonRecord
        : {}
      const runtimeStatus = typeof provider.status === 'string' ? provider.status.toLowerCase() : 'offline'
      const ready = readinessProvider?.readyForNewWork === true || eligibleIds.has(id)
      const blockers = Array.isArray(readinessProvider?.blockers)
        ? readinessProvider.blockers.filter((blocker): blocker is string => typeof blocker === 'string').slice(0, 8)
        : []
      const online = eligibleIds.has(id) || (runtime.loaded === true && runtimeStatus !== 'offline')
      const limited = healthRecord.circuitState === 'open' || blockers.includes('admission')
      const status = ready
        ? 'ready' as const
        : runtimeStatus === 'working'
          ? 'working' as const
          : limited
            ? 'limited' as const
            : online && blockers.includes('inferenceEvidence')
              ? 'verification-required' as const
              : online
                ? 'idle' as const
                : 'offline' as const
      return {
        id,
        name: typeof provider.name === 'string' ? provider.name : id,
        ready,
        online,
        status,
        inferenceVerified: readinessProvider?.inferenceVerified === true,
        blockers,
      }
    })
    const readyProviders = providers.filter((provider) => provider.ready).map((provider) => provider.id)
    const coolingDown = Date.now() < ncoRetryAfter
    const readinessError = typeof readinessRecord.readinessError === 'string'
      ? readinessRecord.readinessError
      : undefined
    const topRanked = ranking.find((item) => item.eligible)
    return {
      available: connected && readyProviders.length > 0 && !coolingDown,
      provider: 'NCO',
      source: 'NCO Core',
      endpoint,
      ncoConnected: connected,
      localAvailable,
      readyProviders,
      providers,
      ...(ranking.length ? { autoRanking: ranking } : {}),
      ...(topRanked ? { autoProvider: topRanked.id, autoReason: topRanked.reason } : {}),
      ...(typeof runtime.agentsOnline === 'number' ? { agentsOnline: runtime.agentsOnline } : {}),
      ...((coolingDown && lastNcoFailure)
        ? { message: lastNcoFailure }
        : readinessError
          ? { message: readinessError }
          : {}),
    }
  } catch (error) {
    const localAvailable = await localAvailablePromise
    return {
      available: false,
      provider: 'NCO',
      source: 'NCO Core',
      endpoint,
      ncoConnected: false,
      localAvailable,
      message: safeErrorMessage(error),
    }
  }
}

export async function reconnectNcoProvider(provider: string): Promise<NcoMetaPromptStatus> {
  const requestedProvider = sanitizeProvider(provider)
  // Auto mode has no single provider to reset. Reset every provider the ranking
  // considers, so a quota gate that has since expired is cleared in one action.
  const targets = requestedProvider === 'auto'
    ? (await rankProviders()).ranking.slice(0, 4).map((item) => item.id)
    : [requestedProvider]
  if (!targets.length) throw new Error('재연결할 NCO 프로바이더를 찾지 못했습니다.')
  const results = await Promise.allSettled(targets.map((target) =>
    requestJson(`/api/circuit/${encodeURIComponent(target)}/reset`, { method: 'POST' }, 5_000)))
  if (results.every((result) => result.status === 'rejected')) {
    const detail = results[0]?.status === 'rejected' ? safeErrorMessage(results[0].reason) : 'unknown error'
    throw new Error(`NCO 프로바이더 재연결에 실패했습니다: ${detail}`)
  }
  ncoRetryAfter = 0
  lastNcoFailure = undefined
  lastNcoProviderKey = requestedProvider
  invalidateProviderSnapshot()
  return getNcoMetaPromptStatus()
}
