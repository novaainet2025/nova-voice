import WebSocket from 'ws'
import { logInfo, logWarn } from './logger'
import { ensureSttServerReady, restartSttServer } from './stt-server'
import { normalizeTranscript } from './transcript-normalizer'

export interface WhisperOptions {
  signal?: AbortSignal
}

export interface WhisperResult {
  text: string
  language: 'ko'
  duration: number
}

const STT_WS_URL = 'ws://127.0.0.1:8765/ws/stt'
const CHUNK_SAMPLES = 4096
const CHUNK_BYTES = CHUNK_SAMPLES * 2
// Four 4096-sample chunks provide 1.024s of silence. Three chunks (0.768s)
// sit too close to the server VAD's 0.7s boundary and can produce an empty
// final for otherwise valid speech after windowing/state transitions.
const FINALIZE_SILENCE_CHUNKS = 4
const MAX_TRANSCRIPTION_ATTEMPTS = 2
const RETRY_DELAY_MS = 120
const INITIAL_TRANSCRIPTION_TIMEOUT_MS = 45_000
const RECOVERY_TRANSCRIPTION_TIMEOUT_MS = 90_000

// The server finalises a segment 0.7s after speech stops, so audio that is
// streamed while the user is still talking is already decoded by the time the
// renderer's own endpointing fires. A capture that is only uploaded after the
// recording ends pays the full decode cost as visible latency instead.
const LIVE_DRAIN_POLL_MS = 10
const LIVE_DRAIN_MAX_MS = 250

let whisperReady = false

interface LiveCapture {
  socket: WebSocket
  finals: string[]
  buffered: Buffer[]
  bytes: number
  open: boolean
  failed: boolean
  pending: Buffer[]
  startedAt: number
  /** Resolves once the server acknowledges the post-finalize echo. */
  settle?: (error?: Error) => void
}

let liveCapture: LiveCapture | null = null

function destroyLiveCapture(capture: LiveCapture | null): void {
  if (!capture) return
  capture.failed = true
  capture.settle?.(new Error('Live capture closed'))
  capture.settle = undefined
  try {
    capture.socket.close()
  } catch {
    // The socket may already be closing.
  }
}

/**
 * Opens the STT socket while the user is still speaking and starts feeding it
 * audio immediately. Never throws: a failed session simply degrades to the
 * buffered {@link transcribePcm} path.
 */
