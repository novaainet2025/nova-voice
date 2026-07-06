import fs from 'fs'
import os from 'os'
import path from 'path'

const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'nova-voice')
const LOG_FILE = path.join(LOG_DIR, 'main.log')
const LOG_BACKUP_FILE = `${LOG_FILE}.1`
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

function rotateIfNeeded(): void {
  try {
    const stats = fs.statSync(LOG_FILE)
    if (stats.size < MAX_LOG_SIZE_BYTES) return

    if (fs.existsSync(LOG_BACKUP_FILE)) {
      fs.unlinkSync(LOG_BACKUP_FILE)
    }
    fs.renameSync(LOG_FILE, LOG_BACKUP_FILE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[Logger] Rotation failed:', error)
    }
  }
}

function formatMeta(meta?: unknown): string {
  if (meta === undefined) return ''
  if (meta instanceof Error) {
    return `\n${meta.stack ?? `${meta.name}: ${meta.message}`}`
  }
  if (typeof meta === 'string') return ` ${meta}`
  try {
    return ` ${JSON.stringify(meta)}`
  } catch {
    return ` ${String(meta)}`
  }
}

function writeLog(level: 'INFO' | 'WARN' | 'ERROR', message: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${formatMeta(meta)}\n`

  if (level === 'ERROR') {
    console.error(message, meta ?? '')
  } else if (level === 'WARN') {
    console.warn(message, meta ?? '')
  } else {
    console.log(message, meta ?? '')
  }

  try {
    ensureLogDir()
    rotateIfNeeded()
    fs.appendFileSync(LOG_FILE, line, 'utf8')
  } catch (error) {
    console.error('[Logger] Write failed:', error)
  }
}

export function logInfo(message: string, meta?: unknown): void {
  writeLog('INFO', message, meta)
}

export function logWarn(message: string, meta?: unknown): void {
  writeLog('WARN', message, meta)
}

export function logError(message: string, meta?: unknown): void {
  writeLog('ERROR', message, meta)
}

export function getMainLogPath(): string {
  return LOG_FILE
}
