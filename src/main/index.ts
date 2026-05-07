import { app, BrowserWindow, shell, screen, dialog, systemPreferences, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createTray, updateTrayMenu, updateTrayIcon, destroyTray } from './tray'
import { registerShortcuts, unregisterAll } from './shortcuts'
import { setupIPC, getRecordingState, setRecordingState, getSettings, cancelCurrentProcessing } from './ipc'
import { initDB, closeDB } from './db'
import { initWhisper, getAvailableModels, warmupWhisper } from './whisper'
import { setOverlayWindow, rememberFrontApp, captureSelectedText, startFrontAppPoller } from './appState'
import { initPipeline } from './pipeline'
import { checkAccessibilityPermission } from './injector'
import { initPTY, createPTY, destroyPTY } from './pty'
import { join as pathJoin } from 'path'
import os from 'os'

// app.whenReady() 이전에 userData 경로 고정 (npx electron 실행 시 "Electron" 기본값 방지)
app.setName('nova-voice')
app.setPath('userData', pathJoin(os.homedir(), 'Library', 'Application Support', 'nova-voice'))

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let recordingStartTime = 0
let durationTimer: ReturnType<typeof setInterval> | null = null
let isQuitting = false

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 600,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // Forward renderer console to main process stdout
  win.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('[Recorder]') || message.startsWith('[DEBUG]') || message.startsWith('[TTS]')) {
      console.log(message)
    }
  })

  // Auto-select Command mode on startup (for testing — remove later)
  // win.webContents.executeJavaScript(`
  //   setTimeout(() => { window.electronAPI?.setSettings({ aiMode: 'command' }); }, 3000);
  // `)

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function createOverlayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const { width: screenWidth } = display.workAreaSize

  const overlayWidth = 420
  const overlayHeight = 180

  const win = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: Math.round((screenWidth - overlayWidth) / 2),
    y: 80,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.platform === 'darwin') {
    win.setIgnoreMouseEvents(true, { forward: true })
  }

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Forward overlay console to main stdout
  win.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('[Overlay]')) {
      console.log(message)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/overlay`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }

  return win
}

async function toggleRecording(): Promise<void> {
  const isRecording = getRecordingState()

  if (isRecording) {
    // === STOP RECORDING ===
    setRecordingState(false)

    // Stop duration timer
    if (durationTimer) {
      clearInterval(durationTimer)
      durationTimer = null
    }

    mainWindow?.webContents.send('recording:state', { isRecording: false, duration: 0 })
    overlayWindow?.webContents.send('recording:state', { isRecording: false, duration: 0 })
    updateTrayMenu(mainWindow!, false)
    updateTrayIcon(false)
  } else {
    // === START RECORDING ===
    await rememberFrontApp()
    // Capture currently selected text (while previous app still has focus)
    await captureSelectedText()

    setRecordingState(true)
    recordingStartTime = Date.now()

    // Show overlay without stealing focus
    const settings = getSettings()
    if (settings.showOverlay) {
      overlayWindow?.showInactive()
    }

    mainWindow?.webContents.send('recording:state', { isRecording: true, duration: 0 })
    overlayWindow?.webContents.send('recording:state', { isRecording: true, duration: 0 })

    // Send duration updates to overlay every 100ms
    durationTimer = setInterval(() => {
      const duration = (Date.now() - recordingStartTime) / 1000
      overlayWindow?.webContents.send('recording:duration', duration)
    }, 100)

    updateTrayMenu(mainWindow!, true)
    updateTrayIcon(true)
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.novavoice.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 창이 열리기 전에 현재 foreground 앱을 기억 (V2T 주입 대상)
  await rememberFrontApp()

  initDB()
  await initWhisper()
  // 백그라운드에서 Whisper 워밍업 (첫 녹음 지연 최소화)
  const _warmupModels = getAvailableModels()
  if (_warmupModels.length > 0) {
    const _priority = ['large-v3-turbo', 'large', 'medium', 'small', 'base']
    const _best = _priority.map(n => _warmupModels.find(m => m.name === n)).find(m => m)
    if (_best) warmupWhisper(_best.path).catch(() => {})
  }
  await initPipeline()  // Initialize TTS (mouth)

  mainWindow = createMainWindow()
  overlayWindow = createOverlayWindow()

  // Register overlay window in shared state
  setOverlayWindow(overlayWindow)

  // 2초마다 외부 앱 추적 시작 (V2T 주입 대상 자동 업데이트)
  startFrontAppPoller()

  // PTY 관리자 초기화 (실제 셸 세션은 TerminalPanel 마운트 시 ptyCreate IPC로 생성)
  initPTY(mainWindow)

  setupIPC(mainWindow)

  // ── Recording IPC handlers (triggered from renderer mic button) ──
  ipcMain.handle('recording:start', () => {
    if (!getRecordingState()) toggleRecording()
  })
  ipcMain.handle('recording:stop', () => {
    if (getRecordingState()) toggleRecording()
  })
  ipcMain.handle('recording:cancel', () => {
    if (getRecordingState()) {
      setRecordingState(false)
      if (durationTimer) { clearInterval(durationTimer); durationTimer = null }
      mainWindow?.webContents.send('recording:state', { isRecording: false, duration: 0 })
      overlayWindow?.webContents.send('recording:state', { isRecording: false, duration: 0 })
      updateTrayMenu(mainWindow!, false)
      updateTrayIcon(false)
    }
  })

  createTray(mainWindow)

  // Check Accessibility permission — required for text injection (Cmd+V simulation)
  if (process.platform === 'darwin') {
    const hasAccess = checkAccessibilityPermission(false)
    if (!hasAccess) {
      console.warn('[Accessibility] Permission not granted — text injection will NOT work')
      // Delay slightly so the main window is visible when the dialog appears
      setTimeout(async () => {
        const { response } = await dialog.showMessageBox(mainWindow!, {
          type: 'warning',
          title: 'Accessibility 권한 필요',
          message: 'NOVA-VOICE가 텍스트를 자동 입력하려면 Accessibility 권한이 필요합니다.',
          detail:
            '시스템 설정 > 개인 정보 보호 및 보안 > 손쉬운 사용에서\n' +
            'NOVA-VOICE (또는 Electron)를 목록에 추가하고 활성화해주세요.\n\n' +
            '권한을 부여한 후 앱을 재시작하세요.',
          buttons: ['시스템 설정 열기', '나중에'],
          defaultId: 0,
        })
        if (response === 0) {
          shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
          )
          // Also trigger the system permission prompt
          checkAccessibilityPermission(true)
        }
      }, 1500)
    } else {
      console.log('[Accessibility] Permission granted ✓')
    }

    // Check Screen Recording permission — required for screenshot features
    const screenStatus = systemPreferences.getMediaAccessStatus('screen')
    if (screenStatus !== 'granted') {
      console.warn('[Screen Recording] Permission not granted — screenshots may not capture all windows')
      setTimeout(async () => {
        const { response } = await dialog.showMessageBox(mainWindow!, {
          type: 'info',
          title: '화면 녹화 권한 (선택사항)',
          message: 'NOVA-VOICE의 스크린샷 기능을 완전히 사용하려면 화면 녹화 권한이 필요합니다.',
          detail:
            '시스템 설정 > 개인 정보 보호 및 보안 > 화면 녹화에서\n' +
            'NOVA-VOICE (또는 Electron)를 활성화해주세요.\n\n' +
            '이 권한 없이도 기본 기능은 모두 사용 가능합니다.',
          buttons: ['시스템 설정 열기', '건너뛰기'],
          defaultId: 1,
        })
        if (response === 0) {
          shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
          )
        }
      }, 3000) // Show after accessibility dialog
    } else {
      console.log('[Screen Recording] Permission granted ✓')
    }

    // Microphone permission — required for voice recording
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus !== 'granted') {
      console.warn('[Microphone] Permission not granted')
      systemPreferences.askForMediaAccess('microphone').then(granted => {
        console.log('[Microphone] Permission:', granted ? 'granted ✓' : 'denied ✗')
      }).catch((e: Error) => console.warn('[Microphone] Permission request failed:', e.message))
    } else {
      console.log('[Microphone] Permission granted ✓')
    }
  }

  const settings = getSettings()
  registerShortcuts(mainWindow, settings.shortcut, toggleRecording, cancelCurrentProcessing)

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  unregisterAll()
  destroyTray()
  closeDB()
  destroyPTY()
})

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.on('window-all-closed', () => {
  // Keep app running in tray
})