export function beginLiveCapture(): void {
  if (liveCapture) {
    destroyLiveCapture(liveCapture)
    liveCapture = null
  }

  let socket: WebSocket
  try {
    socket = new WebSocket(STT_WS_URL)
  } catch (error) {
    logWarn('[Whisper] Live capture socket could not be created', {
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }

  const capture: LiveCapture = {
    socket,
    finals: [],
    buffered: [],
    bytes: 0,
    open: false,
    failed: false,
    pending: [],
    startedAt: performance.now(),
  }
  liveCapture = capture

  socket.once('open', () => {
    if (liveCapture !== capture) {
      destroyLiveCapture(capture)
      return
    }
    capture.open = true
    // Deliberately no `engine` key: the server answers any message carrying one
    // with an `info` frame, and `info` is reserved here as the finalize
    // terminator. mlx is already the server-side default for a new connection.
    socket.send(JSON.stringify({ partials: false }))
    for (const chunk of capture.pending) socket.send(chunk)
    capture.pending = []
  })
  socket.once('error', (error) => {
    capture.failed = true
    capture.settle?.(new Error(`Whisper WebSocket error: ${error.message}`))
    capture.settle = undefined
  })
  socket.once('close', () => {
    capture.open = false
    capture.failed = true
    capture.settle?.(new Error('Whisper connection closed before final result'))
    capture.settle = undefined
  })
  socket.on('message', (data) => {
    let message: { type?: string; text?: string }
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }
    if (message.type === 'final') {
      // The engine emits one final per completed VAD segment. A mid-sentence
      // pause longer than the server's 0.7s window therefore splits an
      // utterance, so every segment has to be kept in arrival order.
      const text = (message.text || '').trim()
      if (text) capture.finals.push(text)
    } else if (message.type === 'info') {
      // Echo of the post-finalize engine ping: the server processes messages
      // sequentially, so every final it will ever send has already arrived.
      capture.settle?.()
      capture.settle = undefined
    } else if (message.type === 'error') {
      capture.settle?.(new Error(message.text || 'Whisper server error'))
      capture.settle = undefined
    }
  })
}

/** Streams one recorded chunk to the live session. */
export function pushLiveAudio(chunk: Buffer): void {
  const capture = liveCapture
  if (!capture || capture.failed) return
  capture.buffered.push(chunk)
  capture.bytes += chunk.byteLength
  if (capture.open) {
    try {
      capture.socket.send(chunk)
    } catch {
      capture.failed = true
    }
  } else {
    capture.pending.push(chunk)
  }
}

export function abortLiveCapture(): void {
  destroyLiveCapture(liveCapture)
  liveCapture = null
}

/**
 * Finishes the streamed utterance. Resolves to `null` when the session cannot
 * be trusted, which tells the caller to fall back to a buffered upload.
 */
export async function finishLiveCapture(
  streamedBytes: number,
  signal?: AbortSignal,
  timeoutMs = INITIAL_TRANSCRIPTION_TIMEOUT_MS,
): Promise<WhisperResult | null> {
  const capture = liveCapture
  liveCapture = null
  if (!capture) return null
  if (capture.failed || !capture.open) {
    destroyLiveCapture(capture)
    return null
  }
  const finishStartedAt = performance.now()

  // The final PCM arrives on a different IPC channel than the streamed chunks.
  // Give the stream a bounded moment to catch up before judging completeness.
  const drainDeadline = Date.now() + LIVE_DRAIN_MAX_MS
  while (capture.bytes < streamedBytes && Date.now() < drainDeadline && !capture.failed) {
    await new Promise((resolve) => setTimeout(resolve, LIVE_DRAIN_POLL_MS))
  }
  if (capture.failed || capture.bytes < streamedBytes) {
    logWarn('[Whisper] Live capture incomplete; falling back to buffered upload', {
      streamedBytes,
      receivedBytes: capture.bytes,
      failed: capture.failed,
    })
    destroyLiveCapture(capture)
    return null
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let done = false
      const finish = (error?: Error) => {
        if (done) return
        done = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abortFromParent)
        if (error) reject(error)
        else resolve()
      }
      const timeout = setTimeout(() => finish(new Error('Whisper STT timed out')), timeoutMs)
      const abortFromParent = () => finish(new Error('Whisper STT cancelled'))
      if (signal?.aborted) {
        finish(new Error('Whisper STT cancelled'))
        return
      }
      signal?.addEventListener('abort', abortFromParent, { once: true })
      capture.settle = finish

      const silence = Buffer.alloc(CHUNK_BYTES)
      for (let index = 0; index < FINALIZE_SILENCE_CHUNKS; index++) capture.socket.send(silence)
      capture.socket.send(JSON.stringify({ finalize: true }))
      // `finalize` only answers when no segment final was sent yet, so it is not
      // a reliable terminator. The engine echo always answers and, because the
      // handler is sequential, it can only be processed after every final.
      capture.socket.send(JSON.stringify({ engine: 'mlx' }))
    })
  } catch (error) {
    destroyLiveCapture(capture)
    if (signal?.aborted) throw error
    logWarn('[Whisper] Live capture finalize failed; falling back to buffered upload', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }

  destroyLiveCapture(capture)
  const transcript = capture.finals.join(' ').trim()
  // `duration` is what the UI shows as recognition latency, so it has to be the
  // work left after the recording stopped — not the length of the recording.
  // Streaming exists precisely to make those two numbers differ.
  const finalizeMs = performance.now() - finishStartedAt
  logInfo('[Whisper] Live capture finished', {
    segments: capture.finals.length,
    textLength: transcript.length,
    bytes: capture.bytes,
    finalizeMs: Math.round(finalizeMs),
    captureSpanMs: Math.round(performance.now() - capture.startedAt),
  })
  return {
    text: normalizeTranscript(filterHallucinations(transcript)),
    language: 'ko',
    duration: finalizeMs / 1000,
  }
}

export async function initWhisper(): Promise<boolean> {
  whisperReady = await ensureSttServerReady(30_000)
  console.log(`[Whisper] Server ${whisperReady ? 'ready' : 'not ready'} at ${STT_WS_URL}`)
  return whisperReady
}

export async function ensureSttReady(maxWaitMs = 10_000): Promise<boolean> {
  whisperReady = await ensureSttServerReady(maxWaitMs)
  return whisperReady
}

