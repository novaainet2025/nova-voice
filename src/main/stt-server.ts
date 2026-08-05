/**
 * STT Server lifecycle manager
 * @@gentop/lib/stt 내장 서버(FastAPI WebSocket :8765)를 자동 시작/종료
 */
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import net from 'net'

const STT_PORT = 8765
const STT_URL = `http://localhost:${STT_PORT}`

function getSttServerDir(): string {
  const candidates = [
    process.env.NOVA_STT_SERVER_DIR,
    path.join(os.homedir(), 'project', '@@gentop', 'lib', 'stt'),
    path.resolve(process.cwd(), '..', '@@gentop', 'lib', 'stt'),
    path.resolve(__dirname, '..', '..', '..', '..', '@@gentop', 'lib', 'stt'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'server', 'main.py'))
      && fs.existsSync(path.join(candidate, '.venv', 'bin', 'python3'))) {
      return candidate
    }
  }
  throw new Error(`Whisper STT server not found. Checked: ${candidates.join(', ')}`)
}

let serverProcess: ChildProcess | null = null
let startPromise: Promise<boolean> | null = null

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
  if (startPromise) {
    return startPromise
  }

  startPromise = (async () => {
  if (await isPortInUse()) {
    console.log(`[STT Server] Already running on :${STT_PORT}`)
    return true
  }

  const sttDir = getSttServerDir()
  const venvPython = path.join(sttDir, '.venv', 'bin', 'python3')

  console.log(`[STT Server] Starting... (${venvPython} -m server.main)`)
  console.log(`[STT Server] cwd: ${sttDir}`)

  const spawnedProcess = spawn(venvPython, ['-m', 'server.main'], {
    cwd: sttDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', STT_PARTIALS_DEFAULT: 'off' },
    detached: false,
  })
  serverProcess = spawnedProcess

  const stdoutHandler = (d: Buffer) => {
    console.log(`[STT Server] ${d.toString().trimEnd()}`)
  }
  const stderrHandler = (d: Buffer) => {
    console.log(`[STT Server/err] ${d.toString().trimEnd()}`)
  }
  const exitHandler = (code: number | null) => {
    console.log(`[STT Server] Exited with code ${code}`)
    if (serverProcess === spawnedProcess) serverProcess = null
  }

  spawnedProcess.stdout?.on('data', stdoutHandler)
  spawnedProcess.stderr?.on('data', stderrHandler)
  spawnedProcess.on('exit', exitHandler)

  const ready = await waitForReady()
  if (ready) {
    console.log(`[STT Server] Ready on :${STT_PORT}`)
  } else {
    console.error(`[STT Server] Failed to start within 30s`)
    spawnedProcess.stdout?.off('data', stdoutHandler)
    spawnedProcess.stderr?.off('data', stderrHandler)
    spawnedProcess.off('exit', exitHandler)
    spawnedProcess.kill('SIGTERM')
    if (serverProcess === spawnedProcess) serverProcess = null
  }
  return ready
  })()

  try {
    return await startPromise
  } finally {
    startPromise = null
  }
}

export async function ensureSttServerReady(maxWaitMs = 10000): Promise<boolean> {
  if (await isPortInUse()) {
    return true
  }

  if (!startPromise) {
    void startSttServer().catch((error: Error) => {
      console.error('[STT Server] Background start failed:', error)
    })
  }

  return waitForReady(maxWaitMs)
}

export async function restartSttServer(maxWaitMs = 30_000): Promise<boolean> {
  const processToStop = serverProcess
  if (!processToStop) {
    if (!await canConnectToPort()) return startSttServer()
    console.warn('[STT Server] Cannot restart an unmanaged process on :8765')
    return false
  }

  console.warn('[STT Server] Restarting after an inference transport failure')
  if (serverProcess === processToStop) serverProcess = null
  processToStop.kill('SIGTERM')

  const stopDeadline = Date.now() + 4_000
  while (Date.now() < stopDeadline && await canConnectToPort()) {
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  if (await canConnectToPort()) {
    processToStop.kill('SIGKILL')
    const killDeadline = Date.now() + 2_000
    while (Date.now() < killDeadline && await canConnectToPort()) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  if (await canConnectToPort()) return false
  return startSttServer().then(async (started) => started && waitForReady(maxWaitMs))
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
