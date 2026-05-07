import { app } from 'electron'
import { execFile as execFileCb, ChildProcess, spawn } from 'child_process'
import { promisify } from 'util'
import http from 'http'
import fs from 'fs'
import path from 'path'

const execFile = promisify(execFileCb)

// Track current playback process for cancellation
let currentPlayback: ChildProcess | null = null

// Track server processes for start/stop management
const serverProcesses: Map<string, ChildProcess> = new Map()

const COSYVOICE_API  = 'http://localhost:8900'
const TTS_API        = 'http://localhost:7860'

// ── 3-Server MLX 아키텍처 (모델 교체 제로 = cold start 제거) ──────────────
// 각 서버는 단일 모델만 상주 → 모델 스왑 없음 → 지연 0.1초 이하
const MLX_KO_API     = 'http://localhost:8800'   // Qwen3-TTS — 한국어 전용
const MLX_EN_API     = 'http://localhost:8801'   // Kokoro-82M — 영어 전용 (82MB 상주)
const MLX_MIX_API    = 'http://localhost:8802'   // Spark-TTS-0.5B — 한영 혼용 전용 (단일 모델)
const MLX_TTS_API    = MLX_KO_API  // backward compat

const MLX_KO_MODEL   = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit'   // Korean best quality
const MLX_EN_MODEL   = 'mlx-community/Kokoro-82M-bf16'                   // English ~50ms
const MLX_MIX_MODEL  = 'mlx-community/Spark-TTS-0.5B-bf16'              // Multilingual, no swap (bf16 = stable)
const MLX_TTS_MODEL        = MLX_KO_MODEL   // backward compat
const MLX_TTS_MODEL_KOKORO = MLX_EN_MODEL   // backward compat

const MLX_WARMUP_TEXT = '안녕'
let mlxTTSVoice = 'Ryan'  // Ryan: best Korean quality (natural male voice)

// Available MLX TTS voices (Qwen3-TTS) — ordered by Korean quality
export const MLX_VOICES = ['Ryan', 'Chelsie', 'Vivian', 'Aiden', 'Ethan', 'Serena', 'Eric', 'Dylan'] as const
export type MLXVoice = typeof MLX_VOICES[number]

// UI 화자 → Kokoro :8801 voice ID 개별 매핑 (5종 실제 다화자)
const KOKORO_VOICE_MAP: Record<string, string> = {
  Ryan:    'am_adam',   // American male, clear/professional
  Chelsie: 'af_bella',  // American female, bright
  Vivian:  'af_heart',  // American female, warm
  Aiden:   'am_adam',   // American male (energetic feel)
  Ethan:   'bm_george', // British male, calm/stable
  Serena:  'bf_emma',   // British female, warm
  Eric:    'am_adam',   // American male, deep
  Dylan:   'bm_george', // British male, casual
}

// UI 화자 → Spark :8802 voice ID 개별 매핑 (4종 실제 다화자, 한국어)
const SPARK_VOICE_MAP: Record<string, string> = {
  Ryan:    'ko_male',   // 한국어 남성 (기본)
  Chelsie: 'ko_female', // 한국어 여성 (기본)
  Vivian:  'female_1',  // 여성 variant 1 (다른 톤)
  Aiden:   'ko_male',   // 한국어 남성
  Ethan:   'male_1',    // 남성 variant 1 (다른 톤)
  Serena:  'ko_female', // 한국어 여성
  Eric:    'male_1',    // 남성 variant 1
  Dylan:   'ko_male',   // 한국어 남성
}

// @@gentop Qwen3-TTS CustomVoice 9화자 매핑
// 서버: http://localhost:7860/api/voices/qwen3-tts/tts
// 화자: sohee(여), aiden(남), dylan(남), eric(남), ono_anna(여), ryan(남), serena(여), uncle_fu(남), vivian(여)
const QWEN3_VOICE_MAP: Record<string, string> = {
  Ryan:    'ryan',      // 남성, 직접 매핑
  Chelsie: 'sohee',    // 여성, sohee (밝고 자연스러운 한국어 여성)
  Vivian:  'vivian',   // 여성, 직접 매핑
  Aiden:   'aiden',    // 남성, 직접 매핑
  Ethan:   'uncle_fu', // 남성, uncle_fu (중후한 남성)
  Serena:  'serena',   // 여성, 직접 매핑
  Eric:    'eric',     // 남성, 직접 매핑
  Dylan:   'dylan',    // 남성, 직접 매핑
}

function getKokoroVoice(mlxVoice: string): string {
  return KOKORO_VOICE_MAP[mlxVoice] || 'am_adam'
}

function getSparkVoice(mlxVoice: string): string {
  return SPARK_VOICE_MAP[mlxVoice] || 'ko_male'
}

function getQwen3Voice(mlxVoice: string): string {
  return QWEN3_VOICE_MAP[mlxVoice] || 'sohee'
}

export function setMLXVoice(voice: string): void {
  mlxTTSVoice = voice
  console.log(`[TTS-MLX] Voice set to: ${voice}`)
}

export function getMLXVoice(): string {
  return mlxTTSVoice
}
const TTS_PROJECT = '/Users/nova-ai/project/@@gentop/lib/tts'

// HTTP helper
function httpRequest(url: string, opts: { method: string; body?: string; timeout?: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method,
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      timeout: opts.timeout || 30000
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`TTS HTTP ${res.statusCode}: ${buf.toString()}`))
        } else {
          resolve(buf)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('TTS request timeout')) })
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

// Check if CosyVoice2 server is running (best quality, MPS GPU)
export async function isCosyVoiceAvailable(): Promise<boolean> {
  try {
    const data = await httpRequest(`${COSYVOICE_API}/health`, { method: 'GET', timeout: 2000 })
    const result = JSON.parse(data.toString())
    return result.status === 'ok'
  } catch {
    return false
  }
}

// Synthesize via CosyVoice2 (MPS GPU accelerated, best Korean quality)
export async function synthesizeCosyVoice(text: string): Promise<string> {
  const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

  const id = `cv2-${Date.now()}`
  const audioPath = path.join(cacheDir, `${id}.wav`)

  console.log(`[CosyVoice2] Synthesizing: "${text.substring(0, 50)}..."`)
  const start = Date.now()

  const body = JSON.stringify({ text, lang: 'ko' })
  const audioData = await httpRequest(`${COSYVOICE_API}/api/tts`, {
    method: 'POST',
    body,
    timeout: 60000  // CosyVoice2 warm 합성 ~5-8s
  })

  fs.writeFileSync(audioPath, audioData)
  const elapsed = Date.now() - start
  console.log(`[CosyVoice2] Done in ${elapsed}ms (${(audioData.length / 1024).toFixed(0)}KB)`)

  return audioPath
}


// Check if legacy TTS server is running
export async function isTTSAvailable(): Promise<boolean> {
  try {
    const data = await httpRequest(`${TTS_API}/health`, { method: 'GET', timeout: 3000 })
    const result = JSON.parse(data.toString())
    return result.status === 'ok' || result.status === 'running' || !!result.server
  } catch {
    return false
  }
}

// Start TTS server if not running
export async function ensureTTSServer(): Promise<boolean> {
  if (await isTTSAvailable()) return true

  console.log('[TTS] Server not running, starting...')
  try {
    const startScript = path.join(TTS_PROJECT, 'start.sh')
    if (!fs.existsSync(startScript)) {
      console.log('[TTS] start.sh not found at:', startScript)
      return false
    }

    // Start in background
    const { spawn } = require('child_process')
    const proc = spawn('bash', [startScript, '--no-open'], {
      cwd: TTS_PROJECT,
      detached: true,
      stdio: 'ignore'
    })
    proc.unref()

    // Wait up to 30s for server to start
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      if (await isTTSAvailable()) {
        console.log('[TTS] Server started successfully')
        return true
      }
    }
    console.log('[TTS] Server start timeout')
    return false
  } catch (e) {
    console.error('[TTS] Failed to start server:', (e as Error).message)
    return false
  }
}

// Synthesize text to speech
export interface TTSOptions {
  text: string
  lang?: string       // 'ko' | 'en' | 'ja' | 'zh'
  speaker?: string    // 'sohee' | 'aiden' | 'dylan' | 'eric' | 'serena' | 'ryan' | 'vivian'
  speed?: number      // 0.5 - 2.0
  voice?: string      // 'qwen3-tts' | 'voxcpm2' | 'melo' (default: qwen3-tts)
  instruct?: string   // 감정/톤 지시 (예: "밝고 활기차게", "차분하고 부드럽게")
}

export interface TTSResult {
  id: string
  url: string
  wavPath: string
  duration: number
}

