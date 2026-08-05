import { globalShortcut, BrowserWindow } from 'electron'
import { logError, logInfo, logWarn } from './logger'
import type { VoiceInputMode } from '../shared/types'

export interface ShortcutBindings {
  /** Plain dictation: the transcript is injected as-is. */
  shortcut: string
  /** Meta prompt: the same capture is answered by an AI provider. */
  metaShortcut: string
}

let registeredShortcuts: string[] = []
let lastMainWindow: BrowserWindow | null = null
let lastOnToggleRecording: ((mode: VoiceInputMode) => void) | null = null
let lastOnCancel: (() => void) | undefined
let lastBindings: ShortcutBindings | null = null

function registerToggle(accelerator: string, mode: VoiceInputMode, onToggle: (mode: VoiceInputMode) => void): boolean {
  if (!accelerator.trim()) {
    logInfo('[Shortcuts] Hotkey disabled', { mode })
    return false
  }
  try {
    const success = globalShortcut.register(accelerator, () => onToggle(mode))
    if (success) {
      registeredShortcuts.push(accelerator)
      // Written to the log file, not just stdout: a packaged build has nowhere
      // to print, and a hotkey another app already owns fails silently.
      logInfo('[Shortcuts] Global hotkey registered', { accelerator, mode })
      return true
    }
    logError('[Shortcuts] Global hotkey rejected by the system', { accelerator, mode })
    return false
  } catch (error) {
    logError('[Shortcuts] Global hotkey registration threw', { accelerator, mode, error })
    return false
  }
}

export function registerShortcuts(
  mainWindow: BrowserWindow,
  bindings: ShortcutBindings,
  onToggleRecording: (mode: VoiceInputMode) => void,
  onCancel?: () => void
): void {
  lastMainWindow = mainWindow
  lastOnToggleRecording = onToggleRecording
  lastOnCancel = onCancel
  unregisterAll()

  // Ctrl+Shift+Space dictates. Ctrl+Shift+Alt+Space records the same way but
  // routes that one utterance through the meta-prompt AI, so the saved default
  // mode never has to be toggled in the UI first.
  registerToggle(bindings.shortcut, 'normal', onToggleRecording)
  if (bindings.metaShortcut && bindings.metaShortcut !== bindings.shortcut) {
    registerToggle(bindings.metaShortcut, 'meta', onToggleRecording)
  }
  lastBindings = { ...bindings }

  // Cancel shortcut: Ctrl+Escape — 처리 중 작업 취소 (글로벌, 다른 앱 포커스 중에도 동작)
  // macOS에서 Ctrl+Shift+Escape는 일부 환경에서 캡처 실패
  // Ctrl+Escape로 변경 (더 신뢰성 높음)
  // 앱 포커스 시 ESC 단독 취소는 렌더러(keydown 이벤트)에서 처리
  if (onCancel) {
    // 두 가지 단축키 모두 등록 시도 (여러 환경 대응)
    const cancelKeys = ['Ctrl+Escape', 'Ctrl+Shift+Escape']
    for (const cancelShortcut of cancelKeys) {
      try {
        const ok = globalShortcut.register(cancelShortcut, () => {
          logInfo('[Shortcuts] Cancel hotkey pressed', { accelerator: cancelShortcut })
          onCancel()
        })
        if (ok) {
          registeredShortcuts.push(cancelShortcut)
          logInfo('[Shortcuts] Cancel hotkey registered', { accelerator: cancelShortcut })
        } else {
          logWarn('[Shortcuts] Cancel hotkey unavailable — another app may own it', { accelerator: cancelShortcut })
        }
      } catch (error) {
        logError('[Shortcuts] Cancel hotkey registration threw', { accelerator: cancelShortcut, error })
      }
    }
  }
}

export function reregisterShortcuts(bindings: ShortcutBindings): boolean {
  if (!lastMainWindow || !lastOnToggleRecording) {
    return false
  }

  const previousBindings = lastBindings
  registerShortcuts(lastMainWindow, bindings, lastOnToggleRecording, lastOnCancel)
  const applied = isShortcutRegistered(bindings.shortcut)
    && (!bindings.metaShortcut
      || bindings.metaShortcut === bindings.shortcut
      || isShortcutRegistered(bindings.metaShortcut))
  if (applied) return true

  if (previousBindings) {
    logWarn('[Shortcuts] Re-register failed; restoring previous bindings', { bindings, previousBindings })
    registerShortcuts(lastMainWindow, previousBindings, lastOnToggleRecording, lastOnCancel)
  }
  return false
}

export function unregisterAll(): void {
  for (const shortcut of registeredShortcuts) {
    try {
      globalShortcut.unregister(shortcut)
    } catch {
      // Ignore errors during cleanup
    }
  }
  registeredShortcuts = []
}

export function isShortcutRegistered(shortcut: string): boolean {
  return globalShortcut.isRegistered(shortcut)
}
