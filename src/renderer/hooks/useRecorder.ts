import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../stores/appStore'

declare global {
  interface Window {
    electronAPI: {
      startRecording: () => Promise<void>
      stopRecording: () => Promise<void>
      cancelRecording: () => Promise<void>
      sendAudioData: (buffer: ArrayBuffer) => Promise<void>
      sendAudioLevel: (level: number) => void
      onAudioLevel: (callback: (level: number) => void) => () => void
      onRecordingDuration: (callback: (duration: number) => void) => () => void
      onRecordingState: (callback: (state: { isRecording: boolean; duration: number }) => void) => () => void
      onTranscriptionResult: (callback: (result: any) => void) => () => void
      onTranscriptionProgress: (callback: (progress: number) => void) => () => void
      getSettings: () => Promise<any>
      setSettings: (settings: any) => Promise<void>
      getHistory: (limit?: number, offset?: number) => Promise<any[]>
      searchHistory: (query: string) => Promise<any[]>
      deleteHistory: (id: string) => Promise<void>
      onOverlayShow: (callback: () => void) => () => void
      onOverlayHide: (callback: () => void) => () => void
      getAIModes: () => Promise<any[]>
      getAIStatus: () => Promise<any>
      processWithAI: (text: string, modeId: string) => Promise<string>
      onAIStage: (callback: (stage: string) => void) => () => void
      speak: (text: string, options?: any) => Promise<void>
      getSpeakers: (lang?: string) => Promise<string[]>
      getMLXVoices: () => Promise<string[]>
      getMLXVoice: () => Promise<string>
      setMLXVoice: (voice: string) => Promise<void>
      getTTSServerStatuses: () => Promise<any[]>
      startTTSServer: (id: string) => Promise<boolean>
      stopTTSServer: (id: string) => Promise<boolean>
      previewTTSVoice: (id: string, voice?: string) => Promise<void>
      getSayVoices: () => Promise<any[]>
      getAllTtsAdapters: () => Promise<any>
      previewSayVoice: (voice: string, text?: string) => Promise<void>
      getPipelineStatus: () => Promise<any>
      getPipelineConfig: () => Promise<any>
      setPipelineConfig: (config: any) => Promise<void>
      initPipeline: () => Promise<any>
      // Claude Terminal
      claudeSend: (text: string) => Promise<string>
      getClaudeStatus: () => Promise<{ ready: boolean; path: string }>
      onClaudeOutput: (callback: (data: { type: string; text: string }) => void) => () => void
      onClaudeStatus: (callback: (status: { ready: boolean; path: string }) => void) => () => void
      onViewNavigate: (callback: (view: string) => void) => () => void
      // Real PTY Terminal (node-pty)
      ptyInput: (data: string) => void
      ptyResize: (cols: number, rows: number) => void
      ptyCreate: (cols?: number, rows?: number, force?: boolean) => Promise<{ ok: boolean }>
      ptyStatus: () => Promise<{ shell: string; ready: boolean }>
      getPathForFile: (file: File) => string
      ptyClaudeRunning: () => Promise<{ ready: boolean; claudeDetected: boolean }>
      ptyType: (command: string) => Promise<{ ok: boolean }>
      onPtyData: (callback: (data: string) => void) => () => void
      onPtyExit: (callback: (code: number) => void) => () => void
      // Attachment
      processAttachment: (opts: any) => Promise<any>
      getDebugLogs: () => Promise<{ ts: number; level: string; msg: string }[]>
      onDebugLog: (callback: (entry: { ts: number; level: string; msg: string }) => void) => () => void
      checkNCOHealth: () => Promise<{
        id: string; name: string; role: string; type: string;
        status: 'online' | 'offline' | 'degraded';
        latencyMs: number; version?: string; model?: string; error?: string; checkedAt: number
      }[]>
      cancelAI: () => Promise<{ cancelled: boolean }>
      onAICancelled: (callback: () => void) => (() => void) | undefined
      quit: () => void
      platform: string
    }
  }
}

