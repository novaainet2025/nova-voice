import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { join } from 'path'
import os from 'os'
import {
  setOverlayWindow,
  rememberFrontApp,
  latchFrontApp,
  releaseFrontAppLatch,
  startFrontAppPoller,
  stopFrontAppPoller,
} from './appState'
import { closeDB, initDB } from './db'
import {
  cancelCurrentTranscription,
  getRecordingState,
  getSettings,
  setActiveInputMode,
  setRecordingState,
  setupIPC,
} from './ipc'
import { shutdownLocalAiMetaPrompt } from './local-ai-meta-prompt'
import { getMainLogPath, logError, logInfo } from './logger'
import { registerShortcuts, unregisterAll } from './shortcuts'
import { startSttServer, stopSttServer } from './stt-server'
import { createTray, destroyTray, hideMainWindow, showMainWindow, updateTrayIcon, updateTrayMenu } from './tray'
import { abortLiveCapture, beginLiveCapture, initWhisper, warmupWhisper } from './whisper'
import type { VoiceInputMode } from '../shared/types'

app.setName('nova-voice')
app.setPath('userData', join(os.homedir(), 'Library', 'Application Support', 'nova-voice'))

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let recordingStartTime = 0
let durationTimer: ReturnType<typeof setInterval> | null = null
let recordingRequestVersion = 0
let activeRecordingMode: VoiceInputMode = 'normal'
let isQuitting = false
let launchedAtLogin = false
const isE2eVerification = process.argv.includes('--nova-voice-e2e')

