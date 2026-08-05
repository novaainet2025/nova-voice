import { app, BrowserWindow, ipcMain } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getHistory, searchHistory, deleteTranscription, saveTranscription } from './db'
import { injectText } from './injector'
import { isCliTarget, routeVoicePrompt } from './cli-command-router'
import { findLearnedCommand, getAppUsageHint, normalizePhrase, observeDictation } from './pattern-learning'
import { getMetaCommandCandidates, getMetaToolCandidates } from './command-catalog'
import { getNcoMetaPromptStatus, reconnectNcoProvider, rewriteMetaPrompt } from './nco-meta-prompt'
import { logError, logInfo, logWarn } from './logger'
import { normalizeTranscript } from './transcript-normalizer'
import {
  getOverlayWindow,
  getPreviousAppName,
  getPreviousBundleId,
  hideOverlay,
  releaseFrontAppLatch,
} from './appState'
import { reregisterShortcuts } from './shortcuts'
import { isSttServerRunning } from './stt-server'
import { abortLiveCapture, finishLiveCapture, pushLiveAudio, transcribePcm } from './whisper'
import { DEFAULT_SETTINGS, SILENCE_TIMEOUT_OPTIONS, STT_ENGINE_NAME } from '../shared/types'
import type { AppSettings, SttStatus, TranscriptionResult, VoiceInputMode } from '../shared/types'

let settings: AppSettings = { ...DEFAULT_SETTINGS }
let isRecording = false
let transcriptionController: AbortController | null = null
let settingsPath: string | null = null
let verificationPcmDelayMs = 0
let activeInputMode: VoiceInputMode | null = null
let lastAudioChunkAt = 0

/**
 * When the last streamed PCM chunk arrived. The recording watchdog uses this to
 * tell a working capture apart from one where the renderer never obtained the
 * microphone — in that state the app looks like it is recording but no audio is
 * flowing and nothing will ever complete.
 */
export function getLastAudioChunkAt(): number {
  return lastAudioChunkAt
}

type LoginItemStatus = {
  supported: boolean
  openAtLogin: boolean
  status: string
}

function getSettingsPath(): string {
  if (!settingsPath) settingsPath = path.join(app.getPath('userData'), 'nova-settings.json')
  return settingsPath
}

function sanitizeSettings(value: unknown): AppSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const silenceTimeoutMs = Number(raw.silenceTimeoutMs)
  const shortcut = typeof raw.shortcut === 'string' && raw.shortcut.trim()
    ? raw.shortcut.trim()
    : DEFAULT_SETTINGS.shortcut
  const hasMetaShortcut = typeof raw.metaShortcut === 'string'
  const rawMetaShortcut = hasMetaShortcut ? (raw.metaShortcut as string).trim() : ''
  const defaultMetaShortcut = DEFAULT_SETTINGS.metaShortcut === shortcut ? '' : DEFAULT_SETTINGS.metaShortcut
  return {
    shortcut,
    // An empty value deliberately disables the meta hotkey. A value identical to
    // the dictation hotkey would silently shadow it, so it disables too rather
    // than registering an ambiguous accelerator.
    metaShortcut: hasMetaShortcut
      ? (rawMetaShortcut === shortcut ? '' : rawMetaShortcut)
      : defaultMetaShortcut,
    autoInject: typeof raw.autoInject === 'boolean' ? raw.autoInject : DEFAULT_SETTINGS.autoInject,
    submitAfterInject: typeof raw.submitAfterInject === 'boolean'
      ? raw.submitAfterInject
      : DEFAULT_SETTINGS.submitAfterInject,
    showOverlay: typeof raw.showOverlay === 'boolean' ? raw.showOverlay : DEFAULT_SETTINGS.showOverlay,
    launchAtLogin: typeof raw.launchAtLogin === 'boolean' ? raw.launchAtLogin : DEFAULT_SETTINGS.launchAtLogin,
    silenceTimeoutMs: (SILENCE_TIMEOUT_OPTIONS as readonly number[]).includes(silenceTimeoutMs)
      ? silenceTimeoutMs
      : DEFAULT_SETTINGS.silenceTimeoutMs,
    inputMode: raw.inputMode === 'meta' ? 'meta' : DEFAULT_SETTINGS.inputMode,
    ncoEnabled: typeof raw.ncoEnabled === 'boolean' ? raw.ncoEnabled : DEFAULT_SETTINGS.ncoEnabled,
    ncoProvider: typeof raw.ncoProvider === 'string' && /^(?:auto|[a-z0-9][a-z0-9-]{0,63})$/.test(raw.ncoProvider)
      ? raw.ncoProvider
      : DEFAULT_SETTINGS.ncoProvider,
  }
}