export async function synthesize(options: TTSOptions): Promise<TTSResult> {
  const voiceId = options.voice || 'qwen3-tts'
  const activeSpeaker = options.speaker || mlxTTSVoice
  const body = JSON.stringify({
    text: options.text,
    lang: options.lang || 'ko',
    speaker: activeSpeaker,
    speed: options.speed || 1.0,
    instruct: options.instruct
  })

  console.log(`[TTS] Synthesizing (${voiceId}/${activeSpeaker}): "${options.text.substring(0, 50)}..."`)

  // Use Qwen3-TTS / VoxCPM2 voice endpoint (natural voices)
  const endpoint = voiceId === 'melo'
    ? `${TTS_API}/api/tts`
    : `${TTS_API}/api/voices/${voiceId}/tts`

  const data = await httpRequest(endpoint, { method: 'POST', body, timeout: 60000 })
  const result = JSON.parse(data.toString())

  // Download WAV to local cache
  const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

  const wavPath = path.join(cacheDir, `${result.id}.wav`)
  const audioData = await httpRequest(`${TTS_API}${result.url}`, { method: 'GET', timeout: 30000 })
  fs.writeFileSync(wavPath, audioData)

  console.log(`[TTS] Saved: ${wavPath} (${(audioData.length / 1024).toFixed(0)}KB)`)

  return {
    id: result.id,
    url: result.url,
    wavPath,
    duration: result.ms / 1000
  }
}

// Stop any currently playing audio
export function stopPlayback(): void {
  if (currentPlayback && !currentPlayback.killed) {
    currentPlayback.kill('SIGTERM')
    currentPlayback = null
    console.log('[TTS] Stopped previous playback')
  }
}

// Play audio file using system player
export async function playAudio(wavPath: string): Promise<void> {
  if (!fs.existsSync(wavPath)) {
    throw new Error(`Audio file not found: ${wavPath}`)
  }

  // Kill previous playback before starting new one
  stopPlayback()

  return new Promise<void>((resolve, reject) => {
    const { execFile: execFileCb } = require('child_process')

    let args: string[]
    let cmd: string

    if (process.platform === 'darwin') {
      cmd = 'afplay'
      args = [wavPath]
    } else if (process.platform === 'win32') {
      cmd = 'powershell'
      args = ['-Command', `(New-Object Media.SoundPlayer "${wavPath}").PlaySync()`]
    } else {
      cmd = 'aplay'
      args = [wavPath]
    }

    const proc: ChildProcess = execFileCb(cmd, args, (error: Error | null) => {
      currentPlayback = null
      if (error) {
        // SIGTERM from stopPlayback() is expected, not an error
        if ((error as any).signal === 'SIGTERM' || (error as any).killed) {
          resolve()
        } else if (process.platform === 'linux' && cmd === 'aplay') {
          // Fallback to paplay on Linux
          const fallback: ChildProcess = execFileCb('paplay', [wavPath], (err2: Error | null) => {
            currentPlayback = null
            err2 ? reject(err2) : resolve()
          })
          currentPlayback = fallback
        } else {
          reject(error)
        }
      } else {
        resolve()
      }
    })

    currentPlayback = proc

    // Timeout: kill afplay if it hangs (max 60s)
    const timeout = setTimeout(() => {
      if (proc && !proc.killed) {
        console.warn('[TTS] Playback timeout, killing process')
        proc.kill('SIGTERM')
      }
    }, 60000)

    proc.on('exit', () => clearTimeout(timeout))
  })
}

// Synthesize and immediately play
export async function speak(text: string, options?: Partial<TTSOptions>): Promise<TTSResult> {
  const result = await synthesize({ text, ...options })
  await playAudio(result.wavPath)
  return result
}

// ─── Qwen3-TTS 청크 스트리밍 (파이프라인 합성+재생) ────────────────────────
// 텍스트를 짧은 청크로 분리 → chunk[i] 재생 중에 chunk[i+1] 동시 합성
// 효과: 첫 소리 대기 1.5-2s (기존 4-8s), 전체 시간 30-50% 단축

function splitForQwen3Streaming(text: string, maxLen = 60): string[] {
  // 1단계: 강한 문장 경계에서 분리 (.!?。！？ 및 줄바꿈)
  const raw = text
    .split(/(?<=[.!?。！？])\s+|(?<=\n)/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  const chunks: string[] = []

  for (const sentence of raw) {
    if (sentence.length <= maxLen) {
      chunks.push(sentence)
    } else {
      // 2단계: 쉼표·한국어 접속부사 앞에서 추가 분리
      const parts = sentence
        .split(/(?<=[,，、])\s*|(?=그리고\s|그래서\s|하지만\s|또한\s|따라서\s|그런데\s|즉\s)/u)
        .map(s => s.trim())
        .filter(s => s.length > 0)

      let current = ''
      for (const part of parts) {
        if (current.length + part.length <= maxLen) {
          current += (current ? ' ' : '') + part
        } else {
          if (current) chunks.push(current)
          // 단일 part가 maxLen 초과 시 어절(공백) 단위 분리
          if (part.length > maxLen) {
            const words = part.split(/\s+/)
            let sub = ''
            for (const w of words) {
              if (sub.length + w.length + 1 <= maxLen) {
                sub += (sub ? ' ' : '') + w
              } else {
                if (sub) chunks.push(sub)
                sub = w.length > maxLen ? w.slice(0, maxLen) : w
              }
            }
            if (sub) chunks.push(sub)
            current = ''
          } else {
            current = part
          }
        }
      }
      if (current) chunks.push(current)
    }
  }

  // 3단계: 너무 짧은 끝 청크는 앞에 합치기 (8자 이하 단독 청크 방지)
  const merged: string[] = []
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1]
    if (prev && chunk.length <= 8 && prev.length + chunk.length <= maxLen + 15) {
      merged[merged.length - 1] = prev + ' ' + chunk
    } else {
      merged.push(chunk)
    }
  }

  return merged.length > 0 ? merged : [text]
}

export async function speakQwen3Chunked(text: string, options?: Partial<TTSOptions>): Promise<void> {
  const chunks = splitForQwen3Streaming(text)

  if (chunks.length <= 1) {
    const result = await synthesize({ text, ...options })
    await playAudio(result.wavPath)
    return
  }

  console.log(`[Qwen3-Chunked] ${chunks.length}청크: ${chunks.map((c, i) => `[${i}]"${c.substring(0, 18)}"`).join(' ')}`)

  const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

  // synthFn: 합성 + 후미 무음 제거
  const synthFn = async (t: string): Promise<string | null> => {
    try {
      const result = await synthesize({ text: t, ...options })
      const buf = fs.readFileSync(result.wavPath)
      const trimmed = trimWAVSilence(buf)
      if (trimmed.length < buf.length) fs.writeFileSync(result.wavPath, trimmed)
      return result.wavPath
    } catch (e) {
      console.warn(`[Qwen3-Chunked] chunk skip: "${t.substring(0, 20)}" —`, (e as Error).message)
      return null
    }
  }

  // Qwen3 :7860은 샘플레이트가 다를 수 있으므로 WAV 병합 비활성화 (silence trim만 적용)
  await runChunkedPipeline(chunks, cacheDir, synthFn, false)
}

