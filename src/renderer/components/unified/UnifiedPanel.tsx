import React, { useMemo, useState } from 'react'
import { STT_ENGINE_NAME } from '../../../shared/types'
import { AudioVisualizer } from '../visualizer/AudioVisualizer'
import { useAppStore } from '../../stores/appStore'

export function UnifiedPanel() {
  const {
    isRecording,
    recordingDuration,
    currentTranscription,
    transcriptionProgress,
    isTranscribing,
    history,
    sttStatus,
    settings,
    metaPromptStatus,
    transcriptionStage,
    activeInputMode,
    setSettings,
  } = useAppStore()
  const [copied, setCopied] = useState(false)
  const [modeSaveError, setModeSaveError] = useState('')
  const [modeChanging, setModeChanging] = useState(false)

  const duration = useMemo(() => {
    const minutes = Math.floor(recordingDuration / 60)
    const seconds = Math.floor(recordingDuration % 60)
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }, [recordingDuration])

  const inputMode = activeInputMode ?? settings?.inputMode ?? 'normal'
  const latestLatency = history[0]?.processingDuration ?? history[0]?.duration
  const statusLabel = transcriptionStage === 'meta-prompting'
    ? 'AI가 요청을 프롬프트로 다듬는 중입니다'
    : transcriptionStage === 'injecting'
      ? '포커스 위치에 입력하는 중입니다'
      : isRecording
    ? '듣고 있습니다'
    : isTranscribing
      ? 'Whisper가 변환 중입니다'
      : sttStatus?.ready === false
        ? 'Whisper를 준비하고 있습니다'
        : inputMode === 'meta'
          ? '메타 모드 · 말한 요청을 프롬프트로 다듬을 준비가 됐습니다'
          : '일반 모드 · 바로 받아쓸 준비가 됐습니다'
  const latestResult = history[0]

  const toggleRecording = () => {
    if (modeChanging) return
    void (isRecording ? window.electronAPI.stopRecording() : window.electronAPI.startRecording())
  }

  const copyResult = async () => {
    if (!currentTranscription) return
    await navigator.clipboard.writeText(currentTranscription)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const selectInputMode = async (mode: 'normal' | 'meta') => {
    if (!settings || settings.inputMode === mode || isRecording || isTranscribing) return
    setModeSaveError('')
    setModeChanging(true)
    try {
      const confirmed = await window.electronAPI.setSettings({ inputMode: mode })
      setSettings(confirmed)
    } catch {
      setModeSaveError('모드 저장에 실패했습니다. 다시 선택해주세요.')
      setSettings(await window.electronAPI.getSettings())
    } finally {
      setModeChanging(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-6 sm:px-8 sm:py-7">
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col">
        <header className="flex items-end justify-between gap-5">
          <div>
            <p className="nova-eyebrow">WHISPER DICTATION</p>
            <h1 className="nova-page-title">빠른 받아쓰기</h1>
            <p className="nova-page-copy">말하는 순간부터 텍스트가 되는 순간까지만 집중합니다.</p>
          </div>
          <div className="hidden sm:flex items-center gap-2 rounded-full border border-emerald-300/10 bg-emerald-300/[0.045] px-3 py-1.5 text-[9px] font-mono tracking-[0.12em] text-emerald-200/70">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(87,217,183,.65)]" />
            PCM · 16 KHZ · MLX
          </div>
        </header>

        <div className="mt-5 grid gap-2 rounded-[20px] border border-white/[0.075] bg-black/15 p-1.5 sm:grid-cols-2" role="group" aria-label="받아쓰기 출력 모드">
          <button
            type="button"
            onClick={() => void selectInputMode('normal')}
            disabled={!settings || isRecording || isTranscribing || modeChanging}
            aria-pressed={inputMode === 'normal'}
            className={`flex min-h-14 items-center gap-3 rounded-[15px] px-4 text-left transition-all disabled:cursor-not-allowed disabled:opacity-55 ${
              inputMode === 'normal'
                ? 'border border-white/[0.1] bg-white/[0.075] shadow-[0_10px_28px_rgba(0,0,0,.16)]'
                : 'border border-transparent hover:bg-white/[0.035]'
            }`}
          >
            <span className={`flex h-8 w-8 items-center justify-center rounded-xl border font-mono text-[10px] ${inputMode === 'normal' ? 'border-white/15 bg-white/10 text-white/80' : 'border-white/[0.07] text-white/28'}`}>TXT</span>
            <span>
              <span className="block text-xs font-medium text-white/75">일반</span>
              <span className="mt-0.5 block text-[10px] text-white/30">받아쓴 문장을 바로 입력</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => void selectInputMode('meta')}
            disabled={!settings || isRecording || isTranscribing || modeChanging}
            aria-pressed={inputMode === 'meta'}
            className={`relative flex min-h-14 items-center gap-3 overflow-hidden rounded-[15px] px-4 text-left transition-all disabled:cursor-not-allowed disabled:opacity-55 ${
              inputMode === 'meta'
                ? 'border border-violet-300/20 bg-[linear-gradient(110deg,rgba(108,92,231,.16),rgba(91,141,239,.1))] shadow-[0_12px_34px_rgba(69,64,170,.17)]'
                : 'border border-transparent hover:bg-white/[0.035]'
            }`}
          >
            {inputMode === 'meta' && <span className="pointer-events-none absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-violet-300/80 to-transparent" />}
            <span className={`flex h-8 w-8 items-center justify-center rounded-xl border ${inputMode === 'meta' ? 'border-violet-300/25 bg-violet-300/10 text-violet-100' : 'border-white/[0.07] text-white/28'}`} aria-hidden="true">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3Z"/><path d="m18.5 15 .7 2.1 2.3.9-2.3.9-.7 2.1-.7-2.1-2.3-.9 2.3-.9.7-2.1Z"/></svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-xs font-medium text-white/78">
                메타 프롬프트
                <span className={`h-1.5 w-1.5 rounded-full ${metaPromptStatus?.available || metaPromptStatus?.localAvailable ? 'bg-emerald-300 shadow-[0_0_7px_rgba(87,217,183,.7)]' : 'bg-amber-300/70'}`} />
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-white/30">
                {!settings?.ncoEnabled
                  ? '로컬 AI · qwen3:14b 전용'
                  : metaPromptStatus?.available
                  ? `AI 병렬 연결 · ${metaPromptStatus.readyProviders?.join(' · ') || 'NCO'} · qwen3:14b`
                  : metaPromptStatus?.localAvailable
                    ? '로컬 AI · qwen3:14b 활성 · NCO 자동 재연결'
                    : 'AI 연결 필요 · 메타 프롬프트 일시 중지'}
              </span>
            </span>
          </button>
        </div>
        {modeSaveError && <p role="alert" className="mt-2 text-[10px] text-red-200/70">{modeSaveError}</p>}
        {!modeSaveError && (
          <p role="status" data-input-mode={inputMode} className={`mt-2 text-[10px] ${inputMode === 'meta' ? 'text-violet-200/65' : 'text-white/32'}`}>
            {modeChanging
              ? '출력 모드를 적용하는 중입니다…'
              : inputMode === 'meta'
                ? '메타 모드 적용됨 · 말한 요청을 AI가 알아듣기 좋은 프롬프트로 다듬어 입력합니다.'
                : '일반 모드 적용됨 · 다음 녹음은 Whisper 원문을 바로 입력합니다.'}
          </p>
        )}

        <section className="mt-4 grid flex-1 gap-4 lg:grid-cols-[1.05fr_.95fr]">
          <div className="glass-light relative flex min-h-[330px] flex-col items-center justify-center overflow-hidden rounded-[28px] border border-white/[0.075] p-7 text-center">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(109,139,255,.13),transparent_42%)]" />
            <div className="relative z-10">
              <p className={`text-xs font-medium tracking-wide ${isRecording ? 'text-red-200' : isTranscribing ? 'text-primary-200' : 'text-white/48'}`}>
                {statusLabel}
              </p>

              <button
                type="button"
                onClick={toggleRecording}
                disabled={isTranscribing || sttStatus?.ready === false || modeChanging}
                className={`group relative mx-auto mt-7 flex h-28 w-28 items-center justify-center rounded-full border transition-all duration-300 active:scale-95 disabled:cursor-wait disabled:opacity-55 ${
                  isRecording
                    ? 'border-red-300/30 bg-red-400/18 shadow-[0_0_0_10px_rgba(255,107,116,.035),0_24px_70px_rgba(255,107,116,.19)]'
                    : 'border-primary-300/25 bg-primary-400/12 shadow-[0_0_0_10px_rgba(109,139,255,.03),0_24px_70px_rgba(76,96,210,.2)] hover:bg-primary-400/18'
                }`}
                aria-label={isRecording ? '녹음 중지' : '녹음 시작'}
              >
                {isRecording && <span className="absolute inset-[-10px] rounded-full border border-red-300/10 animate-ping" />}
                {isRecording ? (
                  <span className="h-7 w-7 rounded-lg bg-red-200 shadow-[0_0_18px_rgba(255,160,166,.55)]" />
                ) : (
                  <svg className="h-10 w-10 text-primary-100 transition-transform group-hover:scale-105" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.45" d="M12 3.5A3.5 3.5 0 0 0 8.5 7v5a3.5 3.5 0 0 0 7 0V7A3.5 3.5 0 0 0 12 3.5Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.45" d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" />
                  </svg>
                )}
              </button>

              <div className="mt-6 h-14 w-[260px] max-w-full">
                {isRecording ? (
                  <AudioVisualizer active variant="panel" mode={inputMode} label="마이크 입력 스펙트럼" />
                ) : isTranscribing ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                      <div className="h-full rounded-full bg-gradient-to-r from-primary-400 to-purple-400 transition-all" style={{ width: `${Math.max(12, transcriptionProgress * 100)}%` }} />
                    </div>
                    <span className="text-[10px] font-mono text-white/30">ZERO-COPY PCM TRANSFER</span>
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-1.5 text-[11px] text-white/28">
                    <span className="flex items-center gap-2">
                      <kbd className="rounded-md border border-white/[0.08] bg-white/[0.035] px-2 py-1 font-mono text-white/48">⌃ ⇧ Space</kbd>
                      일반 받아쓰기
                    </span>
                    <span className="flex items-center gap-2">
                      <kbd className="rounded-md border border-violet-300/15 bg-violet-300/[0.05] px-2 py-1 font-mono text-violet-100/60">⌃ ⇧ ⌥ Space</kbd>
                      메타 프롬프트
                    </span>
                  </div>
                )}
              </div>

              {isRecording && <p className="mt-1 font-mono text-sm tabular-nums text-white/45">{duration}</p>}
            </div>
          </div>

          <div className="flex min-h-[330px] flex-col gap-4">
            <article className="glass-light flex min-h-[215px] flex-1 flex-col rounded-[24px] border border-white/[0.075] p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[9px] font-mono tracking-[0.16em] text-white/25">LATEST TRANSCRIPT</p>
                  <p className="mt-1 text-xs text-white/45">가장 최근에 인식한 문장</p>
                </div>
                <button type="button" onClick={() => void copyResult()} disabled={!currentTranscription} className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5 text-[10px] text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/75 disabled:opacity-25">
                  {copied ? '복사됨' : '복사'}
                </button>
              </div>
              <div className="mt-5 flex flex-1 items-center">
                {currentTranscription ? (
                  <div>
                    {latestResult?.inputMode === 'meta' && (
                      <div className="mb-3 flex items-center gap-2">
                        <span className="rounded-full border border-violet-300/15 bg-violet-300/[0.06] px-2 py-1 text-[8px] font-mono tracking-[0.12em] text-violet-200/75">
                          {latestResult.metaPromptOutcome === 'local-ai'
                            ? `META · ${(latestResult.metaPromptProvider || 'Local AI · qwen3:14b').replace(/^Local AI\s*·\s*/i, '').toUpperCase()}`
                            : latestResult.metaPromptOutcome === 'local'
                              ? 'META · SAFE'
                              : latestResult.metaPromptOutcome === 'fallback'
                                ? 'META · LEGACY'
                                : `META · ${(latestResult.metaPromptProvider || 'NCO').replace(/^NCO\s*·\s*/i, '').toUpperCase()}`}
                        </span>
                        {latestResult.metaPromptOutcome === 'local-ai' && <span className="text-[9px] text-violet-200/55">실제 로컬 AI 답변 완료</span>}
                        {latestResult.metaPromptOutcome === 'local' && <span className="text-[9px] text-amber-200/55">AI 불가 · 안전 가공 완료</span>}
                        {latestResult.metaPromptOutcome === 'fallback' && <span className="text-[9px] text-amber-200/55">이전 기록 · 원문 사용</span>}
                      </div>
                    )}
                    <p className="select-text whitespace-pre-wrap text-[15px] leading-7 text-white/82">{currentTranscription}</p>
                    {latestResult?.inputMode === 'meta' && latestResult.sourceText && latestResult.sourceText !== currentTranscription && (
                      <p className="mt-4 border-t border-white/[0.055] pt-3 text-[10px] leading-5 text-white/28">원문 · {latestResult.sourceText}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm leading-6 text-white/24">마이크 버튼을 누르고 자연스럽게 말해보세요.<br />인식된 텍스트가 여기에 표시됩니다.</p>
                )}
              </div>
            </article>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/[0.065] bg-white/[0.022] px-4 py-3.5">
                <p className="text-[9px] font-mono tracking-[0.12em] text-white/24">ENGINE</p>
                <p className="mt-2 truncate text-xs text-white/65" title={STT_ENGINE_NAME}>large-v3-turbo</p>
              </div>
              <div className="rounded-2xl border border-white/[0.065] bg-white/[0.022] px-4 py-3.5">
                <p className="text-[9px] font-mono tracking-[0.12em] text-white/24">PROCESS LATENCY</p>
                <p className="mt-2 text-xs text-white/65">{latestLatency ? `${latestLatency.toFixed(2)} sec` : '—'}</p>
                {latestResult?.metaPromptDuration != null && <p className="mt-1 text-[9px] text-violet-200/40">AI {latestResult.metaPromptDuration.toFixed(2)} sec</p>}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
