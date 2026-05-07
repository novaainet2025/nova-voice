import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import http from 'http'
import https from 'https'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { isProviderHealthy, recordProviderSuccess, recordProviderFailure } from './self-heal'
import { sanitizeTTSText } from './tts-client'

const execFile = promisify(execFileCb)

const NCO_URL = 'http://localhost:6200'
const OLLAMA_URL = 'http://localhost:11434'
const REQUEST_TIMEOUT = 60000

// Gemini API key rotation — reads from nco/.env
function loadGeminiKeys(): string[] {
  try {
    // __dirname = out/main → 3 levels up = /Users/nova-ai/project
    const envPath = join(__dirname, '../../..', 'nco', '.env')
    const content = readFileSync(envPath, 'utf-8')
    const multi = content.match(/^GEMINI_API_KEYS=(.+)$/m)
    if (multi) return multi[1].trim().split(',').filter(Boolean)
    const single = content.match(/^GEMINI_API_KEY=(.+)$/m)
    if (single) return [single[1].trim()]
  } catch { /* ignore */ }
  return []
}
const GEMINI_KEYS = loadGeminiKeys()
let _geminiIdx = 0
// Per-key cooldown: key → epoch ms when it can be used again
const _keyCooldowns = new Map<string, number>()

function nextGeminiKey(): string | null {
  if (!GEMINI_KEYS.length) return null
  const now = Date.now()
  // Find next available key (not in cooldown)
  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    const key = GEMINI_KEYS[_geminiIdx % GEMINI_KEYS.length]
    _geminiIdx++
    if (now >= (_keyCooldowns.get(key) ?? 0)) return key
  }
  // All keys in cooldown — return the one expiring soonest
  let best = GEMINI_KEYS[0]
  let bestUntil = _keyCooldowns.get(best) ?? 0
  for (const k of GEMINI_KEYS) {
    const u = _keyCooldowns.get(k) ?? 0
    if (u < bestUntil) { best = k; bestUntil = u }
  }
  console.warn(`[Gemini] All ${GEMINI_KEYS.length} keys in cooldown. Soonest in ${Math.ceil((bestUntil - Date.now()) / 1000)}s`)
  return best
}

// Park a key after 429. Parses Gemini's retryDelay if present.
function markKeyExhausted(key: string, errorBody: string): void {
  let coolSec = 65
  try {
    const j = JSON.parse(errorBody.replace(/^HTTP \d+: /, ''))
    const retryDelay: string | undefined = j?.error?.details?.find(
      (d: { retryDelay?: string }) => d.retryDelay
    )?.retryDelay
    if (retryDelay) {
      const m = retryDelay.match(/(\d+)/)
      if (m) coolSec = parseInt(m[1]) + 5  // parsed seconds + buffer
    }
  } catch { /* use default */ }
  _keyCooldowns.set(key, Date.now() + coolSec * 1000)
  console.warn(`[Gemini] Key …${key.slice(-6)} parked for ${coolSec}s`)
}

