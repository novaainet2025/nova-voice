import { useCallback, useEffect, useRef } from 'react'
import { SPECTRUM_BANDS } from '../../shared/types.ts'
import type { AppSettings, MetaPromptStatus, SttStatus, TranscriptionResult, TranscriptionStage, VoiceInputMode } from '../../shared/types.ts'
import { useAppStore } from '../stores/appStore.ts'

declare global {
  interface Window {
    electronAPI: {
      startRecording: (mode?: VoiceInputMode) => Promise<void>
      stopRecording: () => Promise<void>
      cancelRecording: () => Promise<void>
      sendPcmData: (buffer: ArrayBuffer, sampleRate: number, streamedBytes?: number) => Promise<TranscriptionResult | null>
      sendPcmChunk: (buffer: ArrayBuffer) => void
      runVerificationInjection: (text: string) => Promise<boolean>
      getVerificationWindowState: () => Promise<{ visible: boolean; destroyed: boolean }>
      getVerificationTargetContext: () => Promise<{ targetAppName: string; targetBundleId: string; cliTarget: boolean }>
      setVerificationPcmDelay: (delayMs: number) => Promise<number>
      sendAudioLevel: (level: number) => void
      onAudioLevel: (callback: (level: number) => void) => () => void
      sendAudioSpectrum: (bands: Uint8Array) => void
      onAudioSpectrum: (callback: (bands: Uint8Array) => void) => () => void
      onRecordingDuration: (callback: (duration: number) => void) => () => void
      onRecordingState: (callback: (state: { isRecording: boolean; duration: number; cancelled?: boolean; inputMode?: VoiceInputMode }) => void) => () => void
      onTranscriptionResult: (callback: (result: TranscriptionResult) => void) => () => void
      onTranscriptionProgress: (callback: (progress: number) => void) => () => void
      onTranscriptionStage: (callback: (stage: TranscriptionStage) => void) => () => void
      getSttStatus: () => Promise<SttStatus>
      getMetaPromptStatus: () => Promise<MetaPromptStatus>
      reconnectNcoProvider: (provider: string) => Promise<MetaPromptStatus>
      getSettings: () => Promise<AppSettings>
      setSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>
      onSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
      getLoginItemStatus: () => Promise<{ supported: boolean; openAtLogin: boolean; status: string }>
      setLoginItemEnabled: (enabled: boolean) => Promise<{ supported: boolean; openAtLogin: boolean; status: string }>
      getHistory: (limit?: number, offset?: number) => Promise<TranscriptionResult[]>
      searchHistory: (query: string) => Promise<TranscriptionResult[]>
      deleteHistory: (id: string) => Promise<void>
      onViewNavigate: (callback: (view: string) => void) => () => void
      quit: () => void
      platform: string
    }
  }
}

const PCM_WORKLET = `
class NovaPcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(4096);
    this.offset = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'flush' && this.offset > 0) {
        const tail = this.chunk.slice(0, this.offset);
        this.port.postMessage(tail, [tail.buffer]);
        this.offset = 0;
      }
    };
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const count = Math.min(this.chunk.length - this.offset, input.length - sourceOffset);
      this.chunk.set(input.subarray(sourceOffset, sourceOffset + count), this.offset);
      this.offset += count;
      sourceOffset += count;
      if (this.offset === this.chunk.length) {
        const completed = this.chunk;
        this.port.postMessage(completed, [completed.buffer]);
        this.chunk = new Float32Array(4096);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('nova-pcm-recorder', NovaPcmRecorder);
`

