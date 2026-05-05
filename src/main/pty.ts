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

  ptyProcess.onData((data: string) => {
    mainWindow?.webContents.send('pty:data', data)
    // Claude 감지용 최근 출력 업데이트
    updateRecentPTYOutput(data)
    // Claude 신뢰 프롬프트 자동 승인 (1. Yes, I trust this folder)
    autoConfirmClaudeTrust()
    // 응답 캡처 중이면 버퍼에 추가 + idle 타이머 리셋
    if (capture) {
      capture.buffer += data
      if (capture.idleTimer) clearTimeout(capture.idleTimer)
      capture.idleTimer = setTimeout(flushCapture, capture.idleMs ?? 1500)
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[PTY] Shell exited with code ${exitCode}`)
    mainWindow?.webContents.send('pty:exit', exitCode)
    ptyProcess = null

    // 의도적 종료가 아닌 경우에만 자동 재시작 (claude 등 실행 후 셸 종료 방지)
    if (!intentionalKill) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          createPTY(cols, rows)
        }
      }, 500)
    }
    intentionalKill = false
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

// 음성 명령 → PTY에 타이핑 (Claude Code 등 실행)
export async function typeCommandInPTY(command: string): Promise<void> {
  if (!ptyProcess) createPTY()
  await new Promise(r => setTimeout(r, 100))
  writeToPTY(command + '\r')
}

export function isPTYReady(): boolean {
  return ptyProcess !== null
}

// ── PTY에 실행 중인 Claude가 있는지 감지 ──────────────────────────────────────
// 최근 PTY 출력에 Claude Code 특징 패턴이 있으면 true
let _recentPTYOutput = ''
export function updateRecentPTYOutput(data: string): void {
  _recentPTYOutput = (_recentPTYOutput + data).slice(-4000)  // 최근 4KB만 유지
}

export function isClaudeRunningInPTY(): boolean {
  // Claude Code 특징: 상태바 패턴 or 프롬프트 패턴
  return /claude[-\s]?\d|Claude Code|bypass permissions|Sonnet|Opus|Haiku/.test(_recentPTYOutput) ||
         /api.*ws.*Cla/i.test(_recentPTYOutput)
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
  capture.maxTimer = setTimeout(flushCapture, maxMs)
  capture.idleTimer = setTimeout(flushCapture, idleMs)
}

export function stopPTYResponseCapture(): void {
  if (!capture) return
  if (capture.idleTimer) clearTimeout(capture.idleTimer)
  if (capture.maxTimer) clearTimeout(capture.maxTimer)
  capture = null
}

function flushCapture(): void {
  if (!capture) return
  const { buffer, callback } = capture
  stopPTYResponseCapture()

  // ANSI/VT 전체 제거 후 raw 텍스트 전달 (필터링은 호출자가 판단)
  const clean = buffer
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')   // CSI (색상, 커서)
    .replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, '') // OSC (타이틀 등)
    .replace(/\x1b./g, '')                    // 기타 ESC 시퀀스
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '') // 제어문자 (줄바꿈 제외)
    .replace(/\r/g, '')
    .trim()

  console.log(`[PTY Capture] flushed ${clean.length} chars`)
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

  // 3. Claude Code 상태바/UI 라인 제거
  lines = lines.filter(l => !/api\s+ws.*Cla\s+Opn/i.test(l))       // 상태바
  lines = lines.filter(l => !/NCO\s+\d+%.*직접/i.test(l))           // NCO 상태
  lines = lines.filter(l => !/bypass permissions on/i.test(l))       // 권한 표시
  lines = lines.filter(l => !/claude-\d+\s+\[Sonnet|Opus|Haiku/i.test(l))  // 모델 표시
  lines = lines.filter(l => !/^\s*\d+일\s+\d+%.*주별/i.test(l))     // 비용 표시
  lines = lines.filter(l => !/Ctx:\d+%\s*\|\s*\$/i.test(l))          // 컨텍스트 비용

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
