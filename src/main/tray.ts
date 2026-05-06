import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron'
import path from 'path'

let tray: Tray | null = null

export function createTray(mainWindow: BrowserWindow): Tray {
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
  tray.setToolTip('NOVA-VOICE - Voice to Text')

  updateTrayMenu(mainWindow, false)

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  return tray
}

export function updateTrayMenu(mainWindow: BrowserWindow, isRecording: boolean): void {
  if (!tray) return

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'NOVA-VOICE',
      enabled: false
    },
    { type: 'separator' },
    {
      label: isRecording ? '⏹ Stop Recording' : '🎤 Start Recording',
      click: () => {
        mainWindow.webContents.send(isRecording ? 'recording:stop' : 'recording:start')
      }
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('navigate', 'settings')
      }
    },
    {
      label: 'History',
      click: () => {
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('navigate', 'history')
      }
    },
    { type: 'separator' },
    {
      label: 'Quit NOVA-VOICE',
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
    tray.setToolTip('NOVA-VOICE - Recording...')
  } else {
    tray.setToolTip('NOVA-VOICE - Voice to Text')
  }
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