/** Float32 [-1,1] → little-endian 16-bit PCM, the wire format the STT server reads. */
function toPcm16(chunk: Float32Array): Int16Array {
  const pcm = new Int16Array(chunk.length)
  for (let index = 0; index < chunk.length; index++) {
    const sample = Math.max(-1, Math.min(1, chunk[index]))
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return pcm
}

/**
 * Collapses the FFT into log-spaced bands. Linear bins waste most of the width
 * on frequencies speech barely uses, which is what makes a plain bin-per-bar
 * meter look flat and lifeless.
 */
function buildSpectrum(source: Uint8Array, target: Uint8Array, minBin: number, maxBin: number): void {
  const ratio = maxBin / minBin
  let previous = minBin
  for (let band = 0; band < target.length; band++) {
    const upper = Math.min(
      maxBin,
      Math.max(previous + 1, Math.round(minBin * Math.pow(ratio, (band + 1) / target.length))),
    )
    let peak = 0
    for (let bin = previous; bin < upper; bin++) {
      if (source[bin] > peak) peak = source[bin]
    }
    target[band] = peak
    previous = upper
  }
}

export function useRecorder() {
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const recorderNodeRef = useRef<AudioWorkletNode | null>(null)
  const silentGainRef = useRef<GainNode | null>(null)
  const pcmChunksRef = useRef<Float32Array[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const animFrameRef = useRef(0)
  const silenceStartRef = useRef(0)
  const hadSpeechRef = useRef(false)
  const stoppingRef = useRef(false)
  const captureRequestedRef = useRef(false)
  const transcriptionSequenceRef = useRef(0)
  const streamedBytesRef = useRef(0)
  const spectrumRef = useRef(new Uint8Array(SPECTRUM_BANDS))

  const {
    isRecording,
    settings,
    setRecording,
    setRecordingDuration,
    setAudioLevel,
    setSpectrum,
    resetSpectrum,
    setIsTranscribing,
    setCurrentTranscription,
  } = useAppStore()

  const releaseCapture = useCallback(async (flushTail: boolean) => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = 0
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (flushTail && recorderNodeRef.current) {
      recorderNodeRef.current.port.postMessage('flush')
      await new Promise((resolve) => window.setTimeout(resolve, 35))
    }

    recorderNodeRef.current?.disconnect()
    silentGainRef.current?.disconnect()
    sourceRef.current?.disconnect()
    recorderNodeRef.current = null
    silentGainRef.current = null
    sourceRef.current = null
    analyserRef.current = null

    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    const context = audioContextRef.current
    audioContextRef.current = null
    if (context && context.state !== 'closed') {
      await context.close().catch(() => undefined)
    }

    silenceStartRef.current = 0
    hadSpeechRef.current = false
    setRecording(false)
    setRecordingDuration(0)
    setAudioLevel(0)
    resetSpectrum()
  }, [resetSpectrum, setAudioLevel, setRecording, setRecordingDuration])

  const sendCapturedPcm = useCallback(async (sampleRate: number) => {
    const chunks = pcmChunksRef.current
    pcmChunksRef.current = []
    const streamedBytes = streamedBytesRef.current
    streamedBytesRef.current = 0
    const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    if (sampleCount < sampleRate * 0.15) {
      // Too short to transcribe. Cancel so the main process drops the streamed
      // session and stops holding the injection target.
      await window.electronAPI.cancelRecording().catch(() => undefined)
      setCurrentTranscription('음성이 너무 짧습니다. 조금 더 길게 말해주세요.')
      return
    }

    const pcm = new Int16Array(sampleCount)
    let offset = 0
    for (const chunk of chunks) {
      pcm.set(toPcm16(chunk), offset)
      offset += chunk.length
    }

    const sequence = ++transcriptionSequenceRef.current
    setIsTranscribing(true)
    try {
      await window.electronAPI.sendPcmData(pcm.buffer as ArrayBuffer, sampleRate, streamedBytes)
    } catch (error) {
      console.error('[Recorder] STT failed:', error)
      const detail = error instanceof Error ? error.message : String(error)
      setCurrentTranscription(detail.includes('META_PROMPT_AI_UNAVAILABLE')
        ? '메타 프롬프트 AI에 연결하지 못했습니다. NCO 또는 로컬 AI 상태를 확인한 뒤 다시 시도해주세요.'
        : '음성 인식에 실패했습니다. Whisper 서버 상태를 확인해주세요.')
    } finally {
      // A newer capture may already be in flight. An older, cancelled request
      // must not make the UI look idle while the newer request is processing.
      if (transcriptionSequenceRef.current === sequence) setIsTranscribing(false)
    }
  }, [setCurrentTranscription, setIsTranscribing])

  const startRecording = useCallback(async () => {
    if (streamRef.current) return
    if (stoppingRef.current) {
      // Meta prompting and injection can outlive capture teardown. Remember a
      // start request made in that narrow window instead of silently dropping
      // it and leaving the main process in the recording state with no stream.
      captureRequestedRef.current = true
      console.log('[Recorder] Capture start queued until teardown completes')
      return
    }
    captureRequestedRef.current = true

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      if (!captureRequestedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
      if (context.state === 'suspended') await context.resume()

      const workletUrl = URL.createObjectURL(new Blob([PCM_WORKLET], { type: 'text/javascript' }))
      try {
        await context.audioWorklet.addModule(workletUrl)
      } finally {
        URL.revokeObjectURL(workletUrl)
      }
      if (!captureRequestedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        await context.close().catch(() => undefined)
        return
      }

      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      // 1024 bins give the log-spaced visualiser enough low-frequency detail to
      // separate vowels; the smoothing below is done per bar instead.
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.2
      const recorderNode = new AudioWorkletNode(context, 'nova-pcm-recorder')
      const silentGain = context.createGain()
      silentGain.gain.value = 0

      pcmChunksRef.current = []
      streamedBytesRef.current = 0
      recorderNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const chunk = new Float32Array(event.data)
        pcmChunksRef.current.push(chunk)
        // Feed the STT server while the user is still speaking. Its VAD then
        // finalises the segment on its own, so the decode is already done (or
        // nearly done) by the time the recording stops.
        const encoded = toPcm16(chunk)
        streamedBytesRef.current += encoded.byteLength
        window.electronAPI.sendPcmChunk(encoded.buffer as ArrayBuffer)
      }

      source.connect(analyser)
      source.connect(recorderNode)
      recorderNode.connect(silentGain)
      silentGain.connect(context.destination)

      streamRef.current = stream
      audioContextRef.current = context
      sourceRef.current = source
      analyserRef.current = analyser
      recorderNodeRef.current = recorderNode
      silentGainRef.current = silentGain
      silenceStartRef.current = 0
      hadSpeechRef.current = false

      const levelData = new Uint8Array(analyser.fftSize)
      const frequencyData = new Uint8Array(analyser.frequencyBinCount)
      // 16 kHz capture over 1024 bins ≈ 15.6 Hz per bin. Bins 3–170 cover
      // roughly 45 Hz – 2.7 kHz, where speech energy actually lives.
      const minBin = 3
      const maxBin = Math.min(analyser.frequencyBinCount - 1, 170)
      const spectrum = spectrumRef.current
      let frame = 0
      const updateLevel = () => {
        if (!analyserRef.current) return
        analyserRef.current.getByteTimeDomainData(levelData)
        let sumSquares = 0
        for (let i = 0; i < levelData.length; i++) {
          const normalized = (levelData[i] - 128) / 128
          sumSquares += normalized * normalized
        }
        const rms = Math.sqrt(sumSquares / levelData.length)
        const level = Math.min(1, rms * 4)
        setAudioLevel(level)

        if (rms > 0.018) {
          hadSpeechRef.current = true
          silenceStartRef.current = 0
        } else if (hadSpeechRef.current) {
          if (!silenceStartRef.current) silenceStartRef.current = Date.now()
          else if (Date.now() - silenceStartRef.current >= (settings?.silenceTimeoutMs ?? 900)) {
            void window.electronAPI.stopRecording()
            return
          }
        }

        frame++
        if (frame % 2 === 0) {
          analyserRef.current.getByteFrequencyData(frequencyData)
          buildSpectrum(frequencyData, spectrum, minBin, maxBin)
          setSpectrum(spectrum)
          window.electronAPI.sendAudioSpectrum(spectrum)
        }
        if (frame % 3 === 0) window.electronAPI.sendAudioLevel(level)
        animFrameRef.current = requestAnimationFrame(updateLevel)
      }
      animFrameRef.current = requestAnimationFrame(updateLevel)

      setRecording(true)
      const startedAt = Date.now()
      timerRef.current = setInterval(() => {
        setRecordingDuration((Date.now() - startedAt) / 1000)
      }, 100)
      console.log(`[Recorder] PCM capture started at ${context.sampleRate}Hz`)
    } catch (error) {
      captureRequestedRef.current = false
      pcmChunksRef.current = []
      await releaseCapture(false)
      const failure = error as DOMException
      const message = failure.name === 'NotAllowedError'
        ? '마이크 권한을 허용해주세요.'
        : failure.name === 'NotFoundError'
          ? '연결된 마이크가 없습니다.'
          : '마이크를 시작하지 못했습니다.'
      setCurrentTranscription(message)
      console.error('[Recorder] Start failed:', failure)
      // The main process optimistically enters the recording state before the
      // renderer acquires a microphone stream. Roll it back on capture failure
      // so the next shortcut/click is treated as a fresh start.
      await window.electronAPI.cancelRecording().catch(() => undefined)
    }
  }, [releaseCapture, setAudioLevel, setCurrentTranscription, setRecording, setRecordingDuration, setSpectrum, settings?.silenceTimeoutMs])

  const stopRecording = useCallback(async () => {
    captureRequestedRef.current = false
    if (!streamRef.current || stoppingRef.current) return
    stoppingRef.current = true
    const sampleRate = audioContextRef.current?.sampleRate ?? 16000
    let processing: Promise<void> | null = null
    try {
      await releaseCapture(true)
      // Snapshot and clear the completed PCM synchronously before a queued
      // recording can replace pcmChunksRef.current.
      processing = sendCapturedPcm(sampleRate)
    } finally {
      stoppingRef.current = false
      if (captureRequestedRef.current && !streamRef.current) {
        console.log('[Recorder] Starting queued capture after teardown')
        void startRecording()
      }
    }
    await processing
  }, [releaseCapture, sendCapturedPcm, startRecording])

  const cancelRecording = useCallback(async () => {
    captureRequestedRef.current = false
    if (stoppingRef.current) {
      // Cancels a queued restart. The active capture is already being released.
      return
    }
    pcmChunksRef.current = []
    await releaseCapture(false)
  }, [releaseCapture])

  useEffect(() => () => {
    captureRequestedRef.current = false
    pcmChunksRef.current = []
    void releaseCapture(false)
  }, [releaseCapture])

  return { isRecording, startRecording, stopRecording, cancelRecording }
}