function loadSettingsFromDisk(): AppSettings {
  try {
    return sanitizeSettings(JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettingsToDisk(value: AppSettings): void {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(value, null, 2), 'utf8')
  } catch (error) {
    console.error('[Settings] Failed to save:', error)
  }
}

function resolveMetaProjectDir(): string {
  const candidates = [
    path.join(app.getPath('home'), 'project', 'nova-voice'),
    app.getAppPath(),
    process.resourcesPath,
  ]
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json')))
    ?? app.getAppPath()
}

function getLoginItemStatus(): LoginItemStatus {
  if (process.platform !== 'darwin') {
    return { supported: false, openAtLogin: false, status: 'unsupported' }
  }
  if (!app.isPackaged) {
    return { supported: false, openAtLogin: settings.launchAtLogin, status: 'development' }
  }
  try {
    const state = app.getLoginItemSettings({ type: 'mainAppService' })
    return {
      supported: true,
      openAtLogin: state.openAtLogin,
      status: state.status || (state.openAtLogin ? 'enabled' : 'not-registered'),
    }
  } catch (error) {
    console.error('[LoginItem] Failed to read status:', error)
    return { supported: true, openAtLogin: false, status: 'error' }
  }
}

function applyLaunchAtLogin(enabled: boolean): LoginItemStatus {
  if (process.platform === 'darwin' && app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, type: 'mainAppService' })
    } catch (error) {
      console.error('[LoginItem] Failed to update:', error)
    }
  }
  return getLoginItemStatus()
}

function sendToWindows(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, value)
  }
}

function toBuffer(value: ArrayBuffer | ArrayBufferView): Buffer {
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  return Buffer.from(value)
}

export function cancelCurrentTranscription(): void {
  transcriptionController?.abort()
  transcriptionController = null
  abortLiveCapture()
  releaseFrontAppLatch()
  sendToWindows('transcription:progress', 0)
  sendToWindows('transcription:stage', 'idle')
  hideOverlay()
}

/**
 * Records which mode the in-flight capture was started in. A meta hotkey press
 * must apply to that one utterance without rewriting the saved default mode.
 */
export function setActiveInputMode(mode: VoiceInputMode | null): void {
  activeInputMode = mode
}

export function getActiveInputMode(): VoiceInputMode {
  return activeInputMode ?? settings.inputMode
}

