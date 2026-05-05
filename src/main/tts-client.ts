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
  const body = JSON.stringify({
    text: options.text,
    lang: options.lang || 'ko',
    speaker: options.speaker || 'sohee',
    speed: options.speed || 1.0,
    instruct: options.instruct
  })

  console.log(`[TTS] Synthesizing (${voiceId}/${options.speaker || 'sohee'}): "${options.text.substring(0, 50)}..."`)

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

function splitForQwen3Streaming(text: string, maxLen = 35): string[] {
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
      // 2단계: 쉼표·한국어 쉼표에서 추가 분리
      const parts = sentence
        .split(/(?<=[,，、])\s*/)
        .map(s => s.trim())
        .filter(s => s.length > 0)

      let current = ''
      for (const part of parts) {
        if (current.length + part.length <= maxLen) {
          current += (current ? ' ' : '') + part
        } else {
          if (current) chunks.push(current)
          // 단일 part가 maxLen 초과 시 강제 분리
          if (part.length > maxLen) {
            for (let i = 0; i < part.length; i += maxLen) {
              chunks.push(part.slice(i, i + maxLen))
            }
            current = ''
          } else {
            current = part
          }
        }
      }
      if (current) chunks.push(current)
    }
  }

  // 3단계: 너무 짧은 끝 청크는 앞에 합치기 (5자 이하 단독 청크 방지)
  const merged: string[] = []
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1]
    if (prev && chunk.length <= 5 && prev.length + chunk.length <= maxLen + 10) {
      merged[merged.length - 1] = prev + ' ' + chunk
    } else {
      merged.push(chunk)
    }
  }

  return merged.length > 0 ? merged : [text]
}

