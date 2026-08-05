import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import fs from 'fs'
import { isAllowedMetaCommand } from './command-catalog.ts'
import type { MetaCommandCandidate, MetaToolCandidate } from './command-catalog.ts'

const LOCAL_OLLAMA_BASE = 'http://127.0.0.1:11435'
const SHARED_OLLAMA_BASE = 'http://127.0.0.1:11434'
const OLLAMA_GENERATE_URL = `${LOCAL_OLLAMA_BASE}/api/generate`
const OLLAMA_CHAT_URL = `${LOCAL_OLLAMA_BASE}/api/chat`
const LOCAL_META_MODEL = 'qwen3:14b'
// A cold model switch can take well over 20 seconds when NCO previously kept
// a larger Ollama model resident. Meta mode must wait for a real AI result
// rather than silently substituting a deterministic template.
const LOCAL_AI_TIMEOUT_MS = 90_000
const MAX_INPUT_LENGTH = 20_000
const MAX_OUTPUT_LENGTH = 50_000

let warmupInFlight: Promise<boolean> | null = null
let serverStartupInFlight: Promise<boolean> | null = null
let localOllamaProcess: ChildProcess | null = null

export interface MetaPromptContext {
  targetAppName?: string
  targetBundleId?: string
  cliTarget?: boolean
  recentInputs?: string[]
  commandCandidates?: MetaCommandCandidate[]
  toolCandidates?: MetaToolCandidate[]
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
  output = output.replace(/^(?:최종\s*)?(?:AI\s*)?(?:답변|응답)\s*:\s*/i, '')
  output = stripOutOfScopeRestoration(output)
  if (!output || output.length > MAX_OUTPUT_LENGTH) throw new Error('Local AI returned an invalid answer')
  const compactOutput = compact(output, MAX_OUTPUT_LENGTH)
  const compactInput = compact(input, MAX_INPUT_LENGTH)
  if (compactOutput === compactInput) {
    throw new Error('Local AI echoed the transcript instead of answering')
  }
  if (compactInput.length >= 8 && compactOutput.includes(compactInput)) {
    throw new Error('Local AI quoted the transcript instead of answering it')
  }
  const fixedHeadings = output.match(/(?:^|\n)\s*(?:\[(?:역할|목표|요구사항|완료\s*기준)\]|(?:역할|목표|요구사항|완료\s*기준)\s*:)/g)
  if ((fixedHeadings?.length ?? 0) >= 2) {
    throw new Error('Local AI returned a fixed prompt template instead of an answer')
  }
  if (/^(?:Okay|We need|Let's|The user|I need)\b/i.test(output)) {
    throw new Error('Local AI exposed its reasoning instead of a final answer')
  }
  if (/(?:현재\s*사용자가\s*요청한|주요\s*요소를?\s*보존|재구성된\s*(?:prompt|프롬프트)\s*:|음성\s*입력\s*['‘“]|이전\s*시도는|직전\s*응답|검증을\s*통과하지\s*못|요청(?:에|을)\s*(?:지금\s*)?직접\s*(?:답|처리)|최종\s*답변(?:만|으로)\s*작성|중간\s*(?:프롬프트|가이드).*(?:반환|출력))/i.test(output)) {
    throw new Error('Local AI explained the meta rewrite instead of answering')
  }
  if (/(?:토론|논의|비교)(?:할|할\s*수\s*있도록|하게)\s*(?:수\s*있|유도|진행)|논의하게\s*됩니다/i.test(output)) {
    throw new Error('Local AI described a future analysis instead of performing it')
  }
  if (/(?:수정|개선|구현|최적화|검증)(?:을|를)?\s*(?:진행|수행)?\s*(?:하겠습니다|합니다|했습니다|완료했습니다)/i.test(output)) {
    throw new Error('Local AI claimed an unperformed change or verification')
  }
  if (/(?:NOVA\s*VOICE|NOVA-AX|NOVA\s*Use|NCO)/i.test(input)
    && /(?:리뷰|검토)?\s*대상(?:이|은|을)?\s*(?:명확하지|불명확)/i.test(output)) {
    throw new Error('Local AI confused missing evidence with a missing target')
  }
  if (/NOVA\s*VOICE/i.test(input) && /(?:리뷰|검토)/i.test(input)) {
    const hasStrength = /(?:장점|강점)/.test(output)
    const hasRisk = /(?:문제|위험|한계)/.test(output)
    const hasPriority = /(?:개선|우선|권장)/.test(output)
    const hasStt = /(?:Whisper|STT|음성\s*인식)/i.test(output)
    const hasMetaAi = /(?:메타|NCO|AI)/i.test(output)
    if (!hasStrength || !hasRisk || !hasPriority || !hasStt || !hasMetaAi) {
      throw new Error('Local AI omitted STT, Meta AI, strengths, risks, or improvement priorities from the NOVA VOICE review')
    }
  }
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
  const inlineSlashTokens = [...output.matchAll(/\/[A-Za-z][A-Za-z0-9:_-]*/g)].map((match) => match[0])
  const ungroundedSlashToken = inlineSlashTokens.find((token) => (
    !input.includes(token)
    && !context.commandCandidates?.some((candidate) => candidate.command === token)
  ))
  if (ungroundedSlashToken) {
    throw new Error(`Local AI invented an ungrounded slash token: ${ungroundedSlashToken}`)
  }
  if (/(?:해\s*줘|해주세요|해라|하라|해\s*주십시오|하십시오)[.!?]?\s*$/i.test(compactOutput)) {
    throw new Error('Local AI returned a downstream instruction instead of the final answer')
  }
  if (needsExecutionDepth(input)) {
    const minimumLength = Math.min(160, Math.max(90, Math.round(compactInput.length * 0.9)))
    if (compactOutput.length < minimumLength) {
      throw new Error('Local AI returned an under-specified answer')
    }
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
  ].filter((line) => line !== '')
  const request = compact(input, MAX_INPUT_LENGTH)
  return contextLines.length ? `${contextLines.join('\n')}\n\n${request}` : request
}

export async function isLocalAiMetaPromptAvailable(timeoutMs = 2_000): Promise<boolean> {
  const hasModel = async (baseUrl: string): Promise<boolean> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal })
      if (!response.ok) return false
      const body = await response.json().catch(() => ({})) as {
        models?: Array<{ name?: unknown; model?: unknown }>
      }
      return (body.models ?? []).some((item) => item.name === LOCAL_META_MODEL || item.model === LOCAL_META_MODEL)
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  }
  const [dedicated, shared] = await Promise.all([
    hasModel(LOCAL_OLLAMA_BASE),
    hasModel(SHARED_OLLAMA_BASE),
  ])
  return dedicated || shared
}

