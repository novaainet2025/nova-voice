import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import WebSocket from 'ws'
import { ensureSttServerReady } from './stt-server'

const execFile = promisify(execFileCb)

export interface WhisperOptions {
  modelPath: string
  language?: string
  translate?: boolean
  signal?: AbortSignal
}

export interface WhisperResult {
  text: string
  language: string
  duration: number
}

const STT_WS_URL = 'ws://localhost:8765/ws/stt'
const CHUNK_SAMPLES = 4096   // 4096 samples per chunk
const CHUNK_BYTES = CHUNK_SAMPLES * 2  // 16-bit = 2 bytes/sample
const SILENCE_CHUNKS = 6    // ~1.5s silence (6 * 4096/16000 ≈ 1.54s) > VAD silence_limit 0.7s

let whisperReady = false

// ─── Model discovery (유지: 설정 UI에서 사용) ────────────────────────────────

function getModelSearchDirs(): string[] {
  const dirs = [path.join(app.getPath('userData'), 'models')]
  const appModelsDir = path.join(app.getAppPath(), 'models')
  if (fs.existsSync(appModelsDir)) dirs.unshift(appModelsDir)
  const cwdModels = path.join(process.cwd(), 'models')
  if (fs.existsSync(cwdModels) && !dirs.includes(cwdModels)) dirs.unshift(cwdModels)
  return dirs
}

export function getModelsDir(): string {
  const dirs = getModelSearchDirs()
  for (const dir of dirs) {
    if (fs.existsSync(dir)) return dir
  }
  const userDataModels = path.join(app.getPath('userData'), 'models')
  fs.mkdirSync(userDataModels, { recursive: true })
  return userDataModels
}

export function getAvailableModels(): { name: string; path: string; size: string }[] {
  const models: { name: string; path: string; size: string }[] = []
  const seen = new Set<string>()
  for (const dir of getModelSearchDirs()) {
    if (!fs.existsSync(dir)) continue
    const files = fs.readdirSync(dir)
    for (const file of files) {
      if (!(file.endsWith('.bin') || file.endsWith('.ggml'))) continue
      const name = file.replace(/^ggml-/, '').replace(/\.(bin|ggml)$/, '')
      if (seen.has(name)) continue
      seen.add(name)
      const filePath = path.join(dir, file)
      const stats = fs.statSync(filePath)
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(0)
      models.push({ name, path: filePath, size: `${sizeMB}MB` })
    }
  }
  return models
}

// ─── Init: STT 서버 연결 확인 ────────────────────────────────────────────────

export async function initWhisper(): Promise<boolean> {
  try {
    // STT 서버 헬스 체크
    const http = await import('http')
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get('http://localhost:8765/', { timeout: 3000 }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
    })
    whisperReady = ok
    console.log(`[Whisper] STT Server health: ${ok ? 'OK' : 'NOT READY'} (ws://localhost:8765)`)
    if (!ok) {
      console.warn('[Whisper] STT Server not responding — transcription will fail until server is up')
    }
    return whisperReady
  } catch (error) {
    console.error('[Whisper] Init failed:', error)
    return false
  }
}

export async function ensureSttReady(maxWaitMs = 10000): Promise<boolean> {
  if (whisperReady) return true

  const ready = await ensureSttServerReady(maxWaitMs)
  whisperReady = ready
  if (!ready) {
    console.warn(`[Whisper] STT Server not ready after ${maxWaitMs}ms`)
  }
  return ready
}

// ─── Transcribe via WebSocket ────────────────────────────────────────────────

export async function transcribe(
  audioBuffer: Buffer,
  options: WhisperOptions
): Promise<WhisperResult> {
  const startTime = Date.now()
  const tempDir = app.getPath('temp')
  const timestamp = Date.now()
  const tempWebmPath = path.join(tempDir, `nova-voice-${timestamp}.webm`)
  const tempPcmPath = path.join(tempDir, `nova-voice-${timestamp}.pcm`)

  try {
    const ready = await ensureSttReady(10000)
    if (!ready) {
      throw new Error('STT server not ready after 10000ms')
    }

    // webm → raw PCM (16kHz mono s16le)
    fs.writeFileSync(tempWebmPath, audioBuffer)
    await convertToPcm(tempWebmPath, tempPcmPath)

    const pcmData = fs.readFileSync(tempPcmPath)

    // WebSocket으로 STT 서버에 전송
    const result = await transcribeViaWs(pcmData, options)

    const duration = (Date.now() - startTime) / 1000
    return {
      text: result.text.trim(),
      language: result.language || options.language || 'auto',
      duration
    }
  } finally {
    for (const f of [tempWebmPath, tempPcmPath]) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f) } catch { /* ignore */ }
      }
    }
  }
}

