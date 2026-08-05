/**
 * Native macOS side of voice computer control.
 *
 * Only the actions listed in {@link ComputerAction} can reach this module, and
 * only after `parseComputerIntent` has accepted them — there is deliberately no
 * path from a spoken sentence to a shell string. Every command here is invoked
 * through `execFile` with an argument array, so a file name that happens to
 * contain shell metacharacters is data rather than syntax.
 *
 * File access is confined to the home directory. A dictation is a casual act:
 * the user should not be able to reach `/etc` or another account's data by
 * phrasing a sentence in an unlucky way.
 */
import { execFile as execFileCallback } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { logInfo, logWarn } from './logger.ts'
import { discardGeneratedImage, generateImage, generateTable } from './image-generation.ts'
import type { ComputerIntent } from '../shared/computer-intent.ts'

const execFile = promisify(execFileCallback)

const COMMAND_TIMEOUT_MS = 15_000
const MAX_SEARCH_RESULTS = 20
const HOME = os.homedir()

/**
 * Outcome of one action.
 *
 * `refused` is distinct from `error`: it means the action is understood and
 * implementable but deliberately not run — currently because it would change
 * state irreversibly and there is no confirmation UI yet. Collapsing it into
 * `error` would make a safety decision look like a malfunction.
 */
export interface ComputerExecutionResult {
  status: 'ok' | 'refused' | 'error'
  /** Short sentence shown to the user; already in their language. */
  message: string
  /** Anything the action produced, e.g. matched file paths. */
  data?: Record<string, unknown>
}

export interface ExecutionContext {
  requestId?: string
  signal?: AbortSignal
}

/**
 * Actions that change state a user cannot easily undo. They are recognised so
 * the pipeline can ask first; nothing in this module executes them.
 */
export const CONFIRMATION_REQUIRED: ReadonlySet<string> = new Set<string>([
  // No destructive action is implemented yet. The set exists so that adding one
  // without a confirmation path is a deliberate act rather than an oversight.
])

/**
 * Keeps a resolved path inside the home directory.
 *
 * `realpath` is applied first so a symlink cannot be used to step outside the
 * boundary after the string check has passed.
 */
function withinHome(candidate: string): string | null {
  try {
    const resolved = fs.realpathSync(path.resolve(candidate))
    const boundary = fs.realpathSync(HOME)
    if (resolved === boundary || resolved.startsWith(`${boundary}${path.sep}`)) return resolved
    return null
  } catch {
    return null
  }
}