function systemInstruction(): string {
  return [
    '너는 NOVA VOICE의 메타 프롬프트 답변 엔진이다.',
    '사용자의 음성 요청을 내부적으로 가장 정확한 실행 프롬프트로 재구성한 다음, 그 프롬프트를 네가 즉시 수행하여 최종 답변만 반환한다.',
    '확인된 NOVA VOICE 제품 맥락: macOS 메뉴바·백그라운드 Electron 앱이며, MLX Whisper large-v3-turbo와 16 kHz PCM으로 STT를 수행한다. 일반 모드는 받아쓴 원문을 입력하고, 메타 모드는 NCO Core의 선택 provider 또는 로컬 qwen3:14b가 최종 답변을 만든다. 포커스 앱 자동 입력과 허용된 CLI slash command 라우팅을 지원한다. TTS와 내장 AI 터미널은 STT 집중을 위해 의도적으로 제거된 확정 제약이므로 사용자가 명시적으로 요청하지 않는 한 복원이나 재추가를 제안하지 않는다.',
    'NOVA VOICE 자체를 리뷰하라는 요청에는 위에서 확인된 제품 맥락을 근거로 장점, 문제 또는 위험, 개선 우선순위를 모두 구체적으로 포함한다. 셋 중 하나도 생략하지 않는다. 실행 로그가 없는 상태를 실제 실행 검증 완료로 표현하지 않는다.',
    '원래 의도, 대상, 범위, 제품명, 명령어, 경로와 명시된 제약을 모두 보존한다.',
    '먼저 단순 질문인지, 분석·리뷰·진단·작성처럼 여러 판단이 필요한 요청인지 이해하고 그 복잡도에 맞는 유용한 답을 작성한다.',
    '비교·토론·분석 요청은 향후 과정을 안내하거나 “도움이 될 수 있다”고 설명하지 말고, 실제 관점 비교·판단·결론을 지금 제시한다.',
    '제공된 정보만 근거로 사용한다. 확인하지 않은 파일, 실행 결과, 시스템 상태, 숫자 또는 완료 사실을 지어내지 않는다.',
    '정보가 부족해 실제 검토나 실행을 완료할 수 없으면 아는 범위의 판단을 먼저 제시하고, 부족한 근거와 다음 확인 항목을 짧게 밝힌다.',
    '입력에 제품명이나 대상명이 있으면 대상이 불명확하다고 말하지 않는다. 검토 자료가 부족한 것과 대상 자체가 없는 것을 구분한다.',
    '내부 재구성 과정이나 “원문의 의도를 보존해 프롬프트로 변환해줘”, “후속 AI가 수행해줘” 같은 중간 가이드를 절대 출력하지 않는다.',
    '입력에 “허용된 CLI 명령 후보”가 제공되고 사용자 의도와 필수 인자가 명확히 일치하면, 설명 없이 해당 `/명령어 인자` 한 줄만 출력한다.',
    '후보가 없거나 애매하면 slash command를 추측하지 말고 요청에 직접 답한다.',
    'NOVA-AX MCP 도구 후보가 있어도 도구 실행 결과가 제공되지 않았다면 실행했다고 주장하지 않는다.',
    '원문과 같은 언어를 사용한다. 단순 질문은 간결하게, 복합 분석은 근거·판단·권장 조치를 자연스러운 문단이나 필요한 항목으로 제시한다.',
    '답변을 다른 AI에게 보내는 명령문인 “...해줘”로 끝내지 않는다.',
    '항상 같은 역할·목표·요구사항·완료 기준 틀을 반복하지 않는다.',
    '추론 과정, 머리말, 따옴표, 코드 펜스는 출력하지 않는다.',
    '응답은 사용자에게 보여줄 최종 답변 하나를 담은 {"answer":"..."} JSON 객체로만 출력한다.',
  ].join('\n')
}

