import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

export interface WhisperOptions {
  modelPath: string
  language?: string
  translate?: boolean
}

export interface WhisperResult {
  text: string
  language: string
  duration: number
}

let whisperReady = false
let whisperBinaryPath = ''

// Search for models in both project-local and userData directories
function getModelSearchDirs(): string[] {
  const dirs = [
    path.join(app.getPath('userData'), 'models')
  ]

  // Also look in the app's own models/ directory (for dev mode)
  const appModelsDir = path.join(app.getAppPath(), 'models')
  if (fs.existsSync(appModelsDir)) {
    dirs.unshift(appModelsDir)
  }

  // Look relative to CWD (for dev mode: project root/models)
  const cwdModels = path.join(process.cwd(), 'models')
  if (fs.existsSync(cwdModels) && !dirs.includes(cwdModels)) {
    dirs.unshift(cwdModels)
  }

  return dirs
}

export function getModelsDir(): string {
  // Prefer project-local models dir in dev, userData in production
  const dirs = getModelSearchDirs()
  for (const dir of dirs) {
    if (fs.existsSync(dir)) return dir
  }
  // Fallback: create userData models dir
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

function findWhisperBinary(): string {
  const names = process.platform === 'win32'
    ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
    : ['whisper-cli', 'whisper', 'main']

  const searchPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(app.getAppPath(), 'resources', 'bin'),
    path.join(app.getPath('userData'), 'bin')
  ]

  for (const dir of searchPaths) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) {
        console.log(`Found whisper binary: ${candidate}`)
        return candidate
      }
    }
  }
  return ''
}

export async function initWhisper(): Promise<boolean> {
  try {
    whisperBinaryPath = findWhisperBinary()
    const models = getAvailableModels()

    if (whisperBinaryPath) {
      // Quick version check
      try {
        const { stdout } = await execFile(whisperBinaryPath, ['--help'], { timeout: 5000 })
        console.log(`Whisper binary OK: ${whisperBinaryPath}`)
      } catch {
        // --help may return non-zero, that's fine
        console.log(`Whisper binary found: ${whisperBinaryPath}`)
      }
    }

    whisperReady = !!whisperBinaryPath && models.length > 0
    console.log(`Whisper init: binary=${!!whisperBinaryPath}, models=${models.length}, ready=${whisperReady}`)
    for (const m of models) {
      console.log(`  Model: ${m.name} (${m.size}) @ ${m.path}`)
    }
    return whisperReady
  } catch (error) {
    console.error('Failed to initialize Whisper:', error)
    return false
  }
}

export async function transcribe(
  audioBuffer: Buffer,
  options: WhisperOptions
): Promise<WhisperResult> {
  const startTime = Date.now()
  const tempDir = app.getPath('temp')
  const timestamp = Date.now()
  const tempWebmPath = path.join(tempDir, `nova-voice-${timestamp}.webm`)
  const tempWavPath = path.join(tempDir, `nova-voice-${timestamp}.wav`)

  try {
    // Save the raw audio (webm from MediaRecorder)
    fs.writeFileSync(tempWebmPath, audioBuffer)

    // Convert webm to 16kHz mono WAV using ffmpeg (required by whisper.cpp)
    await convertToWav(tempWebmPath, tempWavPath)

    // Transcribe with whisper-cli
    const result = await transcribeWithCLI(tempWavPath, options)

    const duration = (Date.now() - startTime) / 1000
    return {
      text: result.text.trim(),
      language: result.language || options.language || 'auto',
      duration
    }
  } finally {
    // Clean up temp files
    for (const f of [tempWebmPath, tempWavPath]) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f) } catch { /* ignore */ }
      }
    }
  }
}

async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  // Find ffmpeg
  const ffmpegPaths = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
  let ffmpeg = ''
  for (const p of ffmpegPaths) {
    if (fs.existsSync(p)) { ffmpeg = p; break }
  }

  if (!ffmpeg) {
    // Try PATH
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
      'highpass=f=100',     // 100Hz 이하 저주파 잡음 제거
      'lowpass=f=8000',     // 8kHz 이상 고주파 제거
      'anlmdn=s=7',         // AI 노이즈 리덕션 (강도 7)
      'volume=1.5',         // 음량 부스트 (작은 목소리 보정)
    ].join(','),
    '-ar', '16000',       // 16kHz sample rate (whisper requirement)
    '-ac', '1',           // mono
    '-c:a', 'pcm_s16le',  // 16-bit PCM
    '-y',                  // overwrite
    outputPath
  ], { timeout: 30000 })
}

