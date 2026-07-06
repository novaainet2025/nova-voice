import { BrowserWindow, clipboard } from 'electron'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

// Shared mutable state to avoid circular imports between index.ts and ipc.ts
let overlayWindow: BrowserWindow | null = null
let previousAppName = ''
let previousBundleId = ''

// Selected text captured at hotkey press time (before focus shifts away)
let capturedSelectedText = ''

export function getCapturedSelectedText(): string {
  return capturedSelectedText
}

// Called right after rememberFrontApp() — while previous app still has focus.
// Sends Cmd+C directly to the specific previous app process (not frontmost),
// so it works even after Electron may have taken focus.
export async function captureSelectedText(): Promise<void> {
  capturedSelectedText = ''
  let prevClip = ''
  if (process.platform !== 'darwin') {
    capturedSelectedText = clipboard.readText()
    return
  }
  if (!previousAppName) {
    console.log('[Selection] No previous app name — skipping capture')
    return
  }
  try {
    prevClip = clipboard.readText()
    // Clear clipboard so we can detect if Cmd+C actually copied something
    clipboard.writeText('')
    // Send Cmd+C directly to the named process (works even if not frontmost)
    await execFile('osascript', ['-e', `
      tell application "System Events"
        tell process "${previousAppName}"
          keystroke "c" using command down
        end tell
      end tell
    `])
    // Wait for clipboard to update
    await new Promise(r => setTimeout(r, 250))
    const selected = clipboard.readText()
    if (selected && selected.trim()) {
      capturedSelectedText = selected
      console.log(`[Selection] Captured from "${previousAppName}": "${selected.substring(0, 80)}${selected.length > 80 ? '...' : ''}"`)
    } else {
      // Nothing selected — restore previous clipboard content
      clipboard.writeText(prevClip)
      console.log(`[Selection] No text selected in "${previousAppName}"`)
    }
  } catch (e) {
    try { clipboard.writeText(prevClip) } catch { /* ignore */ }
    console.error('[Selection] Capture failed:', (e as Error).message)
  }
}

// ── 2초마다 외부 앱 추적 (NOVA-VOICE가 foreground가 아닐 때만 업데이트) ──
// 이를 통해 마이크 버튼 클릭 전에 어느 앱에 있었는지 항상 알 수 있음
let _pollerTimer: ReturnType<typeof setInterval> | null = null

export function startFrontAppPoller(): void {
  if (_pollerTimer) return
  _pollerTimer = setInterval(() => {
    // 동기 없이 fire-and-forget — 실패해도 무시
    rememberFrontApp().catch(() => {})
  }, 2000)
}

export function stopFrontAppPoller(): void {
  if (_pollerTimer) {
    clearInterval(_pollerTimer)
    _pollerTimer = null
  }
}

export function setOverlayWindow(win: BrowserWindow): void {
  overlayWindow = win
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow
}

export function hideOverlay(): void {
  overlayWindow?.hide()
}

// Remember which app was in front before we start recording.
// Records both process name (for captureSelectedText) and bundle ID (for restoreFrontApp).
export async function rememberFrontApp(): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFile('osascript', ['-e', `
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          set pName to name of frontApp
          try
            set bID to bundle identifier of frontApp
            if bID is missing value then set bID to ""
          on error
            set bID to ""
          end try
          return pName & "|" & bID
        end tell
      `])
      const parts = stdout.trim().split('|')
      const procName = parts[0]?.trim() ?? ''
      const bundleId = parts[1]?.trim() ?? ''
      // Filter out our own app in both dev (Electron) and prod (nova-voice, NOVA-VOICE)
      const ownNames = ['electron', 'voicetype', 'nova-voice', 'novavoice']
      if (procName && !ownNames.includes(procName.toLowerCase())) {
        previousAppName = procName
        previousBundleId = bundleId
        console.log(`Remembered front app: "${previousAppName}" (bundle: "${previousBundleId}")`)
      }
    } catch {
      // ignore
    }
  }
}

export function getPreviousAppName(): string {
  return previousAppName
}

export function getPreviousBundleId(): string {
  return previousBundleId
}

// Activate the previous app using `open -b <bundleId>` (or `open -a <name>` fallback).
// This does NOT require macOS Automation permission — it goes through NSWorkspace,
// the same mechanism as clicking the app in the Dock — and properly restores
// keyboard/cursor focus in text fields.
export async function restoreFrontApp(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (!previousAppName && !previousBundleId) return

  console.log(`Restoring front app: "${previousAppName}" (bundle: "${previousBundleId}")`)

  try {
    if (previousBundleId) {
      // open -b uses bundle ID — most reliable, works regardless of display name
      await execFile('open', ['-b', previousBundleId])
    } else {
      // Fallback: open by process name (may not work for all apps)
      await execFile('open', ['-a', previousAppName])
    }
    // Give the app time to come to foreground and restore text-cursor focus
    await new Promise(resolve => setTimeout(resolve, 500))
  } catch (e) {
    console.error('[Restore] open failed:', (e as Error).message)
    // Last-resort fallback: AppleScript activate (requires Automation permission,
    // but worth trying in case open -b/-a didn't work)
    try {
      await execFile('osascript', ['-e', `tell application "${previousAppName}" to activate`])
      await new Promise(resolve => setTimeout(resolve, 500))
    } catch {
      // Nothing more we can do
    }
  }
}