export function setupIPC(mainWindow: BrowserWindow): void {
  settings = loadSettingsFromDisk()
  saveSettingsToDisk(settings)
  applyLaunchAtLogin(settings.launchAtLogin)

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_event, patch: Partial<AppSettings>) => {
    const previousShortcut = settings.shortcut
    const previousMetaShortcut = settings.metaShortcut
    const previousInputMode = settings.inputMode
    settings = sanitizeSettings({ ...settings, ...patch })
    const shortcutChanged = settings.shortcut !== previousShortcut
      || settings.metaShortcut !== previousMetaShortcut
    if (shortcutChanged && !reregisterShortcuts({
      shortcut: settings.shortcut,
      metaShortcut: settings.metaShortcut,
    })) {
      const rejected = patch.metaShortcut && settings.metaShortcut !== previousMetaShortcut
        ? patch.metaShortcut
        : patch.shortcut
      settings.shortcut = previousShortcut
      settings.metaShortcut = previousMetaShortcut
      throw new Error(`전역 단축키 ${rejected}를 등록할 수 없습니다.`)
    }
    if (typeof patch.launchAtLogin === 'boolean') applyLaunchAtLogin(settings.launchAtLogin)
    saveSettingsToDisk(settings)
    sendToWindows('settings:changed', settings)
    if (settings.inputMode !== previousInputMode) {
      logInfo('[Settings] Input mode changed', {
        previousInputMode,
        inputMode: settings.inputMode,
      })
    }
    return settings
  })

  ipcMain.handle('app:login-item-status', () => getLoginItemStatus())
  ipcMain.handle('app:login-item-set', (_event, enabled: boolean) => {
    settings = { ...settings, launchAtLogin: Boolean(enabled) }
    saveSettingsToDisk(settings)
    return applyLaunchAtLogin(settings.launchAtLogin)
  })
  ipcMain.on('app:quit', () => app.quit())

  // Packaged acceptance tests need to exercise the real macOS injector without
  // targeting any user application. This handler exists only for an explicit
  // E2E launch and is restricted to the isolated Playwright Chrome fixture.
  if (process.argv.includes('--nova-voice-e2e')) {
    ipcMain.handle('verification:inject-text', async (_event, text: unknown) => {
      if (typeof text !== 'string' || !text.trim() || text.length > 10_000) {
        throw new Error('Invalid verification injection text')
      }
      return injectText(text, 'Google Chrome', 'com.google.Chrome', true)
    })
    ipcMain.handle('verification:window-state', () => ({
      visible: !mainWindow.isDestroyed() && mainWindow.isVisible(),
      destroyed: mainWindow.isDestroyed(),
    }))
    ipcMain.handle('verification:target-context', () => {
      const targetAppName = getPreviousAppName()
      const targetBundleId = getPreviousBundleId()
      return {
        targetAppName,
        targetBundleId,
        cliTarget: isCliTarget(targetAppName, targetBundleId),
      }
    })
    ipcMain.handle('verification:set-pcm-delay', (_event, delayMs: unknown) => {
      const value = typeof delayMs === 'number' && Number.isFinite(delayMs)
        ? Math.max(0, Math.min(5_000, Math.round(delayMs)))
        : 0
      verificationPcmDelayMs = value
      return verificationPcmDelayMs
    })
  }

  ipcMain.handle('history:get', (_event, limit?: number, offset?: number) =>
    getHistory(limit, offset))
  ipcMain.handle('history:search', (_event, query: string) => searchHistory(query))
  ipcMain.handle('history:delete', (_event, id: string) => deleteTranscription(id))

  ipcMain.handle('stt:status', async (): Promise<SttStatus> => ({
    ready: await isSttServerRunning(),
    engine: STT_ENGINE_NAME,
    transport: 'pcm-websocket',
    sampleRate: 16000,
  }))
  ipcMain.handle('meta-prompt:status', () => getNcoMetaPromptStatus())
  ipcMain.handle('meta-prompt:reconnect', (_event, provider: unknown) => {
    if (typeof provider !== 'string') throw new Error('Invalid NCO provider')
    return reconnectNcoProvider(provider)
  })

  ipcMain.on('audio:level', (_event, level: number) => {
    getOverlayWindow()?.webContents.send('audio:level', level)
  })

  ipcMain.on('audio:spectrum', (_event, bands: unknown) => {
    if (!(bands instanceof Uint8Array)) return
    getOverlayWindow()?.webContents.send('audio:spectrum', bands)
  })

  // Streamed while the user is still speaking so the STT server can decode the
  // utterance in place of doing it all after the recording stops.
  ipcMain.on('audio:pcm-chunk', (_event, chunk: ArrayBuffer | ArrayBufferView) => {
    lastAudioChunkAt = Date.now()
    try {
      pushLiveAudio(toBuffer(chunk))
    } catch (error) {
      logWarn('[STT] Failed to stream PCM chunk', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  ipcMain.handle('audio:pcm', async (
    _event,
    rawPcm: ArrayBuffer | ArrayBufferView,
    sampleRate: number,
    streamedBytes?: unknown,
  ): Promise<TranscriptionResult | null> => {
    transcriptionController?.abort()
    const controller = new AbortController()
    transcriptionController = controller
    const pcm = toBuffer(rawPcm)
    const requestId = crypto.randomUUID().slice(0, 8)
    const requestStartedAt = performance.now()
    // A mode/provider change made while Whisper or an AI provider is running
    // applies to the next recording, never halfway through this request.
    // The mode itself comes from the hotkey that started this capture.
    const requestSettings = { ...settings, inputMode: getActiveInputMode() }
    setActiveInputMode(null)
    logInfo('[STT] PCM request started', {
      requestId,
      bytes: pcm.byteLength,
      sampleRate,
      inputMode: requestSettings.inputMode,
      ncoEnabled: requestSettings.ncoEnabled,
      ncoProvider: requestSettings.ncoProvider,
    })

    sendToWindows('transcription:stage', 'transcribing')
    sendToWindows('transcription:progress', 0.12)
    try {
      if (verificationPcmDelayMs > 0) {
        abortLiveCapture()
        await new Promise((resolve) => setTimeout(resolve, verificationPcmDelayMs))
        logInfo('[Verification] Delayed PCM request completed', { requestId, delayMs: verificationPcmDelayMs })
        sendToWindows('transcription:progress', 0)
        sendToWindows('transcription:stage', 'idle')
        hideOverlay()
        return null
      }
      // The streamed session usually already holds the decoded segments. It
      // returns null whenever it cannot be trusted, and the buffered upload
      // below stays the source of truth for that case.
      const streamedByteCount = typeof streamedBytes === 'number' && Number.isFinite(streamedBytes)
        ? streamedBytes
        : 0
      const liveResult = streamedByteCount > 0
        ? await finishLiveCapture(streamedByteCount, controller.signal)
        : (abortLiveCapture(), null)
      const whisperResult = liveResult
        ?? await transcribePcm(pcm, sampleRate, { signal: controller.signal })
      logInfo('[STT] Transcription path', { requestId, path: liveResult ? 'streamed' : 'buffered' })
      logInfo('[STT] Whisper response received', {
        requestId,
        textLength: whisperResult.text.length,
        duration: whisperResult.duration,
        aborted: controller.signal.aborted,
        controllerCurrent: transcriptionController === controller,
      })
      if (process.argv.includes('--nova-voice-e2e')) {
        logInfo('[Verification] Whisper transcript', { requestId, text: whisperResult.text })
      }
      if (controller.signal.aborted || transcriptionController !== controller) {
        logWarn('[STT] PCM result discarded after cancellation', {
          requestId,
          aborted: controller.signal.aborted,
          controllerCurrent: transcriptionController === controller,
        })
        return null
      }

      sendToWindows('transcription:progress', 0.92)
      if (!whisperResult.text) {
        logWarn('[STT] Whisper returned no usable text', { requestId, bytes: pcm.byteLength })
        sendToWindows('transcription:progress', 1)
        sendToWindows('transcription:stage', 'idle')
        hideOverlay()
        return null
      }

      // Latched when the recording started, so this is the app that was focused
      // while the user was talking rather than whatever came forward since.
      const targetAppName = getPreviousAppName() || undefined
      const targetBundleId = getPreviousBundleId() || undefined
      logInfo('[STT] Injection target resolved', { requestId, targetAppName, targetBundleId })
      let routedPrompt = routeVoicePrompt(whisperResult.text, targetAppName, targetBundleId)
      const cliTarget = isCliTarget(targetAppName, targetBundleId)
      if (!routedPrompt.isSlashCommand) {
        // The static catalogue missed it. Fall back to what this user has
        // actually been observed doing with this phrasing.
        const learned = findLearnedCommand(whisperResult.text)
        if (learned) {
          const trailing = whisperResult.text.slice(learned.phrase.length).trim()
          routedPrompt = {
            text: trailing ? `${learned.command} ${trailing}` : learned.command,
            isSlashCommand: true,
            shouldExecuteInCli: cliTarget,
          }
          logInfo('[Learning] Routed via learned alias', {
            requestId,
            phrase: learned.phrase,
            command: learned.command,
            hits: learned.hits,
          })
        }
      }
      if (routedPrompt.isSlashCommand) {
        logInfo('[VoiceRouter] Slash command routed', {
          requestId,
          command: routedPrompt.text.split(/\s+/, 1)[0],
          cliTarget: routedPrompt.shouldExecuteInCli,
          targetAppName,
          targetBundleId,
        })
      }

      let finalText = routedPrompt.text
      let shouldExecuteInCli = routedPrompt.shouldExecuteInCli
      let metaPromptOutcome: 'completed' | 'local-ai' | undefined
      let metaPromptProvider: string | undefined
      let metaPromptDuration: number | undefined
      if (requestSettings.inputMode === 'meta' && !routedPrompt.isSlashCommand) {
        const commandCandidates = cliTarget ? getMetaCommandCandidates(routedPrompt.text) : []
        const toolCandidates = cliTarget ? getMetaToolCandidates(routedPrompt.text) : []
        sendToWindows('transcription:stage', 'meta-prompting')
        sendToWindows('transcription:progress', 0.96)
        const metaPromptStartedAt = performance.now()
        const rewritten = await rewriteMetaPrompt(
          routedPrompt.text,
          resolveMetaProjectDir(),
          {
            targetAppName,
            targetBundleId,
            cliTarget,
            commandCandidates,
            toolCandidates,
            recentInputs: getHistory(4)
              .map((item) => item.sourceText || item.text)
              .filter((value) => Boolean(value) && value !== routedPrompt.text)
              .slice(0, 3),
            appUsage: getAppUsageHint(targetBundleId) ?? undefined,
          },
          controller.signal,
          {
            enabled: requestSettings.ncoEnabled,
            provider: requestSettings.ncoProvider,
          },
        )
        metaPromptDuration = (performance.now() - metaPromptStartedAt) / 1000
        const rewrittenRoute = routeVoicePrompt(
          normalizeTranscript(rewritten.text),
          targetAppName,
          targetBundleId,
        )
        finalText = rewrittenRoute.text
        shouldExecuteInCli ||= rewrittenRoute.shouldExecuteInCli
        metaPromptOutcome = rewritten.outcome
        metaPromptProvider = rewritten.provider
        logInfo('[MetaPrompt] AI response completed', {
          provider: metaPromptProvider,
          taskId: rewritten.taskId,
          ncoFailure: rewritten.ncoFailure,
          elapsedMs: Math.round(metaPromptDuration * 1000),
        })
      }

      const processingDuration = (performance.now() - requestStartedAt) / 1000
      let injected: boolean | undefined
      if (requestSettings.autoInject) {
        sendToWindows('transcription:stage', 'injecting')
        // A Meta response is already the AI's final answer. Paste it into the
        // focused app, but do not submit it as a second prompt. Explicit slash
        // commands remain executable through shouldExecuteInCli.
        const submitInjectedText = shouldExecuteInCli
          || (requestSettings.inputMode !== 'meta' && requestSettings.submitAfterInject)
        injected = await injectText(
          finalText,
          targetAppName,
          targetBundleId,
          submitInjectedText,
        )
      }

      const result: TranscriptionResult = {
        id: crypto.randomUUID(),
        text: finalText,
        language: whisperResult.language,
        duration: whisperResult.duration,
        timestamp: Date.now(),
        modelUsed: STT_ENGINE_NAME,
        inputMode: requestSettings.inputMode,
        processingDuration,
        ...(metaPromptDuration !== undefined ? { metaPromptDuration } : {}),
        ...(requestSettings.inputMode === 'meta' ? { sourceText: whisperResult.text } : {}),
        ...(metaPromptOutcome ? { metaPromptOutcome } : {}),
        ...(metaPromptProvider ? { metaPromptProvider } : {}),
        ...(targetAppName ? { targetApp: targetAppName } : {}),
        ...(targetBundleId ? { targetBundleId } : {}),
        cliTarget,
        isSlashCommand: routedPrompt.isSlashCommand,
        ...(injected === undefined ? {} : { injected }),
      }
      // Saved after injection so the stored row records whether the text
      // actually reached the application, which is the quality filter the
      // learning below depends on.
      saveTranscription(result)

      // Only utterances that reached an application are learned from: a failed
      // injection says nothing about what the user meant to do.
      if (injected !== false) {
        observeDictation({
          spokenText: whisperResult.text,
          phrase: normalizePhrase(whisperResult.text),
          ...(routedPrompt.isSlashCommand
            ? { command: routedPrompt.text.split(/\s+/, 1)[0] }
            : {}),
          ...(targetBundleId ? { bundleId: targetBundleId } : {}),
        })
      }

      // Publish completion only after optional injection/Enter has settled.
      // Previously the renderer became idle while the stop handler was still
      // awaiting injection, so an immediate next recording could be dropped.
      sendToWindows('transcription:result', result)
      sendToWindows('transcription:progress', 1)
      sendToWindows('transcription:stage', 'idle')
      logInfo('[STT] PCM request completed', {
        requestId,
        inputMode: requestSettings.inputMode,
        metaPromptOutcome,
        metaPromptProvider,
        sttMs: Math.round(whisperResult.duration * 1000),
        metaPromptMs: metaPromptDuration === undefined ? undefined : Math.round(metaPromptDuration * 1000),
        processingMs: Math.round(processingDuration * 1000),
        totalMs: Math.round(performance.now() - requestStartedAt),
      })
      setTimeout(() => hideOverlay(), 1200)
      return result
    } catch (error) {
      if (!controller.signal.aborted) {
        logError('[STT] Transcription failed', {
          requestId,
          inputMode: requestSettings.inputMode,
          elapsedMs: Math.round(performance.now() - requestStartedAt),
          error: error instanceof Error ? error.message : String(error),
        })
        sendToWindows('transcription:progress', 0)
        sendToWindows('transcription:stage', 'idle')
        hideOverlay()
        throw error
      }
      return null
    } finally {
      if (transcriptionController === controller) {
        transcriptionController = null
        // Injection is done, so the foreground poller may track again. A newer
        // capture owns its own latch and must not be released from here.
        releaseFrontAppLatch()
      }
    }
  })

  mainWindow.on('closed', cancelCurrentTranscription)
}

export function getRecordingState(): boolean {
  return isRecording
}

export function setRecordingState(value: boolean): void {
  isRecording = value
}

export function getSettings(): AppSettings {
  return settings
}