// Simple HTTP/HTTPS request helper (no external deps)
function httpRequest(url: string, options: { method: string; body?: string; timeout?: number; headers?: Record<string, string> }): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? https : http
    const defaultPort = parsed.protocol === 'https:' ? 443 : 80
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : defaultPort,
      path: parsed.pathname + parsed.search,
      method: options.method,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      timeout: options.timeout || REQUEST_TIMEOUT
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`))
        } else {
          resolve(data)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

// Check if NCO backend is running
export async function isNCOAvailable(): Promise<boolean> {
  try {
    const data = await httpRequest(`${NCO_URL}/health`, { method: 'GET', timeout: 3000 })
    const result = JSON.parse(data)
    return result.status === 'ok' || result.status === 'healthy'
  } catch {
    return false
  }
}

// Check if Ollama is running
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    await httpRequest(`${OLLAMA_URL}/api/tags`, { method: 'GET', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

// Get available providers status
export async function getProviderStatus(): Promise<{
  nco: boolean
  ollama: boolean
  claude: boolean
  gemini: boolean
}> {
  const [nco, ollama] = await Promise.all([
    isNCOAvailable(),
    isOllamaAvailable()
  ])

  // Check CLI tools existence (non-blocking)
  let claude = false
  let gemini = false
  try {
    await execFile('which', ['claude'])
    claude = true
  } catch { /* not installed */ }
  try {
    await execFile('which', ['gemini'])
    gemini = true
  } catch { /* not installed */ }

  return { nco, ollama, claude, gemini }
}

// ============================================================
// AI Processing — routes to the best available provider
// ============================================================

export interface AIProcessOptions {
  text: string
  prompt: string
  provider?: string  // 'nco' | 'ollama' | 'claude' | 'gemini' | 'auto'
  model?: string
  voiceFastPath?: boolean  // true = skip NCO, prioritize Claude CLI for quality + speed
}

export interface AIProcessResult {
  text: string
  provider: string
  model?: string
  duration: number
}

export async function processWithAI(options: AIProcessOptions): Promise<AIProcessResult> {
  const start = Date.now()
  const provider = options.provider || 'auto'
  const fullPrompt = options.prompt + options.text

  // Voice fast-path: skip NCO (30s timeout), go Claude CLI → Ollama for speed + quality
  if (options.voiceFastPath && (provider === 'auto')) {
    console.log('[AI] Voice fast-path: Claude CLI → Ollama')

    // Try Claude CLI first (best quality)
    try {
      const result = await processWithClaude(fullPrompt)
      return { ...result, duration: (Date.now() - start) / 1000 }
    } catch (e) {
      console.log('[AI] Claude CLI failed:', (e as Error).message)
    }

    // Fallback to Ollama
    try {
      if (await isOllamaAvailable()) {
        const result = await processWithOllama(fullPrompt, options.model)
        return { ...result, duration: (Date.now() - start) / 1000 }
      }
    } catch (e) {
      console.log('[AI] Ollama failed:', (e as Error).message)
    }

    throw new Error('No AI provider available for voice fast-path')
  }

  // Standard auto: try NCO → Ollama → Claude CLI → Gemini CLI
  if (provider === 'auto' || provider === 'nco') {
    if (isProviderHealthy('nco')) {
      try {
        if (await isNCOAvailable()) {
          const result = await processWithNCO(fullPrompt, options.model)
          recordProviderSuccess('nco')
          return { ...result, duration: (Date.now() - start) / 1000 }
        }
      } catch (e) {
        recordProviderFailure('nco', (e as Error).message)
        console.log('NCO failed, falling back:', (e as Error).message)
      }
    } else {
      console.log('[self-heal] NCO in cooldown, skipping')
    }
    if (provider === 'nco') throw new Error('NCO is not available')
  }

  if (provider === 'auto' || provider === 'ollama') {
    if (isProviderHealthy('ollama')) {
      try {
        if (await isOllamaAvailable()) {
          const result = await processWithOllama(fullPrompt, options.model)
          recordProviderSuccess('ollama')
          return { ...result, duration: (Date.now() - start) / 1000 }
        }
      } catch (e) {
        recordProviderFailure('ollama', (e as Error).message)
        console.log('Ollama failed, falling back:', (e as Error).message)
      }
    } else {
      console.log('[self-heal] Ollama in cooldown, skipping')
    }
    if (provider === 'ollama') throw new Error('Ollama is not available')
  }

  if (provider === 'auto' || provider === 'claude') {
    if (isProviderHealthy('claude')) {
      try {
        const result = await processWithClaude(fullPrompt)
        recordProviderSuccess('claude')
        return { ...result, duration: (Date.now() - start) / 1000 }
      } catch (e) {
        recordProviderFailure('claude', (e as Error).message)
        console.log('Claude CLI failed, falling back:', (e as Error).message)
      }
    } else {
      console.log('[self-heal] Claude CLI in cooldown, skipping')
    }
    if (provider === 'claude') throw new Error('Claude CLI is not available')
  }

  if (provider === 'auto' || provider === 'gemini') {
    if (isProviderHealthy('gemini')) {
      try {
        const result = await processWithGemini(fullPrompt)
        recordProviderSuccess('gemini')
        return { ...result, duration: (Date.now() - start) / 1000 }
      } catch (e) {
        recordProviderFailure('gemini', (e as Error).message)
        console.log('Gemini CLI failed:', (e as Error).message)
      }
    } else {
      console.log('[self-heal] Gemini CLI in cooldown, skipping')
    }
    if (provider === 'gemini') throw new Error('Gemini CLI is not available')
  }

  throw new Error('No AI provider available. Please start NCO or Ollama.')
}

// ============================================================
// Provider implementations
// ============================================================

// Exported wrapper for NCO single-agent task with gemini→claude-code fallback
export async function processWithNCOTask(prompt: string, ai: string): Promise<string> {
  try {
    const result = await processWithNCO(prompt, ai)
    // Check if result is actually an error (gemini 429 gets stored as "completed" with error text)
    if (result.text.includes('rateLimitExceeded') || result.text.includes('429') ||
        result.text.includes('RESOURCE_EXHAUSTED') || result.text.includes('An unexpected critical error')) {
      throw new Error('Gemini rate limited')
    }
    return result.text
  } catch (e) {
    const msg = (e as Error).message
    if ((msg.includes('rate') || msg.includes('429') || msg.includes('Gemini')) && ai === 'gemini') {
      // Gemini 429 → fallback to claude-code
      console.warn('[NCO] Gemini rate limited, falling back to claude-code')
      const result = await processWithNCO(prompt + '\n\n(Respond concisely)', 'claude-code')
      return result.text
    }
    throw e
  }
}

async function processWithNCO(prompt: string, preferredAI?: string): Promise<Omit<AIProcessResult, 'duration'>> {
  console.log(`[NCO] Processing with ${preferredAI || 'conductor'}...`)

  if (preferredAI) {
    // Direct task to specific AI
    const body = JSON.stringify({
      prompt,
      ai: preferredAI,
      mode: 'task'
    })
    const data = await httpRequest(`${NCO_URL}/api/task`, { method: 'POST', body })
    const result = JSON.parse(data)

    // Poll for task result
    if (result.taskId) {
      return await pollNCOTask(result.taskId)
    }
    return { text: result.result || result.response || JSON.stringify(result), provider: 'nco', model: preferredAI }
  }

  // Use conductor (smart routing)
  const body = JSON.stringify({ prompt })
  const data = await httpRequest(`${NCO_URL}/api/conductor`, { method: 'POST', body })
  const result = JSON.parse(data)

  if (result.taskId) {
    return await pollNCOTask(result.taskId)
  }

  // Try to extract text from various response formats
  const text = result.result || result.response || result.text ||
    result.data?.result || result.data?.response ||
    (typeof result === 'string' ? result : JSON.stringify(result))

  return { text, provider: 'nco', model: result.ai || result.provider }
}

async function pollNCOTask(
  taskId: string,
  maxWait = 30000,
  signal?: AbortSignal
): Promise<Omit<AIProcessResult, 'duration'>> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    if (signal?.aborted) throw new Error('NCO task cancelled')
    try {
      const data = await httpRequest(`${NCO_URL}/api/tasks/${taskId}/status`, { method: 'GET', timeout: 5000 })
      const raw = JSON.parse(data)
      const status = raw.status
      if (status === 'completed' || status === 'done') {
        const text = raw.result || raw.response || raw.output || ''
        return { text, provider: 'nco', model: raw.agentId || raw.ai }
      }
      if (status === 'failed' || status === 'error') {
        throw new Error(raw.error || 'NCO task failed')
      }
    } catch (e) {
      if ((e as Error).message.includes('NCO task failed') ||
          (e as Error).message.includes('cancelled')) throw e
    }
    // Interruptible sleep — breaks immediately on abort
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('NCO task cancelled'))
      const t = setTimeout(resolve, 500)
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('NCO task cancelled')) }, { once: true })
    })
  }
  throw new Error('NCO task timeout')
}

async function processWithOllama(prompt: string, model?: string): Promise<Omit<AIProcessResult, 'duration'>> {
  const ollamaModel = model || 'llama3.2:3b'
  console.log(`[Ollama] Processing with ${ollamaModel}...`)

  const body = JSON.stringify({
    model: ollamaModel,
    prompt,
    stream: false
  })

  const data = await httpRequest(`${OLLAMA_URL}/api/generate`, { method: 'POST', body, timeout: 60000 })
  const result = JSON.parse(data)
  return { text: result.response || '', provider: 'ollama', model: ollamaModel }
}

// Vision model priority list for Ollama
const VISION_MODELS = ['llama3.2-vision', 'llava', 'llava-phi3', 'moondream', 'bakllava']

export async function processImageWithOllama(base64: string, prompt: string): Promise<string> {
  // Find an available vision model
  const tagsData = await httpRequest(`${OLLAMA_URL}/api/tags`, { method: 'GET', timeout: 5000 })
  const tags = JSON.parse(tagsData)
  const available: string[] = (tags.models || []).map((m: any) => m.name as string)

  const visionModel = VISION_MODELS.find(vm => available.some(a => a.startsWith(vm)))
  if (!visionModel) throw new Error(`No vision model found. Available: ${available.join(', ')}`)

  console.log(`[Ollama Vision] Using ${visionModel}`)
  const body = JSON.stringify({
    model: visionModel,
    prompt,
    images: [base64],
    stream: false
  })

  const data = await httpRequest(`${OLLAMA_URL}/api/generate`, { method: 'POST', body, timeout: 120000 })
  const result = JSON.parse(data)
  return result.response || ''
}

// Gemini 텍스트 요약 — PTY 캡처 응답을 2-3문장 음성용으로 요약
export async function summarizeWithGemini(text: string): Promise<string> {
  const prompt = `다음 내용을 핵심만 2-3문장으로 자연스럽게 요약해줘. 음성 출력용이라 간결하고 자연스럽게:\n\n${text.substring(0, 3000)}`
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 200 }
  })

  const maxTries = Math.min(GEMINI_KEYS.length, 3)
  let lastErr = 'No Gemini API key'
  for (let i = 0; i < maxTries; i++) {
    const key = nextGeminiKey()
    if (!key) break
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`
      const data = await httpRequest(url, { method: 'POST', body, timeout: 15000 })
      const result = JSON.parse(data)
      const summary = result.candidates?.[0]?.content?.parts?.[0]?.text
      if (!summary) throw new Error('Empty Gemini summary')
      return summary.trim()
    } catch (e) {
      lastErr = (e as Error).message
      if (lastErr.includes('429') || lastErr.includes('RESOURCE_EXHAUSTED') || lastErr.includes('quota')) {
        markKeyExhausted(key, lastErr)
        continue
      }
      throw e
    }
  }
  throw new Error(`summarizeWithGemini failed: ${lastErr}`)
}

