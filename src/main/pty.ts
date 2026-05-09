/**
 * PTY Manager — node-pty 기반 실제 터미널 세션
 *
 * node-pty: 실제 Unix PTY(의사 터미널) 생성
 * xterm.js(렌더러)와 IPC로 연결되어 실제 터미널 에뮬레이터 역할
 */

import { BrowserWindow, app } from 'electron'
import * as pty from 'node-pty'
import os from 'os'
import path from 'path'

let ptyProcess: pty.IPty | null = null
let mainWindow: BrowserWindow | null = null
let intentionalKill = false  // createPTY/destroyPTY 의도적 종료 시 true → 자동 재시작 억제
let restartCount = 0          // 연속 재시작 횟수 — 무한 루프 방지
let lastExitTime = 0          // 마지막 종료 시각 (ms) — 빠른 연속 크래시 감지
const MAX_RESTARTS = 5        // 최대 연속 재시작 횟수
const RESTART_WINDOW = 10000  // 이 시간(ms) 내 연속 종료 시 재시작 카운트 증가

// 기본 셸: macOS는 zsh, Linux는 bash, Windows는 cmd
const DEFAULT_SHELL = process.platform === 'win32' ? 'cmd.exe' :
  process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')

export function initPTY(win: BrowserWindow): void {
  mainWindow = win
}

