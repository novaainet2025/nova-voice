/**
 * Reads what the user is looking at when they speak.
 *
 * Spoken commands lean on the situation: "이거 열어줘" only means something if
 * you know what is selected, and "저장해" depends on which app is in front.
 * Without this the classifier saw the sentence alone and had to guess, which is
 * how "너 이름이 뭐야" once became FOCUS_INPUT.
 *
 * Everything here is read-only and best-effort. A context probe that fails or
 * takes too long yields an empty field rather than delaying the utterance —
 * classification sits in front of dictation and cannot wait on AppleScript.
 */
import { execFile as execFileCallback } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { logWarn } from './logger.ts'

const execFile = promisify(execFileCallback)

/** AppleScript against an unresponsive app can hang; this bounds the wait. */
const PROBE_TIMEOUT_MS = 1_500
const MAX_TITLE_LENGTH = 120
const MAX_SELECTION_ITEMS = 5

export interface ScreenContext {
  /** Frontmost application's display name. */
  appName?: string
  bundleId?: string
  /** Front window title — often the document or page the user means. */
  windowTitle?: string
  /** Files selected in Finder, when Finder is what they are looking at. */
  selection?: string[]
}

function clean(value: string, maxLength = MAX_TITLE_LENGTH): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

/**
 * Reads the frontmost app and its window title in one AppleScript call.
 *
 * One call rather than three: each `osascript` spawn costs ~80ms, and this runs
 * before every computer-control utterance.
 */
async function readFrontmost(): Promise<Pick<ScreenContext, 'appName' | 'bundleId' | 'windowTitle'>> {
  try {
    const { stdout } = await execFile('osascript', ['-e', `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        try
          set bundleId to bundle identifier of frontApp
          if bundleId is missing value then set bundleId to ""
        on error
          set bundleId to ""
        end try
        try
          set windowTitle to name of front window of frontApp
        on error
          set windowTitle to ""
        end try
        return appName & "\\n" & bundleId & "\\n" & windowTitle
      end tell
    `], { timeout: PROBE_TIMEOUT_MS })

    const [appName = '', bundleId = '', windowTitle = ''] = stdout.split('\n')
    return {
      ...(appName.trim() ? { appName: clean(appName) } : {}),
      ...(bundleId.trim() ? { bundleId: clean(bundleId) } : {}),
      ...(windowTitle.trim() ? { windowTitle: clean(windowTitle) } : {}),
    }
  } catch (error) {
    logWarn('[ScreenContext] Could not read the frontmost app', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}

/**
 * Files currently selected in Finder.
 *
 * Only queried when Finder is frontmost: asking otherwise would activate it,
 * and a selection the user cannot see is not the context they meant.
 */
async function readFinderSelection(): Promise<string[]> {
  try {
    const { stdout } = await execFile('osascript', ['-e', `
      tell application "Finder"
        set out to ""
        repeat with item_ in (selection as list)
          set out to out & (POSIX path of (item_ as alias)) & "\\n"
        end repeat
        return out
      end tell
    `], { timeout: PROBE_TIMEOUT_MS })
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_SELECTION_ITEMS)
  } catch {
    // Finder may be busy or scripting may be denied; no selection is a valid
    // answer either way.
    return []
  }
}

/**
 * Collects the situation around one utterance.
 *
 * Never throws and never blocks longer than {@link PROBE_TIMEOUT_MS}: a missing
 * field degrades the classifier's judgement, but a slow probe would delay every
 * spoken command.
 */
export async function readScreenContext(): Promise<ScreenContext> {
  if (process.platform !== 'darwin') return {}

  const frontmost = await readFrontmost()
  const isFinder = frontmost.bundleId === 'com.apple.finder'
  const selection = isFinder ? await readFinderSelection() : []

  return {
    ...frontmost,
    ...(selection.length ? { selection } : {}),
  }
}

/**
 * Renders the context as the few lines a model can actually use.
 *
 * Paths are reduced to file names: the classifier needs to know *what* is
 * selected, and full paths would spend context on directories it never reasons
 * about while leaking more of the filesystem into the prompt than necessary.
 */
export function describeScreenContext(context: ScreenContext): string {
  const lines: string[] = []
  if (context.appName) {
    lines.push(`지금 앞에 있는 앱: ${context.appName}`)
  }
  if (context.windowTitle) {
    lines.push(`현재 창 제목: ${context.windowTitle}`)
  }
  if (context.selection?.length) {
    const names = context.selection.map((item) => path.basename(item))
    lines.push(`Finder에서 선택된 항목: ${names.join(', ')}`)
  }
  if (!lines.length) return ''
  return [
    '[현재 상황]',
    ...lines,
    '지시어("이거", "여기", "이 파일")는 위 상황을 가리킨다. 상황과 발화가 맞지 않으면 NONE으로 답한다.',
  ].join('\n')
}
