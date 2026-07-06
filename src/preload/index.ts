import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppSettings, TranscriptionResult } from '../shared/types'

const api = {
  // Recording
  startRecording: () => ipcRenderer.invoke('recording:start'),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  cancelRecording: () => ipcRenderer.invoke('recording:cancel'),

  // Transcription
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

  // Recording state
  onRecordingState: (callback: (state: { isRecording: boolean; duration: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: { isRecording: boolean; duration: number }) => callback(state)
    ipcRenderer.on('recording:state', handler)
    return () => ipcRenderer.removeListener('recording:state', handler)
  },

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (settings: Partial<AppSettings>): Promise<void> => ipcRenderer.invoke('settings:set', settings),

  // History
  getHistory: (limit?: number, offset?: number): Promise<TranscriptionResult[]> =>
    ipcRenderer.invoke('history:get', limit, offset),
  searchHistory: (query: string): Promise<TranscriptionResult[]> =>
    ipcRenderer.invoke('history:search', query),
  deleteHistory: (id: string): Promise<void> => ipcRenderer.invoke('history:delete', id),

  // Overlay
  onOverlayShow: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('overlay:show', handler)
    return () => ipcRenderer.removeListener('overlay:show', handler)
  },
  onOverlayHide: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('overlay:hide', handler)
    return () => ipcRenderer.removeListener('overlay:hide', handler)
  },

  // Recording duration updates from main process
  onRecordingDuration: (callback: (duration: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, duration: number) => callback(duration)
    ipcRenderer.on('recording:duration', handler)
    return () => ipcRenderer.removeListener('recording:duration', handler)
  },

  // Audio data from renderer to main
  sendAudioData: (buffer: ArrayBuffer) => ipcRenderer.invoke('audio:data', buffer),

  // Audio level: renderer sends level to main, main forwards to overlay
  sendAudioLevel: (level: number) => ipcRenderer.send('audio:level', level),
  onAudioLevel: (callback: (level: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, level: number) => callback(level)
    ipcRenderer.on('audio:level', handler)
    return () => ipcRenderer.removeListener('audio:level', handler)
  },

  // Attachment processing (drag & drop / paste)
  processAttachment: (opts: {
    name: string
    mimeType: string
    content?: string
    base64?: string
    modeId: string
    extraText?: string
  }) => ipcRenderer.invoke('attachment:process', opts),

  // AI modes & processing
  getAIModes: () => ipcRenderer.invoke('ai:modes'),
  getAIStatus: () => ipcRenderer.invoke('ai:status'),
  processWithAI: (text: string, modeId: string) => ipcRenderer.invoke('ai:process', text, modeId),
  onAIStage: (callback: (stage: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, stage: string) => callback(stage)
    ipcRenderer.on('ai:stage', handler)
    return () => ipcRenderer.removeListener('ai:stage', handler)
  },

  // TTS (mouth)
  speak: (text: string, options?: any) => ipcRenderer.invoke('tts:speak', text, options),
  getSpeakers: (lang?: string) => ipcRenderer.invoke('tts:speakers', lang),
  getMLXVoices: () => ipcRenderer.invoke('tts:mlx-voices'),
  getMLXVoice: () => ipcRenderer.invoke('tts:mlx-voice:get'),
  setMLXVoice: (voice: string) => ipcRenderer.invoke('tts:mlx-voice:set', voice),

  // TTS Server management
  getTTSServerStatuses: () => ipcRenderer.invoke('tts:server-status'),
  startTTSServer: (id: string) => ipcRenderer.invoke('tts:server-start', id),
  stopTTSServer: (id: string) => ipcRenderer.invoke('tts:server-stop', id),
  previewTTSVoice: (id: string, voice?: string) => ipcRenderer.invoke('tts:server-preview', id, voice),
  getSayVoices: () => ipcRenderer.invoke('tts:say-voices'),
  previewSayVoice: (voice: string, text?: string) => ipcRenderer.invoke('tts:say-preview', voice, text),
  getAllTtsAdapters: () => ipcRenderer.invoke('tts:all-tts-adapters'),

  // Claude Terminal
  claudeSend: (text: string): Promise<string> => ipcRenderer.invoke('claude:send', text),
  getClaudeStatus: (): Promise<{ ready: boolean; path: string }> => ipcRenderer.invoke('claude:status'),
  onClaudeOutput: (callback: (data: { type: string; text: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { type: string; text: string }) => callback(data)
    ipcRenderer.on('claude:output', handler)
    return () => ipcRenderer.removeListener('claude:output', handler)
  },
  onClaudeStatus: (callback: (status: { ready: boolean; path: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, s: { ready: boolean; path: string }) => callback(s)
    ipcRenderer.on('claude:status', handler)
    return () => ipcRenderer.removeListener('claude:status', handler)
  },
  onViewNavigate: (callback: (view: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, view: string) => callback(view)
    ipcRenderer.on('view:navigate', handler)
    return () => ipcRenderer.removeListener('view:navigate', handler)
  },

  // Pipeline (ear + eye + brain + mouth)
  getPipelineStatus: () => ipcRenderer.invoke('pipeline:status'),
  getPipelineConfig: () => ipcRenderer.invoke('pipeline:config'),
  setPipelineConfig: (config: any) => ipcRenderer.invoke('pipeline:setConfig', config),
  initPipeline: () => ipcRenderer.invoke('pipeline:init'),

  // Real PTY Terminal (node-pty)
  ptyInput: (data: string) => ipcRenderer.send('pty:input', data),
  ptyResize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', cols, rows),
  ptyCreate: (cols?: number, rows?: number, force?: boolean) => ipcRenderer.invoke('pty:create', cols, rows, force),
  // Electron 32+: file.path deprecated → webUtils.getPathForFile() 사용
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  ptyStatus: () => ipcRenderer.invoke('pty:status'),
  ptyClaudeRunning: (): Promise<{ ready: boolean; claudeDetected: boolean }> => ipcRenderer.invoke('pty:claude-running'),
  ptyType: (command: string) => ipcRenderer.invoke('pty:type', command),
  onPtyData: (callback: (data: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: string) => callback(data)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },
  onPtyExit: (callback: (code: number) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, code: number) => callback(code)
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.removeListener('pty:exit', handler)
  },

  // Debug log (main → renderer 실시간 스트리밍)
  getDebugLogs: (): Promise<{ ts: number; level: string; msg: string }[]> =>
    ipcRenderer.invoke('debug:logs'),
  onDebugLog: (callback: (entry: { ts: number; level: string; msg: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, entry: { ts: number; level: string; msg: string }) => callback(entry)
    ipcRenderer.on('debug:log', handler)
    return () => ipcRenderer.removeListener('debug:log', handler)
  },

  // AI 작업 취소 (Ctrl+Shift+Escape 또는 UI 버튼)
  cancelAI: (): Promise<{ cancelled: boolean }> => ipcRenderer.invoke('ai:cancel'),
  onAICancelled: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('ai:cancelled', handler)
    return () => ipcRenderer.removeListener('ai:cancelled', handler)
  },

  // NCO AI 프로바이더 헬스 체크
  checkNCOHealth: (): Promise<{
    id: string; name: string; role: string; type: string;
    status: 'online' | 'offline' | 'degraded';
    latencyMs: number; version?: string; model?: string; error?: string; checkedAt: number
  }[]> => ipcRenderer.invoke('nco:health'),

  // App
  quit: () => ipcRenderer.send('app:quit'),
  platform: process.platform
}

export type ElectronAPI = typeof api

contextBridge.exposeInMainWorld('electronAPI', api)
