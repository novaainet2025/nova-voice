import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import fs from 'fs'
import { logInfo } from './logger.ts'
import { isAllowedMetaCommand } from './command-catalog.ts'
import type { MetaCommandCandidate, MetaToolCandidate } from './command-catalog.ts'

const LOCAL_OLLAMA_BASE = 'http://127.0.0.1:11435'
const SHARED_OLLAMA_BASE = 'http://127.0.0.1:11434'

/**
 * Candidate models in preference order, smallest first.
 *
 * Rewriting a spoken sentence into a prompt is a light task, and a smaller
 * model answers sooner: qwen3:4b needs 2.5GB against 9.3GB for qwen3:14b. Size
 * matters twice over here, because the machine was measured holding two copies
 * of the 14B model (25.6GB of 48GB) with swap effectively full, which is what
 * made inference latency swing between 3s and 27s.
 *
 * A larger model is still used when the small one is not installed, so removing
 * qwen3:4b degrades quality rather than breaking meta mode.
 */
const LOCAL_META_MODEL_CANDIDATES = ['qwen3:4b', 'qwen3:14b'] as const
const MODEL_RESOLUTION_TTL_MS = 60_000
// A cold model switch can take well over 20 seconds when NCO previously kept
// a larger Ollama model resident. Meta mode must wait for a real AI result
// rather than silently substituting a deterministic template.
const LOCAL_AI_TIMEOUT_MS = 90_000
const MAX_INPUT_LENGTH = 20_000
const MAX_OUTPUT_LENGTH = 50_000

let warmupInFlight: Promise<boolean> | null = null
let serverStartupInFlight: Promise<boolean> | null = null
let localOllamaProcess: ChildProcess | null = null

export interface AppUsageContext {
  bundleId: string
  commands: string[]
  phrases: string[]
}

export interface MetaPromptContext {
  targetAppName?: string
  targetBundleId?: string
  cliTarget?: boolean
  recentInputs?: string[]
  commandCandidates?: MetaCommandCandidate[]
  toolCandidates?: MetaToolCandidate[]
  /** What this user has actually been observed asking for in this application. */
  appUsage?: AppUsageContext
}

export interface LocalAiMetaPromptResult {
  text: string
  model: string
}

async function endpointReady(baseUrl: string, timeoutMs = 700): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/api/version`, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function resolveOllamaBinary(): string | undefined {
  return ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/usr/bin/ollama']
    .find((candidate) => fs.existsSync(candidate))
}

/** Models a server has installed, or null when the server cannot be reached. */
async function listModels(baseUrl: string, timeoutMs = 1_500): Promise<Set<string> | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal })
    if (!response.ok) return null
    const body = await response.json().catch(() => ({})) as {
      models?: Array<{ name?: unknown; model?: unknown }>
    }
    const names = new Set<string>()
    for (const item of body.models ?? []) {
      if (typeof item.name === 'string') names.add(item.name)
      if (typeof item.model === 'string') names.add(item.model)
    }
    return names
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Models a server currently holds in memory. */
async function listResidentModels(baseUrl: string, timeoutMs = 1_500): Promise<Set<string>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/api/ps`, { signal: controller.signal })
    if (!response.ok) return new Set()
    const body = await response.json().catch(() => ({})) as {
      models?: Array<{ name?: unknown; model?: unknown }>
    }
    const names = new Set<string>()
    for (const item of body.models ?? []) {
      if (typeof item.name === 'string') names.add(item.name)
      if (typeof item.model === 'string') names.add(item.model)
    }
    return names
  } catch {
    return new Set()
  } finally {
    clearTimeout(timeout)
  }
}

export interface LocalMetaTarget {
  baseUrl: string
  model: string
  /** True when the model was already in memory, so no load cost is paid. */
  resident: boolean
}

let resolvedTarget: { target: LocalMetaTarget; at: number } | null = null

/**
 * Chooses which Ollama server and model to use.
 *
 * Prefers the smallest installed candidate, and prefers a server that already
 * holds it. Reusing the shared server matters: NOVA VOICE used to always spawn
 * its own instance on :11435 and keep a second copy of the same model resident
 * alongside the shared one on :11434.
 */
