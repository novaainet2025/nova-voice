/**
 * Classifies a transcribed utterance as a structured computer-control intent
 * (see docs/plans/computer-use-plan.md, T1). This mirrors local-ai-meta-prompt.ts's
 * model-resolution approach — prefer the smallest installed candidate, prefer
 * a server that already holds it warm — without touching that file: it is
 * shared 1:1 in the plan but its resolver/spawn logic is private to that
 * module, and this task is scoped to two new files only. No new Ollama
 * server or model is introduced here; if nothing candidate-holding is
 * already reachable and warm, classification is skipped rather than paying a
 * cold-load cost, since this call sits in front of every dictation and must
 * stay fast or fall back.
 *
 * parseComputerIntent (src/shared/computer-intent.ts) is the only function
 * allowed to decide an intent is safe to execute. This module never
 * constructs a ComputerIntent by hand — every result comes from that parser,
 * and any confidence below the fallback threshold or parse failure returns
 * null so the caller keeps using plain dictation. Existing dictation/meta
 * behavior is untouched by this module; it is purely additive.
 */

import { logInfo, logWarn } from './logger.ts'
import { ensureDedicatedOllamaServer, warmModel } from './local-ai-meta-prompt.ts'
import { basename } from 'path'
import { describeScreenContext, readScreenContext } from './screen-context.ts'
import { COMPUTER_ACTIONS, parseComputerPlan } from '../shared/computer-intent.ts'
import type { ComputerPlan } from '../shared/computer-intent.ts'

const LOCAL_OLLAMA_BASE = 'http://127.0.0.1:11435'

// Same candidates, same preference order as local-ai-meta-prompt.ts's
// LOCAL_META_MODEL_CANDIDATES — intentionally not imported (unexported) but
// kept identical so this never causes a second model to be pulled resident.
const INTENT_MODEL_CANDIDATES = ['qwen3:4b', 'qwen3:14b'] as const

const MODEL_RESOLUTION_TTL_MS = 60_000
// A gate in front of every utterance has to stay well under the silence
// timeout options (700-2000ms) or a "cold" wait; bounded generously above
// the measured 1.6s warm-inference case so one slow tick does not hang
// dictation, but far below the 20-100s cold-load figures documented in
// local-ai-meta-prompt.ts — a cold load is skipped entirely (see below).
const CLASSIFY_TIMEOUT_MS = 8_000
const MIN_CONFIDENCE = 0.6
/**
 * Explicit "this is not a command" answer.
 *
 * Without it the model had to pick the nearest action from the list and then
 * reported high confidence in that forced choice: "너 이름이 뭐야" came back as
 * FOCUS_INPUT at 0.85 and actually moved the caret. A refusal token is the only
 * way a classifier can say no.
 */
const NONE_ACTION = 'NONE'

/** Actions that do nothing without something to act on. */
const TARGET_REQUIRED: ReadonlySet<string> = new Set([
  'OPEN_APP', 'FOCUS_APP', 'FIND_FILE', 'REVEAL_IN_FINDER',
  'GENERATE_IMAGE', 'GENERATE_TABLE', 'OPEN_URL',
])

/** Words that point at the situation rather than naming it. */
const DEMONSTRATIVE = /(?:이거|이것|이\s*파일|이\s*폴더|여기|저거|저것|그거|그것|선택한|선택된)/

function hasDemonstrative(utterance: string): boolean {
  return DEMONSTRATIVE.test(utterance)
}

/**
 * Whether the user actually said this target.
 *
 * Compared without spaces or case because Korean speech-to-text moves word
 * boundaries around, and an app name may be spoken in Korean but resolved to
 * its English bundle name later.
 */
function mentionsTarget(utterance: string, target: string): boolean {
  const flatten = (value: string) => value.toLowerCase().replace(/[\s.,!?]/g, '')
  const flatUtterance = flatten(utterance)
  const flatTarget = flatten(target)
  if (!flatTarget) return false
  return flatUtterance.includes(flatTarget)
}

const MAX_INPUT_LENGTH = 1_000

interface ClassifierTarget {
  baseUrl: string
  model: string
}

let resolvedTarget: { target: ClassifierTarget | null; at: number } | null = null

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

/**
 * Picks a server+model to classify with, or null when nothing candidate is
 * already warm. Deliberately does not fall back to a cold load or spawn a
 * server the way local-ai-meta-prompt.ts's meta-prompt path does — that path
 * is invoked once per explicit meta-mode utterance and can afford to wait,
 * this one gates every utterance and must fail fast to dictation instead.
 */