function wasOpenedAtLogin(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) return false
  try {
    return app.getLoginItemSettings({ type: 'mainAppService' }).wasOpenedAtLogin
  } catch (error) {
    logError('[LoginItem] Failed to detect login launch', error)
    return false
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 680,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#080a10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // This window owns the microphone. Closing it only hides it to the menu
      // bar, and a hidden window stops requestAnimationFrame entirely (measured:
      // 120Hz → 0Hz) while timers drop to 1Hz. The capture loop that computes
      // the level, the spectrum and the end-of-speech decision lives there, so
      // throttling it silently breaks dictation whenever the window is closed.
      backgroundThrottling: false,
    },
  })

  win.on('ready-to-show', () => {
    if (launchedAtLogin) {
      hideMainWindow(win)
      logInfo('[LoginItem] Started in background at macOS login')
    } else {
      win.show()
      win.focus()
    }
  })

  win.webContents.on('console-message', (_event, _level, message) => {
    if (message.startsWith('[Recorder]')) console.log(message)
  })

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      hideMainWindow(win)
      logInfo('[Window] Hidden to menu bar; STT remains active')
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function createOverlayWindow(): BrowserWindow {
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const overlayWidth = 420
  const win = new BrowserWindow({
    width: overlayWidth,
    height: 180,
    x: Math.round((width - overlayWidth) / 2),
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
      nodeIntegration: false,
      // The overlay is hidden between dictations; its canvas has to resume at
      // full rate the moment it is shown again.
      backgroundThrottling: false,
    },
  })

  if (process.platform === 'darwin') win.setIgnoreMouseEvents(true, { forward: true })
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/overlay`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }
  return win
}

function finishRecording(cancelled = false): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  recordingRequestVersion += 1
  if (!getRecordingState()) return
  setRecordingState(false)
  if (durationTimer) {
    clearInterval(durationTimer)
    durationTimer = null
  }
  const state = {
    isRecording: false,
    duration: 0,
    inputMode: activeRecordingMode,
    ...(cancelled ? { cancelled: true } : {}),
  }
  mainWindow.webContents.send('recording:state', state)
  overlayWindow?.webContents.send('recording:state', state)
  if (cancelled) overlayWindow?.hide()
  updateTrayMenu(mainWindow, false)
  updateTrayIcon(false)
}

async function startRecording(mode?: VoiceInputMode): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || getRecordingState()) return
  const requestVersion = ++recordingRequestVersion
  // Reserve the state before foreground detection. A rapid stop can now
  // invalidate this pending start instead of being dropped while osascript is
  // still resolving the target application.
  setRecordingState(true)

  // Force past any latch left over from an earlier dictation, then latch this
  // capture's target so the 2s foreground poller cannot move it while Whisper
  // and the meta-prompt provider are still running.
  await rememberFrontApp({ force: true })
  if (
    requestVersion !== recordingRequestVersion
    || !getRecordingState()
    || !mainWindow
    || mainWindow.isDestroyed()
  ) return
  latchFrontApp()

  activeRecordingMode = mode ?? getSettings().inputMode
  setActiveInputMode(activeRecordingMode)
  recordingStartTime = Date.now()
  if (getSettings().showOverlay) overlayWindow?.showInactive()

  // Open the STT socket now so audio can stream while the user is still
  // talking; the server then finalises the segment on its own 0.7s silence
  // window instead of decoding everything after the recording stops.
  beginLiveCapture()

  const state = { isRecording: true, duration: 0, inputMode: activeRecordingMode }
  mainWindow.webContents.send('recording:state', state)
  overlayWindow?.webContents.send('recording:state', state)
  durationTimer = setInterval(() => {
    overlayWindow?.webContents.send('recording:duration', (Date.now() - recordingStartTime) / 1000)
  }, 100)
  updateTrayMenu(mainWindow, true)
  updateTrayIcon(true)
}

async function toggleRecording(mode?: VoiceInputMode): Promise<void> {
  if (getRecordingState()) finishRecording()
  else await startRecording(mode)
}

function cancelRecording(): void {
  // Runs before finishRecording, which returns early once the recording state
  // has already been cleared — a cancel that arrives after a normal stop still
  // has to drop the streamed session and free the injection target.
  abortLiveCapture()
  releaseFrontAppLatch()
  setActiveInputMode(null)
  finishRecording(true)
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) app.quit()

app.whenReady().then(async () => {
  logInfo('[Bootstrap] app.whenReady entered', { logFile: getMainLogPath() })
  electronApp.setAppUserModelId('com.novavoice.app')
  app.on('browser-window-created', (_event, window) => optimizer.watchWindowShortcuts(window))

  await rememberFrontApp()
  initDB()
  launchedAtLogin = wasOpenedAtLogin()
  mainWindow = createMainWindow()
  overlayWindow = createOverlayWindow()
  setOverlayWindow(overlayWindow)
  startFrontAppPoller()
  setupIPC(mainWindow)
  ipcMain.handle('recording:start', async (_event, mode?: unknown) => {
    if (!getRecordingState()) {
      await startRecording(mode === 'meta' || mode === 'normal' ? mode : undefined)
    }
  })
  ipcMain.handle('recording:stop', () => {
    if (getRecordingState()) finishRecording()
  })
  ipcMain.handle('recording:cancel', cancelRecording)

  createTray(mainWindow, () => void toggleRecording())
  if (isE2eVerification) {
    logInfo('[Verification] Global shortcuts disabled for isolated E2E run')
  } else {
    const { shortcut, metaShortcut } = getSettings()
    registerShortcuts(
      mainWindow,
      { shortcut, metaShortcut },
      (mode) => void toggleRecording(mode),
      () => {
        if (getRecordingState()) cancelRecording()
        else cancelCurrentTranscription()
      },
    )
  }

  void (async () => {
    const serverReady = await startSttServer()
    if (!serverReady) throw new Error('STT server did not become ready')
    await initWhisper()
    await warmupWhisper()
  })().catch((error: Error) => logError('[Bootstrap] Whisper initialization failed', error))

  app.on('activate', () => {
    if (mainWindow) showMainWindow(mainWindow)
  })
}).catch((error: Error) => {
  logError('[Bootstrap] app.whenReady failed', error)
  throw error
})

app.on('second-instance', () => {
  if (mainWindow) showMainWindow(mainWindow)
})

app.on('before-quit', () => {
  isQuitting = true
  logInfo('[Shutdown] before-quit')
})

app.on('will-quit', () => {
  if (durationTimer) {
    clearInterval(durationTimer)
    durationTimer = null
  }
  cancelCurrentTranscription()
  abortLiveCapture()
  unregisterAll()
  destroyTray()
  closeDB()
  stopSttServer()
  shutdownLocalAiMetaPrompt()
  stopFrontAppPoller()
  mainWindow = null
  overlayWindow = null
})

app.on('window-all-closed', () => {
  // Closing the window keeps Whisper available from the menu bar and hotkey.
})

process.on('uncaughtException', (error: Error) => logError('[Process] uncaughtException', error))
process.on('unhandledRejection', (reason: unknown) => logError('[Process] unhandledRejection', reason))