// Gemini Vision — uses gemini-2.5-flash with API key rotation
// base64: raw base64 string (no data URI prefix)
// mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
export async function processImageWithGemini(base64: string, mimeType: string, prompt: string): Promise<string> {
  const key = nextGeminiKey()
  if (!key) throw new Error('No Gemini API key available. Add GEMINI_API_KEYS to nco/.env')

  // Strip data URI prefix if present
  const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '')

  const body = JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: cleanBase64 } },
        { text: prompt }
      ]
    }]
  })

  // Try gemini-2.5-flash first, fallback to gemini-2.0-flash; rotate keys on 429
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash']
  let lastError = ''
  let activeKey = key

  for (const model of models) {
    // Up to GEMINI_KEYS.length key attempts per model
    const maxKeyTries = Math.max(1, GEMINI_KEYS.length)
    for (let k = 0; k < maxKeyTries; k++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeKey}`
        console.log(`[Gemini Vision] ${model} key…${activeKey.slice(-6)}`)
        const data = await httpRequest(url, { method: 'POST', body, timeout: 60000 })
        const result = JSON.parse(data)
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) throw new Error('Empty response from Gemini')
        console.log(`[Gemini Vision] Done (${text.length} chars)`)
        return text
      } catch (e) {
        lastError = (e as Error).message
        if (lastError.includes('429') || lastError.includes('RESOURCE_EXHAUSTED') || lastError.includes('quota')) {
          markKeyExhausted(activeKey, lastError)
          const next = nextGeminiKey()
          if (next) { activeKey = next; continue }
        }
        break  // non-rate-limit error — try next model
      }
    }
  }

  throw new Error(`Gemini Vision failed: ${lastError}`)
}

// Real-time web search using Gemini + Google Search grounding
// Returns AI-synthesized answer with live search results
export async function searchWithGemini(query: string): Promise<string> {
  if (!GEMINI_KEYS.length) throw new Error('No Gemini API key available')

  const body = JSON.stringify({
    contents: [{ parts: [{ text: query }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.1 }
  })

  const maxTries = Math.min(GEMINI_KEYS.length, 5)
  let lastError: Error = new Error('No Gemini API key')

  for (let i = 0; i < maxTries; i++) {
    const key = nextGeminiKey()
    if (!key) break
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`
    console.log(`[Gemini Search] Try ${i + 1}/${maxTries}: ${query.substring(0, 60)}`)
    try {
      const data = await httpRequest(url, { method: 'POST', body, timeout: 30000 })
      const result = JSON.parse(data)
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error('Empty search response from Gemini')
      console.log(`[Gemini Search] Done (${text.length} chars)`)
      return text
    } catch (e) {
      lastError = e as Error
      const msg = lastError.message
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')) {
        markKeyExhausted(key, msg)  // park this key, try next
        continue
      }
      throw e  // non-rate-limit errors: fail fast
    }
  }

  throw lastError
}

