/**
 * Client for the NOVA Use agent bridge.
 *
 * NOVA Use already drives the desktop and the browser (`@nut-tree-fork/nut-js`,
 * its browser orchestrator) and exposes that capability over a WebSocket. NOVA
 * VOICE therefore turns speech into intents and sends them here, rather than
 * growing a second control stack with its own permission and safety surface.
 *
 * Protocol, read from the NOVA Use sources rather than assumed:
 *  - message envelope `{ id, type, payload }`
 *    — nova-use/src/main/vendor/agent-protocol.ts:126-132
 *  - types `hello` / `welcome` / `error` / `browser.action.request` /
 *    `browser.action.result` — same file, lines 13-27
 *  - the first frame must be HELLO carrying a valid token, otherwise the server
 *    answers "HELLO must be the first message"
 *    — nova-use/src/main/agent-bridge-server.ts:78, 516-533
 *  - the listening port is not fixed. Each live bridge writes
 *    `<pid>-<port>.json` into a registry directory — same file, lines 277-300
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import WebSocket from 'ws'
import { logInfo, logWarn } from './logger.ts'

const MSG_HELLO = 'hello'
const MSG_WELCOME = 'welcome'
const MSG_ERROR = 'error'
const MSG_ACTION_REQUEST = 'browser.action.request'
const MSG_ACTION_RESULT = 'browser.action.result'

const CONTROL_DIR = path.join(os.homedir(), '.nco-cli-ext')
const REGISTRY_DIR = path.join(CONTROL_DIR, 'bridges')
const LEGACY_URL_FILE = path.join(CONTROL_DIR, 'bridge-url')
const LEGACY_TOKEN_FILE = path.join(CONTROL_DIR, 'bridge-token')

const CONNECT_TIMEOUT_MS = 5_000
const ACTION_TIMEOUT_MS = 30_000

/** Actions this app is allowed to ask the bridge to perform. */
export type BridgeAction = 'CLICK' | 'TYPE' | 'SCREENSHOT' | 'NAVIGATE'

export interface BridgeEndpoint {
  url: string
  token: string
  pid: number
}

interface RegistryEntry {
  url: unknown
  token: unknown
  pid: unknown
  startedAt: unknown
}

interface Envelope {
  id: string
  type: string
  payload: Record<string, unknown>
}

let socket: WebSocket | null = null
let connecting: Promise<WebSocket> | null = null
const pending = new Map<string, {
  resolve: (payload: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything, which is how a stale registry entry is told from a live one.
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Finds a bridge that is actually running.
 *
 * Several NOVA Use instances can coexist (dev build, packaged app, acceptance
 * runner), so the newest live registry entry wins and dead ones are skipped
 * instead of being dialled and timing out.
 */
export function readBridgeEndpoint(): BridgeEndpoint | null {
  let newest: { endpoint: BridgeEndpoint; startedAt: number } | null = null
  let entries: string[] = []
  try {
    entries = fs.readdirSync(REGISTRY_DIR)
  } catch {
    entries = []
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, name), 'utf8')) as RegistryEntry
      const url = typeof raw.url === 'string' ? raw.url : ''
      const token = typeof raw.token === 'string' ? raw.token : ''
      const pid = typeof raw.pid === 'number' ? raw.pid : 0
      const startedAt = typeof raw.startedAt === 'number' ? raw.startedAt : 0
      if (!url || !token || !pid || !isAlive(pid)) continue
      if (!newest || startedAt > newest.startedAt) {
        newest = { endpoint: { url, token, pid }, startedAt }
      }
    } catch {
      // A partially written or corrupt entry is skipped, not fatal.
    }
  }
  if (newest) return newest.endpoint

  // Older NOVA Use builds only wrote this single pair. It carries no pid, so a
  // stale file cannot be told from a live bridge here — the connect attempt
  // reports the refusal instead.
  try {
    const url = fs.readFileSync(LEGACY_URL_FILE, 'utf8').trim()
    const token = fs.readFileSync(LEGACY_TOKEN_FILE, 'utf8').trim()
    if (url && token) {
      logWarn('[Bridge] Falling back to the legacy bridge files; liveness is unverified', { url })
      return { url, token, pid: 0 }
    }
  } catch {
    // No legacy files either.
  }
  return null
}

