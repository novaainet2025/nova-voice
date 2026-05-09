import React, { useMemo } from 'react'
import { useAppStore } from '../../stores/appStore'

const BAR_COUNT = 24

export function RecordingOverlay() {
  const {
    isRecording, recordingDuration, audioLevel,
    currentTranscription, isTranscribing, aiStage,
    currentMode, aiModes
  } = useAppStore()

  const formattedDuration = useMemo(() => {
    const mins = Math.floor(recordingDuration / 60)
    const secs = Math.floor(recordingDuration % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }, [recordingDuration])

  const activeMode = aiModes.find(m => m.id === currentMode)
  const stageLabels: Record<string, string> = {
    'transcribing':    '🎙 음성 인식 중...',
    'ai_processing':   `${activeMode?.icon || '🤖'} ${activeMode?.name || 'AI'} 처리 중...`,
    'ai_answering':    '💬 답변 생성 중...',
    'ai_searching':    '🔍 실시간 검색 중...',
    'screen_capture':  '📷 화면 캡처 중...',
    'screen_analyzing':'👁 화면 분석 중...',
    'command_parsing': '⚡ 명령 실행 중...',
    'nco_processing':  '🧠 NCO 처리 중...',
    'confirm_required':'⚠️ 확인 필요...',
    'nco_discussion':  '🗣 토론 중...',
    'nco_parallel':    '👥 팀 작업 중...',
    'nco_agent':       '🤖 에이전트 작업 중...',
    'nco_hive':        '🐝 하이브 실행 중...',
  }
  const colonIdx = aiStage.indexOf(':')
  const stageKey = colonIdx >= 0 ? aiStage.substring(0, colonIdx) : aiStage
  const stageDetail = colonIdx >= 0 ? aiStage.substring(colonIdx + 1) : ''
  const stageLabel = stageLabels[stageKey] || ''
  const stageDisplay = stageLabel + (stageDetail ? ` — ${stageDetail}` : '')

  return (
    <div className="flex items-center justify-center w-full h-full p-4">
      <div className="glass rounded-2xl px-6 py-4 w-full max-w-[380px] shadow-2xl border border-white/10">
        {isRecording && (
          <>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse-recording" />
              <span className="text-sm font-medium text-white/80">Recording</span>
              {activeMode && activeMode.id !== 'direct' && (
                <span className="text-xs bg-primary-600/30 text-primary-300 px-2 py-0.5 rounded-full">
                  {activeMode.icon} {activeMode.name}
                </span>
              )}
              <span className="text-sm font-mono text-white/50 ml-auto">{formattedDuration}</span>
            </div>

            <div className="flex items-center justify-center gap-[3px] h-14 mb-3">
              {Array.from({ length: BAR_COUNT }, (_, i) => {
                const phase = Math.sin(Date.now() / 90 + i * 0.65) * 0.3 + 0.7
                const phase2 = Math.cos(Date.now() / 150 + i * 1.0) * 0.2
                const raw = audioLevel * (phase + phase2)
                const h = 4 + raw * 48
                const centerDist = Math.abs(i - BAR_COUNT / 2) / (BAR_COUNT / 2)
                const opacity = 0.4 + (1 - centerDist) * 0.6
                return (
                  <div key={i} className="rounded-full" style={{
                    width: 4, height: Math.max(4, h),
                    backgroundColor: `rgba(116, 143, 252, ${opacity})`,
                    transition: 'height 80ms ease-out',
                  }} />
                )
              })}
            </div>
            <button
              onClick={() => window.electronAPI?.cancelRecording?.()}
              className="w-full text-xs text-white/30 hover:text-red-400 transition-colors py-1"
            >
              취소 (Esc)
            </button>
          </>
        )}

        {/* AI processing stage */}
        {stageLabel && !isRecording && (
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-4 h-4 border-2 border-t-transparent rounded-full animate-spin ${
              stageKey.startsWith('screen') ? 'border-cyan-400' :
              stageKey === 'ai_searching' ? 'border-yellow-400' :
              stageKey === 'ai_answering' ? 'border-green-400' :
              stageKey === 'command_parsing' ? 'border-orange-400' :
              stageKey.startsWith('nco') ? 'border-purple-400' :
              'border-primary-400'
            }`} />
            <span className={`text-sm ${
              stageKey.startsWith('screen') ? 'text-cyan-300' :
              stageKey === 'ai_searching' ? 'text-yellow-300' :
              stageKey === 'ai_answering' ? 'text-green-300' :
              stageKey === 'command_parsing' ? 'text-orange-300' :
              stageKey.startsWith('nco') ? 'text-purple-300' :
              'text-white/60'
            }`}>{stageDisplay}</span>
          </div>
        )}

        {currentTranscription && !isRecording && !stageLabel && (
          <div className="mt-1">
            <p className="text-sm text-white/90 leading-relaxed line-clamp-5">
              {currentTranscription}
            </p>
          </div>
        )}

        {!isRecording && !currentTranscription && !isTranscribing && !stageLabel && (
          <div className="text-center">
            <p className="text-sm text-white/40">
              Press <kbd className="px-2 py-0.5 bg-white/10 rounded text-white/60 text-xs">
                {window.electronAPI?.platform === 'darwin' ? '⌃' : 'Ctrl'} + Shift + Space
              </kbd> to start
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
