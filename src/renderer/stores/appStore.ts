import { create } from 'zustand'
import type { AppSettings, TranscriptionResult, AIMode, Attachment } from '../../shared/types'

type View = 'home' | 'settings' | 'history' | 'terminal' | 'overlay'

interface AppState {
  // Recording
  isRecording: boolean
  recordingDuration: number
  audioLevel: number

  // Transcription
  currentTranscription: string
  transcriptionProgress: number
  isTranscribing: boolean
  aiStage: string // 'idle' | 'transcribing' | 'ai_processing' | 'done'

  // History
  history: TranscriptionResult[]

  // Settings
  settings: AppSettings | null

  // AI
  aiModes: AIMode[]
  currentMode: string
  aiProviderStatus: { nco: boolean; claude: boolean; gemini: boolean }

  // Attachments
  pendingAttachments: Attachment[]
  isProcessingAttachment: boolean

  // UI
  currentView: View

  // Actions
  setRecording: (isRecording: boolean) => void
  setRecordingDuration: (duration: number) => void
  setAudioLevel: (level: number) => void
  setCurrentTranscription: (text: string) => void
  setTranscriptionProgress: (progress: number) => void
  setIsTranscribing: (isTranscribing: boolean) => void
  setAIStage: (stage: string) => void
  setHistory: (history: TranscriptionResult[]) => void
  addToHistory: (result: TranscriptionResult) => void
  setSettings: (settings: AppSettings) => void
  setCurrentView: (view: View) => void
  setAIModes: (modes: AIMode[]) => void
  setCurrentMode: (mode: string) => void
  setAIProviderStatus: (status: { nco: boolean; claude: boolean; gemini: boolean }) => void
  addAttachment: (attachment: Attachment) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  setProcessingAttachment: (v: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  isRecording: false,
  recordingDuration: 0,
  audioLevel: 0,
  currentTranscription: '',
  transcriptionProgress: 0,
  isTranscribing: false,
  aiStage: 'idle',
  history: [],
  settings: null,
  aiModes: [],
  currentMode: 'direct',
  aiProviderStatus: { nco: false, claude: false, gemini: false },
  pendingAttachments: [],
  isProcessingAttachment: false,
  currentView: 'home',

  setRecording: (isRecording) => set({ isRecording }),
  setRecordingDuration: (recordingDuration) => set({ recordingDuration }),
  setAudioLevel: (audioLevel) => set({ audioLevel }),
  setCurrentTranscription: (currentTranscription) => set({ currentTranscription }),
  setTranscriptionProgress: (transcriptionProgress) => set({ transcriptionProgress }),
  setIsTranscribing: (isTranscribing) => set({ isTranscribing }),
  setAIStage: (aiStage) => set({ aiStage }),
  setHistory: (history) => set({ history }),
  addToHistory: (result) => set((state) => ({ history: [result, ...state.history] })),
  setSettings: (settings) => set({ settings, currentMode: settings.aiMode }),
  setCurrentView: (currentView) => set({ currentView }),
  setAIModes: (aiModes) => set({ aiModes }),
  setCurrentMode: (currentMode) => set({ currentMode }),
  setAIProviderStatus: (aiProviderStatus) => set({ aiProviderStatus }),
  addAttachment: (attachment) => set((state) => ({ pendingAttachments: [...state.pendingAttachments, attachment] })),
  removeAttachment: (id) => set((state) => ({ pendingAttachments: state.pendingAttachments.filter(a => a.id !== id) })),
  clearAttachments: () => set({ pendingAttachments: [] }),
  setProcessingAttachment: (isProcessingAttachment) => set({ isProcessingAttachment }),
}))
