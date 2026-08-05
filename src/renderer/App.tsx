import React, { useEffect } from 'react'
import { HistoryPanel } from './components/history/HistoryPanel'
import { RecordingOverlay } from './components/overlay/RecordingOverlay'
import { SettingsPanel } from './components/settings/SettingsPanel'
import { UnifiedPanel } from './components/unified/UnifiedPanel'
import { useRecorder } from './hooks/useRecorder'
import { useAppStore } from './stores/appStore'

type ViewName = 'home' | 'history' | 'settings'

function App() {
  const {
    currentView,
    sttStatus,
    setCurrentView,
    setRecording,
    setCurrentTranscription,
    setTranscriptionProgress,
    setIsTranscribing,
    addToHistory,
    setAudioLevel,
    setSpectrum,
    resetSpectrum,
    setActiveInputMode,
    setRecordingDuration,
    setSettings,
    setSttStatus,
    setMetaPromptStatus,
    setTranscriptionStage,
  } = useAppStore()
  const { startRecording, stopRecording, cancelRecording } = useRecorder()
  const isOverlay = window.location.hash === '#/overlay'

  useEffect(() => {
    void window.electronAPI.getSettings().then(setSettings)
    const cleanupSettings = window.electronAPI.onSettingsChanged(setSettings)
    return cleanupSettings
  }, [setSettings])

  useEffect(() => {
    if (isOverlay) return
    void window.electronAPI.getMetaPromptStatus().then(setMetaPromptStatus)
    let cancelled = false
    let timer = 0
    const refreshStatus = async () => {
      const status = await window.electronAPI.getSttStatus()
      if (cancelled) return
      setSttStatus(status)
      if (!status.ready) timer = window.setTimeout(() => void refreshStatus(), 1000)
    }
    void refreshStatus()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [isOverlay, setMetaPromptStatus, setSttStatus])

  useEffect(() => {
    const cleanup = window.electronAPI.onViewNavigate((view) => {
      if (view === 'home' || view === 'history' || view === 'settings') {
        setCurrentView(view)
      }
    })
    return cleanup
  }, [setCurrentView])

  useEffect(() => {
    const cleanupState = window.electronAPI.onRecordingState((state) => {
      if (state.cancelled && !isOverlay) {
        setActiveInputMode(null)
        void cancelRecording()
        return
      }
      // The hotkey decides the mode for this one capture, so both windows track
      // it instead of reading the saved default.
      setActiveInputMode(state.isRecording ? state.inputMode ?? null : null)
      setRecording(state.isRecording)
      if (!isOverlay) {
        if (state.isRecording) void startRecording()
        else void stopRecording()
      } else if (!state.isRecording) {
        setAudioLevel(0)
        setRecordingDuration(0)
        resetSpectrum()
      }
    })

    const cleanupResult = window.electronAPI.onTranscriptionResult((result) => {
      setCurrentTranscription(result.text)
      addToHistory(result)
      setIsTranscribing(false)
      setTranscriptionProgress(1)
      if (result.inputMode === 'meta') {
        void window.electronAPI.getMetaPromptStatus().then(setMetaPromptStatus)
      }
    })

    const cleanupProgress = window.electronAPI.onTranscriptionProgress((progress) => {
      setTranscriptionProgress(progress)
      setIsTranscribing(progress > 0 && progress < 1)
    })
    const cleanupStage = window.electronAPI.onTranscriptionStage(setTranscriptionStage)

    const cleanupAudioLevel = isOverlay
      ? window.electronAPI.onAudioLevel(setAudioLevel)
      : undefined
    // The overlay is a separate window with no microphone of its own, so the
    // recording window forwards its analysed bands to it.
    const cleanupSpectrum = isOverlay
      ? window.electronAPI.onAudioSpectrum(setSpectrum)
      : undefined
    const cleanupDuration = isOverlay
      ? window.electronAPI.onRecordingDuration(setRecordingDuration)
      : undefined

    return () => {
      cleanupState()
      cleanupResult()
      cleanupProgress()
      cleanupStage()
      cleanupAudioLevel?.()
      cleanupSpectrum?.()
      cleanupDuration?.()
    }
  }, [
    addToHistory,
    cancelRecording,
    isOverlay,
    resetSpectrum,
    setActiveInputMode,
    setAudioLevel,
    setCurrentTranscription,
    setIsTranscribing,
    setMetaPromptStatus,
    setRecording,
    setRecordingDuration,
    setSpectrum,
    setTranscriptionProgress,
    setTranscriptionStage,
    startRecording,
    stopRecording,
  ])

  if (isOverlay) return <RecordingOverlay />

  return (
    <div className="nova-app h-screen flex flex-col">
      <header className="nova-titlebar drag-region h-14 flex items-center flex-shrink-0" aria-label="NOVA VOICE title bar">
        <div className="nova-traffic-space" aria-hidden="true" />
        <div className="nova-brand-lockup">
          <NovaSignalMark />
          <div>
            <div className="nova-wordmark">NOVA VOICE</div>
            <div className="nova-brand-caption">WHISPER STT</div>
          </div>
        </div>
        <div className="nova-title-status no-drag" title="Whisper STT 상태">
          <span className={`nova-status-dot ${sttStatus?.ready === false ? 'opacity-30' : ''}`} />
          {sttStatus?.ready === false ? 'Starting' : 'STT Ready'}
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <nav className="nova-sidebar flex-shrink-0" aria-label="주요 화면">
          <div className="nova-nav-stack">
            <NavButton view="home" active={currentView === 'home'} onClick={() => setCurrentView('home')} label="받아쓰기">
              <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
              <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" />
            </NavButton>
            <NavButton view="history" active={currentView === 'history'} onClick={() => setCurrentView('history')} label="기록">
              <path d="M12 7v5l3.4 2" />
              <path d="M4.8 6.8A8.5 8.5 0 1 1 3.5 12" />
              <path d="M3.5 5.2v4h4" />
            </NavButton>
            <NavButton view="settings" active={currentView === 'settings'} onClick={() => setCurrentView('settings')} label="설정">
              <circle cx="12" cy="12" r="3" />
              <path d="M19 13.4v-2.8l-2-.6a7.7 7.7 0 0 0-.6-1.4l1-1.8-2-2-1.8 1A7.7 7.7 0 0 0 12.2 5l-.6-2H8.8l-.6 2a7.7 7.7 0 0 0-1.4.6L5 4.6l-2 2 1 1.8a7.7 7.7 0 0 0-.6 1.4l-2 .6v2.8l2 .6a7.7 7.7 0 0 0 .6 1.4L3 17l2 2 1.8-1a7.7 7.7 0 0 0 1.4.6l.6 2h2.8l.6-2a7.7 7.7 0 0 0 1.4-.6l1.8 1 2-2-1-1.8a7.7 7.7 0 0 0 .6-1.4l2-.4Z" transform="translate(2 0) scale(.83)" />
            </NavButton>
          </div>

          <div className="nova-sidebar-foot" aria-hidden="true">
            <span className="nova-key">⌃</span>
            <span className="nova-key">⇧</span>
            <span className="nova-key nova-key-wide">Space</span>
          </div>
        </nav>

        <main className="nova-workspace flex-1 overflow-hidden relative" aria-live="polite">
          <div className={`absolute inset-0 ${currentView === 'home' ? 'flex' : 'hidden'} flex-col`}><UnifiedPanel /></div>
          <div className={`absolute inset-0 ${currentView === 'history' ? 'flex' : 'hidden'} flex-col`}><HistoryPanel /></div>
          <div className={`absolute inset-0 ${currentView === 'settings' ? 'flex' : 'hidden'} flex-col`}><SettingsPanel /></div>
        </main>
      </div>
    </div>
  )
}

function NovaSignalMark() {
  return (
    <svg className="nova-brand-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="34" height="34" rx="10" />
      <path className="nova-mark-orbit" d="M7.2 23.4c3.8 5.1 13.2 6.4 19.5.5 5.4-5 3.8-12.9-1.7-16.1" />
      <path className="nova-mark-wave" d="M8.5 18h2.2l1.5-4.2 2.5 9.3 2.7-12.4 2.6 14.5 2.4-10.2 1.7 3h3.4" />
      <circle cx="27.1" cy="8.2" r="1.7" />
    </svg>
  )
}

function NavButton({ children, active, onClick, label, view }: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
  label: string
  view: ViewName
}) {
  return (
    <button type="button" onClick={onClick} className={`nova-nav-button no-drag ${active ? 'is-active' : ''}`} aria-label={label} aria-current={active ? 'page' : undefined} data-view={view}>
      <span className="nova-nav-indicator" />
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
      <span className="nova-nav-label">{label}</span>
    </button>
  )
}

export default App