async function transcribeWithCLI(
  audioPath: string,
  options: WhisperOptions
): Promise<{ text: string; language: string }> {
  if (!whisperBinaryPath) {
    throw new Error('Whisper binary not found. Install via: brew install whisper-cpp')
  }

  // 초기 프롬프트: 자주 사용하는 고유명사/키워드를 미리 알려줘서 인식률 향상
  // Whisper는 이 프롬프트의 어휘를 문맥으로 활용해 동음이의어/외래어 정확도를 높임
  const initialPrompt = [
    // 앱 이름 (외래어 → 정확한 한글 표기)
    '크롬', '사파리', '파인더', '터미널', '카카오톡', '슬랙', '디스코드',
    '노션', '스포티파이', '비주얼 스튜디오 코드', '커서', '계산기', '줌', '팀즈',
    // PC 명령 키워드
    '열어', '닫아', '실행', '종료', '볼륨', '올려', '내려', '음소거',
    '스크린샷', '캡처', '최소화', '최대화', '검색', '새로고침',
    '복사', '붙여넣기', '실행 취소', '저장', '전체 선택',
    // NCO 키워드
    '토론', '팀', '병렬', '에이전트', '하이브', '분석',
    // 일반 질문 키워드
    '알려줘', '설명해', '뭐야', '어때', '추천', '번역',
  ].join(', ')

  const args = [
    '-m', options.modelPath,
    '-f', audioPath,
    '--no-timestamps',
    // 초기 프롬프트로 고유명사 인식률 향상
    '--prompt', initialPrompt,
    // 정확도 향상 파라미터
    '-bs', '5',                   // beam-size 5 (후보 탐색 넓힘)
    '-bo', '5',                   // best-of 5 (5개 후보 중 최선 선택)
    '-tp', '0',                   // temperature 0 (결정론적 디코딩, 할루시네이션 감소)
    '--no-fallback',              // temperature fallback 비활성화
    // Anti-hallucination settings
    '--no-speech-thold', '0.6',   // 음성이 아닌 구간 감지 임계값 (높을수록 엄격)
    '--entropy-thold', '2.4',     // 엔트로피 임계값 (낮을수록 엄격, 기본 2.4)
    '--logprob-thold', '-1.0',    // 로그 확률 임계값
    '--max-len', '0'              // 세그먼트 최대 길이 제한 없음
  ]

  // Set language for Korean recognition
  if (options.language && options.language !== 'auto') {
    args.push('-l', options.language)
  } else {
    // Default to Korean for this app
    args.push('-l', 'ko')
  }

  console.log(`Transcribing: ${whisperBinaryPath} ${args.join(' ')}`)

  const { stdout, stderr } = await execFile(whisperBinaryPath, args, {
    timeout: 60000,
    maxBuffer: 1024 * 1024
  })

  // whisper-cli outputs text to stdout, with possible metadata lines
  // Filter out non-text lines (timestamps, progress, etc.)
  const lines = stdout.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !l.startsWith('[') && !l.startsWith('whisper_'))

  let text = lines.join(' ').trim()

  // Filter out Whisper hallucinations
  // Common hallucination patterns: repeated text, non-Korean gibberish, known phantom phrases
  text = filterHallucinations(text)

  // Try to detect language from stderr output
  let detectedLang = 'ko'
  const langMatch = stderr.match(/auto-detected language: (\w+)/)
  if (langMatch) {
    detectedLang = langMatch[1]
  }

  return { text, language: detectedLang }
}

// Filter out common Whisper hallucination patterns
function filterHallucinations(text: string): string {
  if (!text) return text

  // Known phantom phrases that Whisper generates from silence/noise
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
    // large-v3 모델에서 자주 발생하는 할루시네이션
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

  // Detect repetition: same phrase repeated 3+ times
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

export function isReady(): boolean {
  return whisperReady
}

export function getWhisperBinaryPath(): string {
  return whisperBinaryPath
}