async function resolveClassifierTarget(): Promise<ClassifierTarget | null> {
  const cached = resolvedTarget
  if (cached && Date.now() - cached.at < MODEL_RESOLUTION_TTL_MS) return cached.target

  // Only the dedicated server is considered. The shared one is NCO's: measured
  // there, a request needing 2.0s of inference took 53s wall-clock behind NCO's
  // queue, and a run of nine utterances timed out on five of them. No deadline
  // in front of a dictation can absorb that, so classification either runs
  // uncontended or falls back to dictation.
  const dedicatedResident = await listResidentModels(LOCAL_OLLAMA_BASE)
  const servers = [{ baseUrl: LOCAL_OLLAMA_BASE, resident: dedicatedResident }]

  for (const model of INTENT_MODEL_CANDIDATES) {
    const warm = servers.find((server) => server.resident.has(model))
    if (!warm) continue
    const target: ClassifierTarget = { baseUrl: warm.baseUrl, model }
    resolvedTarget = { target, at: Date.now() }
    return target
  }

  // Nothing is warm anywhere. Start the dedicated server and warm the smallest
  // candidate in the background so the *next* utterance can be classified; this
  // one falls back to dictation rather than waiting out a cold load.
  void prepareDedicatedClassifier()
  resolvedTarget = { target: null, at: Date.now() }
  return null
}

let preparing: Promise<void> | null = null

/**
 * Brings the dedicated classifier model up out of band.
 *
 * A cold load costs tens of seconds here, far past any deadline that belongs in
 * front of a dictation, so this never blocks a classification — it only makes
 * the following ones possible.
 */
export function prepareIntentClassifier(): Promise<void> {
  return prepareDedicatedClassifier()
}