async function resolveLocalMetaTarget(): Promise<LocalMetaTarget | null> {
  const cached = resolvedTarget
  if (cached && Date.now() - cached.at < MODEL_RESOLUTION_TTL_MS) return cached.target

  const [sharedInstalled, dedicatedInstalled] = await Promise.all([
    listModels(SHARED_OLLAMA_BASE),
    listModels(LOCAL_OLLAMA_BASE),
  ])
  const [sharedResident, dedicatedResident] = await Promise.all([
    sharedInstalled ? listResidentModels(SHARED_OLLAMA_BASE) : Promise.resolve(new Set<string>()),
    dedicatedInstalled ? listResidentModels(LOCAL_OLLAMA_BASE) : Promise.resolve(new Set<string>()),
  ])

  const servers = [
    { baseUrl: SHARED_OLLAMA_BASE, installed: sharedInstalled, resident: sharedResident },
    { baseUrl: LOCAL_OLLAMA_BASE, installed: dedicatedInstalled, resident: dedicatedResident },
  ].filter((server): server is { baseUrl: string; installed: Set<string>; resident: Set<string> } =>
    server.installed !== null)

  // A server already holding a candidate answers immediately; loading one costs
  // 20-100s here, because a shared server has to evict whatever NCO left
  // resident first. Measured: qwen3:4b cold load 101s, warm inference 1.6s.
  for (const model of LOCAL_META_MODEL_CANDIDATES) {
    const warm = servers.find((server) => server.resident.has(model))
    if (!warm) continue
    const target: LocalMetaTarget = { baseUrl: warm.baseUrl, model, resident: true }
    resolvedTarget = { target, at: Date.now() }
    logInfo('[LocalMeta] Model target resolved (warm)', target)
    return target
  }

  // Nothing is warm, so a load is unavoidable. Prefer the dedicated server: the
  // shared one is NCO's, and a model loaded there is evicted again by the next
  // NCO task, which is what made every dictation pay the load cost anew.
  for (const model of LOCAL_META_MODEL_CANDIDATES) {
    const offering = servers.filter((server) => server.installed.has(model))
    if (!offering.length) continue
    const dedicated = offering.find((server) => server.baseUrl === LOCAL_OLLAMA_BASE)
    const chosen = dedicated ?? offering[0]
    const target: LocalMetaTarget = { baseUrl: chosen.baseUrl, model, resident: false }
    resolvedTarget = { target, at: Date.now() }
    logInfo('[LocalMeta] Model target resolved (cold)', target)
    return target
  }
  return null
}

/** Forces the next request to re-read which server holds which model. */
export function invalidateLocalMetaTarget(): void {
  resolvedTarget = null
}

/** Exposed so the intent classifier can share this one dedicated instance. */
export async function ensureDedicatedOllamaServer(): Promise<boolean> {
  return ensureLocalOllamaServer()
}

/**
 * Loads a model into a server without producing output.
 *
 * An empty prompt makes Ollama resident-load the weights and return, which is
 * the cheapest way to pay a cold load deliberately instead of inside a request
 * that has a deadline.
 */
export async function warmModel(baseUrl: string, model: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: '30m' }),
    })
    return response.ok
  } catch {
    return false
  }
}

async function ensureLocalOllamaServer(): Promise<boolean> {
  if (await endpointReady(LOCAL_OLLAMA_BASE)) return true
  if (serverStartupInFlight) return serverStartupInFlight

  serverStartupInFlight = (async () => {
    const binary = resolveOllamaBinary()
    if (!binary) return false
    try {
      localOllamaProcess = spawn(binary, ['serve'], {
        env: {
          ...process.env,
          OLLAMA_HOST: '127.0.0.1:11435',
          OLLAMA_KEEP_ALIVE: '30m',
          OLLAMA_MAX_LOADED_MODELS: '1',
          OLLAMA_NUM_PARALLEL: '1',
        },
        stdio: 'ignore',
      })
      localOllamaProcess.once('exit', () => {
        localOllamaProcess = null
      })
      localOllamaProcess.unref()
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await endpointReady(LOCAL_OLLAMA_BASE)) return true
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return false
    } catch {
      return false
    }
  })().finally(() => {
    serverStartupInFlight = null
  })

  return serverStartupInFlight
}

