/**
 * Structured intent that a spoken utterance can be turned into for computer
 * control (see docs/plans/computer-use-plan.md). `parseComputerIntent` is the
 * single safety boundary between whatever a classifier model returns and
 * anything an executor is allowed to run: nothing downstream may act on an
 * intent that did not pass through this function, and this function accepts
 * only allow-listed actions with correctly typed fields. There is no
 * natural-language-to-shell-command path — every executable action is named
 * here explicitly.
 */

export const COMPUTER_ACTIONS = [
  'OPEN_APP',
  'FOCUS_APP',
  'FIND_FILE',
  'REVEAL_IN_FINDER',
  'FOCUS_INPUT',
  'CLICK',
  'TYPE',
  'SCREENSHOT',
  'GENERATE_IMAGE',
  'GENERATE_TABLE',
] as const

export type ComputerAction = typeof COMPUTER_ACTIONS[number]

const COMPUTER_ACTION_SET = new Set<string>(COMPUTER_ACTIONS)

export interface ComputerIntent {
  action: ComputerAction
  target?: string
  args?: Record<string, string>
  confidence: number
}

// Defensive caps on an LLM-produced object: a runaway or adversarial
// completion should fail validation rather than pass through as an
// oversized target/args payload to an executor.
const MAX_TARGET_LENGTH = 300
const MAX_ARG_VALUE_LENGTH = 300
const MAX_ARG_COUNT = 20
const ALLOWED_TOP_LEVEL_KEYS = new Set(['action', 'target', 'args', 'confidence'])
// Rejected outright even as a string value: these keys only matter if
// something downstream ever spreads args onto an object, but excluding them
// here costs nothing and removes the class of bug entirely.
const FORBIDDEN_ARG_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Returns undefined when args is absent (valid), null when present but invalid. */
function parseArgs(value: unknown): Record<string, string> | null | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) return null
  const keys = Object.keys(value)
  if (keys.length > MAX_ARG_COUNT) return null

  const args: Record<string, string> = {}
  for (const key of keys) {
    if (FORBIDDEN_ARG_KEYS.has(key)) return null
    const raw = value[key]
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ARG_VALUE_LENGTH) return null
    args[key] = raw
  }
  return args
}

/**
 * Turns unknown JSON (typically a classifier model's raw output) into a
 * ComputerIntent, or null when it cannot be trusted to execute. Every
 * rejection path is enumerated below rather than falling through — an
 * unrecognized top-level key, an action outside the allow list, a
 * wrong-typed field, or an out-of-range confidence all return null.
 */
export function parseComputerIntent(raw: unknown): ComputerIntent | null {
  if (!isPlainObject(raw)) return null
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) return null
  }

  const { action, target, args, confidence } = raw

  if (typeof action !== 'string' || !COMPUTER_ACTION_SET.has(action)) return null

  if (
    target !== undefined
    && (typeof target !== 'string' || target.length === 0 || target.length > MAX_TARGET_LENGTH)
  ) {
    return null
  }

  const parsedArgs = parseArgs(args)
  if (parsedArgs === null) return null

  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null
  }

  const intent: ComputerIntent = {
    action: action as ComputerAction,
    confidence,
  }
  if (target !== undefined) intent.target = target as string
  if (parsedArgs !== undefined) intent.args = parsedArgs
  return intent
}
