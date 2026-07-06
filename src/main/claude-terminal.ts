/**
 * Claude Terminal — nova-voice 내장 Claude CLI 실행기
 *
 * 음성 명령이 내장 명령어에 없으면 Claude CLI로 라우팅:
 *   claude -p "prompt" --dangerously-skip-permissions
 *
 * 터미널 패널에 실시간 스트리밍 출력
 */

import { BrowserWindow } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'

const execFile = promisify(execFileCb)

let mainWindow: BrowserWindow | null = null

// Claude binary 경로 후보
const CLAUDE_PATHS = [
  '/Users/nova-ai/.local/bin/claude',
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
]

function findClaude(): string {
  for (const p of CLAUDE_PATHS) {
    if (fs.existsSync(p)) return p
  }
  return 'claude'  // PATH에서 찾기
}

function getClaudeStatusFromPath(claudePath: string): boolean {
  if (claudePath !== 'claude') return fs.existsSync(claudePath)

  const result = spawnSync('command', ['-v', 'claude'], {
    shell: true,
    stdio: 'ignore',
  })

  if (result.status === 0) return true

  console.error('[Claude-Terminal] Claude CLI not found in PATH')
  return false
}

export function initClaudeTerminal(win: BrowserWindow): void {
  mainWindow = win
  const claudePath = findClaude()
  const ready = getClaudeStatusFromPath(claudePath)
  console.log(`[Claude-Terminal] Initialized, binary: ${claudePath}`)
  // 상태 전송
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('claude:status', {
      ready,
      path: claudePath,
    })
  })
}

export function getClaudeStatus(): { ready: boolean; path: string } {
  const p = findClaude()
  return { ready: getClaudeStatusFromPath(p), path: p }
}

// ── 핵심: Claude CLI에 프롬프트 보내고 결과 스트리밍 ─────────────────────
export async function executeWithClaude(prompt: string, opts?: {
  notify?: boolean   // 터미널 패널로 네비게이트할지 여부
}): Promise<string> {
  const claudePath = findClaude()

  return new Promise((resolve) => {
    // 터미널에 입력 표시
    emit('input', `\n▶ [VOICE → CLAUDE]\n${prompt}\n${'─'.repeat(40)}\n`)

    // 터미널 뷰로 자동 이동
    if (opts?.notify !== false) {
      mainWindow?.webContents.send('view:navigate', 'terminal')
    }

    let output = ''
    let settled = false

    const args = [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'text',
    ]

    const proc = spawn(claudePath, args, {
      env: {
        ...process.env,
        TERM: 'dumb',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      emit('error', `\n[타임아웃] Claude 응답 없음 (30s)\n`)
      resolve('')
    }, 30_000)

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      output += text
      emit('stdout', text)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      // Claude CLI stderr에는 진행 상황 표시 등이 있으므로 표시
      if (!text.includes('Bypassing permissions')) {
        emit('stderr', text)
      }
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      emit('system', `\n${'─'.repeat(40)}\n[완료 · exit ${code}]\n`)
      resolve(output.trim())
    })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      emit('error', `\n[오류] Claude 실행 실패: ${err.message}\n경로: ${claudePath}\n`)
      resolve('')
    })
  })
}

// 터미널 패널에 직접 입력 (수동 타이핑)
export async function sendClaudeInput(text: string): Promise<string> {
  return executeWithClaude(text, { notify: false })
}

// 터미널 패널 이동 없이 결과만 반환 — Smart Mode search/answer에서 사용
// claude -p --dangerously-skip-permissions 이므로 bash, WebSearch, 모든 도구 사용 가능
export async function executeWithClaudeSilent(prompt: string): Promise<string> {
  const claudePath = findClaude()

  return new Promise((resolve, reject) => {
    let output = ''
    let stderr = ''

    const args = [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'text',
    ]

    const proc = spawn(claudePath, args, {
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stdout?.on('data', (data: Buffer) => { output += data.toString() })
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

    proc.on('close', (code) => {
      const result = output.trim()
      if (code !== 0 && !result) {
        reject(new Error(`Claude exit ${code}: ${stderr.substring(0, 200)}`))
      } else {
        resolve(result)
      }
    })

    proc.on('error', (err) => reject(err))
  })
}

function emit(type: 'input' | 'stdout' | 'stderr' | 'system' | 'error', text: string) {
  mainWindow?.webContents.send('claude:output', { type, text })
}
