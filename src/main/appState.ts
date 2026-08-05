import { BrowserWindow } from 'electron'
import { execFile as execFileCallback } from 'child_process'
import { promisify } from 'util'
import { shouldRememberFrontApp } from './front-app-policy'

const execFile = promisify(execFileCallback)

// A dictation can take seconds (Whisper, then a meta-prompt provider). The
// injection target has to be the app that was focused when the user started
// talking, so the background poller must not move it in the meantime.
const LATCH_MAX_MS = 120_000

let overlayWindow: BrowserWindow | null = null
let previousAppName = ''
let previousBundleId = ''
let pollerTimer: ReturnType<typeof setInterval> | null = null
let latchedAt = 0

export function startFrontAppPoller(): void {
  if (pollerTimer) return
  pollerTimer = setInterval(() => void rememberFrontApp().catch(() => undefined), 2000)
}

export function stopFrontAppPoller(): void {
  if (!pollerTimer) return
  clearInterval(pollerTimer)
  pollerTimer = null
}

export function setOverlayWindow(window: BrowserWindow): void {
  overlayWindow = window
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null
}

export function hideOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
}

/**
 * Freezes the injection target for the rest of the current dictation. Cleared
 * by {@link releaseFrontAppLatch} once injection settles, and forced open again
 * by the next `rememberFrontApp({ force: true })` so a missed release can never
 * strand the target on a stale app.
 */
export function latchFrontApp(): void {
  latchedAt = Date.now()
}

export function releaseFrontAppLatch(): void {
  latchedAt = 0
}

export function isFrontAppLatched(): boolean {
  return latchedAt > 0 && Date.now() - latchedAt < LATCH_MAX_MS
}

export async function rememberFrontApp(options: { force?: boolean } = {}): Promise<void> {
  if (process.platform !== 'darwin') return
  if (!options.force && isFrontAppLatched()) return
  try {
    const { stdout } = await execFile('osascript', ['-e', `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set processName to name of frontApp
        try
          set bundleId to bundle identifier of frontApp
          if bundleId is missing value then set bundleId to ""
        on error
          set bundleId to ""
        end try
        return processName & "|" & bundleId
      end tell
    `])
    const [processName = '', bundleId = ''] = stdout.trim().split('|')
    if (shouldRememberFrontApp(processName, bundleId)) {
      previousAppName = processName.trim()
      previousBundleId = bundleId.trim()
    }
  } catch {
    // The last known target remains usable when foreground detection is unavailable.
  }
}

export function getPreviousAppName(): string {
  return previousAppName
}

export function getPreviousBundleId(): string {
  return previousBundleId
}