function prepareDedicatedClassifier(): Promise<void> {
  if (preparing) return preparing
  preparing = (async () => {
    try {
      if (!await ensureDedicatedOllamaServer()) return
      const model = INTENT_MODEL_CANDIDATES[0]
      const warmed = await warmModel(LOCAL_OLLAMA_BASE, model)
      if (warmed) {
        // Force the next call to re-read residency rather than wait out the TTL.
        resolvedTarget = null
        logInfo('[IntentClassifier] Dedicated model warmed', { model })
      }
    } catch (error) {
      logWarn('[IntentClassifier] Could not warm the dedicated model', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      preparing = null
    }
  })()
  return preparing
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function compact(value: string, maxLength: number): string {
  return value.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function systemInstruction(): string {
  return [
    '너는 NOVA VOICE의 컴퓨터 제어 의도 분류기다.',
    '사용자가 말로 한 발화 하나를 받아, 그것이 컴퓨터를 조작하려는 명령인지 판정한다.',
    `action은 다음 목록 중 하나이거나, 컴퓨터 제어가 아니면 ${NONE_ACTION}이다: ${COMPUTER_ACTIONS.join(', ')}.`,
    '각 action의 의미: OPEN_APP=앱 실행, FOCUS_APP=이미 떠 있는 앱으로 전환, FIND_FILE=파일 검색, REVEAL_IN_FINDER=파인더에서 위치 표시, FOCUS_INPUT=입력창에 포커스, CLICK=화면 요소 클릭, TYPE=텍스트 입력, SCREENSHOT=화면 캡처, GENERATE_IMAGE=이미지 생성, GENERATE_TABLE=표 생성.',
    '발화가 이 action 중 하나에 명확히 해당하면 target에 대상(앱 이름, 파일명, 검색어 등 원문에서 확인되는 것만)을 채운다. 원문에 없는 대상을 지어내지 않는다.',
    '컴퓨터 제어가 아니면 action을 NONE으로 답한다. 목록에서 억지로 고르지 않는다.',
    'NONE을 써야 하는 경우: 질문("오늘 며칠이야", "너 이름이 뭐야"), 인사, 대화, 문서에 적을 문장, 다른 AI에게 시키는 요청, 대상이 없는 막연한 지시("그럼 열어").',
    '판단 기준은 하나다 — 이 발화를 이 컴퓨터에서 지금 실행했을 때 사용자가 의도한 결과가 나오는가. 아니면 NONE이다.',
    'confidence는 0과 1 사이의 숫자로, 이 발화가 실제로 해당 action을 의미할 확신도를 정직하게 반영한다. 애매하면 NONE을 고르고 낮게 준다.',
    '대상이 필요한 action(OPEN_APP, FOCUS_APP, FIND_FILE, REVEAL_IN_FINDER)은 원문에 대상이 있을 때만 쓴다. 대상이 없으면 NONE이다.',
    '"파인더 열어줘"처럼 앱을 열라는 말은 OPEN_APP이다. REVEAL_IN_FINDER는 특정 파일의 위치를 파인더에서 보여달라는 뜻이므로 대상 파일이 있을 때만 쓴다.',
    'args는 action 수행에 필요한 추가 값(예: TYPE의 입력 문자열)이 원문에서 명확할 때만 채우고, 없으면 비운다.',
    '입력에 [현재 상황]이 있으면 그것을 근거로 판단한다. "이거", "여기", "이 파일" 같은 지시어는 그 상황이 가리키는 대상으로 해석하고, target에 실제 대상 이름을 채운다.',
    '상황과 발화가 어울리지 않으면(예: 문서 편집 중인데 파일 검색 명령처럼 들림) 억지로 실행하지 말고 NONE으로 답한다.',
    '한 발화에 여러 동작이 있으면 steps 배열에 순서대로 담는다. 예: "크롬 열고 네이버 접속해" → OPEN_APP(크롬) 다음 OPEN_URL(네이버).',
    '동작이 하나면 steps에 하나만 담는다. 컴퓨터 제어가 아니면 steps에 action이 NONE인 항목 하나만 담는다.',
    'target은 사용자가 말한 대상을 그대로 옮긴다. "사파리 열어줘"의 target은 "사파리"다. 대상을 말했는데 target을 비우면 안 된다.',
    'OPEN_URL은 웹사이트 접속이다. target에 사이트 이름이나 주소를 그대로 담고, 특정 브라우저를 지정했으면 args.browser에 그 브라우저 이름을 담는다.',
    '설명, 머리말, 코드펜스 없이 지정된 JSON 스키마 그대로만 출력한다.',
  ].join('\n')
}

const INTENT_EXAMPLES = [
  { role: 'user', content: '사파리 열어줘' },
  { role: 'assistant', content: '{"steps":[{"action":"OPEN_APP","target":"사파리","confidence":0.93}],"confidence":0.93}' },
  { role: 'user', content: '크롬 열고 네이버 접속해' },
  { role: 'assistant', content: '{"steps":[{"action":"OPEN_APP","target":"크롬","confidence":0.93},{"action":"OPEN_URL","target":"네이버","args":{"browser":"크롬"},"confidence":0.93}],"confidence":0.93}' },
  { role: 'user', content: '구글드라이브 접속하고 지메일도 열어줘' },
  { role: 'assistant', content: '{"steps":[{"action":"OPEN_URL","target":"구글드라이브","confidence":0.92},{"action":"OPEN_URL","target":"지메일","confidence":0.92}],"confidence":0.92}' },
  { role: 'user', content: '이력서 파일 찾아줘' },
  { role: 'assistant', content: '{"steps":[{"action":"FIND_FILE","target":"이력서","confidence":0.9}],"confidence":0.9}' },
  { role: 'user', content: '입력창에 포커스' },
  { role: 'assistant', content: '{"steps":[{"action":"FOCUS_INPUT","confidence":0.85}],"confidence":0.85}' },
  { role: 'user', content: '화면 캡처해줘' },
  { role: 'assistant', content: '{"steps":[{"action":"SCREENSHOT","confidence":0.88}],"confidence":0.88}' },
  { role: 'user', content: '너 이름이 뭐야' },
  { role: 'assistant', content: '{"steps":[{"action":"NONE","confidence":0.95}],"confidence":0.95}' },
  { role: 'user', content: '그럼 열어' },
  { role: 'assistant', content: '{"steps":[{"action":"NONE","confidence":0.9}],"confidence":0.9}' },
] as const

/**
 * Classifies one utterance into a ComputerIntent, or null when it should
 * fall back to plain dictation — no candidate-holding server is warm, the
 * model call fails or times out, the output does not parse, or confidence
 * lands below MIN_CONFIDENCE. Never throws: every failure path resolves to
 * null so a classification hiccup can never break dictation.
 */
export async function classifyUtterance(text: string, signal?: AbortSignal): Promise<ComputerPlan | null> {
  const trimmed = compact(text, MAX_INPUT_LENGTH)
  if (!trimmed) return null
  if (signal?.aborted) return null

  const target = await resolveClassifierTarget()
  if (!target) return null

  // What is on screen decides what a demonstrative refers to, and it also tells
  // the model when an utterance does not fit the situation at all. Read before
  // the deadline starts: the probe is bounded separately and a failed read
  // simply yields no context.
  const screenContext = await readScreenContext()
  const contextBlock = describeScreenContext(screenContext)
  const userMessage = contextBlock ? `${contextBlock}\n\n${trimmed}` : trimmed

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Intent classification timed out')), CLASSIFY_TIMEOUT_MS)
  const abortFromParent = () => controller.abort(signal?.reason ?? new Error('Intent classification cancelled'))
  if (signal?.aborted) abortFromParent()
  else signal?.addEventListener('abort', abortFromParent, { once: true })

  try {
    const response = await fetch(`${target.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target.model,
        messages: [
          { role: 'system', content: systemInstruction() },
          ...INTENT_EXAMPLES,
          { role: 'user', content: userMessage },
        ],
        think: false,
        format: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: [...COMPUTER_ACTIONS, NONE_ACTION] },
                  // Required, not optional: with target optional the model kept
                  // omitting it even for "사파리 열어줘", and a targetless
                  // OPEN_APP is dropped downstream. Actions that genuinely have
                  // no target (FOCUS_INPUT, SCREENSHOT, NONE) send an empty
                  // string, which the parser treats as absent.
                  target: { type: 'string' },
                  args: { type: 'object' },
                  confidence: { type: 'number' },
                },
                required: ['action', 'target', 'confidence'],
              },
            },
            confidence: { type: 'number' },
          },
          required: ['steps', 'confidence'],
        },
        stream: false,
        keep_alive: '30m',
        options: {
          temperature: 0.1,
          num_predict: 150,
        },
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      logInfo('[IntentClassifier] Ollama returned non-OK status', response.status)
      return null
    }

    const body = await response.json().catch(() => ({})) as { message?: { content?: unknown } }
    const content = typeof body.message?.content === 'string' ? body.message.content : ''
    if (!content) return null

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(content)
    } catch {
      logInfo('[IntentClassifier] Model returned non-JSON output', content.slice(0, 200))
      return null
    }

    // NONE is not an executable action, so it never reaches the parser. It can
    // arrive either as a bare object or as the only step of a plan.
    if (isRecord(parsedJson)) {
      const steps = Array.isArray(parsedJson.steps) ? parsedJson.steps : []
      const declaredNone = parsedJson.action === NONE_ACTION
        || steps.some((step) => isRecord(step) && step.action === NONE_ACTION)
      if (declaredNone) {
        logInfo('[IntentClassifier] Not a computer command', { utterance: trimmed.slice(0, 60) })
        return null
      }
    }

    const plan = parseComputerPlan(parsedJson)
    if (!plan) {
      logInfo('[IntentClassifier] Model output failed plan validation', content.slice(0, 200))
      return null
    }
    if (plan.confidence < MIN_CONFIDENCE) return null

    // Every step is validated independently and one rejection drops the whole
    // plan. Running the surviving half of "크롬 열고 네이버 접속해" would leave
    // the user somewhere they never asked to be.
    for (const step of plan.steps) {
      if (step.confidence < MIN_CONFIDENCE) return null

      // The schema requires `target`, so actions that have none send an empty
      // string. Normalise it away before the target rules below see it.
      if (step.target !== undefined && !step.target.trim()) delete step.target

      // Some actions are meaningless without a target, yet the model returns
      // them for vague utterances anyway: "그럼 열어" came back as OPEN_APP at
      // 0.9, and with screen context available it even borrowed the front
      // window's name as the target. Prompt wording did not stop it.
      if (TARGET_REQUIRED.has(step.action) && !step.target?.trim()) {
        logInfo('[IntentClassifier] Dropped a targetless action', { action: step.action })
        return null
      }

      // A demonstrative left in the target means the model echoed the pronoun
      // instead of resolving it, so the executor would look for a file literally
      // named "이거". Resolve it from the selection here, or give up.
      if (step.target && DEMONSTRATIVE.test(step.target)) {
        const selected = screenContext.selection?.[0]
        if (!selected) {
          logInfo('[IntentClassifier] Demonstrative with nothing selected', { target: step.target })
          return null
        }
        step.target = basename(selected)
      }

      // A target the user never said is a hallucination — most often the app or
      // window name lifted out of the context block. Demonstratives are the
      // deliberate exception, and so is a URL step: "네이버 접속해" names the
      // destination, and the executor resolves it to an address.
      if (
        step.target
        && step.action !== 'OPEN_URL'
        && !mentionsTarget(trimmed, step.target)
        && !hasDemonstrative(trimmed)
      ) {
        logInfo('[IntentClassifier] Dropped an unstated target', {
          action: step.action, target: step.target,
        })
        return null
      }
    }

    logInfo('[IntentClassifier] Plan accepted', {
      steps: plan.steps.map((step) => `${step.action}:${step.target ?? '-'}`),
    })
    return plan
  } catch (error) {
    logInfo('[IntentClassifier] Classification failed', error)
    return null
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromParent)
  }
}
