import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, MetaPromptStatus, SttStatus, TranscriptionResult, TranscriptionStage, VoiceInputMode } from '../shared/types'

const api = {
  startRecording: (mode?: VoiceInputMode) => ipcRenderer.invoke('recording:start', mode),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  cancelRecording: () => ipcRenderer.invoke('recording:cancel'),
  sendPcmData: (buffer: ArrayBuffer, sampleRate: number, streamedBytes = 0) =>
    ipcRenderer.invoke('audio:pcm', buffer, sampleRate, streamedBytes),
  sendPcmChunk: (buffer: ArrayBuffer) => ipcRenderer.send('audio:pcm-chunk', buffer),
  runVerificationInjection: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('verification:inject-text', text),
  getVerificationWindowState: (): Promise<{ visible: boolean; destroyed: boolean }> =>
    ipcRenderer.invoke('verification:window-state'),
  getVerificationTargetContext: (): Promise<{ targetAppName: string; targetBundleId: string; cliTarget: boolean }> =>
    ipcRenderer.invoke('verification:target-context'),
  setVerificationPcmDelay: (delayMs: number): Promise<number> =>
    ipcRenderer.invoke('verification:set-pcm-delay', delayMs),

  onRecordingState: (callback: (state: { isRecording: boolean; duration: number; cancelled?: boolean; inputMode?: VoiceInputMode }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: { isRecording: boolean; duration: number; cancelled?: boolean; inputMode?: VoiceInputMode }) => callback(state)
    ipcRenderer.on('recording:state', handler)
    return () => ipcRenderer.removeListener('recording:state', handler)
  },
  onRecordingDuration: (callback: (duration: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, duration: number) => callback(duration)
    ipcRenderer.on('recording:duration', handler)
    return () => ipcRenderer.removeListener('recording:duration', handler)
  },
  sendAudioLevel: (level: number) => ipcRenderer.send('audio:level', level),
  onAudioLevel: (callback: (level: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, level: number) => callback(level)
    ipcRenderer.on('audio:level', handler)
    return () => ipcRenderer.removeListener('audio:level', handler)
  },
  sendAudioSpectrum: (bands: Uint8Array) => ipcRenderer.send('audio:spectrum', bands),
  onAudioSpectrum: (callback: (bands: Uint8Array) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, bands: Uint8Array) => callback(bands)
    ipcRenderer.on('audio:spectrum', handler)
    return () => ipcRenderer.removeListener('audio:spectrum', handler)
  },

  onTranscriptionResult: (callback: (result: TranscriptionResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: TranscriptionResult) => callback(result)
    ipcRenderer.on('transcription:result', handler)
    return () => ipcRenderer.removeListener('transcription:result', handler)
  },
  onTranscriptionProgress: (callback: (progress: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: number) => callback(progress)
    ipcRenderer.on('transcription:progress', handler)
    return () => ipcRenderer.removeListener('transcription:progress', handler)
  },
  onTranscriptionStage: (callback: (stage: TranscriptionStage) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, stage: TranscriptionStage) => callback(stage)
    ipcRenderer.on('transcription:stage', handler)
    return () => ipcRenderer.removeListener('transcription:stage', handler)
  },
  getSttStatus: (): Promise<SttStatus> => ipcRenderer.invoke('stt:status'),
  getMetaPromptStatus: (): Promise<MetaPromptStatus> => ipcRenderer.invoke('meta-prompt:status'),
  reconnectNcoProvider: (provider: string): Promise<MetaPromptStatus> =>
    ipcRenderer.invoke('meta-prompt:reconnect', provider),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (settings: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', settings),
  onSettingsChanged: (callback: (settings: AppSettings) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: AppSettings) => callback(settings)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.removeListener('settings:changed', handler)
  },
  getLoginItemStatus: (): Promise<{ supported: boolean; openAtLogin: boolean; status: string }> =>
    ipcRenderer.invoke('app:login-item-status'),
  setLoginItemEnabled: (enabled: boolean): Promise<{ supported: boolean; openAtLogin: boolean; status: string }> =>
    ipcRenderer.invoke('app:login-item-set', enabled),

  getHistory: (limit?: number, offset?: number): Promise<TranscriptionResult[]> =>
    ipcRenderer.invoke('history:get', limit, offset),
  searchHistory: (query: string): Promise<TranscriptionResult[]> =>
    ipcRenderer.invoke('history:search', query),
  deleteHistory: (id: string): Promise<void> => ipcRenderer.invoke('history:delete', id),

  onViewNavigate: (callback: (view: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, view: string) => callback(view)
    ipcRenderer.on('view:navigate', handler)
    return () => ipcRenderer.removeListener('view:navigate', handler)
  },
  quit: () => ipcRenderer.send('app:quit'),
  platform: process.platform,
}

export type ElectronAPI = typeof api

contextBridge.exposeInMainWorld('electronAPI', api)
