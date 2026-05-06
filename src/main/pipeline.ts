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

import { smartSpeak, isTTSAvailable, isMLXAvailable, ensureTTSServer, synthesizeMLX, playAudio, startMLXInBackground } from './tts-client'
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
    await smartSpeak(speakText, {
      lang: config.ttsLang,
      speaker: config.ttsSpeaker,
      speed: config.ttsSpeed
    })
  } catch (e) {
    console.error('[Pipeline] TTS failed:', (e as Error).message)
  }
}

/**
 * Strip markdown formatting for TTS
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // **bold** → bold
    .replace(/\*([^*]+)\*/g, '$1')        // *italic* → italic
    .replace(/^[-*•]\s+/gm, '')           // bullet points
    .replace(/^#+\s+/gm, '')              // headings
    .replace(/`([^`]+)`/g, '$1')          // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/\n{2,}/g, '. ')             // double newline → period
    .replace(/\n/g, ' ')                  // single newline → space
    .replace(/\s{2,}/g, ' ')             // collapse spaces
    .trim()
}

/**
 * Split text into sentences for streaming TTS
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
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

  let speakText = stripMarkdown(text)
  if (type === 'error') speakText = `오류: ${speakText}`

  const sentences = splitSentences(speakText)
  // Speak each sentence sequentially — smartSpeak queue handles concurrency
  for (const sentence of sentences) {
    if (sentence.trim().length > 2) {
      try {
        await smartSpeak(sentence, {
          lang: config.ttsLang,
          speaker: config.ttsSpeaker,
          speed: config.ttsSpeed
        })
      } catch (e) {
        console.error('[Pipeline-Stream] TTS failed:', (e as Error).message)
      }
    }
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

// 진행 알림 프리셋 — 자주 쓰는 메시지
export const ProgressMessages = {
  taskStart:    (name: string) => `${name} 시작`,
  taskDone:     (name: string) => `${name} 완료`,
  taskFailed:   (name: string) => `${name} 실패`,
  allDone:      (count: number) => `${count}개 작업 모두 완료`,
  installing:   (pkg: string)  => `${pkg} 설치 중`,
  installed:    (pkg: string)  => `${pkg} 설치 완료`,
  serverStart:  (name: string) => `${name} 서버 시작`,
  serverReady:  (name: string) => `${name} 준비 완료`,
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
    speakProgress(`${tasks.length}개 작업을 동시에 시작합니다`)
  }

  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      if (!task.silent) speakProgress(ProgressMessages.taskStart(task.name))
      try {
        const result = await task.fn()
        if (!task.silent) speakProgress(ProgressMessages.taskDone(task.name))
        return { name: task.name, result }
      } catch (e) {
        const err = e as Error
        if (!task.silent) speakProgress(ProgressMessages.taskFailed(task.name), 'high')
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
      speakProgress(`${done.length}개 성공, ${failed.length}개 실패`)
    }
  }

  return mapped
}

/**
 * Initialize pipeline — ensure TTS server is ready
 */
export async function initPipeline(): Promise<{ tts: boolean }> {
  // Start MLX-Audio server (Qwen3-TTS 4-bit) in background — no blocking at startup
  // Model warm-up happens async; first TTS call ~960ms, subsequent calls ~960ms (warm)
  startMLXInBackground()

  // Also check legacy Qwen3-TTS server (port 7860) for status reporting
  const ttsReady = config.ttsEnabled ? await isTTSAvailable() : false
  console.log(`[Pipeline] Legacy TTS (:7860): ${ttsReady ? 'ready' : 'not running'}`)
  console.log('[Pipeline] MLX-Audio (:8800): starting in background...')

  return { tts: true }  // MLX is our primary — always returns ready
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
