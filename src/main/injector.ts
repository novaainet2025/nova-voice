import { systemPreferences, clipboard } from 'electron'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function getFrontmostApp(): Promise<{ name: string; bundleId: string }> {
  const { stdout } = await execFile('osascript', ['-e', `
    tell application "System Events"
      set frontProcess to first application process whose frontmost is true
      set frontName to name of frontProcess
      try
        set frontBundleId to bundle identifier of frontProcess
      on error
        set frontBundleId to ""
      end try
      return frontName & linefeed & frontBundleId
    end tell
  `])
  const [name = '', bundleId = ''] = stdout.trim().split('\n')
  return { name, bundleId }
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
export async function injectText(text: string, targetApp?: string, bundleId?: string, autoEnter = false): Promise<boolean> {
  if (process.platform === 'darwin') {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      clipboard.writeText(text)
      console.warn('[Inject] Accessibility unavailable — result copied to clipboard without prompting')
      return false
    }
  }

  if (process.platform === 'darwin') {
    // ── Step 1: Save clipboard, set inject text ──────────────────────────────
    const prevClip = clipboard.readText()
    clipboard.writeText(text)
    let injected = false
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
              `tell application "System Events" to set frontmost of process "${escapeAppleScript(processName)}" to true`
            ])
          } catch { /* ignore */ }
        }

        // ── Step 3: Verify target before sending any keystroke ────────────────
        await new Promise(r => setTimeout(r, 350))
        const frontmost = await getFrontmostApp()
        const frontmostMatches = (processName && frontmost.name === processName)
          || (bundleId && frontmost.bundleId === bundleId)
        if (!frontmostMatches) {
          console.warn(`[Inject] Target mismatch — frontmost: "${frontmost.name}" / "${frontmost.bundleId}", wanted: "${processName}" / "${bundleId}"`)
          return false
        }
      }

      // ── Step 4: Paste and optionally submit ────────────────────────────────
      await execFile('osascript', ['-e', `
        tell application "System Events"
          key code 9 using {command down}
          ${autoEnter ? 'delay 0.05\n          key code 36' : ''}
        end tell
      `])
      injected = true
      console.log(`[Inject] OK → "${processName || 'frontmost'}"${autoEnter ? ' + Enter' : ''}`)
      return true
    } catch (e) {
      console.error('[Inject] Failed:', (e as Error).message)
      // text already in clipboard — user can Cmd+V manually
      console.log('[Inject] Text is in clipboard — press Cmd+V to paste manually')
      return false
    } finally {
      if (injected) {
        // Restore only after a confirmed paste. On failure, keep STT text in clipboard.
        setTimeout(() => {
          try { clipboard.writeText(prevClip) } catch { /* ignore */ }
        }, 3000)
      }
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
      return true
    } catch (e) {
      console.error('[Inject] Failed:', (e as Error).message)
      return false
    } finally {
      setTimeout(() => { try { clipboard.writeText(prevClip) } catch { /* ignore */ } }, 3000)
    }
  } else {
    // Linux: type text directly via xdotool
    try {
      await execFile('xdotool', ['type', '--clearmodifiers', text])
      if (autoEnter) await execFile('xdotool', ['key', 'Return'])
      return true
    } catch (e) {
      console.error('[Inject] Failed:', (e as Error).message)
      return false
    }
  }
}
