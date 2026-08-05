/**
 * Speaks short answers through the local all-tts hub.
 *
 * The hub already runs on this machine and exposes several backends. Two are
 * installed, and edge_tts was measured at roughly half the latency of mac_say
 * (360ms against 851ms warm, same sentence), so it is the default — a spoken
 * answer that arrives a second late feels broken in a way a written one does
 * not. `speak` never throws: failing to speak should not fail the utterance
 * that produced the answer.
 */
import { execFile as execFileCallback } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { logInfo, logWarn } from './logger.ts'

const TTS_BASE = 'http://127.0.0.1:7861'
/** Measured 2× faster than mac_say and the only adapter that streams. */
const DEFAULT_ADAPTER = 'edge_tts'
const DEFAULT_VOICE = 'ko-KR-SunHiNeural'
const SYNTHESIS_TIMEOUT_MS = 15_000
const HEALTH_TIMEOUT_MS = 1_500
/** Long answers are truncated rather than narrated at length. */
const MAX_SPEECH_LENGTH = 400

let playback: ReturnType<typeof execFileCallback> | null = null

export interface SpeechResult {
  spoken: string
  adapter: string
  synthesisMs: number
}

/** True when the hub is reachable and has at least one adapter. */
export async function isTtsAvailable(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(`${TTS_BASE}/health`, { signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json().catch(() => ({})) as { adapters?: unknown }
    return Array.isArray(body.adapters) && body.adapters.length > 0
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Strips what should be heard but not read aloud.
 *
 * A spoken answer carrying markdown reads as punctuation noise, and a URL read
 * character by character is unusable, so both are reduced to something a
 * listener can follow.
 */
export function toSpeakableText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' 코드 블록 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' 이미지 ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' 링크 ')
    // Bold is unwrapped before list markers are stripped: doing it the other
    // way round eats the opening ** and leaves the closing one behind.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^[#>\-*]+\s*/gm, '')
    .replace(/[|_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPEECH_LENGTH)
}

/** Stops whatever is currently being spoken. */
export function stopSpeaking(): void {
  if (!playback) return
  try {
    playback.kill('SIGTERM')
  } catch {
    // The player may already have exited.
  }
  playback = null
}

/**
 * Synthesises text and plays it.
 *
 * A new request cancels the previous playback: two answers talking over each
 * other is worse than losing the older one.
 */
export async function speak(
  text: string,
  options: { adapter?: string; voice?: string; signal?: AbortSignal } = {},
): Promise<SpeechResult | null> {
  const spoken = toSpeakableText(text)
  if (!spoken) return null

  const adapter = options.adapter ?? DEFAULT_ADAPTER
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SYNTHESIS_TIMEOUT_MS)
  const abortFromParent = () => controller.abort()
  options.signal?.addEventListener('abort', abortFromParent, { once: true })

  try {
    const response = await fetch(`${TTS_BASE}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: spoken,
        adapter,
        voice: options.voice ?? DEFAULT_VOICE,
        format: 'mp3',
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      logWarn('[TTS] Synthesis rejected', { status: response.status, adapter })
      return null
    }

    const body = await response.json() as { url?: unknown; ms?: unknown }
    if (typeof body.url !== 'string' || !body.url) {
      logWarn('[TTS] Synthesis returned no audio', { adapter })
      return null
    }

    const file = await downloadAudio(body.url, controller.signal)
    if (!file) return null

    stopSpeaking()
    playPath(file)

    const synthesisMs = typeof body.ms === 'number' ? body.ms : 0
    logInfo('[TTS] Speaking', { adapter, chars: spoken.length, synthesisMs })
    return { spoken, adapter, synthesisMs }
  } catch (error) {
    if (!controller.signal.aborted) {
      logWarn('[TTS] Failed to speak', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return null
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromParent)
  }
}

async function downloadAudio(urlPath: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(`${TTS_BASE}${urlPath}`, { signal })
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    // The hub serves the file over HTTP, but afplay needs it on disk.
    const file = path.join(os.tmpdir(), `nova-tts-${Date.now()}.mp3`)
    fs.writeFileSync(file, buffer)
    return file
  } catch {
    return null
  }
}

/**
 * Plays the file without blocking the caller.
 *
 * Speech runs alongside whatever happens next — the user should be able to
 * start a new dictation while an answer is still being read.
 */
function playPath(file: string): void {
  playback = execFileCallback('afplay', [file], () => {
    playback = null
    try {
      fs.unlinkSync(file)
    } catch {
      // A leftover temp file is not worth reporting.
    }
  })
}

/** Voices the hub offers for the given adapter, for the settings screen. */
export async function listVoices(adapter = DEFAULT_ADAPTER): Promise<string[]> {
  try {
    const response = await fetch(`${TTS_BASE}/api/adapters`)
    if (!response.ok) return []
    const body = await response.json() as {
      adapters?: Array<{ name?: unknown; speaker_rule?: unknown }>
    }
    const entry = (body.adapters ?? []).find((item) => item.name === adapter)
    if (typeof entry?.speaker_rule !== 'string') return []
    return entry.speaker_rule.split(',').map((voice) => voice.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** Confirms `afplay` exists; without it synthesis would succeed but stay silent. */
export function canPlayAudio(): boolean {
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/afplay')
}

export async function ttsDiagnostics(): Promise<Record<string, unknown>> {
  return {
    available: await isTtsAvailable(),
    canPlay: canPlayAudio(),
    adapter: DEFAULT_ADAPTER,
    voice: DEFAULT_VOICE,
  }
}