// ─── MLX-KO 청크 스트리밍 (:8800 Qwen3-TTS 전용) ─────────────────────────────
// 최적화: 후미 무음 제거 + lookahead 2 + WAV 병합
export async function speakMLXKoChunked(text: string, voice?: string, api = MLX_KO_API, model = MLX_KO_MODEL): Promise<void> {
  const chunks = splitForQwen3Streaming(text)
  // Qwen3-Base는 단일화자 — voice는 Kokoro fallback 시에만 사용
  const v = (api === MLX_EN_API) ? getKokoroVoice(voice || mlxTTSVoice) : 'qwen3'
  const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

  if (chunks.length <= 1) {
    const normalized = normalizeKoreanNumbers(chunks[0] || text)
    const audioData = await synthesizeMLXSegment(normalized, model, v, api)
    if (audioData.length < 100) return
    const trimmed = trimWAVSilence(audioData)
    const p = path.join(cacheDir, `mlx-ko-${Date.now()}.wav`)
    fs.writeFileSync(p, trimmed)
    await playAudio(p)
    return
  }

  console.log(`[MLX-KO-Chunked] ${chunks.length}청크: ${chunks.map((c, i) => `[${i}]"${c.substring(0, 18)}"`).join(' ')}`)

  const synthFn = async (t: string): Promise<string | null> => {
    try {
      const normalized = normalizeKoreanNumbers(t)
      const audioData = await synthesizeMLXSegment(normalized, model, v, api)
      if (audioData.length < 100) throw new Error(`Empty audio (${audioData.length} bytes)`)
      const trimmed = trimWAVSilence(audioData)  // 후미 무음 제거
      const p = path.join(cacheDir, `mlx-ko-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
      fs.writeFileSync(p, trimmed)
      return p
    } catch (e) {
      console.warn(`[MLX-KO-Chunked] chunk skip: "${t.substring(0, 20)}" —`, (e as Error).message)
      return null
    }
  }

  await runChunkedPipeline(chunks, cacheDir, synthFn, true)
}

// ─── MLX-EN 청크 스트리밍 (:8801 Kokoro-82M 전용) ────────────────────────────
// 최적화: 후미 무음 제거 + lookahead 2 + WAV 병합
export async function speakMLXEnChunked(text: string, voice?: string, api = MLX_EN_API, model = MLX_EN_MODEL): Promise<void> {
  const chunks = splitForQwen3Streaming(text)
  const v = voice || getKokoroVoice(mlxTTSVoice)
  const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

  if (chunks.length <= 1) {
    const audioData = await synthesizeMLXSegment(chunks[0] || text, model, v, api)
    if (audioData.length < 100) return
    const trimmed = trimWAVSilence(audioData)
    const p = path.join(cacheDir, `mlx-en-${Date.now()}.wav`)
    fs.writeFileSync(p, trimmed)
    await playAudio(p)
    return
  }

  console.log(`[MLX-EN-Chunked] ${chunks.length}청크: ${chunks.map((c, i) => `[${i}]"${c.substring(0, 18)}"`).join(' ')}`)

  const synthFn = async (t: string): Promise<string | null> => {
    try {
      const audioData = await synthesizeMLXSegment(t, model, v, api)
      if (audioData.length < 100) throw new Error(`Empty audio (${audioData.length} bytes)`)
      const trimmed = trimWAVSilence(audioData)  // 후미 무음 제거
      const p = path.join(cacheDir, `mlx-en-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
      fs.writeFileSync(p, trimmed)
      return p
    } catch (e) {
      console.warn(`[MLX-EN-Chunked] chunk skip: "${t.substring(0, 20)}" —`, (e as Error).message)
      return null
    }
  }

  await runChunkedPipeline(chunks, cacheDir, synthFn, true)
}

// ─── MLX-MIX 청크 스트리밍 (:8802 Spark-TTS 전용) ────────────────────────────
// 최적화: 후미 무음 제거 + lookahead 2 + WAV 병합
export async function speakSparkChunked(text: string, sparkVoice: string): Promise<void> {
  const chunks = splitForQwen3Streaming(text)
  const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

  if (chunks.length <= 1) {
    const normalized = normalizeKoreanNumbers(chunks[0] || text)
    const audioData = await synthesizeMLXSegment(normalized, MLX_MIX_MODEL, sparkVoice, MLX_MIX_API)
    if (audioData.length < 100) return
    const trimmed = trimWAVSilence(audioData)
    const p = path.join(cacheDir, `mlx-mix-${Date.now()}.wav`)
    fs.writeFileSync(p, trimmed)
    await playAudio(p)
    return
  }

  console.log(`[Spark-Chunked] ${chunks.length}청크 voice=${sparkVoice}: ${chunks.map((c, i) => `[${i}]"${c.substring(0, 18)}"`).join(' ')}`)

  const synthFn = async (t: string): Promise<string | null> => {
    try {
      const normalized = normalizeKoreanNumbers(t)
      const audioData = await synthesizeMLXSegment(normalized, MLX_MIX_MODEL, sparkVoice, MLX_MIX_API)
      if (audioData.length < 100) throw new Error(`Empty audio (${audioData.length} bytes)`)
      const trimmed = trimWAVSilence(audioData)  // 후미 무음 제거
      const p = path.join(cacheDir, `mlx-mix-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
      fs.writeFileSync(p, trimmed)
      return p
    } catch (e) {
      console.warn(`[Spark-Chunked] chunk skip: "${t.substring(0, 20)}" —`, (e as Error).message)
      return null
    }
  }

  await runChunkedPipeline(chunks, cacheDir, synthFn, true)
}

// Fallback: use macOS 'say' or similar if TTS server unavailable
export async function speakFallback(text: string, lang = 'ko', voiceOverride?: string): Promise<void> {
  if (process.platform === 'darwin') {
    const voiceMap: Record<string, string> = {
      'ko': 'Yuna',
      'en': 'Samantha',
      'ja': 'Kyoko',
      'zh': 'Ting-Ting'
    }
    const voice = voiceOverride || voiceMap[lang] || 'Yuna'
    await execFile('say', ['-v', voice, text])
  } else if (process.platform === 'win32') {
    await execFile('powershell', ['-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak("${text.replace(/"/g, '""')}")`
    ])
  }
}

// Warm up a single MLX endpoint with a test synthesis
async function warmupMLXEndpoint(api: string, model: string, voice: string, label: string): Promise<void> {
  try {
    const body = JSON.stringify({ model, input: MLX_WARMUP_TEXT, voice, response_format: 'wav' })
    await httpRequest(`${api}/v1/audio/speech`, { method: 'POST', body, timeout: 120000 })
    console.log(`[TTS-MLX] ${label} warmed up`)
  } catch (e) {
    console.log(`[TTS-MLX] ${label} warmup failed (non-fatal):`, (e as Error).message)
  }
}

// Preload all three MLX models in parallel — eliminates cold start
export async function warmupMLX(): Promise<void> {
  await Promise.all([
    warmupMLXEndpoint(MLX_KO_API,  MLX_KO_MODEL,  mlxTTSVoice, 'Qwen3-TTS/Korean :8800'),
    warmupMLXEndpoint(MLX_EN_API,  MLX_EN_MODEL,  'af_heart',   'Kokoro/English :8801'),
    warmupMLXEndpoint(MLX_MIX_API, MLX_MIX_MODEL, 'ko_female',    'Spark-TTS/Mixed :8802'),
  ])
}

// ─── MLX 가용성 캐시 (2초 타임아웃 → 조금만 느려도 폴백하는 버그 방지) ──────
// 이전: isMLXAvailable() 매 호출마다 2s 타임아웃 → 합성 중엔 응답 느려 false 반환 → say 폴백
// 해결: 30초 캐시 + 타임아웃 5초 → 일시적 느림에도 MLX 유지, 실제 다운시만 폴백
const _mlxAvailCache = new Map<string, { ok: boolean; ts: number }>()
const MLX_AVAIL_CACHE_MS = 30_000  // 30초 캐시
const MLX_HEALTH_TIMEOUT = 5000    // 5초 타임아웃 (2초 → 5초)

async function checkMLXServer(api: string): Promise<boolean> {
  const now = Date.now()
  const cached = _mlxAvailCache.get(api)
  if (cached && now - cached.ts < MLX_AVAIL_CACHE_MS) return cached.ok
  try {
    const data = await httpRequest(`${api}/v1/models`, { method: 'GET', timeout: MLX_HEALTH_TIMEOUT })
    const ok = data.length > 0
    _mlxAvailCache.set(api, { ok, ts: now })
    return ok
  } catch {
    _mlxAvailCache.set(api, { ok: false, ts: now })
    return false
  }
}

// 캐시 무효화 (서버 시작/중지 후 즉시 재확인)
export function invalidateMLXCache(): void {
  _mlxAvailCache.clear()
}

export async function isMLXAvailable(): Promise<boolean> {
  return checkMLXServer(MLX_KO_API)
}

async function isMLXEnAvailable(): Promise<boolean> {
  return checkMLXServer(MLX_EN_API)
}

async function isMLXMixAvailable(): Promise<boolean> {
  return checkMLXServer(MLX_MIX_API)
}

// Start MLX server if not running, then warmup model — fire-and-forget for app startup
export function startMLXInBackground(): void {
  ;(async () => {
    try {
      const [koRunning, enRunning, mixRunning] = await Promise.all([
        isMLXAvailable(), isMLXEnAvailable(), isMLXMixAvailable()
      ])

      // Start any servers that aren't running
      const starts: Promise<boolean>[] = []
      if (!koRunning)  starts.push(startTTSServer('mlx_ko'))
      if (!enRunning)  starts.push(startTTSServer('mlx_en'))
      if (!mixRunning) starts.push(startTTSServer('mlx_mix'))
      if (starts.length) await Promise.all(starts)

      // Warm up all models in parallel
      await warmupMLX()

      if (koRunning && enRunning && mixRunning) {
        console.log('[TTS-MLX] All 3 servers already running, warming up...')
        return
      }
      console.log('[TTS-MLX] Starting servers in background...')
    } catch (e) {
      console.log('[TTS-MLX] Background start failed:', (e as Error).message)
    }
  })()
}

// ─── 한국어 숫자/날짜 텍스트 정규화 ─────────────────────────────────────────
// Spark-TTS 등 다국어 모델이 숫자를 영어/중국어로 읽는 문제 방지

function toSinoKorean(n: number): string {
  if (n === 0) return '영'
  if (n < 0) return '마이너스 ' + toSinoKorean(-n)
  const ones = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구']
  if (n < 10) return ones[n]
  if (n < 100) {
    const t = Math.floor(n / 10), o = n % 10
    return (t > 1 ? ones[t] : '') + '십' + (o ? ones[o] : '')
  }
  if (n < 1000) {
    const h = Math.floor(n / 100), rest = n % 100
    return (h > 1 ? ones[h] : '') + '백' + (rest ? toSinoKorean(rest) : '')
  }
  if (n < 10000) {
    const th = Math.floor(n / 1000), rest = n % 1000
    return (th > 1 ? ones[th] : '') + '천' + (rest ? toSinoKorean(rest) : '')
  }
  if (n < 100000000) {
    const man = Math.floor(n / 10000), rest = n % 10000
    return toSinoKorean(man) + '만' + (rest ? toSinoKorean(rest) : '')
  }
  return n.toString()
}

/**
 * 한국어 컨텍스트의 숫자/날짜를 한국어 발음으로 정규화
 * "2026년 5월 50%" → "이천이십육년 오월 오십 퍼센트"
 */
export function normalizeKoreanNumbers(text: string): string {
  if (!/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text)) return text  // 한국어 없으면 패스

  // (?<!\.) 소수점 이후 숫자는 단위 변환 금지 (3.8GB → "3.팔기가바이트" 방지)
  return text
    .replace(/(?<!\.)\b(\d{1,4})년/g,  (_, n) => toSinoKorean(parseInt(n)) + '년')
    .replace(/(?<!\.)\b(\d{1,2})월/g,  (_, n) => toSinoKorean(parseInt(n)) + '월')
    .replace(/(?<!\.)\b(\d{1,2})일/g,  (_, n) => toSinoKorean(parseInt(n)) + '일')
    .replace(/(?<!\.)\b(\d{1,2})시/g,  (_, n) => toSinoKorean(parseInt(n)) + '시')
    .replace(/(?<!\.)\b(\d{1,2})분/g,  (_, n) => toSinoKorean(parseInt(n)) + '분')
    .replace(/(?<!\.)\b(\d{1,2})초/g,  (_, n) => toSinoKorean(parseInt(n)) + '초')
    .replace(/(?<!\.)\b(\d+)개/g,      (_, n) => { const v = parseInt(n); return v < 10000 ? toSinoKorean(v) + '개' : n + '개' })
    .replace(/(?<!\.)\b(\d+)명/g,      (_, n) => { const v = parseInt(n); return v < 10000 ? toSinoKorean(v) + '명' : n + '명' })
    .replace(/(?<!\.)\b(\d+)%/g,       (_, n) => toSinoKorean(parseInt(n)) + ' 퍼센트')
    .replace(/(?<!\.)\b(\d+)GB/gi,     (_, n) => toSinoKorean(parseInt(n)) + '기가바이트')
    .replace(/(?<!\.)\b(\d+)MB/gi,     (_, n) => toSinoKorean(parseInt(n)) + '메가바이트')
    .replace(/(?<!\.)\b(\d+)KB/gi,     (_, n) => toSinoKorean(parseInt(n)) + '킬로바이트')
    .replace(/(?<![\d.])(\d+)(?![\d.])/g, (_, n) => { const v = parseInt(n); return v < 100000 ? toSinoKorean(v) : n })
}

