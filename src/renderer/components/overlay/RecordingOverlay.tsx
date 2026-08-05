import React, { useMemo } from 'react'
import { AudioVisualizer } from '../visualizer/AudioVisualizer'
import { useAppStore } from '../../stores/appStore'

export function RecordingOverlay() {
  const {
    isRecording,
    recordingDuration,
    currentTranscription,
    isTranscribing,
    transcriptionProgress,
    transcriptionStage,
    history,
    settings,
    activeInputMode,
  } = useAppStore()
  // While a capture is running the hotkey that started it wins, so the overlay
  // shows the mode this utterance is actually using.
  const inputMode = activeInputMode ?? settings?.inputMode ?? 'normal'
  const latestResult = history[0]

  const duration = useMemo(() => {
    const minutes = Math.floor(recordingDuration / 60)
    const seconds = Math.floor(recordingDuration % 60)
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }, [recordingDuration])

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div className="nova-overlay-card glass w-full max-w-[390px] rounded-[22px] px-5 py-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative flex h-6 w-6 items-center justify-center rounded-lg border border-primary-300/20 bg-primary-400/10" aria-hidden="true">
              <span className="absolute h-2.5 w-3.5 -rotate-12 rounded-[50%] border border-primary-300/35" />
              <span className="h-1 w-1 rounded-full bg-red-300 shadow-[0_0_6px_rgba(255,107,116,.7)]" />
            </div>
            <div>
              <p className="text-[9px] font-semibold tracking-[0.16em] text-white/55">NOVA VOICE</p>
              <p className="mt-0.5 font-mono text-[8px] text-white/20">WHISPER STT · PCM 16 KHZ</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`rounded-full border px-2 py-1 text-[8px] font-mono tracking-wide ${inputMode === 'meta' ? 'border-violet-300/20 bg-violet-300/[0.08] text-violet-100/75' : inputMode === 'computer' ? 'border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-100/80' : 'border-white/[0.07] bg-white/[0.045] text-white/40'}`}>
              {inputMode === 'meta' ? 'META AI' : inputMode === 'computer' ? 'CONTROL' : 'NORMAL'}
            </span>
            <span className="rounded-full border border-white/[0.07] bg-white/[0.045] px-2 py-1 text-[9px] text-white/40">MLX</span>
          </div>
        </div>

        {isRecording && (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="relative flex h-3 w-3 items-center justify-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-red-400/25" />
                <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
              </span>
              <span className="text-xs font-medium text-white/72">{inputMode === 'meta' ? '메타 모드로 듣고 있습니다' : inputMode === 'computer' ? '컴퓨터 제어 명령을 듣고 있습니다' : '일반 모드로 듣고 있습니다'}</span>
              <span className="ml-auto font-mono text-xs tabular-nums text-white/40">{duration}</span>
            </div>
            <div className="mb-2 h-14 w-full">
              <AudioVisualizer active variant="overlay" mode={inputMode} />
            </div>
            <button type="button" onClick={() => void window.electronAPI.cancelRecording()} className="w-full py-1 text-[10px] text-white/25 transition-colors hover:text-red-300">Esc · 녹음 취소</button>
          </>
        )}

        {isTranscribing && !isRecording && (
          <div className="py-3">
            <div className="flex items-center gap-3">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-400 border-t-transparent" />
              <span className="text-xs text-white/60">
                {transcriptionStage === 'meta-prompting'
                  ? (inputMode === 'computer' ? '명령을 실행하는 중' : 'AI가 프롬프트로 다듬는 중')
                  : transcriptionStage === 'injecting'
                    ? '포커스 위치에 입력 중'
                    : inputMode === 'meta'
                      ? 'Whisper 인식 후 프롬프트로 다듬기'
                      : 'Whisper 음성 인식 중'}
              </span>
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full bg-gradient-to-r from-primary-400 to-purple-400 transition-all" style={{ width: `${Math.max(12, transcriptionProgress * 100)}%` }} />
            </div>
          </div>
        )}

        {currentTranscription && !isRecording && !isTranscribing && (
          <div className="mt-1 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3.5 py-3">
            {latestResult?.inputMode === 'meta' && (
              <p className="mb-2 text-[8px] font-mono tracking-wide text-violet-200/65">
                META 완료 · {(latestResult.metaPromptProvider || 'AI').replace(/^(?:NCO|Local AI)\s*·\s*/i, '').toUpperCase()}
                {latestResult.metaPromptDuration != null ? ` · ${latestResult.metaPromptDuration.toFixed(2)}s` : ''}
              </p>
            )}
            <p className="line-clamp-4 select-text text-xs leading-relaxed text-white/78">{currentTranscription}</p>
          </div>
        )}

        {!isRecording && !isTranscribing && !currentTranscription && (
          <div className="space-y-1.5 py-3 text-center text-[11px] text-white/32">
            <div>
              <kbd className="rounded-md border border-white/[0.07] bg-white/[0.045] px-2 py-1 font-mono text-[10px] text-white/55">⌃ ⇧ Space</kbd>
              <span className="ml-2">일반 받아쓰기</span>
            </div>
            <div>
              <kbd className="rounded-md border border-violet-300/15 bg-violet-300/[0.05] px-2 py-1 font-mono text-[10px] text-violet-100/60">⌃ ⇧ ⌥ Space</kbd>
              <span className="ml-2">메타 프롬프트</span>
            </div>
            <div>
              <kbd className="rounded-md border border-emerald-300/15 bg-emerald-300/[0.05] px-2 py-1 font-mono text-[10px] text-emerald-100/65">⌃ ⌥ Space</kbd>
              <span className="ml-2">컴퓨터 제어</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