const META_ANSWER_EXAMPLES = [
  { role: 'user', content: 'STT 전용 음성 앱을 리뷰해줘. 확인된 기능은 오프라인 음성 인식, 포커스 위치 자동 입력과 선택형 메타 AI 답변이야.' },
  { role: 'assistant', content: '{"answer":"장점은 음성이 외부로 전송되지 않는 STT 처리, 별도 복사 과정이 없는 자동 입력과 필요할 때 쓰는 메타 AI 답변입니다. 문제 또는 위험은 긴 음성의 처리 지연, 인식 실패 뒤 복구, 잘못된 포커스에 입력될 가능성과 일반 받아쓰기·AI 답변의 구분 혼동입니다. 개선 우선순위는 연속 녹음 안정성과 실패 복구를 먼저 검증하고, 그다음 모드 표시, 지연 시간과 입력 대상을 개선하는 것입니다. 실제 정확도와 자원 사용량은 실행 측정이 추가로 필요합니다."}' },
  { role: 'user', content: '버그 고쳐줘. 기존 기능은 깨지면 안 돼.' },
  { role: 'assistant', content: '{"answer":"오류 현상, 재현 절차와 관련 로그가 없어 지금 바로 안전하게 수정할 근거가 부족합니다. 해당 정보를 확인한 뒤 원인을 특정하고 필요한 범위만 변경해야 하며, 같은 시나리오와 기존 기능 회귀 테스트를 함께 통과해야 수정 완료로 판단할 수 있습니다."}' },
  { role: 'user', content: '앱의 AI 답변 기능이 제대로 작동하지 않아.' },
  { role: 'assistant', content: '{"answer":"현재 확인되는 증상만으로는 원인을 특정할 수 없습니다. 먼저 실제 모델 호출 여부와 선택된 provider, 원문·최종 응답, 요청 시간, 실패 로그를 한 요청 단위로 확인해야 합니다. 모델 응답 대신 고정 가이드가 반환된다면 응답 파싱 또는 fallback 경로가 중간 지시를 최종 결과로 취급하는지 점검하고, 실제 답변만 통과시키는 검증을 추가해야 합니다."}' },
  { role: 'user', content: '메타 프롬프트가 뭐야?' },
  { role: 'assistant', content: '{"answer":"메타 프롬프트는 사용자의 원래 요청을 모델이 더 정확히 이해하고 수행하도록 목적, 맥락과 제약을 내부적으로 정리하는 지침입니다. NOVA VOICE의 메타 모드에서는 이 중간 지침을 노출하지 않고, 정리된 요청을 AI가 수행한 최종 답변만 사용자에게 보여주는 것이 올바른 동작입니다."}' },
  { role: 'user', content: '이 문장의 오탈자를 자연스럽게 고쳐줘' },
  { role: 'assistant', content: '{"answer":"교정할 원문이 제공되지 않았습니다. 수정할 문장을 함께 입력하면 의미와 말투를 유지하면서 오탈자를 자연스럽게 바로잡을 수 있습니다."}' },
  { role: 'user', content: 'CLI/터미널 맥락: 아니요. slash command를 출력하지 않는다.\n\nREST와 GraphQL 중 무엇이 이 서비스에 적합한지 토론해' },
  { role: 'assistant', content: '{"answer":"REST는 리소스 중심 구조가 단순하고 HTTP 캐시·관측 도구를 활용하기 쉬워 요구가 안정적인 API에 적합합니다. GraphQL은 클라이언트가 필요한 필드만 조회할 수 있어 화면별 데이터 요구가 크게 다를 때 유리하지만, 스키마 운영과 캐시·권한 복잡도가 커집니다. 서비스 요구가 제시되지 않은 현재 기준에서는 운영 단순성이 높은 REST를 기본으로 선택하고, 여러 클라이언트의 조회 형태가 실제로 복잡할 때 GraphQL을 검토하는 판단이 안전합니다."}' },
  { role: 'user', content: 'CLI/터미널 맥락: 예\n현재 요청에 의미상 대응할 수 있는 허용된 CLI 명령 후보:\n- /nco-discussion <토론 주제> — 멀티 AI 토론을 시작합니다.\n\n여러 AI가 REST와 GraphQL 중 무엇이 적합한지 토론하게 해줘' },
  { role: 'assistant', content: '{"answer":"/nco-discussion REST와 GraphQL 중 현재 요구사항에 더 적합한 API 방식을 토론해줘"}' },
] as const