export function useRecorder() {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const animFrameRef = useRef<number>(0)
  // 2초 무음 자동 종료
  const silenceStartRef = useRef<number>(0)
  const hadSpeechRef = useRef<boolean>(false)
  const SILENCE_THRESHOLD = 0.02  // RMS 기준 무음 임계값
  const SILENCE_TIMEOUT_MS = 2000 // 2초 무음 시 자동 종료

  const {
    isRecording,
    setRecording,
    setRecordingDuration,
    setAudioLevel,
    setIsTranscribing,
    setCurrentTranscription
  } = useAppStore()

  const cleanupRecordingResources = useCallback(async (options?: {
    resetState?: boolean
    discardRecorderHandlers?: boolean
  }) => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = 0
    }

    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    const mediaRecorder = mediaRecorderRef.current
    mediaRecorderRef.current = null
    if (mediaRecorder) {
      if (options?.discardRecorderHandlers) {
        mediaRecorder.ondataavailable = null
        mediaRecorder.onstop = null
      }
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop()
      }
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    const audioContext = audioContextRef.current
    audioContextRef.current = null
    if (audioContext && audioContext.state !== 'closed') {
      try {
        await audioContext.close()
      } catch (error) {
        console.warn('[Recorder] AudioContext close failed:', error)
      }
    }
    analyserRef.current = null
    silenceStartRef.current = 0
    hadSpeechRef.current = false

    if (options?.resetState) {
      setRecording(false)
      setRecordingDuration(0)
      setAudioLevel(0)
    }
  }, [setRecording, setRecordingDuration, setAudioLevel])

  useEffect(() => {
    return () => {
      void cleanupRecordingResources({ discardRecorderHandlers: true })
    }
  }, [cleanupRecordingResources])

  const startRecording = useCallback(async () => {
    try {
      console.log('[Recorder] Starting...')

      if (streamRef.current || mediaRecorderRef.current) {
        console.warn('[Recorder] Duplicate start prevented')
        await cleanupRecordingResources({
          resetState: true,
          discardRecorderHandlers: true,
        })
        return
      }

      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = 0
      }

      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          // 브라우저 DSP 끔 — Whisper + ffmpeg anlmdn이 더 정확함
          // 브라우저 노이즈 억제가 특정 주파수를 깎아 오히려 인식률 저하 유발
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      })
      console.log('[Recorder] Mic stream acquired')

      streamRef.current = stream
      audioChunksRef.current = []

      // Set up AudioContext + AnalyserNode for level visualization
      const audioContext = new AudioContext({ sampleRate: 16000 })
      // IMPORTANT: resume AudioContext (may be suspended by browser policy)
      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }
      console.log('[Recorder] AudioContext state:', audioContext.state)

      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)

      audioContextRef.current = audioContext
      analyserRef.current = analyser

      // Start audio level animation loop
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      let logCounter = 0

      const updateLevel = () => {
        if (!analyserRef.current) return

        // Use time-domain data for more responsive level detection
        analyserRef.current.getByteTimeDomainData(dataArray)

        // Calculate RMS (root mean square) for accurate volume level
        let sumSquares = 0
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128 // center around 0
          sumSquares += normalized * normalized
        }
        const rms = Math.sqrt(sumSquares / dataArray.length)

        // Scale to 0-1 range with amplification for visibility
        const level = Math.min(1, rms * 3.5)

        setAudioLevel(level)

        // 2초 무음 자동 종료 — 말을 한 적 있고, 이후 2초 동안 무음이면 자동 중지
        if (rms > 0.03) {
          // 음성 감지됨
          hadSpeechRef.current = true
          silenceStartRef.current = 0
        } else if (hadSpeechRef.current) {
          // 말한 후 무음 시작
          if (silenceStartRef.current === 0) {
            silenceStartRef.current = Date.now()
          } else if (Date.now() - silenceStartRef.current >= SILENCE_TIMEOUT_MS) {
            console.log('[Recorder] 2초 무음 감지 — 자동 종료')
            // stopRecording을 직접 호출하면 의존성 문제 → IPC로 트리거
            window.electronAPI?.stopRecording?.()
            return // 더 이상 animation frame 불필요
          }
        }

        // Forward audio level to overlay via IPC (throttle to ~20fps to reduce overhead)
        logCounter++
        if (logCounter % 3 === 0 && window.electronAPI?.sendAudioLevel) {
          window.electronAPI.sendAudioLevel(level)
        }

        // Debug log every ~1 second
        if (logCounter % 60 === 0) {
          console.log(`[Recorder] Audio level: ${level.toFixed(3)} (rms: ${rms.toFixed(4)})`)
        }

        animFrameRef.current = requestAnimationFrame(updateLevel)
      }
      animFrameRef.current = requestAnimationFrame(updateLevel)

      // Start MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000,  // 128kbps (기본 32~64kbps보다 훨씬 선명)
      })

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = async () => {
        console.log('[Recorder] MediaRecorder stopped, chunks:', audioChunksRef.current.length)
        if (audioChunksRef.current.length === 0) return

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType })
        const arrayBuffer = await audioBlob.arrayBuffer()
        console.log('[Recorder] Audio size:', (arrayBuffer.byteLength / 1024).toFixed(1), 'KB')

        setIsTranscribing(true)
        try {
          await window.electronAPI.sendAudioData(arrayBuffer)
        } catch (error) {
          console.error('[Recorder] Transcription failed:', error)
          setCurrentTranscription('음성 인식에 실패했어요. Whisper 모델 설정을 확인해주세요.')
        }
        setIsTranscribing(false)
      }

      mediaRecorder.start(100)
      mediaRecorderRef.current = mediaRecorder
      silenceStartRef.current = 0
      hadSpeechRef.current = false

      setRecording(true)
      const now = Date.now()

      // Duration timer
      timerRef.current = setInterval(() => {
        setRecordingDuration((Date.now() - now) / 1000)
      }, 100)

      console.log('[Recorder] Recording started')
    } catch (error) {
      await cleanupRecordingResources({
        resetState: true,
        discardRecorderHandlers: true,
      })
      const err = error as DOMException
      let userMsg = '마이크 접근에 실패했어요.'
      if (err.name === 'NotAllowedError') {
        userMsg = '마이크 권한을 허용해주세요. 시스템 설정에서 확인해주세요.'
      } else if (err.name === 'NotFoundError') {
        userMsg = '연결된 마이크가 없어요.'
      } else if (err.name === 'NotReadableError') {
        userMsg = '마이크가 다른 앱에서 사용 중이에요.'
      }
      console.error('[Recorder] Failed to start:', err.name, err.message)
      setCurrentTranscription(userMsg)
    }
  }, [cleanupRecordingResources, setRecording, setRecordingDuration, setAudioLevel, setIsTranscribing, setCurrentTranscription])

  const stopRecording = useCallback(() => {
    console.log('[Recorder] Stopping...')
    void cleanupRecordingResources({ resetState: true })
  }, [cleanupRecordingResources])

  const cancelRecording = useCallback(() => {
    console.log('[Recorder] Cancelling...')
    audioChunksRef.current = []
    void cleanupRecordingResources({
      resetState: true,
      discardRecorderHandlers: true,
    })
  }, [cleanupRecordingResources])

  return {
    isRecording,
    startRecording,
    stopRecording,
    cancelRecording
  }
}