// ─── TTS 텍스트 정제 — 음성 출력에 부적합한 요소 제거/요약 ──────────────────────
// 마크다운 문법, URL, 파일 경로, 긴 ID, IP 주소 등을 음성에 맞게 변환

// 영문 대문자 약어 → 한국어 발음 (TTS 자연스러운 독음)
const TTS_ABBR_MAP: Record<string, string> = {
  API: '에이피아이', TTS: '티티에스', STT: '에스티티',
  PTY: '피티와이',  IPC: '아이피씨',  URL: '유알엘',
  HTTP: '에이치티티피', HTTPS: '에이치티티피에스',
  CPU: '씨피유',   GPU: '지피유',   MLX: '엠엘엑스',
  NCO: '엔씨오',   AI: '에이아이', CLI: '씨엘아이',
  JSON: '제이슨',  CSV: '씨에스브이', WAV: '웨이브',
  PDF: '피디에프', PNG: '피엔지',   JPG: '제이펙',
  UI: '유아이',    UX: '유엑스',    DB: '디비',
  ID: '아이디',    OK: '오케이',    PR: '피알',
  MPS: '엠피에스', MCP: '엠씨피',  SSH: '에스에스에이치',
  LLM: '엘엘엠',  SDK: '에스디케이', DOM: '돔',
  VS: '대',        FPS: '에프피에스', RAM: '램',
  PC: '피씨',      OS: '오에스',    VPN: '브이피엔',
  // 추가 기술 약어
  ML: '엠엘',     DL: '딥러닝',    NLP: '엔엘피',
  USB: '유에스비', NFC: '엔에프씨', QA: '큐에이',
  HTML: '에이치티엠엘', CSS: '씨에스에스', JWT: '제이더블유티',
  AWS: '에이더블유에스', GCP: '지씨피', REST: '레스트',
  TCP: '티씨피',   UDP: '유디피',   CI: '씨아이',  CD: '씨디',
  PM: '피엠',      CTO: '씨티오',   CEO: '씨이오',
  ROI: '아르오아이', KPI: '케이피아이', OKR: '오케이알',
}

// 영어 브랜드·제품명 → 한국어 음성 (한국어 TTS 엔진의 영어 발음 어색함 방지)
const TTS_BRAND_KO: [RegExp, string][] = [
  [/\bClaude\b/g, '클로드'],
  [/\bGemini\b/g, '제미나이'],
  [/\bGoogle\b/g, '구글'],
  [/\bApple\b/g, '애플'],
  [/\biPhone\b/g, '아이폰'],
  [/\biPad\b/g, '아이패드'],
  [/\bMacBook\b/g, '맥북'],
  [/\bMacOS\b|\bmacOS\b/g, '맥'],
  [/\bWindows\b/g, '윈도우'],
  [/\bLinux\b/g, '리눅스'],
  [/\bGitHub\b/g, '깃허브'],
  [/\bgit\b/g, '깃'],           // 소문자 git (shell 명령어 컨텍스트)
  [/\bGit\b/g, '깃'],
  [/\bPython\b/g, '파이썬'],
  [/\bJavaScript\b/g, '자바스크립트'],
  [/\bTypeScript\b/g, '타입스크립트'],
  [/\bReact\b/g, '리액트'],
  [/\bElectron\b/g, '일렉트론'],
  [/\bWhisper\b/g, '위스퍼'],
  [/\bOpenAI\b/g, '오픈에이아이'],
  [/\bAnthropic\b/g, '앤트로픽'],
  [/\bOllama\b/g, '올라마'],
  [/\bChatGPT\b/g, '챗지피티'],
  [/\bYouTube\b/g, '유튜브'],
  [/\bNetflix\b/g, '넷플릭스'],
  [/\bSpotify\b/g, '스포티파이'],
  [/\bSlack\b/g, '슬랙'],
  [/\bNotion\b/g, '노션'],
  [/\bFigma\b/g, '피그마'],
  [/\bVite\b/g, '비트'],
  [/\bNode\.js\b|\bNodeJS\b/g, '노드제이에스'],
  [/\bNode\b/g, '노드'],
  [/\bNova\b/g, '노바'],
  [/\bnpm\b/g, '엔피엠'],         // Node 패키지 관리자
  [/\bbrew\b/g, '브루'],          // Homebrew (macOS)
  [/\bdocker\b/gi, '도커'],          // 컨테이너
  [/\bkubernetes\b/gi, '쿠버네티스'], // 오케스트레이션
  [/\bterraform\b/gi, '테라폼'],     // IaC
  [/\bVS\s*Code\b|\bVSCode\b/g, '브이에스코드'],
  [/\bXcode\b/g, '엑스코드'],
  [/\bAndroid\b/g, '안드로이드'],
  [/\bFlutter\b/g, '플러터'],
  [/\biOS\b/g, '아이오에스'],
  [/\bSwiftUI\b/g, '스위프트유아이'],
  [/\bVercel\b/g, '버셀'],
  [/\bNext\.js\b|\bNextjs\b/g, '넥스트제이에스'],
  [/\bSvelteKit\b|\bSvelte\b/g, '스벨트'],
  [/\bVue\b/g, '뷰'],
  [/\bSupabase\b/g, '수파베이스'],
  [/\bwebpack\b/gi, '웹팩'],
  [/\bpnpm\b/g, '피엔피엠'],
  [/\byarn\b/gi, '얀'],
]