/** Rejects arguments that osascript would treat as anything but a literal. */
function isSafeAppName(value: string): boolean {
  return /^[\p{L}\p{N} .&'()+-]{1,64}$/u.test(value)
}

/**
 * Maps a spoken app name onto one macOS can actually launch.
 *
 * `open -a` matches the bundle's display name, so a name transliterated by STT
 * fails: "노바 유즈" and "파인더" are what the user says, but the bundles are
 * "NOVA Use" and "Finder". Only names confirmed to exist on this machine are
 * returned, so a wrong guess surfaces as "not found" rather than launching
 * something unintended.
 */
async function resolveAppName(spoken: string): Promise<string> {
  if (await appExists(spoken)) return spoken
  const normalized = spoken.toLowerCase().replace(/\s+/g, '')
  for (const [pattern, actual] of SPOKEN_APP_NAMES) {
    if (pattern.test(normalized) && await appExists(actual)) return actual
  }
  return spoken
}

/** True when macOS can resolve this name to an installed application. */
async function appExists(name: string): Promise<boolean> {
  if (!isSafeAppName(name)) return false
  try {
    await execFile('open', ['-Ra', name], { timeout: COMMAND_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

/**
 * Korean speech-to-text renders application names phonetically, so the spoken
 * form never matches the bundle name. Kept small and explicit: a fuzzy matcher
 * here would eventually launch the wrong application.
 */
const SPOKEN_APP_NAMES: Array<[RegExp, string]> = [
  [/^(노바유즈|노바유스|novause)$/, 'NOVA Use'],
  [/^(노바보이스|novavoice)$/, 'NOVA VOICE'],
  [/^(파인더|finder)$/, 'Finder'],
  [/^(사파리|safari)$/, 'Safari'],
  [/^(크롬|구글크롬|chrome)$/, 'Google Chrome'],
  [/^(터미널|terminal)$/, 'Terminal'],
  [/^(설정|시스템설정|systemsettings)$/, 'System Settings'],
  [/^(메모|notes)$/, 'Notes'],
  [/^(캘린더|달력|calendar)$/, 'Calendar'],
  [/^(음악|music)$/, 'Music'],
]

async function openApp(spoken: string): Promise<ComputerExecutionResult> {
  const name = await resolveAppName(spoken)
  if (!isSafeAppName(name)) {
    return { status: 'error', message: `앱 이름을 이해하지 못했습니다: ${spoken}` }
  }
  try {
    // `open -a` resolves by display name and launches or raises the app. It is
    // the same mechanism Finder uses, so an app the user cannot open manually
    // will not open here either.
    await execFile('open', ['-a', name], { timeout: COMMAND_TIMEOUT_MS })
    logInfo('[ComputerUse] Opened app', { name })
    return { status: 'ok', message: `${name}을(를) 열었습니다.` }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logWarn('[ComputerUse] Failed to open app', { spoken, name, detail })
    return { status: 'error', message: `${spoken}을(를) 찾지 못했습니다.` }
  }
}

async function focusApp(spoken: string): Promise<ComputerExecutionResult> {
  const name = await resolveAppName(spoken)
  if (!isSafeAppName(name)) {
    return { status: 'error', message: `앱 이름을 이해하지 못했습니다: ${spoken}` }
  }
  try {
    await execFile('osascript', [
      '-e', 'on run argv',
      '-e', 'tell application "System Events" to set frontmost of process (item 1 of argv) to true',
      '-e', 'end run',
      name,
    ], { timeout: COMMAND_TIMEOUT_MS })
    logInfo('[ComputerUse] Focused app', { name })
    return { status: 'ok', message: `${name}으로 전환했습니다.` }
  } catch {
    // The process may not be running under that exact name; launching is the
    // behaviour a user means by "switch to X" when X is not open.
    return openApp(spoken)
  }
}

async function findFile(query: string): Promise<ComputerExecutionResult> {
  const term = query.trim()
  if (!term) return { status: 'error', message: '찾을 파일 이름을 알려주세요.' }
  try {
    // Spotlight is scoped to the home directory with -onlyin, and the query is
    // passed as one argument so quotes in a filename cannot alter it.
    const { stdout } = await execFile(
      'mdfind',
      ['-onlyin', HOME, '-name', term],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    )
    const matches = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => withinHome(line))
      .filter((line): line is string => line !== null)
      .slice(0, MAX_SEARCH_RESULTS)

    logInfo('[ComputerUse] File search finished', { term, matches: matches.length })
    if (!matches.length) return { status: 'ok', message: `"${term}"에 해당하는 파일을 찾지 못했습니다.` }
    return {
      status: 'ok',
      message: `"${term}" 검색 결과 ${matches.length}건을 찾았습니다.`,
      data: { matches },
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logWarn('[ComputerUse] File search failed', { term, detail })
    return { status: 'error', message: '파일 검색에 실패했습니다.' }
  }
}

async function revealInFinder(target: string): Promise<ComputerExecutionResult> {
  // A bare word is a search request, not a path; find it first and reveal the
  // best match rather than failing on something the user clearly meant.
  const direct = withinHome(target)
  let revealPath = direct
  if (!revealPath) {
    const found = await findFile(target)
    const matches = Array.isArray(found.data?.matches) ? found.data.matches as string[] : []
    revealPath = matches[0] ?? null
  }
  if (!revealPath) {
    return { status: 'error', message: `"${target}"을(를) 홈 폴더에서 찾지 못했습니다.` }
  }
  try {
    await execFile('open', ['-R', revealPath], { timeout: COMMAND_TIMEOUT_MS })
    logInfo('[ComputerUse] Revealed in Finder', { revealPath })
    return {
      status: 'ok',
      message: `Finder에서 ${path.basename(revealPath)}을(를) 표시했습니다.`,
      data: { path: revealPath },
    }
  } catch {
    return { status: 'error', message: 'Finder에서 표시하지 못했습니다.' }
  }
}

/**
 * Puts the caret in the frontmost window's text field.
 *
 * There is no reliable cross-application way to name "the input box", so this
 * asks the accessibility layer for the focused window's first text input. When
 * the app exposes none, that is reported rather than guessed at with a click.
 */
async function focusInput(): Promise<ComputerExecutionResult> {
  try {
    const { stdout } = await execFile('osascript', ['-e', `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        try
          set targetWindow to front window of frontApp
        on error
          return "no-window"
        end try
        try
          set fields to (every text field of targetWindow)
          if (count of fields) > 0 then
            set focused of (item 1 of fields) to true
            return "ok"
          end if
        end try
        try
          set areas to (every text area of targetWindow)
          if (count of areas) > 0 then
            set focused of (item 1 of areas) to true
            return "ok"
          end if
        end try
        return "no-field"
      end tell
    `], { timeout: COMMAND_TIMEOUT_MS })

    const outcome = stdout.trim()
    logInfo('[ComputerUse] Focus input', { outcome })
    if (outcome === 'ok') return { status: 'ok', message: '입력창에 커서를 두었습니다.' }
    if (outcome === 'no-window') return { status: 'error', message: '앞쪽에 창이 없습니다.' }
    return { status: 'error', message: '이 앱에서는 입력창을 찾지 못했습니다.' }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logWarn('[ComputerUse] Focus input failed', { detail })
    return { status: 'error', message: '입력창에 커서를 두지 못했습니다. 손쉬운 사용 권한을 확인해주세요.' }
  }
}

/**
 * Turns dictated rows into a Markdown table.
 *
 * Speech has no cell boundaries, so the split is explicit: newlines separate
 * rows, and commas or tabs separate cells. `args.rows` is preferred when the
 * classifier managed to structure it, because that is unambiguous.
 */
function generateTableIntent(intent: ComputerIntent): ComputerExecutionResult {
  const raw = intent.args?.rows ?? intent.target ?? ''
  const rows = raw
    .split(/[\n;]+/)
    .map((line) => line.split(/[,\t]/).map((cell) => cell.trim()).filter(Boolean))
    .filter((row) => row.length > 0)
  if (!rows.length) {
    return { status: 'error', message: '표에 넣을 내용을 알려주세요.' }
  }
  const table = generateTable(rows)
  logInfo('[ComputerUse] Table generated', { rows: rows.length })
  return { status: 'ok', message: table, data: { table, rows: rows.length } }
}

/**
 * Generates an image and hands back its path.
 *
 * The scratch directory is deliberately not cleaned up on success: the caller
 * still has to attach the file. `discardGeneratedImage` releases it afterwards.
 */
async function generateImageIntent(
  description: string,
  signal?: AbortSignal,
): Promise<ComputerExecutionResult> {
  if (!description) return { status: 'error', message: '어떤 이미지를 만들지 알려주세요.' }
  try {
    const image = await generateImage(description, signal)
    logInfo('[ComputerUse] Image generated', { bytes: image.bytes, model: image.model })
    return {
      status: 'ok',
      message: `이미지를 만들었습니다 (${Math.round(image.bytes / 1024)}KB).`,
      data: { imagePath: image.path, bytes: image.bytes },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logWarn('[ComputerUse] Image generation failed', { message })
    return { status: 'error', message }
  }
}

/** Actions this module handles; anything else belongs to another executor. */
export const OS_ACTIONS: ReadonlySet<string> = new Set([
  'OPEN_APP', 'FOCUS_APP', 'FIND_FILE', 'REVEAL_IN_FINDER', 'FOCUS_INPUT',
])

/**
 * Single entry point for every accepted intent.
 *
 * Actions that are not implemented here yet (image/table generation, browser
 * control) are reported rather than silently ignored, so a spoken request never
 * appears to succeed without doing anything.
 */
export async function executeComputerIntent(
  intent: ComputerIntent,
  context: ExecutionContext = {},
): Promise<ComputerExecutionResult> {
  if (process.platform !== 'darwin') {
    return { status: 'error', message: '컴퓨터 제어는 현재 macOS에서만 지원합니다.' }
  }
  if (CONFIRMATION_REQUIRED.has(intent.action)) {
    // Irreversible actions wait for a confirmation surface that does not exist
    // yet. Refusing is the only safe outcome until it does.
    logWarn('[ComputerUse] Refused an action that needs confirmation', {
      action: intent.action, requestId: context.requestId,
    })
    return { status: 'refused', message: '이 동작은 확인 절차가 필요해 아직 실행하지 않습니다.' }
  }
  const target = intent.target?.trim() ?? ''

  switch (intent.action) {
    case 'OPEN_APP':
      return target ? openApp(target) : { status: 'error', message: '어떤 앱을 열지 알려주세요.' }
    case 'FOCUS_APP':
      return target ? focusApp(target) : { status: 'error', message: '어떤 앱으로 전환할지 알려주세요.' }
    case 'FIND_FILE':
      return findFile(target)
    case 'REVEAL_IN_FINDER':
      return target ? revealInFinder(target) : { status: 'error', message: '어떤 파일을 표시할지 알려주세요.' }
    case 'FOCUS_INPUT':
      return focusInput()

    case 'GENERATE_TABLE':
      return generateTableIntent(intent)
    case 'GENERATE_IMAGE':
      return generateImageIntent(target, context.signal)

    case 'CLICK':
    case 'TYPE':
    case 'SCREENSHOT':
      // These belong to NOVA Use's browser/screen layer. The adapter exists
      // (nova-use-bridge.ts) but is not routed yet; saying so is better than
      // reporting a success that never happened.
      return {
        status: 'error',
        message: '화면 제어는 NOVA Use 연결이 필요합니다. 아직 연결되지 않았습니다.',
      }
    default:
      return { status: 'error', message: `지원하지 않는 동작입니다: ${intent.action}` }
  }
}
