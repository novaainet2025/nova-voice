import { globalShortcut, BrowserWindow } from 'electron'

let registeredShortcuts: string[] = []
let lastMainWindow: BrowserWindow | null = null
let lastOnToggleRecording: (() => void) | null = null
let lastOnCancelProcessing: (() => void) | undefined

export function registerShortcuts(
  mainWindow: BrowserWindow,
  shortcut: string,
  onToggleRecording: () => void,
  onCancelProcessing?: () => void
): void {
  lastMainWindow = mainWindow
  lastOnToggleRecording = onToggleRecording
  lastOnCancelProcessing = onCancelProcessing
  unregisterAll()

  // Recording toggle shortcut (e.g. Ctrl+Shift+Space)
  try {
    const success = globalShortcut.register(shortcut, () => {
      onToggleRecording()
    })
    if (success) {
      registeredShortcuts.push(shortcut)
      console.log(`Global shortcut registered: ${shortcut}`)
    } else {
      console.error(`Failed to register shortcut: ${shortcut}`)
    }
  } catch (error) {
    console.error(`Error registering shortcut ${shortcut}:`, error)
  }

  // Cancel shortcut: Ctrl+Escape — 처리 중 작업 취소 (글로벌, 다른 앱 포커스 중에도 동작)
  // macOS에서 Ctrl+Shift+Escape는 일부 환경에서 캡처 실패
  // Ctrl+Escape로 변경 (더 신뢰성 높음)
  // 앱 포커스 시 ESC 단독 취소는 렌더러(keydown 이벤트)에서 처리
  if (onCancelProcessing) {
    // 두 가지 단축키 모두 등록 시도 (여러 환경 대응)
    const cancelKeys = ['Ctrl+Escape', 'Ctrl+Shift+Escape']
    for (const cancelShortcut of cancelKeys) {
      try {
        const ok = globalShortcut.register(cancelShortcut, () => {
          console.log(`[Cancel] ★ 단축키 감지: ${cancelShortcut}`)  // 진단 로그
          onCancelProcessing()
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('ai:cancelled')
          }
        })
        if (ok) {
          registeredShortcuts.push(cancelShortcut)
          console.log(`Cancel shortcut registered: ${cancelShortcut} (global)`)
        } else {
          console.warn(`Cancel shortcut FAILED to register: ${cancelShortcut} (다른 앱이 점유 중일 수 있음)`)
        }
      } catch (error) {
        console.error(`Error registering cancel shortcut ${cancelShortcut}:`, error)
      }
    }
  }
}

export function reregisterShortcuts(shortcut: string): boolean {
  if (!lastMainWindow || !lastOnToggleRecording) {
    return false
  }
  registerShortcuts(lastMainWindow, shortcut, lastOnToggleRecording, lastOnCancelProcessing)
  return isShortcutRegistered(shortcut)
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
