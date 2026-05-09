import React, { useEffect } from 'react'
import { useAppStore } from './stores/appStore'
import { useRecorder } from './hooks/useRecorder'
import { RecordingOverlay } from './components/overlay/RecordingOverlay'
import { SettingsPanel } from './components/settings/SettingsPanel'
import { HistoryPanel } from './components/history/HistoryPanel'
import { UnifiedPanel } from './components/unified/UnifiedPanel'

function App() {
  const { currentView, setCurrentView, setRecording, setCurrentTranscription, addToHistory, setAudioLevel, setRecordingDuration, setAIStage, setAIModes, setCurrentMode } = useAppStore()
  // 뷰 네비게이션 이벤트 (main→renderer, 예: Claude 실행 시 터미널로 이동)
  useEffect(() => {
    const cleanup = window.electronAPI?.onViewNavigate?.((view) => {
      // 'terminal' is merged into 'home' (UnifiedPanel)
      if (view === 'terminal') setCurrentView('home')
      else setCurrentView(view as any)
    })
    return () => cleanup?.()
  }, [setCurrentView])
  const { startRecording, stopRecording, cancelRecording } = useRecorder()

  // Check if this is the overlay window
  const isOverlay = window.location.hash === '#/overlay'

  useEffect(() => {
    if (!window.electronAPI) return

    // Listen for recording state from main process
    const cleanupState = window.electronAPI.onRecordingState((state) => {
      if ((state as any).cancelled && !isOverlay) {
        // 취소: MediaRecorder 중단 + 오디오 폐기 (STT 처리 없음)
        cancelRecording()
        return
      }
      setRecording(state.isRecording)
      if (state.isRecording && !isOverlay) {
        startRecording()
      } else if (!state.isRecording && !isOverlay) {
        stopRecording()
      }
      // Reset overlay audio level when recording stops
      if (!state.isRecording && isOverlay) {
        setAudioLevel(0)
        setRecordingDuration(0)
      }
    })

    // Listen for transcription results
    const cleanupResult = window.electronAPI.onTranscriptionResult((result) => {
      // Show AI result if available, otherwise raw text
      setCurrentTranscription(result.aiResult || result.text)
      addToHistory(result)
      setAIStage('done')
    })

    // Listen for AI processing stage
    let cleanupAIStage: (() => void) | undefined
    if (window.electronAPI.onAIStage) {
      cleanupAIStage = window.electronAPI.onAIStage((stage) => {
        setAIStage(stage)
      })
    }

    // Load AI modes for overlay
    if (isOverlay) {
      window.electronAPI.getAIModes?.().then((modes: any[]) => setAIModes(modes))
      window.electronAPI.getSettings?.().then((s: any) => setCurrentMode(s.aiMode || 'direct'))
    }

    // Overlay: listen for audio level + duration updates forwarded from main window
    let cleanupAudioLevel: (() => void) | undefined
    let cleanupDuration: (() => void) | undefined
    if (isOverlay) {
      if (window.electronAPI.onAudioLevel) {
        cleanupAudioLevel = window.electronAPI.onAudioLevel((level) => {
          setAudioLevel(level)
        })
      }
      if (window.electronAPI.onRecordingDuration) {
        cleanupDuration = window.electronAPI.onRecordingDuration((duration) => {
          setRecordingDuration(duration)
        })
      }
    }

    return () => {
      cleanupState()
      cleanupResult()
      cleanupAIStage?.()
      cleanupAudioLevel?.()
      cleanupDuration?.()
    }
  }, [isOverlay, setRecording, startRecording, stopRecording, setCurrentTranscription, addToHistory, setAudioLevel, setRecordingDuration, setAIStage, setAIModes, setCurrentMode])

  // Overlay mode
  if (isOverlay) {
    return <RecordingOverlay />
  }

  // Main app
  return (
    <div className="h-screen flex flex-col">
      {/* Title bar drag region */}
      <div className="drag-region h-12 flex items-center px-4 flex-shrink-0">
        <div className="w-20" /> {/* Space for traffic lights on macOS */}
        <span className="text-sm font-medium text-white/50">NOVA-VOICE</span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <nav className="w-16 flex flex-col items-center py-4 gap-2 flex-shrink-0 border-r border-white/5">
          <NavButton
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
            }
            active={currentView === 'home'}
            onClick={() => setCurrentView('home')}
            label="Home"
          />
          <NavButton
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
            active={currentView === 'history'}
            onClick={() => setCurrentView('history')}
            label="History"
          />
          <NavButton
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
            active={currentView === 'settings'}
            onClick={() => setCurrentView('settings')}
            label="Settings"
          />
        </nav>

        {/* Content — 모든 뷰를 항상 마운트, CSS로만 표시/숨김 (터미널 세션 유지) */}
        <main className="flex-1 overflow-hidden relative">
          <div className={`absolute inset-0 ${currentView === 'home' ? 'flex' : 'hidden'} flex-col`}>
            <UnifiedPanel />
          </div>
          <div className={`absolute inset-0 ${currentView === 'history' ? 'flex' : 'hidden'} flex-col`}>
            <HistoryPanel />
          </div>
          <div className={`absolute inset-0 ${currentView === 'settings' ? 'flex' : 'hidden'} flex-col`}>
            <SettingsPanel />
          </div>
        </main>
      </div>
    </div>
  )
}

function NavButton({
  icon,
  active,
  onClick,
  label
}: {
  icon: React.ReactNode
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`no-drag w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
        active
          ? 'bg-primary-600/20 text-primary-400'
          : 'text-white/40 hover:text-white/60 hover:bg-white/5'
      }`}
    >
      {icon}
    </button>
  )
}

export default App
