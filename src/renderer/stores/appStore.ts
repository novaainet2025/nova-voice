import { create } from 'zustand'
import { SPECTRUM_BANDS } from '../../shared/types.ts'
import type { AppSettings, MetaPromptStatus, SttStatus, TranscriptionResult, TranscriptionStage, VoiceInputMode } from '../../shared/types.ts'

type View = 'home' | 'settings' | 'history'

interface AppState {
  isRecording: boolean
  recordingDuration: number
  audioLevel: number
  /**
   * Live frequency bands, updated ~30×/s. Deliberately a stable buffer that is
   * mutated in place: the canvas visualiser samples it from its own animation
   * frame, so pushing it through React state would only add re-renders.
   */
  spectrum: Uint8Array
  /** Mode the in-flight capture was started in (hotkey overrides the default). */
  activeInputMode: VoiceInputMode | null
  currentTranscription: string
  transcriptionProgress: number
  isTranscribing: boolean
  history: TranscriptionResult[]
  settings: AppSettings | null
  sttStatus: SttStatus | null
  metaPromptStatus: MetaPromptStatus | null
  transcriptionStage: TranscriptionStage
  currentView: View
  setRecording: (value: boolean) => void
  setRecordingDuration: (value: number) => void
  setAudioLevel: (value: number) => void
  setSpectrum: (value: Uint8Array) => void
  resetSpectrum: () => void
  setActiveInputMode: (value: VoiceInputMode | null) => void
  setCurrentTranscription: (value: string) => void
  setTranscriptionProgress: (value: number) => void
  setIsTranscribing: (value: boolean) => void
  setHistory: (value: TranscriptionResult[]) => void
  addToHistory: (value: TranscriptionResult) => void
  setSettings: (value: AppSettings) => void
  setSttStatus: (value: SttStatus) => void
  setMetaPromptStatus: (value: MetaPromptStatus) => void
  setTranscriptionStage: (value: TranscriptionStage) => void
  setCurrentView: (value: View) => void
}

const spectrumBuffer = new Uint8Array(SPECTRUM_BANDS)

export const useAppStore = create<AppState>((set, get) => ({
  isRecording: false,
  recordingDuration: 0,
  audioLevel: 0,
  spectrum: spectrumBuffer,
  activeInputMode: null,
  currentTranscription: '',
  transcriptionProgress: 0,
  isTranscribing: false,
  history: [],
  settings: null,
  sttStatus: null,
  metaPromptStatus: null,
  transcriptionStage: 'idle',
  currentView: 'home',
  setRecording: (isRecording) => set({ isRecording }),
  setRecordingDuration: (recordingDuration) => set({ recordingDuration }),
  setAudioLevel: (audioLevel) => set({ audioLevel }),
  setSpectrum: (value) => {
    const target = get().spectrum
    if (value !== target) target.set(value.subarray(0, target.length))
  },
  resetSpectrum: () => get().spectrum.fill(0),
  setActiveInputMode: (activeInputMode) => set({ activeInputMode }),
  setCurrentTranscription: (currentTranscription) => set({ currentTranscription }),
  setTranscriptionProgress: (transcriptionProgress) => set({ transcriptionProgress }),
  setIsTranscribing: (isTranscribing) => set({ isTranscribing }),
  setHistory: (history) => set({ history }),
  addToHistory: (result) => set((state) => ({ history: [result, ...state.history] })),
  setSettings: (settings) => set({ settings }),
  setSttStatus: (sttStatus) => set({ sttStatus }),
  setMetaPromptStatus: (metaPromptStatus) => set({ metaPromptStatus }),
  setTranscriptionStage: (transcriptionStage) => set({ transcriptionStage }),
  setCurrentView: (currentView) => set({ currentView }),
}))