async function convertToPcm(inputPath: string, outputPath: string): Promise<void> {
  const ffmpegPaths = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
  let ffmpeg = ''
  for (const p of ffmpegPaths) {
    if (fs.existsSync(p)) { ffmpeg = p; break }
  }
  if (!ffmpeg) {
    try {
      const { stdout } = await execFile('which', ['ffmpeg'])
      ffmpeg = stdout.trim()
    } catch {
      throw new Error('ffmpeg not found. Please install ffmpeg: brew install ffmpeg')
    }
  }

  await execFile(ffmpeg, [
    '-i', inputPath,
    '-af', [
      'highpass=f=80',
      'anlmdn=s=0.5',
      'volume=1.2',
    ].join(','),
    '-ar', '16000',
    '-ac', '1',
    '-f', 's16le',        // raw PCM (no WAV header)
    '-c:a', 'pcm_s16le',
    '-y',
    outputPath
  ], { timeout: 30000 })
}

async function transcribeViaWs(
  pcmData: Buffer,
  options: WhisperOptions
): Promise<{ text: string; language: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(STT_WS_URL)

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        reject(new Error('STT WebSocket timeout (30s)'))
      }
    }, 30000)

    // AbortSignal 연결
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeout)
        reject(new Error('STT cancelled'))
        return
      }
      options.signal.addEventListener('abort', () => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          ws.close()
          reject(new Error('STT cancelled'))
        }
      }, { once: true })
    }

    ws.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(`STT WebSocket error: ${err.message}`))
      }
    })

    ws.on('open', () => {
      console.log(`[Whisper/WS] Connected, sending ${pcmData.length} bytes PCM`)

      // partial 전사 비활성화 — 이 클라이언트는 final만 사용.
      // 서버가 발화 중 누적 버퍼를 반복 재전사(폐기됨)하던 낭비를 제거 → 지연 대폭 감소
      ws.send(JSON.stringify({ partials: false }))

      // PCM을 청크 단위로 전송
      for (let offset = 0; offset < pcmData.length; offset += CHUNK_BYTES) {
        const end = Math.min(offset + CHUNK_BYTES, pcmData.length)
        ws.send(pcmData.subarray(offset, end))
      }

      // silence padding 전송 — VAD가 final을 발행하도록 트리거
      const silenceChunk = Buffer.alloc(CHUNK_BYTES, 0)
      for (let i = 0; i < SILENCE_CHUNKS; i++) {
        ws.send(silenceChunk)
      }
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())

        if (msg.type === 'final') {
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            ws.close()

            let text = msg.text || ''
            text = filterHallucinations(text)
            text = restoreEnglishTerms(text)

            console.log(`[Whisper/WS] Final: "${text}" (latency=${msg.latency_ms}ms, rtf=${msg.rtf})`)
            resolve({ text, language: 'ko' })
          }
        } else if (msg.type === 'partial') {
          console.log(`[Whisper/WS] Partial: "${msg.text}"`)
        } else if (msg.type === 'error') {
          console.error(`[Whisper/WS] Server error: ${msg.text}`)
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            ws.close()
            reject(new Error(`STT server error: ${msg.text}`))
          }
        }
      } catch { /* ignore parse errors */ }
    })

    ws.on('close', () => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        // 서버가 final 없이 닫힌 경우 — 빈 결과 반환
        resolve({ text: '', language: 'ko' })
      }
    })
  })
}

// ─── 한글 음사 → 영어 원문 복원 ──────────────────────────────────────────────

