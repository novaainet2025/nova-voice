/**
 * Answers a spoken question out loud.
 *
 * This is the one mode whose output is heard rather than read, which changes
 * what a good answer looks like: two or three sentences, no lists, no markdown,
 * no code. A paragraph that reads well takes half a minute to listen to.
 *
 * The answer comes from the same providers meta mode uses — NCO when it is
 * reachable, the local model otherwise — so no new backend is introduced for
 * this feature.
 */
import { askLocalModel } from './local-ai-meta-prompt.ts'
import { ncoRequestJson, safeErrorMessage } from './nco-core-client.ts'
import { resolveAutoProvider, recordProviderOutcome } from './nco-provider-selector.ts'
import { logInfo, logWarn } from './logger.ts'

const SUBMIT_TIMEOUT_MS = 8_000
const STATUS_TIMEOUT_MS = 5_000
/**
 * Spoken answers are worth much less late than written ones: past roughly half
 * a minute the user has moved on, so this deadline is far tighter than the
 * two minutes meta mode allows.
 */
const TOTAL_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 400
const MAX_QUESTION_LENGTH = 500
/** Roughly 20 seconds of speech — past that a listener stops following. */
const MAX_ANSWER_LENGTH = 300
/**
 * Model used for spoken answers.
 *
 * Larger than the classifier's qwen3:4b on purpose. Measured on the same
 * question, 4b ignored `think: false` and read its reasoning aloud ("Okay, the
 * user is asking…"), while 14b answered in two natural Korean sentences with a
 * 1.0s eval. Quality matters more here than model size: this output is heard.
 */
const ANSWER_MODEL = 'qwen3:14b'

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const TERMINAL_FAILURES = new Set([
  'failed', 'timed_out', 'cancelled', 'canceled', 'blocked', 'policy_denied', 'requires_human',
])

export interface VoiceAnswer {
  text: string
  provider: string
  elapsedMs: number
}

/**
 * Instruction shared by both providers.
 *
 * Written for the ear: the constraints here exist because the result is spoken,
 * not because they make a better paragraph.
 */
function answerInstruction(question: string): string {
  return [
    '너는 음성으로 답하는 비서다. 아래 질문에 한국어로 답한다.',
    '',
    '[말하기 규칙]',
    '- 답변은 소리로 들린다. 두세 문장 안에 끝낸다.',
    '- 목록, 번호, 마크다운, 코드, 표를 쓰지 않는다. 문장으로만 말한다.',
    '- URL, 파일 경로, 긴 숫자열은 읽기 어려우므로 넣지 않는다.',
    '- 모르면 모른다고 짧게 말한다. 추측을 사실처럼 말하지 않는다.',
    '- 되묻지 말고 지금 아는 범위에서 답한다.',
    '- 생각 과정이나 영어 설명을 쓰지 말고 한국어 답변만 말한다.',
    '',
    '[질문]',
    question,
  ].join('\n')
}

/** Trims an answer down to something worth listening to. */
function tidyAnswer(value: string): string {
  const cleaned = value
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*[-*\d.]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= MAX_ANSWER_LENGTH) return cleaned
  // Cut at a sentence boundary so speech does not stop mid-clause.
  const clipped = cleaned.slice(0, MAX_ANSWER_LENGTH)
  const lastStop = Math.max(clipped.lastIndexOf('.'), clipped.lastIndexOf('!'), clipped.lastIndexOf('?'))
  return lastStop > MAX_ANSWER_LENGTH * 0.5 ? clipped.slice(0, lastStop + 1) : clipped
}

async function answerViaNco(
  question: string,
  projectDir: string,
  signal?: AbortSignal,
): Promise<VoiceAnswer> {
  const decision = await resolveAutoProvider()
  const provider = decision.provider
  const startedAt = Date.now()
  let taskId = ''

  try {
    const submission = await ncoRequestJson('/api/task', {
      method: 'POST',
      body: JSON.stringify({
        ai: provider,
        prompt: answerInstruction(question),
        priority: 1,
        callerAgentId: 'nova-voice',
        metadata: {
          allowProviderFailover: true,
          queuePriority: 1,
          queueWaitMaxMs: 5_000,
          projectDir,
          source: 'nova-voice',
          purpose: 'voice-answer',
        },
      }),
    }, SUBMIT_TIMEOUT_MS, signal)

    taskId = typeof submission.taskId === 'string' ? submission.taskId : ''
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error('NCO did not return a valid task ID')

    const deadline = Date.now() + TOTAL_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error('Voice answer cancelled')
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

      const body = await ncoRequestJson(
        `/api/task/${encodeURIComponent(taskId)}`, {}, STATUS_TIMEOUT_MS, signal,
      )
      const task = body.task && typeof body.task === 'object' ? body.task as Record<string, unknown> : body
      const status = typeof task.status === 'string' ? task.status.toLowerCase() : 'unknown'

      if (status === 'completed' || status === 'complete' || status === 'done') {
        const raw = typeof task.response === 'string'
          ? task.response
          : typeof task.output === 'string' ? task.output : ''
        const text = tidyAnswer(raw)
        if (!text) throw new Error('NCO returned an empty answer')
        recordProviderOutcome(provider, { ok: true, elapsedMs: Date.now() - startedAt })
        return { text, provider: `NCO · ${provider}`, elapsedMs: Date.now() - startedAt }
      }
      if (TERMINAL_FAILURES.has(status)) {
        throw new Error(`NCO voice answer ${status}`)
      }
    }
    throw new Error('NCO voice answer timed out')
  } catch (error) {
    if (!signal?.aborted) {
      recordProviderOutcome(provider, {
        ok: false, elapsedMs: Date.now() - startedAt, failure: safeErrorMessage(error),
      })
    }
    if (taskId) {
      await ncoRequestJson(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }, 2_000)
        .catch(() => undefined)
    }
    throw error
  }
}

async function answerViaLocal(question: string, signal?: AbortSignal): Promise<VoiceAnswer> {
  const startedAt = Date.now()
  const result = await askLocalModel(answerInstruction(question), signal, 220, ANSWER_MODEL)
  if (!result) throw new Error('Local AI is unavailable')
  const text = tidyAnswer(result.text)
  if (!text) throw new Error('Local AI returned an empty answer')
  return { text, provider: `Local AI · ${result.model}`, elapsedMs: Date.now() - startedAt }
}

/**
 * Produces a spoken-length answer.
 *
 * Both providers race and the first usable answer wins, the same arrangement
 * meta mode uses: NCO is better when it is free, and the local model is the one
 * that always responds.
 */
export async function answerQuestion(
  question: string,
  projectDir: string,
  signal?: AbortSignal,
): Promise<VoiceAnswer | null> {
  const trimmed = question.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_LENGTH)
  if (!trimmed) return null

  const candidates: Array<Promise<VoiceAnswer>> = [
    answerViaLocal(trimmed, signal),
    answerViaNco(trimmed, projectDir, signal).catch((error) => {
      logWarn('[VoiceAnswer] NCO path failed', { error: safeErrorMessage(error) })
      throw error
    }),
  ]

  try {
    const winner = await Promise.any(candidates)
    logInfo('[VoiceAnswer] Answered', {
      provider: winner.provider,
      chars: winner.text.length,
      elapsedMs: winner.elapsedMs,
    })
    return winner
  } catch (error) {
    if (signal?.aborted) return null
    logWarn('[VoiceAnswer] No provider answered', { error: safeErrorMessage(error) })
    return null
  }
}