function settleAll(error: Error): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(error)
  }
  pending.clear()
}

function handleMessage(data: WebSocket.RawData): void {
  let message: Envelope
  try {
    const parsed = JSON.parse(data.toString()) as unknown
    if (!parsed || typeof parsed !== 'object') return
    message = parsed as Envelope
  } catch {
    return
  }
  const entry = typeof message.id === 'string' ? pending.get(message.id) : undefined
  if (!entry) return
  pending.delete(message.id)
  clearTimeout(entry.timer)
  if (message.type === MSG_ERROR) {
    const detail = typeof message.payload?.message === 'string'
      ? message.payload.message
      : 'bridge reported an error'
    entry.reject(new Error(`NOVA Use bridge error: ${detail}`))
    return
  }
  entry.resolve(message.payload ?? {})
}

/**
 * Connects and completes the HELLO handshake.
 *
 * Each failure mode gets its own message: a bridge that is not running, a
 * refused connection and a rejected token are three different things for
 * whoever has to fix it, and a silent failure here would surface later as an
 * unexplained dead voice command.
 */
export async function connectBridge(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) return socket
  if (connecting) return connecting

  const endpoint = readBridgeEndpoint()
  if (!endpoint) {
    throw new Error(
      `NOVA Use bridge is not running: no live entry in ${REGISTRY_DIR}. Start NOVA Use first.`,
    )
  }

  connecting = new Promise<WebSocket>((resolve, reject) => {
    const next = new WebSocket(endpoint.url)
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        try { next.close() } catch { /* already closing */ }
        reject(error)
      } else {
        resolve(next)
      }
    }
    const timer = setTimeout(
      () => finish(new Error(`NOVA Use bridge did not answer HELLO within ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS,
    )

    next.once('error', (error) => finish(new Error(`NOVA Use bridge connection failed: ${error.message}`)))
    next.once('open', () => {
      const hello: Envelope = {
        id: crypto.randomUUID(),
        type: MSG_HELLO,
        payload: { token: endpoint.token, role: 'agent' },
      }
      next.send(JSON.stringify(hello))
    })
    next.on('message', (data) => {
      if (settled) {
        handleMessage(data)
        return
      }
      try {
        const message = JSON.parse(data.toString()) as Envelope
        if (message.type === MSG_WELCOME) {
          logInfo('[Bridge] Connected to NOVA Use', { url: endpoint.url, pid: endpoint.pid })
          finish()
        } else if (message.type === MSG_ERROR) {
          const detail = typeof message.payload?.message === 'string' ? message.payload.message : 'unknown'
          finish(new Error(`NOVA Use bridge rejected the handshake: ${detail}`))
        }
      } catch {
        // Ignore frames that are not JSON until the handshake settles.
      }
    })
    next.once('close', () => {
      finish(new Error('NOVA Use bridge closed the connection during the handshake'))
      if (socket === next) socket = null
      settleAll(new Error('NOVA Use bridge connection closed'))
    })
  })

  try {
    socket = await connecting
    return socket
  } finally {
    connecting = null
  }
}

/** Sends one action and waits for the matching result frame. */
export async function sendAction(
  action: BridgeAction,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const live = await connectBridge()
  const id = crypto.randomUUID()
  const request: Envelope = {
    id,
    type: MSG_ACTION_REQUEST,
    payload: { ...payload, action },
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`NOVA Use bridge did not answer ${action} within ${ACTION_TIMEOUT_MS}ms`))
    }, ACTION_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    try {
      live.send(JSON.stringify(request))
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      reject(new Error(`NOVA Use bridge send failed: ${(error as Error).message}`))
    }
  })
}

/** Expected result frame type, exported so callers can assert on it. */
export const BRIDGE_ACTION_RESULT = MSG_ACTION_RESULT

export function closeBridge(): void {
  settleAll(new Error('NOVA Use bridge closed'))
  if (!socket) return
  try {
    socket.close()
  } catch (error) {
    logWarn('[Bridge] Failed to close cleanly', { error: (error as Error).message })
  }
  socket = null
}