export function createPTY(cols = 120, rows = 30): void {
  // 기존 PTY를 의도적으로 종료 (자동 재시작 억제)
  if (ptyProcess) {
    intentionalKill = true
    try { ptyProcess.kill() } catch { /* ignore */ }
    ptyProcess = null
  }

  // 환경변수: LANG은 덮어쓰지 않음 (시스템 기본값 사용)
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }

  ptyProcess = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-256color',
    cols,
    rows,
    // nova-voice 프로젝트 디렉토리 사용 (Claude 신뢰 프롬프트 방지)
    cwd: app.isPackaged
      ? os.homedir()
      : path.resolve(__dirname, '../../'),
    env,
  })

  intentionalKill = false  // 새 PTY 생성 완료 — 이후 비정상 종료는 자동 재시작
  restartCount = 0          // 정상 생성 완료 — 재시작 카운터 초기화

  ptyProcess.onData((data: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', data)
    }
    // Claude 감지용 최근 출력 업데이트
    updateRecentPTYOutput(data)
    // Claude 신뢰 프롬프트 자동 승인 (1. Yes, I trust this folder)
    autoConfirmClaudeTrust()
    // 응답 캡처 중이면:
    //   - idle 타이머: 모든 데이터에 리셋 (스피너 포함) → Claude 마지막 출력 후 idleMs 뒤에 flush
    //   - 버퍼: 실제 콘텐츠만 추가 (노이즈 제외) → 추출 품질 향상
    // ⚠️ 이전 버그: 노이즈=타이머 리셋 안 함 → 에코 후 3초에 조기 flush (Claude 응답 전!)
    if (capture) {
      // \n 보존 — 라인별 노이즈 감지를 위해 \x0a(\n) 제외하고 제어문자 제거
      const stripped = data
        .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')  // CSI
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')            // OSC
        .replace(/\x1b./g, '')                                          // 기타 ESC
        .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')                     // 제어문자 (\n=\x0a 제외)
      // 한 줄이 노이즈인지 판단하는 헬퍼
      const isNoiseLine = (t: string): boolean =>
        // api ws 패턴: ✗(U+2717) 포함 — "api✗ ws✗ [Cla Opn...]" 상태바 감지
        /api[^\w\n]{0,3}ws/i.test(t)
        || /NCO.*(?:직접|↑|↓|%)|bypass\s*permission|shift.*tab.*cycle/i.test(t)
        || /claude[-\s]?\d.*(?:Sonnet|Opus|Haiku|4\.\d)/i.test(t)
        || /Ctx:\s*\d+%|주별|weekly|\d+%\s*[·•]\s*주별/i.test(t)
        || /^[✢✳✦✧✸✼❋✻✶✷✹✺]\s+\w+[…\.]*\s*$/.test(t)
        || /^[✢✳✦✧✸✼❋✻✶✷✹✺·]\s*[a-zA-Z0-9.…]*$/.test(t)
        || /^[⎿└]\s+Tip:/i.test(t)
        // Claude Code 스피너 단어: -ing/-ting/-zing 으로 끝나는 단일 영문 단어
        || /^[a-zA-Z]+(?:ing|ting|zing)[.…]*$/i.test(t)
        // Flambé 등 라틴 확장 문자 포함 단일 대문자 시작 단어 (6-25자)
        || /^[A-Z\u00C0-\u00D6\u00D8-\u00DE][a-zA-Z\u00C0-\u024F]{5,24}[.…!]?$/.test(t)
        // 수평선으로 시작하는 장식/구분선 (내용 있어도 제거)
        || /^[─━═╌╍┄┅]{5,}/.test(t)
        || /^\??\d{1,3}$/.test(t)
      const nonEmptyLines = stripped.split('\n').map(l => l.trim()).filter(l => l.length > 0)
      if (nonEmptyLines.length > 0) {
        // idle 타이머는 항상 리셋 (스피너도 포함) — Claude 출력이 완전히 멈춘 후 flush
        if (capture.idleTimer) clearTimeout(capture.idleTimer)
        capture.idleTimer = setTimeout(flushCapture, capture.idleMs ?? 1500)
        // 버퍼에는 실제 콘텐츠가 있는 청크만 추가 (순수 노이즈 청크 제외)
        const hasRealContent = nonEmptyLines.some(l => !isNoiseLine(l))
        if (hasRealContent) {
          capture.buffer += data
        }
      }
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[PTY] Shell exited with code ${exitCode}`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', exitCode)
    }
    resetClaudeLastSeen()  // Claude 감지 이력 초기화
    ptyProcess = null

    // 의도적 종료가 아닌 경우에만 자동 재시작 (claude 등 실행 후 셸 종료 방지)
    if (!intentionalKill) {
      const now = Date.now()
      if (now - lastExitTime < RESTART_WINDOW) {
        restartCount++
      } else {
        restartCount = 1
      }
      lastExitTime = now

      if (restartCount > MAX_RESTARTS) {
        console.error(`[PTY] Max restarts (${MAX_RESTARTS}) exceeded — giving up`)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:error', `터미널 재시작에 ${MAX_RESTARTS}번 실패했어요. 앱을 다시 시작해주세요.`)
        }
        restartCount = 0
      } else {
        // 지수 백오프: 500ms → 1s → 2s → 4s → 8s
        const delay = Math.min(500 * Math.pow(2, restartCount - 1), 8000)
        console.log(`[PTY] Restarting in ${delay}ms (attempt ${restartCount}/${MAX_RESTARTS})`)
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            createPTY(cols, rows)
          }
        }, delay)
      }
    }
  })

  console.log(`[PTY] Created: ${DEFAULT_SHELL} (${cols}x${rows})`)
}

export function writeToPTY(data: string): void {
  ptyProcess?.write(data)
}

export function resizePTY(cols: number, rows: number): void {
  ptyProcess?.resize(cols, rows)
}

export function destroyPTY(): void {
  if (ptyProcess) {
    intentionalKill = true
    try { ptyProcess.kill() } catch { /* ignore */ }
    ptyProcess = null
  }
}

/**
 * NCO/슬래시 명령어 안정적 실행 — 3단계 타이밍 보장
 * 문제: writeToPTY(cmd + '\r') 단일 호출 시 Claude 출력 중이면 \r 이 씹힘
 * 해결: 라인 클리어(Ctrl+U) → 명령 입력 → 100ms 후 Enter → 600ms 후 안전망 Enter
 */
export async function sendCommandToPTY(command: string): Promise<void> {
  if (!ptyProcess) {
    createPTY()
    await new Promise(r => setTimeout(r, 300))
  }
  // 1) 현재 입력 줄 클리어 (진행 중인 타이핑이 있을 경우 제거)
  ptyProcess?.write('\x15')
  await new Promise(r => setTimeout(r, 50))
  // 2) 명령어 입력
  ptyProcess?.write(command)
  await new Promise(r => setTimeout(r, 100))
  // 3) 첫 번째 Enter
  ptyProcess?.write('\r')
  // 4) 600ms 후 안전망 Enter (이미 실행된 경우 빈 줄로 무해)
  setTimeout(() => { ptyProcess?.write('\r') }, 600)
}

// 음성 명령 → PTY에 타이핑 (Claude Code 등 실행)
export async function typeCommandInPTY(command: string): Promise<void> {
  await sendCommandToPTY(command)
}

export function isPTYReady(): boolean {
  return ptyProcess !== null
}

// ── PTY에 실행 중인 Claude가 있는지 감지 ──────────────────────────────────────
// 최근 PTY 출력에 Claude Code 특징 패턴이 있으면 true
let _recentPTYOutput = ''
let _claudeLastSeen = 0          // Claude 마지막 감지 타임스탬프 (ms)
const CLAUDE_SEEN_TTL = 300_000  // 5분 이내 감지 이력 = 실행 중으로 간주

export function updateRecentPTYOutput(data: string): void {
  _recentPTYOutput = (_recentPTYOutput + data).slice(-4000)  // 최근 4KB만 유지
  // Claude 감지 시 타임스탬프 갱신 (버퍼 침묵 중 odetection 유지용)
  if (/claude[-\s]?\d|Claude Code|bypass permissions|Sonnet|Opus|Haiku/i.test(data) ||
      /api.*ws.*Cla/i.test(data)) {
    _claudeLastSeen = Date.now()
  }
}

// Claude 이력 초기화 (PTY 종료 또는 intentional kill 시 호출)
export function resetClaudeLastSeen(): void {
  _claudeLastSeen = 0
}

export function isClaudeRunningInPTY(): boolean {
  // 1) 현재 버퍼에 Claude 패턴 존재
  const inBuffer = /claude[-\s]?\d|Claude Code|bypass permissions|Sonnet|Opus|Haiku/.test(_recentPTYOutput) ||
                   /api.*ws.*Cla/i.test(_recentPTYOutput)
  // 2) 최근 5분 이내 Claude를 감지한 이력 + PTY 살아있음
  const recentHistory = _claudeLastSeen > 0 && (Date.now() - _claudeLastSeen) < CLAUDE_SEEN_TTL && ptyProcess !== null
  return inBuffer || recentHistory
}

// ── Claude 신뢰 프롬프트 자동 승인 ───────────────────────────────────────────
// "Accessing workspace" 감지 → 2초 후 Enter (신뢰 프롬프트 자동 승인)
let _trustConfirmSent = false
let _trustEnterTimer: ReturnType<typeof setTimeout> | null = null

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB012]/g, '').replace(/\x1b./g, '')
}

function autoConfirmClaudeTrust(): void {
  if (_trustConfirmSent) return
  const clean = stripAnsi(_recentPTYOutput)
  // "Accessing workspace" 또는 "Quick safety check" 감지 시 2초 후 Enter
  if (/Accessing workspace|Quick safety check|I trust this folder/.test(clean)) {
    if (_trustEnterTimer) return  // 이미 타이머 진행 중
    console.log('[PTY] Claude 신뢰 프롬프트 감지 — 2초 후 Enter 전송')
    _trustEnterTimer = setTimeout(() => {
      _trustEnterTimer = null
      _trustConfirmSent = true
      ptyProcess?.write('\r')
      console.log('[PTY] Enter 전송 완료 (신뢰 승인)')
      // 10초 후 재감지 허용
      setTimeout(() => { _trustConfirmSent = false }, 10000)
    }, 2000)
  }
}

// ── PTY 응답 캡처 (음성 입력 → TTS 출력) ────────────────────────────────────
// 타이핑 후 PTY 출력을 버퍼링, idleMs 동안 출력 없으면 콜백 호출

type CaptureCallback = (cleanText: string) => void

let capture: {
  buffer: string
  idleTimer: ReturnType<typeof setTimeout> | null
  maxTimer: ReturnType<typeof setTimeout> | null
  idleMs: number
  callback: CaptureCallback
} | null = null

export function startPTYResponseCapture(
  callback: CaptureCallback,
  idleMs = 1500,
  maxMs = 30000
): void {
  stopPTYResponseCapture()
  capture = { buffer: '', idleTimer: null, maxTimer: null, idleMs, callback }
  // maxTimer만 즉시 시작 — idle 타이머는 첫 실제 컨텐츠 도착 시 시작
  // (즉시 idleTimer 시작 시 Claude 응답이 3초+ 걸리면 빈 버퍼로 조기 flush됨)
  capture.maxTimer = setTimeout(() => {
    if (capture) (capture as any)._timedOut = true
    flushCapture()
  }, maxMs)
}

export function stopPTYResponseCapture(): void {
  if (!capture) return
  if (capture.idleTimer) clearTimeout(capture.idleTimer)
  if (capture.maxTimer) clearTimeout(capture.maxTimer)
  capture = null
}

function flushCapture(): void {
  if (!capture) return
  const timedOut = !!(capture as any)._timedOut
  const { buffer, callback } = capture
  stopPTYResponseCapture()

  // ANSI/VT 전체 제거 후 raw 텍스트 전달
  // ⚠️ \r 덮어쓰기 시뮬레이션 금지 — Claude Code 상태바가 \r로 응답 텍스트를 덮어 clean=0이 됨
  const clean = buffer
    // CSI 시퀀스 (색상, 커서, 지우기 등) — 먼저 제거
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    // OSC 시퀀스 (타이틀, 링크 등)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS, PM, APC, SOS, SS2, SS3
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    // 나머지 단일 ESC 시퀀스
    .replace(/\x1b./g, '')
    // \r → 줄바꿈으로 변환 (덮어쓰기 시뮬레이션 대신 줄 분리)
    .replace(/\r/g, '\n')
    // 남은 제어문자 (줄바꿈 \x0a 제외)
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
    // 중복 줄바꿈 정리
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (timedOut) console.log("[PTY] Response capture timed out")
  console.log(`[PTY Capture] buf=${buffer.length} clean=${clean.length} preview="${clean.substring(0, 80).replace(/\n/g,' ')}"`)
  if (clean.length > 10) {
    callback(clean)
  }
}

// ── Claude PTY 응답 텍스트 정제 ───────────────────────────────────────────────
// Claude Code interactive 출력에서 실제 응답만 추출
export function extractClaudeResponseFromPTY(raw: string, question: string): string {
  let lines = raw.split('\n')

  // 1. 입력 에코 이후만 사용 (질문 앞부분 30자로 위치 탐색)
  const questionSnippet = question.substring(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const echoIdx = lines.findIndex(l => new RegExp(questionSnippet, 'i').test(l))
  if (echoIdx !== -1) lines = lines.slice(echoIdx + 1)

  // 2. 스피너/진행표시 라인 제거
  lines = lines.filter(l => !/^[⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷●○◐◑◒◓\s]*$/.test(l.trim() || ' '))
  lines = lines.filter(l => !/^\s*[⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷].*(?:Thinking|Working|Analyzing|Running|Searching)/i.test(l))
  // Claude Code 사고 단계 스피너: ✢ ✶ ✳ ✦ + 공백 + 단어 패턴 (공백 있음)
  lines = lines.filter(l => !/^[✢✳✦✧✸✼❋✻✶✷✹✺]\s+\w+[…\.]*\s*$/.test(l.trim()))
  // 스피너 char + 붙어쓰기 영문 단편: ✶c, ✻Nu, ✸Nucl 등 (공백 없이 붙음)
  lines = lines.filter(l => !/^[✢✳✦✧✸✼❋✻✶✷✹✺·]\s*[a-zA-Z0-9.…]*$/.test(l.trim()))
  // Claude Code 스피너 단어 — 단일 영문 단어가 -ing/-ting/-zing으로 끝나는 줄 전체 제거
  // (Nucleating, Computing, Razzmatazzing, Riffing 등 현재/미래 모든 스피너 포괄)
  lines = lines.filter(l => !/^[a-zA-Z]+(?:ing|ting|zing)[.…]*$/i.test(l.trim()))
  // 위 패턴으로 잡히지 않는 기타 스피너 단어: ASCII+라틴확장 단일 단어 6-25자 (Flambé 등)
  // 대문자 시작 + 소문자 계속 → 스피너 단어 패턴 (한국어 응답에 영향 없음)
  lines = lines.filter(l => !/^[A-Z\u00C0-\u00D6\u00D8-\u00DE][a-zA-Z\u00C0-\u024F]{5,24}[.…!]?$/.test(l.trim()))
  // 위 패턴으로 잡히지 않는 기타 컴퓨팅 라벨 단편 (Nuclei, Perplex 등)
  lines = lines.filter(l => !/^(?:Nuclei|Perplex|Analyz|Synthes|Theori|Reflect)[a-zA-Z.…]*$/i.test(l.trim()))
  // 짧은 영문 단편 (1-4자, 한국어 없음) — \r 덮어쓰기 애니메이션 잔여 조각
  lines = lines.filter(l => !/^[a-zA-Z]{1,4}[.…]?$/.test(l.trim()))
  // Tip 라인 (extractClaudeResponseFromPTY 레벨 추가 차단 — 다중줄 청크 누락 방어)
  lines = lines.filter(l => !/^[⎿└]\s+Tip:/i.test(l.trim()))
  // 괄호로만 감싸인 한국어 상태 메시지 (예: "(턴 종료 분석 중...)")
  lines = lines.filter(l => !/^\([가-힣\w\s.…]*(?:중|ing)[.…]*\)$/.test(l.trim()))
  // Claude Code UI 장식 라인: ─────… / ━━━… 등 수평선 (뒤에 내용 있어도 제거 — $ 앵커 제거)
  // "──────────────────────────────────────삼십구m" 같은 구분선+내용 포함
  lines = lines.filter(l => !/^[─━═╌╍┄┅]{5,}/.test(l.trim()))

  // 3. Claude Code 상태바/UI 라인 제거 (포괄적 패턴)
  lines = lines.filter(l => {
    const t = l.replace(/\s+/g, ' ').trim()  // 공백 정규화 (붙어쓰기 처리)
    if (!t) return false  // 빈 줄은 일단 유지 (후처리에서 정리)

    // 상태바 첫 줄: "api ws [Cla Opn Gem …]" — ✗(U+2717) 포함 모든 변형 처리
    if (/api[^\w\n]{0,3}ws/i.test(t)) return false
    // NCO 진행바: "NCO ░▒█ 0%(NCO:0↑직접:0↓)" — 진행바 문자 또는 %+직접 패턴
    if (/NCO[\s\S]{0,20}(?:직접|↑|↓)/i.test(t)) return false
    if (/NCO.*\d+%/i.test(t) && /직접|↑|↓/.test(t)) return false
    // bypass permissions: 붙어서 나오는 경우 포함
    if (/bypass\s*permissions?\s*on/i.test(t)) return false
    if (/shift\s*\+?\s*tab\s*to\s*cycle/i.test(t)) return false
    // 모델 표시: "claude-1 [Sonnet 4.6]" 또는 "claude-N [Model]"
    if (/claude[-\s]?\d.*(?:Sonnet|Opus|Haiku|4\.\d)/i.test(t)) return false
    // 비용/시간 표시: "1일 05/06 16:40 · 주별" or "↻ 1일"
    if (/(?:↻|주별|weekly).*\d{2}\/\d{2}/i.test(t)) return false
    if (/\d+일.*주별/i.test(t)) return false
    if (/주별\s*\d{2}\/\d{2}/i.test(t)) return false
    // 컨텍스트/비용: "Ctx:0% | $0.05" or "1% · 주별 2%"
    if (/Ctx:\d+%\s*\|/i.test(t)) return false
    if (/\d+%\s*[·•]\s*주별\s*\d+%/i.test(t)) return false
    // 터미널 커서 위치 쿼리: "?20" 또는 숫자만 있는 줄
    if (/^\??\d{1,3}$/.test(t)) return false
    // ⏵⏵ 또는 >> 로 시작하는 UI 프롬프트
    if (/^[⏵►»>]{1,3}\s*bypass/i.test(t)) return false
    if (/^[⏵►»>]{2,}/.test(t)) return false

    return true
  })

  // 4. Claude 프롬프트 라인 제거 (끝부분)
  while (lines.length && /^\s*[>❯►»]\s*$/.test(lines[lines.length - 1].trim())) {
    lines.pop()
  }

  // 5. 앞뒤 빈 줄 정리
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ── 음성 → PTY Claude → TTS 통합 핵심 함수 ──────────────────────────────────
// 1. PTY에 질문 타이핑
// 2. Claude 응답 캡처 (idle 감지)
// 3. 응답 정제 후 callback으로 전달
export async function askClaudeViaPTY(
  question: string,
  onResponse: (text: string) => void,
  opts: { idleMs?: number; maxMs?: number } = {}
): Promise<void> {
  const idleMs = opts.idleMs ?? 3000   // 3초 무응답 = Claude 완료
  const maxMs  = opts.maxMs  ?? 90000  // 최대 90초 대기

  // 캡처 먼저 시작 (타이핑 전)
  startPTYResponseCapture((rawText) => {
    const response = extractClaudeResponseFromPTY(rawText, question)
    console.log(`[PTY-Claude] Extracted ${response.length} chars from ${rawText.length} chars raw`)
    if (response.length > 5) {
      onResponse(response)
    } else {
      // 파싱 실패 시 raw 텍스트 일부라도 전달
      const fallback = rawText.substring(0, 500).replace(/\n{3,}/g, '\n\n').trim()
      if (fallback.length > 5) onResponse(fallback)
    }
  }, idleMs, maxMs)

  // 50ms 후 타이핑 (캡처 활성화 보장)
  await new Promise(r => setTimeout(r, 50))
  writeToPTY(question + '\r')
}