// Claude Code CLI 경로 후보 (claude-terminal.ts와 동일)
function findClaudeBinary(): string {
  const { existsSync } = require('fs')
  const candidates = [
    '/Users/nova-ai/.local/bin/claude',
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return 'claude'
}

// 실제 Claude Code CLI 실행 — --dangerously-skip-permissions으로 bash/WebSearch 모두 사용 가능
// opts.cwd: 프로젝트 컨텍스트(undefined=nova-voice) vs 일반질문(os.homedir())
export async function processWithClaude(
  prompt: string,
  opts?: { cwd?: string }
): Promise<Omit<AIProcessResult, 'duration'>> {
  const claudePath = findClaudeBinary()
  const os = require('os')
  const cwd = opts?.cwd ?? process.cwd()
  console.log('[Claude] Processing with Claude Code CLI (full tools)...')
  const { spawn } = require('child_process')

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const proc = spawn(claudePath, [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'text',
    ], {
      cwd,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code: number) => {
      const text = stdout.trim()
      if (code !== 0 && !text) {
        reject(new Error(`Claude exit ${code}: ${stderr.substring(0, 200)}`))
      } else {
        resolve({ text, provider: 'claude', model: 'claude-code' })
      }
    })

    proc.on('error', reject)

    // 60초 타임아웃
    setTimeout(() => { proc.kill(); reject(new Error('Claude timeout')) }, 60000)
  })
}

