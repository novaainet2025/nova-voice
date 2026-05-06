import { systemPreferences, clipboard } from 'electron'
import { execFile as execFileCb, spawn } from 'child_process'
import { promisify } from 'util'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const execFile = promisify(execFileCb)

const DEBUG_LOG = join(tmpdir(), 'nova-inject-debug.log')
function dlog(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`
  try { appendFileSync(DEBUG_LOG, line) } catch { /* ignore */ }
  console.log(msg)
}

export function checkAccessibilityPermission(prompt = false): boolean {
  if (process.platform !== 'darwin') return true
  return systemPreferences.isTrustedAccessibilityClient(prompt)
}

// Inject text into the target app's focused text field.
//
// macOS 3-step approach (proven reliable):
//   1. Set clipboard via Electron's clipboard API (synchronous, no shell)
//   2. Activate target app: `open -b bundleId` (NSWorkspace) + Accessibility `set frontmost`
//   3. Send Cmd+V via separate osascript (after activation is confirmed)
//
// Key insight: keep clipboard set, activation, and keystroke as separate async steps
// so each can succeed independently without timing conflicts.
export async function injectText(text: string, targetApp?: string, bundleId?: string, autoEnter = false): Promise<void> {
  if (process.platform === 'darwin') {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      console.error('[Inject] BLOCKED — no Accessibility permission')
      systemPreferences.isTrustedAccessibilityClient(true)
      return
    }
  }

  if (process.platform === 'darwin') {
    // ── Step 1: Save clipboard, set inject text ──────────────────────────────
    const prevClip = clipboard.readText()
    clipboard.writeText(text)
    console.log(`[Inject] Clipboard set (${text.length} chars), target: "${targetApp || 'frontmost'}" bundle: "${bundleId || 'n/a'}"`)

    try {
      const processName = targetApp || ''

      if (processName || bundleId) {
        // ── Step 2: Activate target app ───────────────────────────────────────
        // Use BOTH methods for maximum reliability:
        //   a) open -b (NSWorkspace, async, no Automation permission)
        //   b) set frontmost (Accessibility, synchronous)
        if (bundleId) {
          try {
            await execFile('open', ['-b', bundleId])
          } catch { /* ignore if already open */ }
        }
        if (processName) {
          try {
            await execFile('osascript', ['-e',
              `tell application "System Events" to set frontmost of process "${processName}" to true`
            ])
          } catch { /* ignore */ }
        }

        // ── Step 3: Wait for app to settle + send paste ───────────────────────
        await new Promise(r => setTimeout(r, 400))

        // Verify clipboard content right before paste
        const clipCheck = await execFile('pbpaste').catch(() => ({ stdout: '' }))
        const clipPreview = clipCheck.stdout.substring(0, 30)
        console.log(`[Inject] Clipboard before paste: "${clipPreview}${clipCheck.stdout.length > 30 ? '...' : ''}" (${clipCheck.stdout.length} chars)`)

        const result = await execFile('osascript', ['-e', `
          tell application "System Events"
            set frontName to name of first application process whose frontmost is true
            key code 9 using {command down}
            ${autoEnter ? 'key code 36' : ''}
          end tell
          return frontName
        `])
        const actualTarget = result.stdout.trim()
        console.log(`[Inject] Keystroke sent → frontmost: "${actualTarget}" (wanted: "${processName || bundleId}")${autoEnter ? ' + Enter' : ''}`)

      } else {
        // ── No target: paste to current frontmost ─────────────────────────────
        await new Promise(r => setTimeout(r, 100))
        const result = await execFile('osascript', ['-e', `
          tell application "System Events"
            set frontName to name of first application process whose frontmost is true
            keystroke "v" using command down
            ${autoEnter ? 'key code 36' : ''}
          end tell
          return frontName
        `])
        console.log(`[Inject] OK → frontmost: "${result.stdout.trim()}"${autoEnter ? ' + Enter' : ''}`)
      }

    } catch (e) {
      console.error('[Inject] Failed:', (e as Error).message)
      // text already in clipboard — user can Cmd+V manually
      console.log('[Inject] Text is in clipboard — press Cmd+V to paste manually')
    } finally {
      // Restore original clipboard after 3s
      setTimeout(() => {
        try { clipboard.writeText(prevClip) } catch { /* ignore */ }
      }, 3000)
    }

  } else if (process.platform === 'win32') {
    const prevClip = clipboard.readText()
    clipboard.writeText(text)
    try {
      const sendKeys = autoEnter ? '^v{ENTER}' : '^v'
      await execFile('powershell', [
        '-Command',
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${sendKeys}")`
      ])
    } finally {
      setTimeout(() => { try { clipboard.writeText(prevClip) } catch { /* ignore */ } }, 3000)
    }
  } else {
    // Linux: type text directly via xdotool
    await execFile('xdotool', ['type', '--clearmodifiers', text])
    if (autoEnter) await execFile('xdotool', ['key', 'Return'])
  }
}
