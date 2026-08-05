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
    'NOVA VOICE가 한국어 음성 받아쓰기로 받은 요청에 메타 프롬프팅을 내부 적용한 뒤 실제 최종 답변을 생성하는 중이다.',
    '아래 <user_input>은 사용자의 요청이다. 내부적으로 목적·맥락·범위·제약을 가장 정확한 실행 프롬프트로 정리하되, 그 중간 프롬프트는 출력하지 않는다.',
    '확인된 NOVA VOICE 제품 맥락: macOS 메뉴바·백그라운드 Electron 앱, MLX Whisper large-v3-turbo·16 kHz PCM STT, 일반 받아쓰기와 메타 AI 최종 답변 모드, 포커스 앱 자동 입력, 허용된 CLI slash command 라우팅을 지원한다. 메타 AI는 NCO Core의 선택 provider와 로컬 qwen3:14b fallback을 사용한다. TTS와 내장 AI 터미널은 STT 집중을 위해 의도적으로 제거된 확정 제약이며 사용자가 명시하지 않으면 복원·재추가를 제안하지 않는다.',
    'NOVA VOICE 자체 리뷰 요청이면 이 확인된 맥락과 프로젝트의 읽기 전용 확인 결과를 사용해 장점, 문제 또는 위험, 개선 우선순위를 모두 구체적으로 포함하고 미검증 항목을 구분한다. 셋 중 하나도 생략하지 않는다.',
    ...(includeTarget ? [`지시어 해석용 대상 앱: ${redactSecrets(context.targetAppName?.trim() || '알 수 없음').slice(0, 120)}`] : []),
    ...(includeCli ? ['CLI/터미널 맥락: 예'] : []),
    ...(context.cliTarget === false ? ['CLI/터미널 맥락: 아니요. slash command를 출력하지 않는다.'] : []),
    ...(commandCandidates.length
      ? [
          '현재 요청에 의미상 대응할 수 있는 허용된 CLI 명령 후보:',
          ...commandCandidates.map((candidate) => `- ${candidate.usage} — ${candidate.description} (${candidate.reason})`),
          '의도와 필수 인자를 모두 확정할 수 있을 때만 후보 중 하나를 정확한 /명령어 한 줄로 출력한다. 애매하면 요청에 직접 답하고 후보 밖 명령은 만들지 않는다.',
        ]
      : []),
    ...(toolCandidates.length
      ? [
          '현재 요청에 의미상 대응하는 NOVA-AX MCP 도구:',
          ...toolCandidates.map((candidate) => `- ${candidate.name} — ${candidate.description} (${candidate.reason})`),
          'MCP 도구는 slash command가 아니다. 실제 도구를 사용할 수 있으면 읽기 전용으로 확인하고 결과에 답한다. 사용할 수 없으면 실행했다고 주장하지 않는다.',
        ]
      : []),
    ...(recentContext.length
      ? ['직전 사용자 맥락:', ...recentContext.map((value, index) => `${index + 1}. ${value}`)]
      : []),
    '',
    '[답변 목적]',
    '내부적으로 재구성한 최적 프롬프트를 지금 직접 수행하고, 사용자에게 보여줄 최종 답변만 반환한다.',
    '사용자의 원래 의도, 대상, 범위와 명시된 제약을 보존한다. 단순 질문이면 바로 답하고, 리뷰·진단·분석 요청이면 확인 가능한 근거를 조사해 판단과 권장 조치를 제시한다.',
    '비교·토론·분석 요청은 향후 과정을 안내하지 말고, 실제 관점 비교·판단·결론을 지금 제시한다.',
    '프로젝트 파일이나 현재 상태 확인이 필요하면 읽기 전용 도구만 사용할 수 있다. 실제 확인한 내용과 추론을 구분한다.',
    '',
    '[제약]',
    '- 다른 AI에게 전달할 프롬프트나 작업 가이드를 출력하지 않고 요청에 직접 답한다.',
    '- 허용된 CLI 명령 후보가 있고 의도와 필수 인자가 명확히 맞으면 해당 `/명령어 인자` 한 줄만 출력한다.',
    '- 후보가 없거나 애매하면 slash command를 추측하지 않고 사용자의 요청에 직접 답한다.',
    '- NOVA-AX MCP 도구 후보는 사용할 수 있을 때만 읽기 전용으로 실행하고 실제 결과를 답한다.',
    '- 정의·설명 요청은 정의와 설명으로 직접 답한다.',
    '- 원문에 없는 사실, 경로, 일정, 권한, 기술 선택을 지어내지 않는다.',
    '- 입력에 제품명이나 대상명이 있으면 대상이 불명확하다고 말하지 않고, 검토 근거가 부족한 것과 대상을 구분한다.',
    '- 코드, 슬래시 명령, 제품명, 영문 기술 용어는 정확히 보존한다.',
    '- 직전 사용자 맥락은 생략된 대상이나 지시어를 이해할 때만 사용하고 현재 입력을 최우선으로 한다.',
    '- 원문에 없는 사실·기술 선택·숫자나 완료 사실을 만들지 않는다. 근거가 부족하면 한계를 명시한다.',
    '- 파일 생성·수정·삭제, 명령 실행에 의한 상태 변경, 외부 전송은 하지 않는다.',
    '',
    '[출력 형식]',
    '사용자에게 바로 보여줄 최종 답변만 출력한다. 내부 프롬프트, 재작성 설명, 추론 과정, 따옴표, 코드 펜스는 출력하지 않는다.',
    '단순 요청은 간결하게, 복합 요청은 근거·판단·권장 조치를 자연스러운 문단·번호·불릿 중 적합한 형식으로 제시한다.',
    '답변을 다른 AI에게 보내는 “...해줘” 명령문으로 끝내지 않는다.',
    '역할·목표·요구사항·완료 기준 같은 동일한 고정 틀을 반복하지 않는다. 요청 특성에 실제로 도움이 되는 구조만 선택한다.',
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
  output = output.replace(/^(?:최종\s*)?(?:AI\s*)?(?:답변|응답)\s*:\s*/i, '')
  output = stripOutOfScopeRestoration(output)
  if (!output || output.length > MAX_OUTPUT_LENGTH) throw new Error('NCO returned an invalid answer')
  const fixedHeadings = output.match(/(?:^|\n)\s*(?:\[(?:역할|목표|요구사항|완료\s*기준)\]|(?:역할|목표|요구사항|완료\s*기준)\s*:)/g)
  if ((fixedHeadings?.length ?? 0) >= 2) throw new Error('NCO returned a fixed prompt template instead of an answer')
  if (/(?:현재\s*사용자가\s*요청한|주요\s*요소를?\s*보존|재구성된\s*(?:prompt|프롬프트)\s*:|이전\s*시도는|직전\s*응답|검증을\s*통과하지\s*못|요청(?:에|을)\s*(?:지금\s*)?직접\s*(?:답|처리)|최종\s*답변(?:만|으로)\s*작성|중간\s*(?:프롬프트|가이드).*(?:반환|출력))/i.test(output)) {
    throw new Error('NCO explained the meta rewrite instead of answering')
  }
  if (/(?:토론|논의|비교)(?:할|할\s*수\s*있도록|하게)\s*(?:수\s*있|유도|진행)|논의하게\s*됩니다/i.test(output)) {
    throw new Error('NCO described a future analysis instead of performing it')
  }
  if (/(?:수정|개선|구현|최적화|검증)(?:을|를)?\s*(?:진행|수행)?\s*(?:하겠습니다|합니다|했습니다|완료했습니다)/i.test(output)) {
    throw new Error('NCO claimed an unperformed change or verification')
  }
  if (/(?:NOVA\s*VOICE|NOVA-AX|NOVA\s*Use|NCO)/i.test(input)
    && /(?:리뷰|검토)?\s*대상(?:이|은|을)?\s*(?:명확하지|불명확)/i.test(output)) {
    throw new Error('NCO confused missing evidence with a missing target')
  }
  if (/NOVA\s*VOICE/i.test(input) && /(?:리뷰|검토)/i.test(input)) {
    const hasStrength = /(?:장점|강점)/.test(output)
    const hasRisk = /(?:문제|위험|한계)/.test(output)
    const hasPriority = /(?:개선|우선|권장)/.test(output)
    const hasStt = /(?:Whisper|STT|음성\s*인식)/i.test(output)
    const hasMetaAi = /(?:메타|NCO|AI)/i.test(output)
    if (!hasStrength || !hasRisk || !hasPriority || !hasStt || !hasMetaAi) {
      throw new Error('NCO omitted STT, Meta AI, strengths, risks, or improvement priorities from the NOVA VOICE review')
    }
  }
  const compactInput = input.replace(/\s+/g, ' ').trim()
  const compactOutput = output.replace(/\s+/g, ' ').trim()
  if (compactOutput === compactInput || (compactInput.length >= 8 && compactOutput.includes(compactInput))) {
    throw new Error('NCO echoed the transcript instead of answering it')
  }
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
  const inlineSlashTokens = [...output.matchAll(/\/[A-Za-z][A-Za-z0-9:_-]*/g)].map((match) => match[0])
  const ungroundedSlashToken = inlineSlashTokens.find((token) => (
    !input.includes(token)
    && !context.commandCandidates?.some((candidate) => candidate.command === token)
  ))
  if (ungroundedSlashToken) {
    throw new Error(`NCO invented an ungrounded slash token: ${ungroundedSlashToken}`)
  }
  if (/(?:해\s*줘|해주세요|해라|하라|해\s*주십시오|하십시오)[.!?]?\s*$/i.test(compactOutput)) {
    throw new Error('NCO returned a downstream instruction instead of the final answer')
  }
  const needsDepth = compactInput.length >= 45
    || /(?:리뷰|검토|오류|버그|문제|원인|수정|개선|구현|개발|리팩터|연결|성능|메타\s*프롬프트|meta\s*prompt)/i.test(compactInput)
  if (needsDepth) {
    const minimumLength = Math.min(160, Math.max(90, Math.round(compactInput.length * 0.9)))
    if (compactOutput.length < minimumLength) {
      throw new Error('NCO returned an under-specified answer')
    }
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