export async function transcribePcm(
  pcmData: Buffer,
  sampleRate: number,
  options: WhisperOptions = {},
): Promise<WhisperResult> {
  if (sampleRate !== 16_000) {
    throw new Error(`Expected 16000Hz PCM, received ${sampleRate}Hz`)
  }
  if (!await ensureSttReady()) {
    throw new Error('Whisper STT server is not ready')
  }

  const startedAt = performance.now()
  let transcript = ''
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= MAX_TRANSCRIPTION_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) throw new Error('Whisper STT cancelled')
    try {
      const result = await transcribeViaWebSocket(
        pcmData,
        options.signal,
        attempt === 1 ? INITIAL_TRANSCRIPTION_TIMEOUT_MS : RECOVERY_TRANSCRIPTION_TIMEOUT_MS,
      )
      transcript = result.text.trim()
      if (transcript) break
      lastError = new Error('Whisper returned an empty final result')
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = error instanceof Error ? error : new Error(String(error))
    }

    if (attempt < MAX_TRANSCRIPTION_ATTEMPTS) {
      logWarn('[Whisper] Transcription attempt failed; retrying once', {
        attempt,
        bytes: pcmData.byteLength,
        error: lastError.message,
      })
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      const transportFailed = /(?:timed out|connection closed|WebSocket error)/i.test(lastError.message)
      const recovered = transportFailed
        ? await restartSttServer(30_000)
        : await ensureSttReady(5_000)
      if (!recovered) throw new Error(`Whisper STT recovery failed after: ${lastError.message}`)
    }
  }

  if (!transcript && lastError && !/empty final result/i.test(lastError.message)) throw lastError
  logInfo('[Whisper] Transcription attempts finished', {
    bytes: pcmData.byteLength,
    textLength: transcript.length,
    recovered: Boolean(lastError && transcript),
  })
  return {
    text: normalizeTranscript(filterHallucinations(transcript)),
    language: 'ko',
    duration: (performance.now() - startedAt) / 1000,
  }
}

function transcribeViaWebSocket(
  pcmData: Buffer,
  signal?: AbortSignal,
  timeoutMs = INITIAL_TRANSCRIPTION_TIMEOUT_MS,
): Promise<{ text: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(STT_WS_URL)
    const finals: string[] = []
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromParent)
      socket.close()
      if (error) reject(error)
      else resolve({ text: finals.join(' ').trim() })
    }
    const timeout = setTimeout(() => finish(new Error('Whisper STT timed out')), timeoutMs)
    const abortFromParent = () => finish(new Error('Whisper STT cancelled'))

    if (signal?.aborted) {
      finish(new Error('Whisper STT cancelled'))
      return
    }
    signal?.addEventListener('abort', abortFromParent, { once: true })

    socket.once('error', (error) => finish(new Error(`Whisper WebSocket error: ${error.message}`)))
    socket.once('open', () => {
      // No `engine` key: the server answers any message carrying one with an
      // `info` frame, which is used below as the deterministic terminator.
      socket.send(JSON.stringify({ partials: false }))
      for (let offset = 0; offset < pcmData.length; offset += CHUNK_BYTES) {
        socket.send(pcmData.subarray(offset, Math.min(offset + CHUNK_BYTES, pcmData.length)))
      }
      const silence = Buffer.alloc(CHUNK_BYTES)
      for (let index = 0; index < FINALIZE_SILENCE_CHUNKS; index++) socket.send(silence)
      socket.send(JSON.stringify({ finalize: true }))
      // `finalize` answers only when no segment final was sent yet, so closing
      // on the first final used to drop every later segment of a long
      // utterance — and hang whenever no segment completed at all.
      socket.send(JSON.stringify({ engine: 'mlx' }))
    })
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.type === 'final') {
          console.log(`[Whisper] Final in ${message.latency_ms}ms (rtf=${message.rtf})`)
          const text = (message.text || '').trim()
          if (text) finals.push(text)
        } else if (message.type === 'info') {
          finish()
        } else if (message.type === 'error') {
          finish(new Error(message.text || 'Whisper server error'))
        }
      } catch {
        // Ignore unrelated server messages.
      }
    })
    socket.once('close', () => {
      if (!settled) finish(new Error('Whisper connection closed before final result'))
    })
  })
}

export async function warmupWhisper(): Promise<boolean> {
  if (!await ensureSttReady(30_000)) return false

  return new Promise((resolve) => {
    const socket = new WebSocket(STT_WS_URL)
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.close()
      console.log(`[Whisper] Model warmup ${ready ? 'complete' : 'skipped'}`)
      resolve(ready)
    }
    const timeout = setTimeout(() => finish(false), 60_000)
    socket.once('error', () => finish(false))
    socket.once('open', () => socket.send(JSON.stringify({ warmup: true, engine: 'mlx' })))
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.type === 'ready') finish(true)
        else if (message.type === 'error') finish(false)
      } catch {
        // Ignore malformed messages.
      }
    })
  })
}

function filterHallucinations(text: string): string {
  if (!text) return ''
  const phantomPhrases = [
    /^(MBC 뉴스|KBS 뉴스|SBS 뉴스).*$/i,
    /^시청해 ?주셔서 ?감사합니다\.?$/,
    /^감사합니다\.?$/,
    /^(구독|좋아요|알림).*(눌러|부탁).*$/,
    /^Thank(s| you) for watching\.?$/i,
    /^Subtitles by.*$/i,
    /^♪.*$/,
    /자막.*제공/,
    /Amara\.org/i,
  ]
  if (phantomPhrases.some((pattern) => pattern.test(text.trim()))) return ''
  return text
}