export function shutdownLocalAiMetaPrompt(): void {
  if (localOllamaProcess && !localOllamaProcess.killed) localOllamaProcess.kill('SIGTERM')
  localOllamaProcess = null
}

function compact(value: string, maxLength: number): string {
  return value.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
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

function needsExecutionDepth(input: string): boolean {
  const normalized = compact(input, MAX_INPUT_LENGTH)
  return normalized.length >= 45
    || /(?:리뷰|검토|오류|버그|문제|원인|수정|개선|구현|개발|리팩터|연결|성능|메타\s*프롬프트|meta\s*prompt)/i.test(normalized)
}

function cleanOutput(value: string, input: string, context: MetaPromptContext): string {
  let output = value.trim()
  if (output.startsWith('{')) {
    try {
      const parsed = JSON.parse(output) as { answer?: unknown }
      if (typeof parsed.answer === 'string') output = parsed.answer.trim()
    } catch {
      // The validation below reports a concise provider error.
    }
  }
  const fenced = output.match(/^```(?:text|markdown)?\s*\n([\s\S]*?)\n```$/i)
  if (fenced) output = fenced[1].trim()
  output = output.replace(/^(?:다듬은\s*|재작성한\s*|최종\s*)?(?:프롬프트|prompt)\s*:\s*/i, '')
  output = stripOutOfScopeRestoration(output)
  if (!output || output.length > MAX_OUTPUT_LENGTH) throw new Error('Local AI returned an invalid prompt')
  const compactOutput = compact(output, MAX_OUTPUT_LENGTH)
  const compactInput = compact(input, MAX_INPUT_LENGTH)

  if (compactOutput.startsWith('/')) {
    if (
      context.cliTarget !== true
      || output.includes('\n')
      || !isAllowedMetaCommand(compactOutput, context.commandCandidates)
    ) {
      throw new Error('Local AI returned a slash command outside the allowed catalog candidates')
    }
    return compactOutput
  }

  if (compactOutput === compactInput) {
    rejectOutput('Local AI returned the transcript unchanged instead of enriching it', output)
  }
  if (/^(?:Okay|We need|Let's|The user|I need)\b/i.test(output)) {
    rejectOutput('Local AI exposed its reasoning instead of the prompt', output)
  }
  if (/^(?:네|아니(?:요|오)|예)[,.\s]/.test(compactOutput)
    || /^(?:다음은|아래는|이\s*(?:요청|프롬프트)(?:은|는))/.test(compactOutput)) {
    rejectOutput('Local AI wrapped the prompt in a preamble instead of returning it directly', output)
  }
  if (/(?:재구성된\s*(?:prompt|프롬프트)|프롬프트를\s*작성했|다음과\s*같이\s*다듬)/i.test(compactOutput)) {
    rejectOutput('Local AI described the rewrite instead of returning the prompt', output)
  }
  // Meta mode produces an instruction for another AI. Output that reports a
  // finished analysis or a completed change is an answer, which is the exact
  // failure this mode exists to avoid.
  if (/(?:하겠습니다|했습니다|완료했습니다|입니다\.\s*$|살펴본\s*결과|분석한\s*결과)/.test(compactOutput)) {
    rejectOutput('Local AI answered the request instead of turning it into a prompt', output)
  }
  if (!REQUEST_ENDING.test(compactOutput)) {
    rejectOutput('Local AI returned prose that does not read as a request', output)
  }

  const inlineSlashTokens = [...output.matchAll(/\/[A-Za-z][A-Za-z0-9:_-]*/g)].map((match) => match[0])
  const ungroundedSlashToken = inlineSlashTokens.find((token) => (
    !input.includes(token)
    && !context.commandCandidates?.some((candidate) => candidate.command === token)
  ))
  if (ungroundedSlashToken) {
    throw new Error(`Local AI invented an ungrounded slash token: ${ungroundedSlashToken}`)
  }

  // The point of the mode is enrichment, so a prompt shorter than the sentence
  // the user actually said has lost information rather than added any.
  const minimumLength = Math.max(Math.round(compactInput.length * 1.15), 24)
  if (compactOutput.length < minimumLength) {
    rejectOutput('Local AI returned a prompt that adds nothing to the transcript', output)
  }
  return output
}

function needsTargetContext(input: string): boolean {
  return /(?:이\s*앱|여기|현재\s*(?:앱|화면|창)|포커스|입력\s*위치|해당\s*(?:앱|화면|창))/i.test(input)
}

function needsRecentContext(input: string): boolean {
  return /(?:방금|아까|앞서|이전|계속|그대로|그\s*부분|나머지|마저|이것|이거|그거|저것|후속)/i.test(input)
}

function buildContextMessage(input: string, context: MetaPromptContext): string {
  const includeTarget = needsTargetContext(input)
  const includeCli = context.cliTarget === true
    && (includeTarget || /(?:CLI|터미널|명령어|슬래시|\/[a-z][a-z-]*)/i.test(input))
  const target = includeTarget ? compact(context.targetAppName || '', 120) : ''
  const bundleId = includeTarget ? compact(context.targetBundleId || '', 160) : ''
  const recent = (needsRecentContext(input) ? context.recentInputs ?? [] : [])
    .map((value) => compact(value, 500))
    .filter(Boolean)
    .slice(0, 3)
  const commandCandidates = context.cliTarget === true
    ? (context.commandCandidates ?? []).slice(0, 6)
    : []
  const toolCandidates = context.cliTarget === true
    ? (context.toolCandidates ?? []).slice(0, 4)
    : []

  const contextLines = [
    target ? `지시어 해석용 대상 앱: ${target}` : '',
    bundleId ? `대상 bundle id: ${bundleId}` : '',
    includeCli ? 'CLI/터미널 맥락: 예' : '',
    context.cliTarget === false ? 'CLI/터미널 맥락: 아니요. slash command를 출력하지 않는다.' : '',
    commandCandidates.length
      ? [
          '현재 요청에 의미상 대응할 수 있는 허용된 CLI 명령 후보:',
          ...commandCandidates.map((candidate) => `- ${candidate.usage} — ${candidate.description} (${candidate.reason})`),
          '의도와 필수 인자를 모두 확정할 수 있을 때만 후보 중 하나를 정확한 /명령어 형식으로 출력한다. 애매하면 사용자의 요청에 직접 답한다. 후보 밖 명령은 만들지 않는다.',
        ].join('\n')
      : '',
    toolCandidates.length
      ? [
          '현재 요청에 의미상 대응하는 NOVA-AX MCP 도구:',
          ...toolCandidates.map((candidate) => `- ${candidate.name} — ${candidate.description} (${candidate.reason})`),
          'MCP 도구는 slash command가 아니다. 실제 도구 실행 결과가 제공되지 않았다면 실행했다고 주장하지 말고, 필요한 확인 방법과 현재 판단 한계를 답변에 명시한다.',
        ].join('\n')
      : '',
    recent.length ? `직전 사용자 맥락:\n${recent.map((value, index) => `${index + 1}. ${value}`).join('\n')}` : '',
    // Learned from this user's own history, so the prompt can match how they
    // usually phrase requests in this particular application.
    context.appUsage && (context.appUsage.commands.length || context.appUsage.phrases.length)
      ? [
          '이 앱에서 사용자가 반복해 온 요청 (참고용, 강제 아님):',
          ...context.appUsage.commands.map((command) => `- 자주 쓰는 명령: ${command}`),
          ...context.appUsage.phrases.slice(0, 3).map((phrase) => `- 자주 하는 요청: ${compact(phrase, 80)}`),
        ].join('\n')
      : '',
  ].filter((line) => line !== '')
  const request = compact(input, MAX_INPUT_LENGTH)
  return contextLines.length ? `${contextLines.join('\n')}\n\n${request}` : request
}

export async function isLocalAiMetaPromptAvailable(): Promise<boolean> {
  return (await resolveLocalMetaTarget()) !== null
}

function systemInstruction(): string {
  return [
    '너는 NOVA VOICE의 메타 프롬프트 작성 엔진이다.',
    '사용자가 말로 한 거친 요청을, 다른 AI가 정확히 알아듣고 수행할 수 있는 프롬프트로 다듬는다. 요청을 대신 수행하지 않는다.',
    '너의 결과물은 사용자의 커서 위치에 그대로 붙여넣어져 그 자리의 AI에게 전달된다.',
    '확인된 NOVA VOICE 제품 맥락: macOS 메뉴바·백그라운드 Electron 앱이며, MLX Whisper large-v3-turbo와 16 kHz PCM으로 STT를 수행한다. 일반 모드는 받아쓴 원문을 그대로 입력하고, 메타 모드는 다듬은 프롬프트를 입력한다. 포커스 앱 자동 입력과 허용된 CLI slash command 라우팅을 지원한다.',
    '말하면서 생략된 목적·대상·범위·판단 기준을 원문에서 추론 가능한 범위 안에서 명시적으로 채워 요청을 풍부하게 만든다.',
    '모호한 지시어("이거", "저기", "적당히")는 원문 맥락으로 특정할 수 있으면 특정하고, 특정할 수 없으면 프롬프트 안에서 무엇을 확인해야 하는지로 바꾼다.',
    '요청이 이미 구체적이면 과하게 부풀리지 말고 필요한 만큼만 정돈한다.',
    '원래 의도, 대상, 범위, 제품명, 명령어, 경로와 명시된 제약을 모두 보존한다. 범위를 임의로 넓히거나 좁히지 않는다.',
    '요청에 대한 답, 설명, 해설, 분석 결과를 쓰지 않는다. 결과물은 어디까지나 지시문이다.',
    '원문에 없는 사실, 경로, 파일명, 일정, 수치, 기술 선택을 지어내지 않는다. 근거가 없으면 프롬프트 안에서 확인 항목으로 남긴다.',
    '입력에 “허용된 CLI 명령 후보”가 제공되고 사용자 의도와 필수 인자가 명확히 일치하면, 설명 없이 해당 `/명령어 인자` 한 줄만 출력한다.',
    '후보가 없거나 애매하면 slash command를 추측하지 말고 일반 프롬프트로 다듬는다.',
    'NOVA-AX MCP 도구 후보가 있어도 직접 실행하지 않는다. 프롬프트 안에서 참고할 수단으로만 언급할 수 있다.',
    '원문과 같은 언어를 사용한다.',
    '짧은 요청은 한두 문장으로, 복합 요청은 목적·대상·범위·제약·완료 기준 중 실제로 필요한 항목만 골라 자연스러운 문단이나 불릿으로 구성한다. 고정 틀을 기계적으로 반복하지 않는다.',
    '마지막은 수행을 요청하는 지시문으로 끝낸다. 예: “…를 분석해 줘”, “…를 구현해 줘”.',
    '머리말, “다음은 프롬프트입니다” 같은 안내, 추론 과정, 따옴표, 코드 펜스는 출력하지 않는다.',
    '응답은 다듬은 프롬프트 하나를 담은 {"answer":"..."} JSON 객체로만 출력한다.',
  ].join('\n')
}

const META_ANSWER_EXAMPLES = [
  { role: 'user', content: '지금 실행하고 있는 앱 리뷰한다' },
  { role: 'assistant', content: '{"answer":"지금 실행 중인 앱을 리뷰해 줘. 먼저 어떤 앱이고 어떤 상태로 떠 있는지 확인한 뒤, 실제로 동작을 확인할 수 있는 부분과 코드만 보고 판단한 부분을 구분해서 정리해 줘. 잘 만들어진 점, 문제나 위험이 될 만한 점, 고친다면 어떤 순서로 손대는 게 좋을지를 각각 근거와 함께 짚어 줘. 확인하지 못한 항목은 추측하지 말고 무엇을 더 봐야 하는지로 남겨 줘."}' },
  { role: 'user', content: '버그 고쳐줘. 기존 기능은 깨지면 안 돼.' },
  { role: 'assistant', content: '{"answer":"발생한 버그를 수정해 줘. 먼저 증상과 재현 절차, 관련 로그를 확인해서 원인을 특정하고, 원인에 해당하는 최소 범위만 변경해 줘. 기존 동작이 깨지지 않는 것이 조건이니 수정 후에는 같은 시나리오 재현 테스트와 주변 기능 회귀 확인까지 함께 해 줘."}' },
  { role: 'user', content: '이거 왜 느린지 좀 봐줘' },
  { role: 'assistant', content: '{"answer":"지금 느리게 동작하는 부분의 원인을 분석해 줘. 어디서 시간이 실제로 소모되는지 측정으로 확인하고, 추측이 아니라 측정값을 근거로 병목을 특정해 줘. 병목을 찾으면 개선 방안을 비용과 효과를 비교해 제시하고, 측정하지 못한 구간은 따로 밝혀 줘."}' },
  { role: 'user', content: '로그인 화면 좀 만들어줘' },
  { role: 'assistant', content: '{"answer":"로그인 화면을 구현해 줘. 프로젝트에 이미 있는 화면 구조와 스타일 규칙을 먼저 확인하고 그 방식에 맞춰 작성해 줘. 입력값 검증과 실패했을 때 사용자에게 보여줄 상태 처리까지 포함하고, 인증 방식이나 연동할 API가 코드에서 확인되지 않으면 임의로 정하지 말고 무엇을 정해야 하는지 알려 줘."}' },
  { role: 'user', content: 'CLI/터미널 맥락: 아니요. slash command를 출력하지 않는다.\n\nREST랑 GraphQL 중에 뭐가 나은지 토론해' },
  { role: 'assistant', content: '{"answer":"REST와 GraphQL 중 이 서비스에 무엇이 더 적합한지 비교해 줘. 데이터 요구가 화면마다 얼마나 다른지, 캐시와 권한 처리가 얼마나 중요한지, 운영 복잡도를 감당할 수 있는지를 기준으로 양쪽 장단점을 짚고, 현재 확인 가능한 조건에서 어느 쪽을 택할지 결론까지 내려 줘. 판단에 필요한데 확인되지 않은 조건이 있으면 그것도 함께 밝혀 줘."}' },
  { role: 'user', content: 'CLI/터미널 맥락: 예\n현재 요청에 의미상 대응할 수 있는 허용된 CLI 명령 후보:\n- /nco-discussion <토론 주제> — 멀티 AI 토론을 시작합니다.\n\n여러 AI가 REST와 GraphQL 중 무엇이 적합한지 토론하게 해줘' },
  { role: 'assistant', content: '{"answer":"/nco-discussion REST와 GraphQL 중 현재 요구사항에 더 적합한 API 방식을 토론해줘"}' },
] as const

async function requestLocalRewrite(
  input: string,
  context: MetaPromptContext,
  signal: AbortSignal,
  revisionAttempt: number,
  target: LocalMetaTarget,
  validationFailure = '',
): Promise<string> {
  const forceRevision = revisionAttempt > 0
  const revisionInstruction = [
    forceRevision
      ? needsExecutionDepth(input)
        ? '직전 응답은 프롬프트가 아니었다. 요청에 답하지 말고, 요청을 수행할 AI가 받을 지시문을 목적·대상·범위·확인 항목이 드러나게 다시 작성한다.'
        : '직전 응답은 프롬프트가 아니었다. 요청에 답하지 말고 요청을 수행할 AI에게 보낼 지시문 한두 문장으로 다시 작성한다.'
      : '',
    forceRevision && validationFailure
      ? `직전 결과의 검증 실패: ${compact(validationFailure, 240)}. 같은 문장이나 구조를 반복하지 말고 이 실패를 직접 교정한다.`
      : '',
    revisionAttempt >= 2
      ? '원문을 그대로 인용하지 않는다. 메타 작업 자체를 설명하지 말고, 사용자가 원한 일을 수행하라는 지시문만 작성한다.'
      : '',
  ].filter(Boolean).join('\n\n')
  const userMessage = buildContextMessage(input, context)
  const response = await fetch(`${target.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: target.model,
      messages: [
        { role: 'system', content: systemInstruction() },
        ...META_ANSWER_EXAMPLES,
        ...(revisionInstruction ? [{ role: 'system', content: revisionInstruction }] : []),
        { role: 'user', content: userMessage },
      ],
      think: false,
      format: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
        required: ['answer'],
      },
      stream: false,
      keep_alive: '30m',
      options: {
        temperature: forceRevision ? Math.min(0.45, 0.25 + revisionAttempt * 0.08) : 0.2,
        num_predict: compact(input, MAX_INPUT_LENGTH).length < 350 ? 520 : 800,
      },
    }),
    signal,
  })
  const body = await response.json().catch(() => ({})) as {
    message?: { content?: unknown }
    error?: unknown
  }
  if (!response.ok) {
    const detail = typeof body.error === 'string' ? `: ${body.error}` : ''
    throw new Error(`Local AI returned ${response.status}${detail}`)
  }
  return typeof body.message?.content === 'string' ? body.message.content : ''
}

export function warmupLocalAiMetaPrompt(): Promise<boolean> {
  if (warmupInFlight) return warmupInFlight

  warmupInFlight = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Local AI warmup timed out')), LOCAL_AI_TIMEOUT_MS)
    try {
      const target = await resolveLocalMetaTarget()
      if (!target) return false
      const response = await fetch(`${target.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: target.model,
          prompt: '',
          stream: false,
          keep_alive: '30m',
        }),
        signal: controller.signal,
      })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  })().finally(() => {
    warmupInFlight = null
  })

  return warmupInFlight
}