export async function processWithClaudeStreaming(
  prompt: string,
  onSentence: (sentence: string) => void,
  opts?: { cwd?: string }
): Promise<{ text: string; provider: string; model: string }> {
  const claudePath = findClaudeBinary()
  const cwd = opts?.cwd ?? process.cwd()
  const { spawn } = require('child_process')

  return new Promise((resolve, reject) => {
    let stdout = ''
    let buffer = ''
    let stderr = ''

    const proc = spawn(claudePath, [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'text',
    ], {
      cwd,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stdout += chunk
      buffer += chunk
      // 문장 경계 감지 — 소수점(3.14)·약어(e.g.) 앞 마침표는 경계로 보지 않음
      // 마침표+공백+대문자/한글/숫자 시작 패턴
      const sentenceEnd = /([.!?。！？])\s+(?=[A-Z가-힣\d])/g
      let match: RegExpExecArray | null
      let lastIdx = 0
      while ((match = sentenceEnd.exec(buffer)) !== null) {
        const sentence = buffer.slice(lastIdx, match.index + match[0].length).trim()
        const cleaned = sanitizeTTSText(sentence)
        if (cleaned.length > 5) onSentence(cleaned)
        lastIdx = match.index + match[0].length
      }
      buffer = buffer.slice(lastIdx)
    })

    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code: number) => {
      // Flush remaining buffer — sanitize 적용
      const remaining = sanitizeTTSText(buffer.trim())
      if (remaining.length > 5) onSentence(remaining)
      const text = stdout.trim()
      if (code !== 0 && !text) {
        reject(new Error(`Claude exit ${code}: ${stderr.substring(0, 200)}`))
      } else {
        resolve({ text, provider: 'claude', model: 'claude-code' })
      }
    })

    proc.on('error', reject)
    setTimeout(() => { proc.kill(); reject(new Error('Claude timeout')) }, 60000)
  })
}

async function processWithGemini(prompt: string): Promise<Omit<AIProcessResult, 'duration'>> {
  console.log('[Gemini] Processing...')
  const { stdout } = await execFile('gemini', ['-p', prompt], {
    timeout: 60000,
    maxBuffer: 1024 * 1024
  })
  return { text: stdout.trim(), provider: 'gemini', model: 'gemini-2.5-pro' }
}

// ============================================================
// NCO Advanced Collaboration Features
// ============================================================

export interface NCOCollabResult {
  text: string
  sessionId?: string
  participants?: string[]
  rounds?: number
  mode: string
}

// Progress callback type for long-running operations
export type ProgressCallback = (msg: string, level?: 'info' | 'warn' | 'success') => void