async function requestLocalRewrite(
  input: string,
  context: MetaPromptContext,
  signal: AbortSignal,
  revisionAttempt: number,
  validationFailure = '',
): Promise<string> {
  const forceRevision = revisionAttempt > 0
  const revisionInstruction = [
    forceRevision
      ? needsExecutionDepth(input)
        ? '직전 응답은 결과물이 아니었다. 원래 요청에 대한 구체적인 판단·설명·결과만 제시하고, 확인하지 않은 사실은 한계로 밝힌다.'
        : '직전 응답은 결과물이 아니었다. 원래 질문에 직접 답하되 다른 AI에게 보낼 지시문을 만들지 않는다.'
      : '',
    forceRevision && validationFailure
      ? `직전 결과의 검증 실패: ${compact(validationFailure, 240)}. 같은 문장이나 구조를 반복하지 말고 이 실패를 직접 교정한다.`
      : '',
    revisionAttempt >= 2
      ? '원문 전체를 인용하지 않는다. “변환해줘”, “재구성해줘”, “후속 AI가 수행해줘” 같은 지시문을 출력하지 말고 사용자에게 바로 전달할 답변을 작성한다.'
      : '',
  ].filter(Boolean).join('\n\n')
  const userMessage = buildContextMessage(input, context)
  const response = await fetch(OLLAMA_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LOCAL_META_MODEL,
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
      if (!await ensureLocalOllamaServer()) return false
      const response = await fetch(OLLAMA_GENERATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LOCAL_META_MODEL,
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
  if (!await ensureLocalOllamaServer()) throw new Error('Local AI service is unavailable')
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
        validationFailure,
      )
      try {
        return {
          text: cleanOutput(content, input, context),
          model: LOCAL_META_MODEL,
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