export function sanitizeTTSText(raw: string): string {
  let t = raw

  // 1. 마크다운 코드 블록 전체 → "코드 생략"
  t = t.replace(/```[\s\S]*?```/g, '코드 생략.')

  // 2. 인라인 코드 (`...`) → 내용 제거 (코드 식별자는 TTS에 부적합)
  t = t.replace(/`[^`\n]+`/g, '')

  // 3. 마크다운 헤더 (## 제목) → 제목만
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '$1')

  // 4. 굵기/기울기 (**text** / *text* / __text__ / _text_) → 내용만
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/\*([^*\n]+)\*/g, '$1')
  t = t.replace(/__([^_]+)__/g, '$1')
  t = t.replace(/_([^_\n]+)_/g, '$1')

  // 5. URL (http/https) → "링크 생략"
  // 5a. 마크다운 링크 [텍스트](url) → 텍스트만 추출
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // 5b. 남은 URL (http/https)
  t = t.replace(/https?:\/\/[^\s)>\]"',]+/g, '링크 생략')

  // 6. 파일 경로 → 제거 (절대 /path/to/file 및 상대 src/main/ipc.ts 모두)
  // 최소 3세그먼트(/)이면 절대경로, 2세그먼트+확장자이면 상대경로
  t = t.replace(/(?:^|(?<=\s))[\w.-]*(?:\/[\w.-]+){2,}(?:\.\w{1,5})?(?=\s|$)/gm, '')
  // 단일 파일명 (확장자 포함, 슬래시 없음): package.json, tsconfig.ts, ipc.ts 등
  t = t.replace(/\b[\w-]+\.(ts|js|tsx|jsx|json|yaml|yml|toml|env|sh|py|rs|go|md)\b/g, '')

  // 6b. 이메일 주소 → "이메일 주소"
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi, '이메일 주소')

  // 7. 긴 ID / 해시 (16자 이상 영숫자 혼합) → 제거
  t = t.replace(/\b[A-Za-z0-9_-]{16,}\b/g, '')

  // 8. IP 주소 → "아이피 주소"
  t = t.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '아이피 주소')

  // 9. localhost:포트 → "로컬 서버"
  t = t.replace(/localhost:\d+/g, '로컬 서버')
  // 9b. 단독 :포트번호 (4-5자리, 앞에 숫자 없음) → 제거 (시간 HH:MM 제외)
  t = t.replace(/(?<![0-9]):\d{4,5}\b/g, '')

  // 10. 마크다운 리스트 기호 (- / * / •) → 제거
  t = t.replace(/^[ \t]*[-*•]\s+/gm, '')

  // 11. 마크다운 수평선 (--- / ***) → 제거
  t = t.replace(/^[-*_]{3,}\s*$/gm, '')

  // 12. 표 구분자 (| --- |) → 제거
  t = t.replace(/\|[-:| ]+\|/g, '')
  t = t.replace(/\|/g, ' ')

  // 13. 괄호 안 약어/코드 → 제거
  t = t.replace(/\([A-Za-z0-9_.-]{2,}\)/g, '')

  // 14. 이모지 제거 (TTS 엔진이 이모지 발음 시 어색하거나 건너뜀)
  t = t.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]/gu, '')

  // 15. 특수기호 → 자연스러운 표현 또는 제거
  t = t.replace(/→|▶|►/g, '로')
  t = t.replace(/←/g, '에서')
  t = t.replace(/↑/g, '위로')
  t = t.replace(/↓/g, '아래로')
  t = t.replace(/[✓✔☑]/g, '완료')
  t = t.replace(/[★☆✦✧]/g, '')
  t = t.replace(/[…⋯]/g, '.')
  t = t.replace(/[—–ー]/g, ' ')
  t = t.replace(/[«»""'']/g, '')
  t = t.replace(/[·•·⋅]/g, '')
  t = t.replace(/[♪♫♬]/g, '')
  t = t.replace(/[❌✗]/g, '실패')
  t = t.replace(/[⚠⚡]/g, '')

  // 16. 버전 번호 (v1.0.0, v2.3, v18, v20) → "버전"
  t = t.replace(/\bv\d+(?:\.\d+){0,3}\b/gi, '버전')

  // 17. 번호 목록 (1. / 2) / 가. 등) → 제거
  t = t.replace(/^\s*\d+[.)]\s+/gm, '')
  t = t.replace(/^\s*[가-힣][.)]\s+/gm, '')

  // 18. 브랜드·제품명 → 한국어 음성 (한국어 TTS 영어 발음 어색함 방지, 약어 처리 전 우선 적용)
  for (const [pattern, ko] of TTS_BRAND_KO) {
    t = t.replace(pattern, ko)
  }

  // 18b. 영문 대문자 약어 → 한국어 발음 (문장 중 자연스럽게 읽히도록)
  t = t.replace(/\b([A-Z]{2,6})\b/g, (m) => TTS_ABBR_MAP[m] || m)

  // 19. snake_case 식별자 → 제거 (한글 컨텍스트에서 코드 변수명)
  t = t.replace(/\b\w+_\w[\w_]*\b/g, '')

  // 20. camelCase 식별자 (소문자 시작, 대문자 포함) → 제거
  t = t.replace(/\b[a-z][a-z0-9]*[A-Z]\w*\b/g, '')

  // 20b. PascalCase 복합 식별자 (두 단어+ 합성, 한국어 컨텍스트) → 제거
  // BrowserWindow, ElectronApp 등 코드 API 이름 (Brand/Abbr 맵 처리 이후 잔여분)
  if (/[가-힣]/.test(t)) {
    t = t.replace(/\b[A-Z][a-z]{2,}(?:[A-Z][a-z]+)+\b/g, '')
  }

  // 21. 한국어 컨텍스트 숫자 정규화 (50%→오십퍼센트, 2026년→이천이십육년 등)
  if (/[가-힣]/.test(t)) {
    t = normalizeKoreanNumbers(t)
  }

  // 22. 연속된 구두점 정리 (,, / .. / ... 등)
  t = t.replace(/[.,!?]{2,}/g, (m) => m[0])
  t = t.replace(/\s*,\s*,/g, ',')

  // 23. 줄 시작의 외로운 구두점 제거
  t = t.replace(/^\s*[,.:;·]\s*/gm, '')

  // 24. 연속 공백·줄바꿈 정리
  t = t.replace(/\n{3,}/g, '\n')
  t = t.replace(/[ \t]{2,}/g, ' ')
  t = t.trim()

  if (t !== raw) console.log(`[TTS-sanitize] "${raw.substring(0, 60).replace(/\n/g, '↵')}" → "${t.substring(0, 60).replace(/\n/g, '↵')}"`)
  return t
}

// ─── Multilingual TTS (한영 혼재 자동 분리) ──────────────────────────────────

// 텍스트를 한국어/영어 세그먼트로 분리
// 예: "안녕하세요 Apple Silicon에 최적화" → [{ko,"안녕하세요 "},{en,"Apple Silicon"},{ko,"에 최적화"}]
function splitLanguageSegments(text: string): Array<{ text: string; lang: 'ko' | 'en' }> {
  const segments: Array<{ text: string; lang: 'ko' | 'en' }> = []

  // 한글 유니코드 범위: 가-힣(syllables) + ㄱ-ㅎ/ㅏ-ㅣ(jamo)
  const parts = text.split(/([가-힣ㄱ-ㅎㅏ-ㅣ][가-힣ㄱ-ㅎㅏ-ㅣ\s·~!?,.:;'"()「」『』【】0-9]*)/)

  for (const part of parts) {
    if (!part) continue
    const trimmed = part.trim()
    if (!trimmed) continue
    const hasKorean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(part)
    const lang: 'ko' | 'en' = hasKorean ? 'ko' : 'en'

    // 직전 세그먼트와 같은 언어면 합치기
    const prev = segments[segments.length - 1]
    if (prev && prev.lang === lang) {
      prev.text += part
    } else {
      segments.push({ text: part, lang })
    }
  }

  return segments.filter(s => s.text.trim().length > 0)
}

// ─── WAV 후미 무음 제거 ────────────────────────────────────────────────────────
// MLX TTS 모델들이 합성 끝에 붙이는 무음 패딩(200-500ms)을 제거해 청크 간 갭 최소화
// threshold: 16-bit PCM 절댓값 기준 (0~32767)
//   200이면 한국어 문장 끝 조용한 발음("요","다")이 잘릴 수 있어 80으로 낮춤
// keepTrailMs: 마지막 유효 샘플 이후 유지할 트레일 (50ms → 120ms로 늘려 클리핑 방지)
function trimWAVSilence(buf: Buffer, keepTrailMs = 120, sampleRate = 24000, threshold = 80): Buffer {
  const HDR = 44
  if (buf.length <= HDR + 200) return buf  // 너무 짧으면 패스
  const data = buf.slice(HDR)
  const BPS = 2  // 16-bit LE = 2 bytes/sample

  // 뒤에서부터 threshold 초과 샘플 탐색
  let end = data.length
  while (end >= BPS) {
    if (Math.abs(data.readInt16LE(end - BPS)) > threshold) break
    end -= BPS
  }

  // 최소 트레일 유지 (자연스러운 끝맺음, 클리핑 방지)
  const keepBytes = Math.floor(sampleRate * (keepTrailMs / 1000)) * BPS
  end = Math.min(data.length, end + keepBytes)
  if (end >= data.length) return buf  // 제거할 것 없음

  // WAV 헤더 재조립
  const result = Buffer.alloc(HDR + end)
  buf.copy(result, 0, 0, HDR)
  buf.copy(result, HDR, HDR, HDR + end)
  result.writeUInt32LE(HDR + end - 8, 4)  // RIFF chunk size
  result.writeUInt32LE(end, 40)            // data chunk size

  const trimmedMs = Math.round(((data.length - end) / BPS / sampleRate) * 1000)
  if (trimmedMs > 20) console.log(`[TTS-trim] 후미 무음 ${trimmedMs}ms 제거`)
  return result
}

// ─── Peekable Promise ─────────────────────────────────────────────────────────
// Promise 완료 여부를 블로킹 없이 확인 — 청크 병합 판단용
function createPeekable<T>(p: Promise<T>) {
  let done = false
  let val: T | undefined
  p.then(v => { done = true; val = v }).catch(() => { done = true })
  return {
    promise: p,
    isReady: () => done,
    get: () => val,
  }
}

// ─── 공용 청크 파이프라인 ─────────────────────────────────────────────────────
// 4개 엔진(Qwen3/MLX-KO/MLX-EN/Spark) 공용 — synthFn만 다름
//
// 최적화 레이어:
//  (1) 후미 무음 제거 — synthFn에서 trimWAVSilence 적용
//  (2) lookahead 2   — 청크[i+1]과 청크[i+2]를 동시 합성 선행 시작
//  (3) WAV 병합      — 다음 청크가 이미 합성 완료 시 mergeWAVBuffers → afplay 1회 절감
//
// enableMerge: WAV 샘플레이트가 동일한 MLX 엔진에서만 true (Qwen3 :7860은 false)
async function runChunkedPipeline(
  chunks: string[],
  cacheDir: string,
  synthFn: (text: string) => Promise<string | null>,
  enableMerge = true
): Promise<void> {
  if (chunks.length === 0) return
  if (chunks.length === 1) {
    const p = await synthFn(chunks[0])
    if (p) await playAudio(p)
    return
  }

  // Lookahead 2: 청크[0]과 청크[1]을 동시에 합성 시작
  let cur = createPeekable(synthFn(chunks[0]))
  let nxt: ReturnType<typeof createPeekable<string | null>> | null =
    chunks.length > 1 ? createPeekable(synthFn(chunks[1])) : null
  let nextSynthIdx = 2  // 다음에 합성 시작할 청크 인덱스

  let i = 0
  while (i < chunks.length) {
    const curPath = await cur.promise

    // 다음 청크 이미 합성 완료 + WAV 병합 가능? → afplay 재기동 1회 절감
    if (enableMerge && curPath && nxt && nxt.isReady() && i + 1 < chunks.length) {
      const nxtPath = nxt.get()
      if (nxtPath) {
        try {
          const merged = mergeWAVBuffers([fs.readFileSync(curPath), fs.readFileSync(nxtPath)])
          const mergedPath = path.join(cacheDir,
            `merged-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
          fs.writeFileSync(mergedPath, merged)

          // 병합 재생 중 lookahead: 다음 두 청크 합성 선행 시작
          const newCur = nextSynthIdx < chunks.length
            ? createPeekable(synthFn(chunks[nextSynthIdx])) : null
          const newNxt = nextSynthIdx + 1 < chunks.length
            ? createPeekable(synthFn(chunks[nextSynthIdx + 1])) : null

          await playAudio(mergedPath)

          i += 2
          nextSynthIdx += 2
          if (newCur) { cur = newCur; nxt = newNxt }
          else break
          continue
        } catch (e) {
          console.warn('[TTS-pipeline] WAV 병합 실패, 개별 재생:', (e as Error).message)
        }
      }
    }

    // 개별 재생
    if (curPath) await playAudio(curPath)

    i++
    if (i >= chunks.length) break

    // 다음 이터레이션 준비: nxt → cur, 새 lookahead 시작
    cur = nxt || createPeekable(synthFn(chunks[i]))
    nxt = nextSynthIdx < chunks.length
      ? createPeekable(synthFn(chunks[nextSynthIdx])) : null
    nextSynthIdx++
  }
}

