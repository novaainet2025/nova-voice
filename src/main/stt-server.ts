/**
 * STT Server lifecycle manager
 * @@gentop/lib/stt 내장 서버(FastAPI WebSocket :8765)를 자동 시작/종료
 */
import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import http from 'http'
import net from 'net'
import { is } from '@electron-toolkit/utils'

const STT_PORT = 8765
const STT_URL = `http://localhost:${STT_PORT}`

function getSttServerDir(): string {
  if (is.dev) {
    return path.resolve(process.cwd(), '..', '@@gentop', 'lib', 'stt')
  }
  return path.resolve(__dirname, '..', '..', '..', '..', '@@gentop', 'lib', 'stt')
}

let serverProcess: ChildProcess | null = null

function canConnectToPort(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: STT_PORT })
    let settled = false

    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

function verifySttIdentity(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${STT_URL}/`, { timeout: 2000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        resolve(res.statusCode === 200 && /whisper|stt/i.test(body))
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

async function isPortInUse(): Promise<boolean> {
  if (!await canConnectToPort()) return false
  return verifySttIdentity()
}

async function waitForReady(maxWaitMs = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    if (await isPortInUse()) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

export async function startSttServer(): Promise<boolean> {
  if (await isPortInUse()) {
    console.log(`[STT Server] Already running on :${STT_PORT}`)
    return true
  }

  const sttDir = getSttServerDir()
  const venvPython = path.join(sttDir, '.venv', 'bin', 'python3')

  console.log(`[STT Server] Starting... (${venvPython} -m server.main)`)
  console.log(`[STT Server] cwd: ${sttDir}`)

  serverProcess = spawn(venvPython, ['-m', 'server.main'], {
    cwd: sttDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    detached: false,
  })

  const stdoutHandler = (d: Buffer) => {
    console.log(`[STT Server] ${d.toString().trimEnd()}`)
  }
  const stderrHandler = (d: Buffer) => {
    console.log(`[STT Server/err] ${d.toString().trimEnd()}`)
  }
  const exitHandler = (code: number | null) => {
    console.log(`[STT Server] Exited with code ${code}`)
    serverProcess = null
  }

  serverProcess.stdout?.on('data', stdoutHandler)
  serverProcess.stderr?.on('data', stderrHandler)
  serverProcess.on('exit', exitHandler)

  const ready = await waitForReady()
  if (ready) {
    console.log(`[STT Server] Ready on :${STT_PORT}`)
  } else {
    console.error(`[STT Server] Failed to start within 30s`)
    serverProcess?.stdout?.off('data', stdoutHandler)
    serverProcess?.stderr?.off('data', stderrHandler)
    serverProcess?.off('exit', exitHandler)
    serverProcess?.kill('SIGTERM')
    serverProcess = null
  }
  return ready
}

export function stopSttServer(): void {
  if (serverProcess) {
    console.log('[STT Server] Stopping...')
    serverProcess.kill('SIGTERM')
    serverProcess = null
  }
}

export async function isSttServerRunning(): Promise<boolean> {
  return isPortInUse()
}