export async function speakQwen3Chunked(text: string, options?: Partial<TTSOptions>): Promise<void> {
  const chunks = splitForQwen3Streaming(text)

  // 단일 짧은 텍스트 → 그냥 바로 합성 (파이프라인 오버헤드 불필요)
  if (chunks.length <= 1) {
    const result = await synthesize({ text, ...options })
    await playAudio(result.wavPath)
    return
  }

  console.log(`[Qwen3-Chunked] ${chunks.length}청크: ${chunks.map((c, i) => `[${i}]"${c.substring(0, 18)}"`).join(' ')}`)

  // 파이프라인: chunk[0] 합성 시작 → 재생 중에 chunk[1] 합성 → ...
  let pending: Promise<TTSResult> = synthesize({ text: chunks[0], ...options })

  for (let i = 0; i < chunks.length; i++) {
    const current = await pending

    // chunk[i+1] 합성을 playAudio 전에 시작 → 재생과 합성이 동시 진행
    if (i + 1 < chunks.length) {
      pending = synthesize({ text: chunks[i + 1], ...options })
    }

    await playAudio(current.wavPath)
    // 재생 완료 시 next chunk는 이미 완성(또는 거의 완성) 상태
  }
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

  return text
    .replace(/(\d{1,4})년/g,  (_, n) => toSinoKorean(parseInt(n)) + '년')
    .replace(/(\d{1,2})월/g,  (_, n) => toSinoKorean(parseInt(n)) + '월')
    .replace(/(\d{1,2})일/g,  (_, n) => toSinoKorean(parseInt(n)) + '일')
    .replace(/(\d{1,2})시/g,  (_, n) => toSinoKorean(parseInt(n)) + '시')
    .replace(/(\d{1,2})분/g,  (_, n) => toSinoKorean(parseInt(n)) + '분')
    .replace(/(\d+)%/g,       (_, n) => toSinoKorean(parseInt(n)) + ' 퍼센트')
    .replace(/(\d+)GB/gi,     (_, n) => toSinoKorean(parseInt(n)) + '기가바이트')
    .replace(/(\d+)MB/gi,     (_, n) => toSinoKorean(parseInt(n)) + '메가바이트')
    .replace(/(\d+)KB/gi,     (_, n) => toSinoKorean(parseInt(n)) + '킬로바이트')
    .replace(/(\d+)/g,        (_, n) => { const v = parseInt(n); return v < 100000 ? toSinoKorean(v) : n })
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

  // 모든 텍스트 → Qwen3-TTS :8800 + mlxTTSVoice (화자 고정)
  // Qwen3는 한국어·한영 혼용·순수 영어 모두 자연스럽게 처리
  // 영어를 Kokoro로 분리하면 화자가 랜덤하게 바뀌는 것처럼 들리므로 단일 경로로 통일
  console.log(`[TTS-MLX] ${hasKorean ? (hasLatin ? 'Mixed' : 'Korean') : 'English'} → Qwen3-TTS :8800 voice=${mlxTTSVoice}`)
  const audioData = await synthesizeMLXSegment(text, MLX_KO_MODEL, mlxTTSVoice, MLX_KO_API)
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
  // 직렬화: 이전 TTS 완료 후 다음 시작
  const result = new Promise<void>((resolve, reject) => {
    _ttsQueue = _ttsQueue.then(() => _doSmartSpeak(text, options).then(resolve, reject)).catch(() => {})
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
      const audioPath = await synthesizeMLX(text)
      await playAudio(audioPath)
      return
    } catch (e) {
      console.log('[TTS-MLX] Failed:', (e as Error).message)
      invalidateMLXCache()
    }
    // MLX 계열 실패 → say(Yuna)로만 폴백 (다른 TTS 엔진 사용 금지 — 목소리 변경 방지)
    await speakFallback(text, 'ko', 'Yuna')
    return
  }

  if (model === 'mlx_ko') {
    // isMLXAvailable 사전 체크 제거 — 2초 타임아웃 오탐으로 say 폴백 방지
    // 합성 자체가 실패할 때만 폴백 (synthesizeMLXSegment timeout: 30s)
    try {
      const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
      const audioData = await synthesizeMLXSegment(text, MLX_KO_MODEL, mlxTTSVoice, MLX_KO_API)
      if (audioData.length < 100) throw new Error(`Empty audio (${audioData.length} bytes)`)
      const audioPath = path.join(cacheDir, `mlx-ko-${Date.now()}.wav`)
      fs.writeFileSync(audioPath, audioData)
      await playAudio(audioPath)
      return
    } catch (e) {
      console.log('[TTS-MLX-KO] Failed, falling back to say:', (e as Error).message)
      invalidateMLXCache()  // 실패 시 캐시 무효화 → 다음 호출에서 서버 재확인
    }
    // mlx_ko 실패 → say(Yuna) 폴백만 허용 (qwen3/cosyvoice 폴백 금지)
    await speakFallback(text, 'ko', 'Yuna')
    return
  }

  if (model === 'mlx_en') {
    try {
      const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
      const audioData = await synthesizeMLXSegment(text, MLX_EN_MODEL, 'af_heart', MLX_EN_API)
      if (audioData.length < 100) throw new Error(`Empty audio (${audioData.length} bytes)`)
      const audioPath = path.join(cacheDir, `mlx-en-${Date.now()}.wav`)
      fs.writeFileSync(audioPath, audioData)
      await playAudio(audioPath)
      return
    } catch (e) {
      console.log('[TTS-MLX-EN] Failed:', (e as Error).message)
      invalidateMLXCache()
    }
    await speakFallback(text, 'en', 'Samantha')
    return
  }

  if (model === 'mlx_mix') {
    try {
      const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
      // 숫자/날짜를 한국어로 정규화 (Spark가 영어/중국어로 읽는 문제 방지)
      const normalized = normalizeKoreanNumbers(text)
      if (normalized !== text) console.log(`[TTS-Spark] Normalized: "${text.substring(0,40)}" → "${normalized.substring(0,40)}"`)
      const audioData = await synthesizeMLXSegment(normalized, MLX_MIX_MODEL, 'ko_female', MLX_MIX_API)
      if (audioData.length < 100) throw new Error(`Empty audio (${audioData.length} bytes)`)
      const audioPath = path.join(cacheDir, `mlx-mix-${Date.now()}.wav`)
      fs.writeFileSync(audioPath, audioData)
      await playAudio(audioPath)
      return
    } catch (e) {
      console.log('[TTS-MLX-MIX] Failed:', (e as Error).message)
      invalidateMLXCache()
    }
    await speakFallback(text, 'ko', 'Yuna')
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
    // cosyvoice 실패 → say(Yuna) 폴백만 허용 (목소리 변경 방지)
    await speakFallback(text, 'ko', 'Yuna')
    return
  }

  // qwen3 (default) — 청크 파이프라인으로 첫 소리 대기 단축
  try {
    if (await isTTSAvailable()) {
      await speakQwen3Chunked(text, options)
      return
    }
  } catch (e) {
    console.log('[Qwen3-TTS] Failed, trying MLX:', (e as Error).message)
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

  await speakFallback(text, options?.lang, _sayVoice)
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
  } else if (id === 'mlx_ko' || id === 'mlx_en' || id === 'mlx_mix') {
    const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
    let buf: Buffer
    if (id === 'mlx_ko') {
      // 전역 mlxTTSVoice 변경 없이 preview voice를 직접 전달
      buf = await synthesizeMLXSegment(PREVIEW_KO, MLX_KO_MODEL, voice || mlxTTSVoice, MLX_KO_API)
    } else if (id === 'mlx_en') {
      buf = await synthesizeMLXSegment(PREVIEW_EN, MLX_EN_MODEL, 'af_heart', MLX_EN_API)
    } else {
      buf = await synthesizeMLXSegment(PREVIEW_MIX, MLX_MIX_MODEL, 'ko_female', MLX_MIX_API)
    }
    const audioPath = path.join(cacheDir, `preview-${id}-${Date.now()}.wav`)
    fs.writeFileSync(audioPath, buf)
    await playAudio(audioPath)
  } else if (id === 'mlx') {
    // 전역 mlxTTSVoice 변경 없이 preview voice를 직접 사용
    const previewVoice = voice || mlxTTSVoice
    const cacheDir = path.join(app.getPath('userData'), 'tts-cache')
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
    const buf = await synthesizeMLXSegment(PREVIEW_KO, MLX_KO_MODEL, previewVoice, MLX_KO_API)
    const audioPath = path.join(cacheDir, `preview-mlx-${Date.now()}.wav`)
    fs.writeFileSync(audioPath, buf)
    await playAudio(audioPath)
  } else if (id === 'qwen3') {
    const result = await synthesize({ text: PREVIEW_KO, voice: 'qwen3-tts', speaker: voice || 'sohee' })
    await playAudio(result.wavPath)
  }
}