const ENGLISH_RESTORE_MAP: [RegExp, string][] = [
  [/\bNCO\b|엔씨오\b/g,                    'NCO'],
  [/\bAI\b|에이아이\b|에이 아이\b/g,         'AI'],
  [/\bAPI\b|에이피아이\b|에이 피 아이\b/g,   'API'],
  [/클로드\b/g,                             'Claude'],
  [/제미나이\b|재미나이\b|지미나이\b/g,       'Gemini'],
  [/\bGPT\b|지피티\b/g,                    'GPT'],
  [/\bLLM\b|엘엘엠\b/g,                    'LLM'],
  [/위스퍼\b/g,                             'Whisper'],
  [/코덱스\b/g,                             'Codex'],
  [/에이더\b|아이더\b/g,                    'Aider'],
  [/코파일럿\b/g,                           'Copilot'],
  [/깃허브\b/g,                             'GitHub'],
  [/\b깃\b(?!허브)/g,                       'git'],
  [/비에스코드\b|브이에스코드\b/g,            'VS Code'],
  [/\bnpm\b|엔피엠\b/g,                     'npm'],
  [/\bSSH\b|에스에스에이치\b/g,              'SSH'],
  [/\bURL\b|유알엘\b/g,                     'URL'],
  [/\bJSON\b|제이슨\b(?!씨)/g,              'JSON'],
  [/\bUI\b|유아이\b/g,                      'UI'],
  [/\bUX\b|유엑스\b/g,                      'UX'],
  [/\bPR\b|피알\b/g,                        'PR'],
  [/크롬\b/g,                               'Chrome'],
  [/사파리\b(?!공원)/g,                      'Safari'],
  [/슬랙\b/g,                               'Slack'],
  [/디스코드\b/g,                            'Discord'],
  [/노션\b/g,                               'Notion'],
  [/피그마\b/g,                              'Figma'],
  [/도커\b/g,                               'Docker'],
  [/\bTTS\b|티티에스\b/g,                   'TTS'],
  [/\bSTT\b|에스티티\b/g,                   'STT'],
  [/\bMLX\b|엠엘엑스\b/g,                   'MLX'],
  [/\bPTY\b|피티와이\b/g,                   'PTY'],
]

function restoreEnglishTerms(text: string): string {
  if (!text) return text
  let result = text
  for (const [pattern, replacement] of ENGLISH_RESTORE_MAP) {
    result = result.replace(pattern, replacement)
  }
  return result
}

function filterHallucinations(text: string): string {
  if (!text) return text

  const phantomPhrases = [
    /^(MBC 뉴스|KBS 뉴스|SBS 뉴스).*$/i,
    /^시청해 ?주셔서 ?감사합니다\.?$/,
    /^감사합니다\.?$/,
    /^(구독|좋아요|알림).*(눌러|부탁).*$/,
    /^Thank you (for watching|so much)\.?$/i,
    /^Thanks for watching\.?$/i,
    /^Subtitles by.*$/i,
    /^(ご視聴ありがとうございました|お疲れ様でした)\.?$/,
    /^\.+$/,
    /^\[.*\]$/,
    /^♪.*$/,
    /자막.*제공/,
    /광고.*포함/,
    /한글\s*자막/,
    /^(영상|동영상|비디오).*(제공|시청|감상)/,
    /^(이 영상|본 영상|다음 영상)/,
    /Amara\.org/i,
    /^(Continue|Continued)\.?$/i,
    /^(다음|이전)\s*(영상|편|회)/,
    /협찬|제작지원|제공/,
  ]

  for (const pattern of phantomPhrases) {
    if (pattern.test(text.trim())) {
      console.log(`[Whisper] Filtered hallucination: "${text}"`)
      return ''
    }
  }

  const words = text.split(/\s+/)
  if (words.length >= 6) {
    const half = Math.floor(words.length / 2)
    const first = words.slice(0, half).join(' ')
    const second = words.slice(half, half * 2).join(' ')
    if (first === second) {
      console.log(`[Whisper] Filtered repeated hallucination: "${text.substring(0, 60)}..."`)
      return first
    }
  }

  return text
}

// ─── Warmup: STT 서버에 테스트 요청 ──────────────────────────────────────────

export async function warmupWhisper(_modelPath: string): Promise<void> {
  try {
    console.log('[Whisper] Warming up STT server...')
    // 0.5초 무음 PCM → 서버로 전송하여 MLX 모델 로드 트리거
    const numSamples = 8000  // 0.5s at 16kHz
    const silencePcm = Buffer.alloc(numSamples * 2, 0)

    await transcribeViaWs(silencePcm, { modelPath: '' })
    console.log('[Whisper] Warmup complete (STT server MLX model loaded)')
  } catch {
    // warmup 실패는 무시
    console.log('[Whisper] Warmup skipped (server may not be ready yet)')
  }
}

export function isReady(): boolean {
  return whisperReady
}

export function getWhisperBinaryPath(): string {
  return '' // CLI 바이너리 더 이상 사용하지 않음
}
