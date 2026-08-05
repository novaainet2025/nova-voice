import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron'
import path from 'path'

let tray: Tray | null = null
let toggleRecordingHandler: (() => void) | null = null

export function hideMainWindow(mainWindow: BrowserWindow): void {
  mainWindow.hide()
  if (process.platform === 'darwin') app.dock.hide()
}

export function showMainWindow(mainWindow: BrowserWindow): void {
  if (process.platform === 'darwin') void app.dock.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

export function createTray(mainWindow: BrowserWindow, onToggleRecording: () => void): Tray {
  toggleRecordingHandler = onToggleRecording
  // Create a simple tray icon - use a template image on macOS for dark/light mode support
  const iconPath = path.join(__dirname, '../../resources/tray-icon.png')
  let icon: ReturnType<typeof nativeImage.createFromPath>

  try {
    icon = nativeImage.createFromPath(iconPath)
    if (process.platform === 'darwin') {
      icon = icon.resize({ width: 18, height: 18 })
      icon.setTemplateImage(true)
    }
  } catch {
    // Create a simple colored icon as fallback
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('NOVA VOICE · Whisper 받아쓰기')

  updateTrayMenu(mainWindow, false)

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      hideMainWindow(mainWindow)
    } else {
      showMainWindow(mainWindow)
    }
  })

  return tray
}

export function updateTrayMenu(mainWindow: BrowserWindow, isRecording: boolean): void {
  if (!tray) return

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'NOVA VOICE',
      enabled: false
    },
    { type: 'separator' },
    {
      label: isRecording ? '녹음 중지' : '녹음 시작',
      click: () => {
        toggleRecordingHandler?.()
      }
    },
    { type: 'separator' },
    {
      label: '설정 열기',
      click: () => {
        showMainWindow(mainWindow)
        mainWindow.webContents.send('view:navigate', 'settings')
      }
    },
    {
      label: '기록 열기',
      click: () => {
        showMainWindow(mainWindow)
        mainWindow.webContents.send('view:navigate', 'history')
      }
    },
    { type: 'separator' },
    {
      label: 'NOVA VOICE 종료',
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
}

export function updateTrayIcon(recording: boolean): void {
  if (!tray) return

  if (recording) {
    tray.setToolTip('NOVA VOICE · 녹음 중')
  } else {
    tray.setToolTip('NOVA VOICE · Whisper 받아쓰기')
  }
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
    toggleRecordingHandler = null
  }
}