// WAV 병합 (24000Hz / Mono / 16-bit 고정 — 두 모델 모두 동일)
function mergeWAVBuffers(buffers: Buffer[]): Buffer {
  const PCM_HEADER_SIZE = 44
  const totalPcm = buffers.reduce((acc, b) => acc + b.length - PCM_HEADER_SIZE, 0)
  const result = Buffer.alloc(PCM_HEADER_SIZE + totalPcm)

  // Copy header from first buffer
  buffers[0].copy(result, 0, 0, PCM_HEADER_SIZE)

  // Fix RIFF chunk size (bytes 4-7): total file size - 8
  result.writeUInt32LE(PCM_HEADER_SIZE + totalPcm - 8, 4)
  // Fix data chunk size (bytes 40-43)
  result.writeUInt32LE(totalPcm, 40)

  // Append PCM data from all buffers
  let offset = PCM_HEADER_SIZE
  for (const buf of buffers) {
    buf.copy(result, offset, PCM_HEADER_SIZE)
    offset += buf.length - PCM_HEADER_SIZE
  }

  return result
}

// 서버에서 실제 로드된 첫 번째 모델 ID를 가져오는 캐시
const _modelIdCache = new Map<string, string>()

async function getActualModelId(api: string, fallback: string): Promise<string> {
  if (_modelIdCache.has(api)) return _modelIdCache.get(api)!
  try {
    const data = await httpRequest(`${api}/v1/models`, { method: 'GET', timeout: 2000 })
    const info = JSON.parse(data.toString())
    const id = info?.data?.[0]?.id || fallback
    _modelIdCache.set(api, id)
    return id
  } catch {
    return fallback
  }
}

// 단일 세그먼트 합성 — api 엔드포인트 명시적 지정
async function synthesizeMLXSegment(text: string, model: string, voice: string, api = MLX_KO_API): Promise<Buffer> {
  // 실제 서버에 로드된 모델 ID 사용 (4bit vs bf16 불일치 방지)
  const actualModel = await getActualModelId(api, model)

  // Qwen3-TTS-Base: 샘플링 기반 → temperature=0으로 결정론적 합성 (항상 동일 목소리)
  // Spark-TTS: temperature 파라미터 미지원 (0 bytes 오류 발생) → 전송 안 함
  // Kokoro: temperature 무관 (이미 결정론적)
  const isQwen3 = api === MLX_KO_API
  const payload: Record<string, unknown> = { model: actualModel, input: text, voice, response_format: 'wav' }
  if (isQwen3) payload.temperature = 0.0

  const body = JSON.stringify(payload)
  // timeout: 10초 (서버 다운 시 빠른 폴백 — 정상 합성은 ~1초이므로 충분)
  return httpRequest(`${api}/v1/audio/speech`, { method: 'POST', body, timeout: 10000 })
}

// 한영 혼재 스마트 합성 — 3-Server 라우팅 (모델 교체 없음)
// ┌─────────────────────────────────────────────────────────────────┐
// │  Korean only  → :8800 Qwen3-TTS      (최고 한국어 품질)          │
// │  English only → :8801 Kokoro-82M     (50ms, 영어 ElevenLabs급)  │
// │  Mixed        → :8802 Spark-TTS-0.5B (단일 모델, 교체 없음)      │
// └─────────────────────────────────────────────────────────────────┘
export async function synthesizeMLXMultilingual(text: string): Promise<string> {
  const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

  const hasKorean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text)
  const hasLatin  = /[a-zA-Z]/.test(text)
  const start     = Date.now()

  // 3-Server 라우팅: 언어별 최적 서버로 분기
  if (!hasKorean && hasLatin) {
    // 순수 영어 → Kokoro-82M :8801 (50ms, 영어 최적화)
    console.log(`[TTS-MLX] English → Kokoro-82M :8801 voice=${getKokoroVoice(mlxTTSVoice)}`)
    const audioData = await synthesizeMLXSegment(text, MLX_EN_MODEL, getKokoroVoice(mlxTTSVoice), MLX_EN_API)
    const audioPath = path.join(cacheDir, `mlx-en-${Date.now()}.wav`)
    fs.writeFileSync(audioPath, audioData)
    console.log(`[TTS-MLX] Done in ${Date.now() - start}ms`)
    return audioPath
  }

  if (hasKorean && hasLatin) {
    // 한영 혼용 → Spark-TTS :8802 (한국어+영어 동시 지원, 단일 모델)
    const sparkVoice = getSparkVoice(mlxTTSVoice)
    console.log(`[TTS-MLX] Mixed → Spark-TTS :8802 voice=${sparkVoice}`)
    const normalized = normalizeKoreanNumbers(text)
    const audioData = await synthesizeMLXSegment(normalized, MLX_MIX_MODEL, sparkVoice, MLX_MIX_API)
    const audioPath = path.join(cacheDir, `mlx-mix-${Date.now()}.wav`)
    fs.writeFileSync(audioPath, audioData)
    console.log(`[TTS-MLX] Done in ${Date.now() - start}ms`)
    return audioPath
  }

  // 한국어 only → Qwen3-TTS :8800 (한국어 전용 고품질, 단일화자)
  console.log(`[TTS-MLX] Korean → Qwen3-TTS :8800`)
  const normalized = normalizeKoreanNumbers(text)
  const audioData = await synthesizeMLXSegment(normalized, MLX_KO_MODEL, 'qwen3', MLX_KO_API)
  const audioPath = path.join(cacheDir, `mlx-ko-${Date.now()}.wav`)
  fs.writeFileSync(audioPath, audioData)
  console.log(`[TTS-MLX] Done in ${Date.now() - start}ms`)
  return audioPath
}

// Synthesize via MLX-Audio server (OpenAI-compatible, fast)
// → 한영 혼재 시 자동으로 synthesizeMLXMultilingual 호출
export async function synthesizeMLX(text: string): Promise<string> {
  return synthesizeMLXMultilingual(text)
}

// 현재 선택된 TTS 모델 (설정에서 ipc.ts가 주입)
let _ttsModel: string = 'qwen3'
let _sayVoice: string = 'Yuna'

export function setActiveTTSModel(model: string): void { _ttsModel = model }
export function setActiveSayVoice(voice: string): void { _sayVoice = voice }
export function getActiveTTSModel(): string { return _ttsModel }

