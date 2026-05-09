/**
 * NOVA-VOICE Central Pipeline
 *
 * 귀(Ear)  = Whisper STT (음성 → 텍스트)
 * 눈(Eye)  = Screen Capture + AI Vision (화면 인식)
 * 뇌(Brain) = AI Processing (NCO/Ollama/Claude — 텍스트 처리)
 * 입(Mouth) = TTS (텍스트 → 음성 출력)
 *
 * Flow:
 *   [Ear] 사용자 음성 입력
 *     → [Brain] AI 모드에 따라 처리
 *       → Direct: 그대로 텍스트 출력
 *       → Command: PC 제어 명령 실행
 *       → AI Mode: 번역/교정/요약/답변 등
 *       → NCO Mode: 멀티AI 토론/팀/에이전트
 *     → [Mouth] 결과를 음성으로 출력 (TTS)
 *     → [Hand] 결과를 커서 위치에 텍스트 삽입
 */

import { smartSpeak, isTTSAvailable, isMLXAvailable, ensureTTSServer, synthesizeMLX, playAudio, startMLXInBackground, startTTSServer, getActiveTTSModel, sanitizeTTSText } from './tts-client'
import { BrowserWindow } from 'electron'

export interface PipelineConfig {
  ttsEnabled: boolean
  ttsLang: string
  ttsSpeaker: string
  ttsSpeed: number
  speakCommands: boolean    // Command 결과도 음성으로 읽기
  speakAIResults: boolean   // AI 결과도 음성으로 읽기
}

const defaultConfig: PipelineConfig = {
  ttsEnabled: true,
  ttsLang: 'ko',
  ttsSpeaker: 'Ryan',   // 전역 화자 고정 — ipc.ts에서 settings.mlxVoice로 덮어씀
  ttsSpeed: 1.0,
  speakCommands: true,
  speakAIResults: true   // AI 결과도 반드시 음성으로 출력
}

let config = { ...defaultConfig }

export function setPipelineConfig(newConfig: Partial<PipelineConfig>): void {
  config = { ...config, ...newConfig }
}

export function getPipelineConfig(): PipelineConfig {
  return { ...config }
}

/**
 * Pipeline output handler — 결과를 음성(입)으로 출력
 */
export async function pipelineSpeak(
  text: string,
  type: 'command' | 'ai_result' | 'notification' | 'error'
): Promise<void> {
  if (!config.ttsEnabled) return

  // Filter by type
  if (type === 'command' && !config.speakCommands) return
  if (type === 'ai_result' && !config.speakAIResults) return

  // sanitizeTTSText가 smartSpeak 내부에서 URL/마크다운 정제를 처리함 — 여기서 하드 컷 금지
  let speakText = text
  if (type === 'error') {
    speakText = `오류: ${text}`
  }

  try {
    // speaker는 tts-client.ts mlxTTSVoice 전역 변수로 관리 — UI 이름 전달 금지
    await smartSpeak(speakText, {
      lang: config.ttsLang,
      speed: config.ttsSpeed
    })
  } catch (e) {
    console.error('[Pipeline] TTS failed:', (e as Error).message)
  }
}

// stripMarkdown 제거 — sanitizeTTSText (tts-client.ts)로 통합
// 24개 규칙 포함: 경로/해시/약어/camelCase/숫자정규화 등 포괄 처리

/**
 * Split text into sentences for streaming TTS
 * 소수점(3.14), 약어(e.g., i.e.) 앞 마침표는 문장 경계로 보지 않음
 * 한국어 문장 끝(다. 요. 죠. 어. 네. 지.)도 명시 감지
 */
function splitSentences(text: string): string[] {
  return text
    // 마침표/느낌표/물음표+공백 → 마킹
    .replace(/([.!?。！？])\s+/g, '$1\x00')
    // 한국어 구어체 문장 끝 (다. 요. 죠. 어. 네. 지.) + 공백 → 마킹
    // 숫자 뒤 마침표(소수점)·영어 약어는 제외
    .replace(/(?<=[가-힣])([.。])\s+/g, '$1\x00')
    // 숫자 뒤 마침표 복원 (소수점 오인 방지)
    .replace(/(\d)\x00/g, '$1 ')
    // 단일 소문자 약어 복원 (e.g., i.e.)
    .replace(/\b([a-z])\.\x00/g, '$1. ')
    .split('\x00')
    .map(s => s.trim())
    .filter(s => s.length > 2)  // 너무 짧은 조각 제거 (>2: "완료!" 같은 3자 감탄사 보존)
}

/**
 * Streaming TTS — speak sentence by sentence for faster first-audio
 */
export async function pipelineSpeakStreaming(
  text: string,
  type: 'command' | 'ai_result' | 'notification' | 'error'
): Promise<void> {
  if (!config.ttsEnabled) return
  if (type === 'command' && !config.speakCommands) return
  if (type === 'ai_result' && !config.speakAIResults) return

  let speakText = sanitizeTTSText(text)
  if (type === 'error') speakText = `오류: ${speakText}`
  if (!speakText.trim()) return

  // 단일 smartSpeak 호출 — 내부 chunked pipeline(lookahead 2)이 문장 분리 처리
  // 이전: sentence별 순차 합성 → 문장 사이 1-2초 무음 갭 발생
  // 수정: 전체 텍스트를 한 번에 전달 → speakQwen3Chunked가 연속 재생
  // speaker는 tts-client.ts의 mlxTTSVoice 전역 변수로 관리 — 여기서 UI 이름 전달 금지
  try {
    await smartSpeak(speakText, {
      lang: config.ttsLang,
      speed: config.ttsSpeed
    })
  } catch (e) {
    console.error('[Pipeline-Stream] TTS failed:', (e as Error).message)
  }
}

