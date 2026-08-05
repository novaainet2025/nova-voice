/**
 * Shared low-level access to the neural-cli-orchestrator Core.
 *
 * Kept separate from the meta-prompt runtime so the provider selector can talk
 * to the same endpoint without importing it (which would be circular).
 */

const DEFAULT_NCO_BASE = 'http://127.0.0.1:6200'

export type JsonRecord = Record<string, unknown>

export function resolveNcoBase(): string {
  // NOVA VOICE talks directly to the general neural-cli-orchestrator Core.
  // Do not allow a Nova Use sidecar (or another loopback service) to replace
  // the provider registry and readiness source through an inherited env var.
  return DEFAULT_NCO_BASE
}

function readNcoToken(): string | undefined {
  return process.env.NCO_TOKEN?.trim() || undefined
}

export function redactSecrets(value: string): string {
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/gi, '***REDACTED***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '***REDACTED***')
    .replace(/gh[po]_[A-Za-z0-9]{20,}/gi, '***REDACTED***')
    .replace(/xox[bap]-[A-Za-z0-9-]{10,}/gi, '***REDACTED***')
    .replace(/AKIA[0-9A-Z]{16}/g, '***REDACTED***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer ***REDACTED***')
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecrets(message).replace(/\s+/g, ' ').trim().slice(0, 500)
}

export async function ncoRequestJson(
  route: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
  parentSignal?: AbortSignal,
): Promise<JsonRecord> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`NCO request timed out: ${route}`)), timeoutMs)
  const abortFromParent = () => controller.abort(parentSignal?.reason ?? new Error('Meta prompt cancelled'))
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })

  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const token = readNcoToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  try {
    const response = await fetch(`${resolveNcoBase()}${route}`, {
      ...init,
      headers,
      signal: controller.signal,
    })
    const body = await response.json().catch(() => ({})) as JsonRecord
    if (!response.ok) {
      const detail = [body.error, body.detail, body.reason]
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .join(': ')
      throw new Error(`NCO ${route} returned ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    return body
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', abortFromParent)
  }
}

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