// Poll discussion session until completed (max 10 min)
async function pollDiscussion(
  sessionId: string,
  maxWait = 600000,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<NCOCollabResult> {
  const start = Date.now()
  let lastProgressReport = 0
  const PROGRESS_INTERVAL = 30000 // Report progress every 30s

  while (Date.now() - start < maxWait) {
    if (signal?.aborted) throw new Error('Discussion cancelled')

    const elapsed = Date.now() - start

    // Periodic progress update every 30s
    if (elapsed - lastProgressReport >= PROGRESS_INTERVAL) {
      const elapsedSec = Math.round(elapsed / 1000)
      onProgress?.(`[NCO] 토론 진행 중... ${elapsedSec}초 경과 (session: ${sessionId.slice(-8)})`)
      lastProgressReport = elapsed
    }

    try {
      const data = await httpRequest(`${NCO_URL}/api/discussions/${sessionId}`, { method: 'GET', timeout: 5000 })
      const d = JSON.parse(data)
      const disc = d.discussion || d

      // Report round progress
      if (disc.current_round > 0) {
        onProgress?.(`[NCO] 토론 ${disc.current_round}라운드 완료, 다음 라운드 대기 중...`, 'info')
      }

      if (disc.status === 'completed') {
        let text = disc.report || ''
        // Try result_json first for structured synthesis
        if (disc.result_json) {
          try {
            const rj = JSON.parse(disc.result_json)
            // result_json has rounds[].responses and a synthesis
            const synthesis = rj.synthesis || rj.adoptedProposal || rj.result || ''
            if (synthesis && synthesis.length > text.length) text = synthesis
          } catch { /* ignore */ }
        }
        // Read messages to find the synthesis (last Korean markdown message)
        try {
          const msgData = await httpRequest(`${NCO_URL}/api/discussions/${sessionId}/messages`, { method: 'GET', timeout: 5000 })
          const msgs = JSON.parse(msgData)
          const messages: Array<{role: string; content: string}> = msgs.messages || []
          // Synthesis is usually the last message with "합성 결과" or "##" sections
          for (let i = messages.length - 1; i >= 0; i--) {
            const content = messages[i]?.content || ''
            if (content.includes('합성') || content.includes('결론') || content.includes('##')) {
              if (content.length > text.length) { text = content; break }
            }
          }
          // If still nothing useful, concat all AI responses
          if (!text || text.length < 50) {
            const aiMessages = messages.filter(m => m.role && m.content && !m.content.startsWith('```json'))
            text = aiMessages.map(m => `[${m.role}]: ${m.content}`).join('\n\n')
          }
        } catch { /* ignore */ }
        let participants: string[] = []
        try { participants = JSON.parse(disc.participants_json || '[]') } catch { /* ignore */ }
        return {
          text: text || '(토론 완료, 결과 없음)',
          sessionId,
          participants,
          rounds: disc.current_round || 0,
          mode: disc.mode || 'discussion'
        }
      }
      if (disc.status === 'failed') throw new Error(`Discussion failed: ${disc.error || 'unknown'}`)
    } catch (e) {
      if ((e as Error).message.startsWith('Discussion failed') ||
          (e as Error).message.includes('cancelled')) throw e
    }
    // Interruptible sleep
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Discussion cancelled'))
      const t = setTimeout(resolve, 3000)
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Discussion cancelled')) }, { once: true })
    })
  }
  throw new Error('NCO Discussion timeout (10 min)')
}