// ─── TTS 진행 알림 시스템 (비동기 fire-and-forget) ──────────────────────────
// 병렬 태스크 실행 중 사용자에게 진행 상황을 음성으로 알림
// 블로킹 없이 즉시 반환 — TTS 큐에 enqueue됨

let _progressEnabled = true

export function setProgressSpeakEnabled(enabled: boolean): void {
  _progressEnabled = enabled
}

/**
 * 태스크 진행 상황을 TTS로 알림 (비동기, 블로킹 없음)
 * - 태스크 시작/완료/오류를 사용자가 들을 수 있도록 함
 * - 설정에서 TTS 꺼져 있으면 자동 무시
 */
export function speakProgress(message: string, priority: 'low' | 'normal' | 'high' = 'normal'): void {
  if (!config.ttsEnabled || !_progressEnabled) return

  // high priority: 현재 재생 중인 TTS를 중단하고 즉시 알림
  // normal/low: 큐에 추가 (현재 재생 완료 후)
  if (priority === 'high') {
    // 현재 TTS 중단 후 즉시 재생
    smartSpeak(message, { lang: config.ttsLang, speed: 1.1 }).catch(() => {})
  } else {
    // 직렬 큐에 추가 (pipelineSpeak와 동일한 smartSpeak 직렬화 사용)
    smartSpeak(message, { lang: config.ttsLang, speed: 1.05 }).catch(() => {})
  }
}

// 진행 알림 프리셋 — 자주 쓰는 메시지 (구어체)
export const ProgressMessages = {
  taskStart:    (_name: string) => '시작할게요.',
  taskDone:     (_name: string) => '완료됐어요.',
  taskFailed:   (_name: string) => '잠시 문제가 생겼어요.',
  allDone:      (count: number) => count > 1 ? `${count}개 작업 모두 끝났어요.` : '완료됐어요.',
  installing:   (_pkg: string)  => '설치 중이에요.',
  installed:    (_pkg: string)  => '설치 완료됐어요.',
  serverStart:  (_name: string) => '서버 시작 중이에요.',
  serverReady:  (_name: string) => '준비됐어요.',
} as const

/**
 * 병렬 태스크 실행 with TTS 진행 알림
 * - 각 태스크 시작/완료 시 TTS 알림
 * - 모든 태스크 완료 시 요약 알림
 */
export async function runParallelWithProgress<T>(
  tasks: Array<{
    name: string
    fn: () => Promise<T>
    silent?: boolean  // 이 태스크는 TTS 알림 없음
  }>
): Promise<Array<{ name: string; result?: T; error?: Error }>> {
  if (tasks.length === 0) return []

  // 시작 알림 (태스크 수가 1개 초과 시만)
  if (tasks.length > 1) {
    speakProgress(`${tasks.length}개 작업을 동시에 시작할게요.`)
  }

  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      // 태스크별 개별 알림 제거 — 병렬 실행 시 큐 쌓임 방지
      // 시작/완료 알림은 배치 요약(allDone/failure)에서만 처리
      try {
        const result = await task.fn()
        return { name: task.name, result }
      } catch (e) {
        const err = e as Error
        console.error(`[Pipeline] Task "${task.name}" failed:`, err.message)
        return { name: task.name, error: err }
      }
    })
  )

  const mapped = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { name: '?', error: new Error('settled rejected') }
  )

  const failed = mapped.filter(r => r.error)
  const done = mapped.filter(r => !r.error)

  if (tasks.length > 1) {
    if (failed.length === 0) {
      speakProgress(ProgressMessages.allDone(done.length))
    } else {
      speakProgress(`${done.length}개 완료됐고, ${failed.length}개 실패했어요.`)
    }
  }

  return mapped
}

/**
 * Initialize pipeline — ensure TTS server is ready
 */
export async function initPipeline(): Promise<{ tts: boolean }> {
  const activeModel = getActiveTTSModel()
  console.log(`[Pipeline] TTS 모델: ${activeModel} (설정값)`)

  if (activeModel === "say") {
    console.log("[Pipeline] say 모델 — 서버 불필요")
  } else if (["mlx", "mlx_ko", "mlx_en", "mlx_mix"].includes(activeModel)) {
    startMLXInBackground()
    console.log("[Pipeline] MLX-Audio: 백그라운드 시작 중...")
  } else if (activeModel === "qwen3") {
    ensureTTSServer().then(ok =>
      console.log(`[Pipeline] Qwen3-TTS (:7860): ${ok ? "준비됨" : "시작 실패"}`)
    ).catch(() => {})
    console.log("[Pipeline] Qwen3-TTS: 백그라운드 시작 중...")
  } else if (activeModel === "cosyvoice") {
    isTTSAvailable().then(ok =>
      console.log(`[Pipeline] CosyVoice2 (:8900): ${ok ? "준비됨" : "미실행"}`)
    ).catch(() => {})
  }

  return { tts: true }
}

/**
 * Pipeline status for UI
 */
export async function getPipelineStatus(): Promise<{
  ear: boolean   // Whisper ready
  eye: boolean   // Screen capture available
  brain: boolean // AI available
  mouth: boolean // TTS available
}> {
  const tts = await isMLXAvailable() || await isTTSAvailable()

  return {
    ear: true,   // Whisper is always checked at startup
    eye: true,   // screencapture/AppleScript always available
    brain: true, // At least regex command parsing works
    mouth: tts
  }
}