// macOS say 사용 가능한 한국어 화자 목록
export const SAY_VOICES = [
  { id: 'Yuna',    name: 'Yuna',    lang: 'ko', desc: '한국어 여성 (기본)' },
  { id: 'Sora',    name: 'Sora',    lang: 'ko', desc: '한국어 여성' },
  { id: 'Samantha',name: 'Samantha',lang: 'en', desc: '영어 여성' },
  { id: 'Daniel',  name: 'Daniel',  lang: 'en', desc: '영어 남성' },
  { id: 'Kyoko',   name: 'Kyoko',   lang: 'ja', desc: '일본어 여성' },
  { id: 'Ting-Ting',name:'Ting-Ting',lang:'zh', desc: '중국어 여성' },
] as const

// ─── TTS 직렬화 뮤텍스 — 동시 synthesis 방지 ────────────────────────────────
// .catch()로 비동기 발사된 smartSpeak 호출이 겹치면 목소리가 섞이는 문제 해결
let _ttsQueue: Promise<void> = Promise.resolve()

// Smart speak: 설정된 ttsModel 우선 — MLX 계열은 say로만 폴백 (다른 엔진으로 폴백 금지)
export async function smartSpeak(text: string, options?: Partial<TTSOptions>): Promise<void> {
  const clean = sanitizeTTSText(text)
  if (!clean.trim()) return  // 정제 후 내용 없으면 스킵
  // 직렬화: 이전 TTS 완료 후 다음 시작
  const result = new Promise<void>((resolve, reject) => {
    _ttsQueue = _ttsQueue.then(() => _doSmartSpeak(clean, options).then(resolve, reject)).catch(() => {})
  })
  return result
}

async function _doSmartSpeak(text: string, options?: Partial<TTSOptions>): Promise<void> {
  const model = _ttsModel

  // 선택된 모델 먼저 시도
  if (model === 'say') {
    await speakFallback(text, options?.lang, _sayVoice)
    return
  }

  if (model === 'mlx') {
    try {
      // 목소리 일관성 정책: 한국어가 있으면 항상 MLX-KO (Qwen3-TTS)
      // 이전: hasKorean && hasLatin → Spark → 연속 발화 중 목소리 변경 버그
      // 수정: 순수 영어만 MLX-EN, 한국어 포함(한영 혼용 포함) → MLX-KO 단일화
      const hasKorean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text)
      const hasLatin  = /[a-zA-Z]/.test(text)
      if (!hasKorean && hasLatin) {
        await speakMLXEnChunked(text, undefined, MLX_EN_API, MLX_EN_MODEL)
      } else {
        // 한국어 있거나 한영 혼용 → MLX-KO (목소리 고정, Qwen3이 영어 단어도 처리)
        await speakMLXKoChunked(text, mlxTTSVoice, MLX_KO_API, MLX_KO_MODEL)
      }
      return
    } catch (e) {
      console.log('[TTS-MLX] Failed:', (e as Error).message)
      invalidateMLXCache()
    }
    // MLX 실패 → 침묵 (say 폴백 금지 — 목소리 혼합 방지)
    console.warn('[TTS-MLX] 실패, 침묵 처리 (목소리 통일 정책)')
    return
  }

  if (model === 'mlx_ko') {
    try {
      await speakMLXKoChunked(text, mlxTTSVoice, MLX_KO_API, MLX_KO_MODEL)
      return
    } catch (e) {
      console.log('[TTS-MLX-KO] Failed:', (e as Error).message)
      invalidateMLXCache()
    }
    console.warn('[TTS-MLX-KO] 실패, 침묵 처리')
    return
  }

  if (model === 'mlx_en') {
    try {
      await speakMLXEnChunked(text, 'af_heart', MLX_EN_API, MLX_EN_MODEL)
      return
    } catch (e) {
      console.log('[TTS-MLX-EN] Failed:', (e as Error).message)
      invalidateMLXCache()
    }
    // mlx_en 실패 → 침묵 (목소리 통일 정책)
    console.warn('[TTS-MLX-EN] 실패, 침묵 처리')
    return
  }

  if (model === 'mlx_mix') {
    try {
      const sparkVoice = getSparkVoice(mlxTTSVoice)
      console.log(`[TTS-Spark] voice=${mlxTTSVoice} → Spark :8802 sparkVoice=${sparkVoice}`)
      await speakSparkChunked(text, sparkVoice)
      return
    } catch (e) {
      console.log('[TTS-Spark-Chunked] Failed:', (e as Error).message)
      invalidateMLXCache()
    }
    // mlx_mix 실패 → 침묵 (목소리 통일 정책)
    console.warn('[TTS-MLX-MIX] 실패, 침묵 처리')
    return
  }

  if (model === 'cosyvoice') {
    try {
      if (await isCosyVoiceAvailable()) {
        const audioPath = await synthesizeCosyVoice(text)
        await playAudio(audioPath)
        return
      }
    } catch (e) {
      console.log('[CosyVoice2] Failed, falling back:', (e as Error).message)
    }
    // cosyvoice 실패 → 침묵 (목소리 통일 정책)
    console.warn('[CosyVoice2] 실패, 침묵 처리')
    return
  }

  // qwen3 — @@gentop :7860, 9화자 CustomVoice, 화자 매핑 후 청크 파이프라인
  if (model === 'qwen3' || !['say','mlx','mlx_ko','mlx_en','mlx_mix','cosyvoice'].includes(model)) {
    try {
      if (await isTTSAvailable()) {
        const qwen3Speaker = getQwen3Voice(mlxTTSVoice)
        console.log(`[Qwen3-TTS] voice=${mlxTTSVoice} → speaker=${qwen3Speaker} (:7860)`)
        await speakQwen3Chunked(text, { voice: 'qwen3-tts', speaker: qwen3Speaker, ...options })
        return
      }
    } catch (e) {
      console.log('[Qwen3-TTS] Failed:', (e as Error).message)
    }
    console.warn('[Qwen3-TTS] 실패, 침묵 처리')
    return
  }

  try {
    if (await isMLXAvailable()) {
      const audioPath = await synthesizeMLX(text)
      await playAudio(audioPath)
      return
    }
  } catch (e) {
    console.log('[TTS-MLX] Failed, trying CosyVoice2:', (e as Error).message)
  }

  try {
    if (await isCosyVoiceAvailable()) {
      const audioPath = await synthesizeCosyVoice(text)
      await playAudio(audioPath)
      return
    }
  } catch (e) {
    console.log('[CosyVoice2] Failed, using say:', (e as Error).message)
  }

  console.warn('[TTS] 모든 TTS 서버 불가 → 침묵 (목소리 통일 정책)')
}

// Get available speakers
export async function getSpeakers(lang = 'ko'): Promise<string[]> {
  try {
    const data = await httpRequest(`${TTS_API}/api/speakers?lang=${lang}`, { method: 'GET' })
    const result = JSON.parse(data.toString())
    return Object.keys(result.speakers || result)
  } catch {
    return ['sohee'] // default fallback
  }
}

// ─── TTS Server Management ─────────────────────────────────────────────────

export interface TTSServerStatus {
  id: 'cosyvoice' | 'qwen3' | 'mlx' | 'mlx_ko' | 'mlx_en' | 'mlx_mix'
  name: string
  port: number
  running: boolean
  device?: string
  model?: string
  latencyMs?: number
}

const VENV = '/Users/nova-ai/project/nova-voice/.venv-tts/bin/python3'

const SERVER_CONFIGS = {
  cosyvoice: {
    name: 'CosyVoice2',
    port: 8900,
    cwd: '/Users/nova-ai/project/cosyvoice2-official',
    bin: '/Users/nova-ai/miniconda3/envs/cosyvoice/bin/python3',
    args: ['server.py'],
    env: { PYTORCH_ENABLE_MPS_FALLBACK: '1' },
  },
  // ── 3-Server MLX (모델 교체 없음) ──
  mlx_ko: {
    name: 'MLX-Qwen3 (Korean)',
    port: 8800,
    cwd: '/Users/nova-ai/project/nova-voice',
    bin: VENV,
    args: ['-m', 'mlx_audio.server', '--port', '8800'],
    env: {},
  },
  mlx_en: {
    name: 'MLX-Kokoro (English)',
    port: 8801,
    cwd: '/Users/nova-ai/project/nova-voice',
    bin: VENV,
    args: ['-m', 'mlx_audio.server', '--port', '8801'],
    env: {},
  },
  mlx_mix: {
    name: 'MLX-Spark (Multilingual)',
    port: 8802,
    cwd: '/Users/nova-ai/project/nova-voice',
    bin: VENV,
    args: ['-m', 'mlx_audio.server', '--port', '8802'],
    env: {},
  },
  // Legacy alias (maps to mlx_ko)
  mlx: {
    name: 'MLX-Audio',
    port: 8800,
    cwd: '/Users/nova-ai/project/nova-voice',
    bin: VENV,
    args: ['-m', 'mlx_audio.server', '--port', '8800'],
    env: {},
  },
  qwen3: {
    name: 'Qwen3-TTS',
    port: 7860,
    cwd: '/Users/nova-ai/project/@@gentop/lib/tts',
    bin: 'bash',
    args: ['start.sh', '--no-open'],
    env: {},
  },
} as const