// Poll task table until completed (used by conductor + hive)
// Multi-AI Discussion
export async function startDiscussion(
  prompt: string,
  ais?: string[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<NCOCollabResult> {
  if (!(await isNCOAvailable())) throw new Error('NCO is not running')
  if (signal?.aborted) throw new Error('Discussion cancelled')

  // 1 round, use reliable providers (claude-code + gemini are stable; ollama gets stuck)
  const providers = ais || ['claude-code', 'gemini']
  const body = JSON.stringify({
    prompt,
    providers,
    rounds: 1,
    mode: 'discussion'
  })
  const data = await httpRequest(`${NCO_URL}/api/realtime/discussion`, { method: 'POST', body, timeout: 15000 })
  const result = JSON.parse(data)
  const sessionId = result.sessionId || result.discussionId

  console.log(`[NCO Discussion] Started session=${sessionId}, polling for result (max 10min)...`)
  onProgress?.(`[NCO] 토론 시작됨 (session: ${sessionId.slice(-8)}) — 1라운드, AI들이 토론 중...`)
  return await pollDiscussion(sessionId, 600000, onProgress, signal)
}

// Parallel Team Execution
export async function startParallel(prompt: string, ais?: string[]): Promise<NCOCollabResult> {
  if (!(await isNCOAvailable())) throw new Error('NCO is not running')

  const body = JSON.stringify({
    prompt,
    providers: ais,
    mode: 'parallel'
  })
  // Parallel saves each result as a completed task — wait ~30s then read recent tasks
  const data = await httpRequest(`${NCO_URL}/api/realtime/parallel`, { method: 'POST', body, timeout: 15000 })
  const result = JSON.parse(data)
  const providers: string[] = result.providers || ais || []

  console.log(`[NCO Parallel] Started with providers: ${providers.join(', ')}, waiting...`)
  await new Promise(r => setTimeout(r, 30000))  // parallel tasks take ~30s

  // Fetch recent completed tasks matching this prompt
  try {
    const tasksData = await httpRequest(`${NCO_URL}/api/tasks?limit=20`, { method: 'GET', timeout: 5000 })
    const { tasks = [] } = JSON.parse(tasksData)
    const matches = tasks.filter((t: any) =>
      t.status === 'completed' && t.mode === 'parallel' && t.prompt === prompt
    )
    if (matches.length > 0) {
      const combined = matches.map((t: any) => `[${t.assigned_to}]: ${t.response || ''}`).join('\n\n')
      return { text: combined, participants: providers, mode: 'parallel' }
    }
  } catch { /* ignore */ }

  return {
    text: `병렬 실행 완료 (${providers.join(', ')})`,
    participants: providers,
    mode: 'parallel'
  }
}

// Autonomous Agent
export async function startAgent(prompt: string, ai?: string): Promise<NCOCollabResult> {
  if (!(await isNCOAvailable())) throw new Error('NCO is not running')

  const body = JSON.stringify({
    prompt,
    ai: ai || 'claude-code',
    mode: 'agent'
  })
  const data = await httpRequest(`${NCO_URL}/api/agent/start`, { method: 'POST', body, timeout: 15000 })
  const result = JSON.parse(data)

  return {
    text: result.result || result.status || 'Agent started',
    sessionId: result.sessionId || result.agentId,
    mode: 'agent'
  }
}

// Hive Mode (All 9 AIs)
export async function startHive(prompt: string): Promise<NCOCollabResult> {
  if (!(await isNCOAvailable())) throw new Error('NCO is not running')

  const body = JSON.stringify({ prompt })
  const data = await httpRequest(`${NCO_URL}/api/hive`, { method: 'POST', body, timeout: 15000 })
  const result = JSON.parse(data)
  const sessionId = result.sessionId

  console.log(`[NCO Hive] Started session=${sessionId}, polling discussion result...`)
  return await pollDiscussion(sessionId, 600000)  // hive takes longer (max 10 min)
}

// ============================================================
// Provider Health Check
// ============================================================

export interface ProviderHealthResult {
  id: string
  name: string
  role: string
  type: 'cli' | 'api' | 'local'
  status: 'online' | 'offline' | 'degraded'
  latencyMs: number
  version?: string
  model?: string
  error?: string
  checkedAt: number
}

/** NCO config 경로 후보 */
function findNCOProvidersConfig(): string | null {
  const candidates = [
    join(__dirname, '../../../nco/config/ai-providers.json'),
    '/Users/nova-ai/project/nco/config/ai-providers.json',
  ]
  return candidates.find(p => existsSync(p)) ?? null
}

/** 단일 API 엔드포인트 헬스 체크 */
async function pingEndpoint(url: string, timeoutMs = 4000): Promise<{ ok: boolean; latencyMs: number; body?: string }> {
  const start = Date.now()
  try {
    const body = await httpRequest(url, { method: 'GET', timeout: timeoutMs })
    return { ok: true, latencyMs: Date.now() - start, body }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start }
  }
}

/** 단일 CLI 명령 헬스 체크 */
async function pingCLI(command: string, args: string[], timeoutMs = 4000): Promise<{ ok: boolean; latencyMs: number; version?: string }> {
  const start = Date.now()
  try {
    const { stdout } = await execFile(command, args, { timeout: timeoutMs })
    const version = stdout.trim().split('\n')[0].substring(0, 80)
    return { ok: true, latencyMs: Date.now() - start, version }
  } catch {
    return { ok: false, latencyMs: Date.now() - start }
  }
}

/**
 * 모든 NCO AI 프로바이더 헬스 체크 (병렬).
 * ai-providers.json에서 목록을 읽어 각 프로바이더를 테스트한다.
 */
export async function checkAllProviders(): Promise<ProviderHealthResult[]> {
  const configPath = findNCOProvidersConfig()
  if (!configPath) {
    return [{
      id: 'config-error', name: 'Config Missing', role: 'N/A', type: 'api',
      status: 'offline', latencyMs: 0,
      error: 'ai-providers.json not found', checkedAt: Date.now()
    }]
  }

  let providers: any[]
  try {
    const raw = readFileSync(configPath, 'utf-8')
    providers = JSON.parse(raw).providers || []
  } catch (e) {
    return [{ id: 'parse-error', name: 'Config Parse Error', role: 'N/A', type: 'api',
      status: 'offline', latencyMs: 0, error: (e as Error).message, checkedAt: Date.now() }]
  }

  // NCO 서버 자체 헬스도 포함
  const ncoCheck = pingEndpoint(`${NCO_URL}/health`, 4000).then(r => ({
    id: 'nco-server', name: 'NCO Server', role: 'Orchestrator', type: 'api' as const,
    status: (r.ok ? 'online' : 'offline') as 'online' | 'offline' | 'degraded',
    latencyMs: r.latencyMs,
    model: r.body ? (() => { try { const d = JSON.parse(r.body!); return `${d.providerCount} providers, ${d.runtime?.agentsOnline} agents` } catch { return undefined } })() : undefined,
    checkedAt: Date.now()
  }))

  const providerChecks = providers.map(async (p: any): Promise<ProviderHealthResult> => {
    const base: Omit<ProviderHealthResult, 'status' | 'latencyMs' | 'error'> = {
      id: p.id, name: p.name, role: p.role || 'unknown',
      type: p.type || 'api', checkedAt: Date.now()
    }

    try {
      if (p.type === 'cli') {
        // CLI: healthCheck 명령 실행
        const cmd = p.healthCheck?.command || p.command
        const args = p.healthCheck?.args || ['--version']
        const r = await pingCLI(cmd, args, p.healthCheck?.timeout || 5000)
        return { ...base, status: r.ok ? 'online' : 'offline', latencyMs: r.latencyMs, version: r.version }
      } else {
        // API/local: healthCheck URL 핑
        const url = p.healthCheck?.url || p.endpoint
        if (!url) return { ...base, status: 'degraded', latencyMs: 0, error: 'No endpoint configured' }
        const r = await pingEndpoint(url, p.healthCheck?.timeout || 5000)
        let modelInfo: string | undefined
        if (r.ok && r.body) {
          try {
            const d = JSON.parse(r.body)
            // OpenAI /v1/models 응답
            if (d.data) modelInfo = `${d.data.length} models`
            // Ollama /api/tags 응답
            else if (d.models) modelInfo = `${d.models.length} models`
            // NCO health 응답
            else if (d.providerCount !== undefined) modelInfo = `${d.providerCount} providers`
          } catch { /* ignore */ }
        }
        return { ...base, status: r.ok ? 'online' : 'offline', latencyMs: r.latencyMs, model: modelInfo,
          error: r.ok ? undefined : 'Connection failed' }
      }
    } catch (e) {
      return { ...base, status: 'offline', latencyMs: 0, error: (e as Error).message.substring(0, 80) }
    }
  })

  const results = await Promise.all([ncoCheck, ...providerChecks])
  return results
}

// Smart Conductor (voice fast-path: local Claude CLI → Ollama fallback)
// NCO agents run in the nco/ directory sandbox — unusable for nova-voice code questions.
// Local Claude CLI runs in the actual nova-voice project context.
export async function startConductor(prompt: string, signal?: AbortSignal): Promise<NCOCollabResult> {
  if (signal?.aborted) throw new Error('Conductor cancelled')

  console.log('[Conductor] Voice fast-path: local Claude CLI (runs in nova-voice project)')
  try {
    const claudeResult = await processWithClaude(prompt)
    if (signal?.aborted) throw new Error('Conductor cancelled')
    return {
      text: claudeResult.text || '(결과 없음)',
      participants: ['claude'],
      mode: 'conductor-voice'
    }
  } catch (e) {
    if ((e as Error).message.includes('cancelled')) throw e
    console.warn('[Conductor] Claude CLI failed, falling back to Ollama:', (e as Error).message)
    // Fallback to Ollama
    try {
      const ollamaResult = await processWithOllama(prompt)
      return { text: ollamaResult.text, participants: ['ollama'], mode: 'conductor-voice-fallback' }
    } catch (e2) {
      if ((e2 as Error).message.includes('cancelled')) throw e2
      // Final fallback: NCO gemini if available
      if (await isNCOAvailable()) {
        const body = JSON.stringify({ prompt, ai: 'gemini', priority: 7 })
        const data = await httpRequest(`${NCO_URL}/api/task`, { method: 'POST', body })
        const result = JSON.parse(data)
        if (result.taskId) {
          const taskResult = await pollNCOTask(result.taskId, 60000, signal)
          return { text: taskResult.text, participants: ['gemini'], mode: 'conductor-nco-fallback' }
        }
      }
      throw new Error('No AI available for conductor request')
    }
  }
}
