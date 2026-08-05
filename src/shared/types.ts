export const STT_ENGINE_NAME = 'Whisper large-v3-turbo · MLX'

/** Number of log-spaced spectrum bands streamed from the recorder to the visualizer. */
export const SPECTRUM_BANDS = 48

/**
 * What a capture does with what it hears.
 *
 * `computer` is hotkey-only: it is never a saved default, because a mode that
 * silently executes actions should be entered deliberately each time.
 */
export type VoiceInputMode = 'normal' | 'meta' | 'computer'
export type TranscriptionStage = 'idle' | 'transcribing' | 'meta-prompting' | 'injecting'
export type MetaPromptOutcome = 'completed' | 'local-ai' | 'local' | 'fallback'

export interface TranscriptionResult {
  id: string
  text: string
  language: string
  duration: number
  timestamp: number
  modelUsed: string
  inputMode?: VoiceInputMode
  sourceText?: string
  metaPromptOutcome?: MetaPromptOutcome
  metaPromptProvider?: string
  processingDuration?: number
  metaPromptDuration?: number
  /** Application the text was injected into — the context pattern learning needs. */
  targetApp?: string
  targetBundleId?: string
  cliTarget?: boolean
  isSlashCommand?: boolean
  /** False when injection failed and the text only reached the clipboard. */
  injected?: boolean
}

export interface RecordingState {
  isRecording: boolean
  duration: number
  audioLevel: number
}

export interface AppSettings {
  /** Global hotkey for plain dictation. */
  shortcut: string
  /** Global hotkey that records straight into meta-prompt mode for one utterance. */
  metaShortcut: string
  /** Global hotkey that records straight into computer-control mode. */
  computerShortcut: string
  autoInject: boolean
  submitAfterInject: boolean
  showOverlay: boolean
  launchAtLogin: boolean
  silenceTimeoutMs: number
  inputMode: VoiceInputMode
  ncoEnabled: boolean
  ncoProvider: string
}

export interface NcoProviderOption {
  id: string
  name: string
  ready: boolean
  online: boolean
  status: 'ready' | 'idle' | 'working' | 'verification-required' | 'limited' | 'offline'
  inferenceVerified: boolean
  blockers: string[]
}

/** One provider's standing in the auto-selection ranking. */
export interface NcoProviderRanking {
  id: string
  name: string
  score: number
  eligible: boolean
  reason: string
  /** Rolling mean of observed meta-prompt latency, in seconds. */
  avgSeconds?: number
  successRate?: number
}

export interface MetaPromptStatus {
  available: boolean
  provider: 'NCO'
  source: 'NCO Core'
  endpoint: string
  ncoConnected: boolean
  localAvailable: boolean
  readyProviders?: string[]
  providers?: NcoProviderOption[]
  agentsOnline?: number
  message?: string
  /** Provider the auto selector would use right now. */
  autoProvider?: string
  autoReason?: string
  autoRanking?: NcoProviderRanking[]
}

export interface SttStatus {
  ready: boolean
  engine: string
  transport: 'pcm-websocket'
  sampleRate: 16000
}

export type IpcChannels =
  | 'recording:start'
  | 'recording:stop'
  | 'recording:cancel'
  | 'recording:state'
  | 'transcription:result'
  | 'transcription:progress'
  | 'transcription:stage'
  | 'audio:pcm'
  | 'audio:pcm-chunk'
  | 'audio:spectrum'
  | 'settings:get'
  | 'settings:set'
  | 'settings:changed'
  | 'app:login-item-status'
  | 'app:login-item-set'
  | 'history:get'
  | 'history:search'
  | 'history:delete'
  | 'stt:status'
  | 'meta-prompt:status'
  | 'meta-prompt:reconnect'
  | 'app:quit'

/** Selectable auto-stop delays. 700ms is the fastest endpointing that still
 *  clears the server VAD's own 0.7s silence window without clipping speech. */
export const SILENCE_TIMEOUT_OPTIONS = [700, 900, 1200, 1600, 2000] as const

export const DEFAULT_SETTINGS: AppSettings = {
  shortcut: 'Ctrl+Shift+Space',
  metaShortcut: 'Ctrl+Shift+Alt+Space',
  computerShortcut: 'Ctrl+Alt+Space',
  autoInject: true,
  submitAfterInject: true,
  showOverlay: true,
  launchAtLogin: true,
  silenceTimeoutMs: 900,
  inputMode: 'normal',
  ncoEnabled: true,
  ncoProvider: 'auto',
}