export async function getTTSServerStatuses(): Promise<TTSServerStatus[]> {
  const results: TTSServerStatus[] = []

  // CosyVoice2
  try {
    const t0 = Date.now()
    const data = await httpRequest(`${COSYVOICE_API}/health`, { method: 'GET', timeout: 2000 })
    const info = JSON.parse(data.toString())
    results.push({
      id: 'cosyvoice', name: 'CosyVoice2', port: 8900,
      running: info.status === 'ok',
      device: info.device,
      model: info.model,
      latencyMs: Date.now() - t0,
    })
  } catch {
    results.push({ id: 'cosyvoice', name: 'CosyVoice2', port: 8900, running: false })
  }

  // MLX 3-server (병렬 체크)
  await Promise.all([
    (async () => {
      try {
        const t0 = Date.now()
        const data = await httpRequest(`${MLX_KO_API}/v1/models`, { method: 'GET', timeout: 2000 })
        const info = JSON.parse(data.toString())
        const modelId = info?.data?.[0]?.id || MLX_KO_MODEL
        results.push({ id: 'mlx_ko', name: 'MLX-Qwen3 (한국어)', port: 8800,
          running: true, device: 'mps', model: modelId.split('/').pop(), latencyMs: Date.now() - t0 })
      } catch {
        results.push({ id: 'mlx_ko', name: 'MLX-Qwen3 (한국어)', port: 8800, running: false })
      }
    })(),
    (async () => {
      try {
        const t0 = Date.now()
        const data = await httpRequest(`${MLX_EN_API}/v1/models`, { method: 'GET', timeout: 2000 })
        const info = JSON.parse(data.toString())
        const modelId = info?.data?.[0]?.id || MLX_EN_MODEL
        results.push({ id: 'mlx_en', name: 'MLX-Kokoro (영어)', port: 8801,
          running: true, device: 'mps', model: modelId.split('/').pop(), latencyMs: Date.now() - t0 })
      } catch {
        results.push({ id: 'mlx_en', name: 'MLX-Kokoro (영어)', port: 8801, running: false })
      }
    })(),
    (async () => {
      try {
        const t0 = Date.now()
        const data = await httpRequest(`${MLX_MIX_API}/v1/models`, { method: 'GET', timeout: 2000 })
        const info = JSON.parse(data.toString())
        const modelId = info?.data?.[0]?.id || MLX_MIX_MODEL
        results.push({ id: 'mlx_mix', name: 'MLX-Spark (한영혼용)', port: 8802,
          running: true, device: 'mps', model: modelId.split('/').pop(), latencyMs: Date.now() - t0 })
      } catch {
        results.push({ id: 'mlx_mix', name: 'MLX-Spark (한영혼용)', port: 8802, running: false })
      }
    })(),
  ])

  // Qwen3-TTS
  try {
    const t0 = Date.now()
    const data = await httpRequest(`${TTS_API}/health`, { method: 'GET', timeout: 2000 })
    const info = JSON.parse(data.toString())
    results.push({
      id: 'qwen3', name: 'Qwen3-TTS', port: 7860,
      running: !!(info.status === 'ok' || info.status === 'running' || info.server),
      model: info.version || 'qwen3-tts',
      latencyMs: Date.now() - t0,
    })
  } catch {
    results.push({ id: 'qwen3', name: 'Qwen3-TTS', port: 7860, running: false })
  }

  return results
}

export async function startTTSServer(id: keyof typeof SERVER_CONFIGS): Promise<boolean> {
  if (serverProcesses.has(id)) return true // already tracked

  const cfg = SERVER_CONFIGS[id]
  if (!cfg) return false

  // Check if already running externally
  try {
    const statuses = await getTTSServerStatuses()
    if (statuses.find(s => s.id === id)?.running) return true
  } catch { /* ignore */ }

  console.log(`[TTS] Starting ${id} server...`)

  const env = { ...process.env, ...cfg.env }
  const proc = spawn(cfg.bin, cfg.args, {
    cwd: cfg.cwd,
    env,
    detached: false,
    stdio: 'ignore',
  })

  proc.on('exit', (code) => {
    console.log(`[TTS] ${id} server exited with code ${code}`)
    serverProcesses.delete(id)
  })

  serverProcesses.set(id, proc)

  // Wait up to 40s for server to respond
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000))
    try {
      const statuses = await getTTSServerStatuses()
      if (statuses.find(s => s.id === id)?.running) {
        console.log(`[TTS] ${id} server ready after ${i + 1}s`)
        return true
      }
    } catch { /* keep waiting */ }
  }

  console.log(`[TTS] ${id} server start timeout`)
  return false
}

export async function stopTTSServer(id: string): Promise<boolean> {
  // Try our tracked process first
  const proc = serverProcesses.get(id)
  if (proc && !proc.killed) {
    proc.kill('SIGTERM')
    serverProcesses.delete(id)
    await new Promise(r => setTimeout(r, 500))
  }

  // Also pkill by port as fallback
  const portMap: Record<string, number> = {
    cosyvoice: 8900, mlx: 8800, mlx_ko: 8800, mlx_en: 8801, mlx_mix: 8802, qwen3: 7860
  }
  const port = portMap[id]
  if (port) {
    try {
      await execFile('bash', ['-c', `lsof -ti:${port} | xargs kill -TERM 2>/dev/null || true`])
    } catch { /* ignore */ }
  }

  await new Promise(r => setTimeout(r, 800))
  return true
}

export async function previewTTSVoice(id: string, voice?: string): Promise<void> {
  const PREVIEW_TEXT = '안녕하세요! 저는 노바 AI입니다. 이 목소리로 안내해 드릴게요.'

  const PREVIEW_KO  = '안녕하세요! 저는 노바 AI입니다. 이 목소리로 안내해 드릴게요.'
  const PREVIEW_EN  = 'Hello! I am Nova AI. This is how I sound in English.'
  const PREVIEW_MIX = '안녕하세요! I am Nova AI. 한영 혼용 테스트입니다.'

  if (id === 'cosyvoice') {
    const audioPath = await synthesizeCosyVoice(PREVIEW_KO)
    await playAudio(audioPath)
  } else if (id === 'mlx_ko' || id === 'mlx_en' || id === 'mlx_mix' || id === 'mlx') {
    // 모델별 실제 사용 서버로 프리뷰 라우팅 (언어 일치 필수)
    const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
    const selectedVoice = voice || mlxTTSVoice
    let buf: Buffer
    if (id === 'mlx_en') {
      // 영어 전용 → Kokoro :8801 + 영어 텍스트
      const kokoroVoice = getKokoroVoice(selectedVoice)
      console.log(`[TTS-Preview] mlx_en voice=${selectedVoice} → Kokoro :8801 voice=${kokoroVoice}`)
      buf = await synthesizeMLXSegment(PREVIEW_EN, MLX_EN_MODEL, kokoroVoice, MLX_EN_API)
    } else if (id === 'mlx_mix') {
      // 혼용 → Spark-TTS :8802 + 한국어 텍스트 (화자 구분)
      const sparkVoice = getSparkVoice(selectedVoice)
      console.log(`[TTS-Preview] mlx_mix voice=${selectedVoice} → Spark :8802 voice=${sparkVoice}`)
      buf = await synthesizeMLXSegment(normalizeKoreanNumbers(PREVIEW_KO), MLX_MIX_MODEL, sparkVoice, MLX_MIX_API)
    } else {
      // mlx_ko / mlx → Qwen3-TTS :8800 + 한국어 텍스트 (단일화자, 고품질 한국어)
      console.log(`[TTS-Preview] ${id} voice=${selectedVoice} → Qwen3-TTS :8800 (한국어 단일화자)`)
      buf = await synthesizeMLXSegment(normalizeKoreanNumbers(PREVIEW_KO), MLX_KO_MODEL, 'qwen3', MLX_KO_API)
    }
    const audioPath = path.join(cacheDir, `preview-${id}-${Date.now()}.wav`)
    fs.writeFileSync(audioPath, buf)
    await playAudio(audioPath)
  } else if (id === 'qwen3') {
    // @@gentop :7860 샘플 캐시 endpoint — 미리 생성된 WAV, 빠른 응답
    const qwen3Speaker = getQwen3Voice(voice || mlxTTSVoice)
    console.log(`[TTS-Preview] qwen3 voice=${voice || mlxTTSVoice} → speaker=${qwen3Speaker}`)
    try {
      // GET /api/voices/qwen3-tts/sample/{speaker}?lang=ko → WAV 직접 반환 (캐시)
      const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
      const sampleData = await httpRequest(
        `${TTS_API}/api/voices/qwen3-tts/sample/${qwen3Speaker}?lang=ko`,
        { method: 'GET', timeout: 15000 }
      )
      const samplePath = path.join(cacheDir, `preview-qwen3-${qwen3Speaker}-${Date.now()}.wav`)
      fs.writeFileSync(samplePath, sampleData)
      await playAudio(samplePath)
    } catch {
      // sample endpoint 실패 시 synthesize() fallback
      const result = await synthesize({ text: PREVIEW_KO, voice: 'qwen3-tts', speaker: qwen3Speaker })
      await playAudio(result.wavPath)
    }
  }
}