async function waitForWarmup(signal?: AbortSignal): Promise<void> {
  if (!warmupInFlight) return
  if (!signal) {
    await warmupInFlight
    return
  }
  if (signal.aborted) throw signal.reason ?? new Error('Meta prompt cancelled')
  let abortFromParent: (() => void) | undefined
  try {
    await Promise.race([
      warmupInFlight,
      new Promise<never>((_resolve, reject) => {
        abortFromParent = () => reject(signal.reason ?? new Error('Meta prompt cancelled'))
        signal.addEventListener('abort', abortFromParent, { once: true })
      }),
    ])
  } finally {
    if (abortFromParent) signal.removeEventListener('abort', abortFromParent)
  }
}

export async function rewriteWithLocalAiMetaPrompt(
  input: string,
  context: MetaPromptContext = {},
  signal?: AbortSignal,
): Promise<LocalAiMetaPromptResult> {
  await waitForWarmup(signal)
  let target = await resolveLocalMetaTarget()
  if (!target) {
    // No reachable server already holds a candidate. Start the dedicated one,
    // which is the only case where a second Ollama instance is justified.
    if (!await ensureLocalOllamaServer()) throw new Error('Local AI service is unavailable')
    invalidateLocalMetaTarget()
    target = await resolveLocalMetaTarget()
    if (!target) throw new Error('No local meta-prompt model is installed')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Local AI meta prompt timed out')), LOCAL_AI_TIMEOUT_MS)
  const abortFromParent = () => controller.abort(signal?.reason ?? new Error('Meta prompt cancelled'))
  if (signal?.aborted) abortFromParent()
  else signal?.addEventListener('abort', abortFromParent, { once: true })

  try {
    let validationFailure = ''
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const content = await requestLocalRewrite(
        input,
        context,
        controller.signal,
        attempt,
        target,
        validationFailure,
      )
      try {
        return {
          text: cleanOutput(content, input, context),
          model: target.model,
        }
      } catch (error) {
        validationFailure = error instanceof Error ? error.message : String(error)
        if (attempt === 2) throw error
      }
    }
    throw new Error('Local AI meta prompt validation exhausted')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromParent)
  }
}
