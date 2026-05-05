import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import http from 'http'
import https from 'https'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

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
function nextGeminiKey(): string | null {
  if (!GEMINI_KEYS.length) return null
  return GEMINI_KEYS[_geminiIdx++ % GEMINI_KEYS.length]
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
    try {
      if (await isNCOAvailable()) {
        const result = await processWithNCO(fullPrompt, options.model)
        return { ...result, duration: (Date.now() - start) / 1000 }
      }
    } catch (e) {
      console.log('NCO failed, falling back:', (e as Error).message)
    }
    if (provider === 'nco') throw new Error('NCO is not available')
  }

  if (provider === 'auto' || provider === 'ollama') {
    try {
      if (await isOllamaAvailable()) {
        const result = await processWithOllama(fullPrompt, options.model)
        return { ...result, duration: (Date.now() - start) / 1000 }
      }
    } catch (e) {
      console.log('Ollama failed, falling back:', (e as Error).message)
    }
    if (provider === 'ollama') throw new Error('Ollama is not available')
  }

  if (provider === 'auto' || provider === 'claude') {
    try {
      const result = await processWithClaude(fullPrompt)
      return { ...result, duration: (Date.now() - start) / 1000 }
    } catch (e) {
      console.log('Claude CLI failed, falling back:', (e as Error).message)
    }
    if (provider === 'claude') throw new Error('Claude CLI is not available')
  }

  if (provider === 'auto' || provider === 'gemini') {
    try {
      const result = await processWithGemini(fullPrompt)
      return { ...result, duration: (Date.now() - start) / 1000 }
    } catch (e) {
      console.log('Gemini CLI failed:', (e as Error).message)
    }
    if (provider === 'gemini') throw new Error('Gemini CLI is not available')
  }

  throw new Error('No AI provider available. Please start NCO or Ollama.')
}

// ============================================================
// Provider implementations
// ============================================================

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

async function pollNCOTask(taskId: string, maxWait = 30000): Promise<Omit<AIProcessResult, 'duration'>> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const data = await httpRequest(`${NCO_URL}/api/tasks/${taskId}`, { method: 'GET', timeout: 5000 })
      const task = JSON.parse(data)

      if (task.status === 'completed' || task.status === 'done') {
        const text = task.result || task.response || task.output || ''
        return { text, provider: 'nco', model: task.ai || task.agent }
      }
      if (task.status === 'failed' || task.status === 'error') {
        throw new Error(task.error || 'NCO task failed')
      }
    } catch (e) {
      if ((e as Error).message.includes('NCO task failed')) throw e
    }
    await new Promise(r => setTimeout(r, 500))
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
  const key = nextGeminiKey()
  if (!key) throw new Error('No Gemini API key')

  const prompt = `다음 내용을 핵심만 2-3문장으로 자연스럽게 요약해줘. 음성 출력용이라 간결하고 자연스럽게:\n\n${text.substring(0, 3000)}`
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 200 }
  })

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`
  const data = await httpRequest(url, { method: 'POST', body, timeout: 15000 })
  const result = JSON.parse(data)
  const summary = result.candidates?.[0]?.content?.parts?.[0]?.text
  if (!summary) throw new Error('Empty Gemini summary')
  return summary.trim()
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

  // Try gemini-2.5-flash first, fallback to gemini-2.0-flash
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash']
  let lastError = ''

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
      console.log(`[Gemini Vision] Using ${model}...`)
      const data = await httpRequest(url, { method: 'POST', body, timeout: 60000 })
      const result = JSON.parse(data)
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error('Empty response from Gemini')
      console.log(`[Gemini Vision] Done (${text.length} chars)`)
      return text
    } catch (e) {
      lastError = (e as Error).message
      console.log(`[Gemini Vision] ${model} failed: ${lastError}`)
      // Try next key on quota error
      if (lastError.includes('429') || lastError.includes('quota')) {
        const nextKey = nextGeminiKey()
        if (nextKey && nextKey !== key) {
          // Retry same model with different key
          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${nextKey}`
            const data = await httpRequest(url, { method: 'POST', body, timeout: 60000 })
            const result = JSON.parse(data)
            const text = result.candidates?.[0]?.content?.parts?.[0]?.text
            if (text) return text
          } catch { /* try next model */ }
        }
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

  const maxTries = Math.min(GEMINI_KEYS.length, 3)
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
      if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
        console.warn(`[Gemini Search] Key ${i + 1} quota exceeded, trying next key...`)
        continue
      }
      throw e  // non-quota errors: fail fast
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
export async function processWithClaude(prompt: string): Promise<Omit<AIProcessResult, 'duration'>> {
  const claudePath = findClaudeBinary()
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

// Poll discussion session until completed (max 3 min)
async function pollDiscussion(sessionId: string, maxWait = 180000): Promise<NCOCollabResult> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const data = await httpRequest(`${NCO_URL}/api/discussions/${sessionId}`, { method: 'GET', timeout: 5000 })
      const d = JSON.parse(data)
      const disc = d.discussion || d
      if (disc.status === 'completed') {
        // report column has the synthesis text
        let text = disc.report || ''
        // if report is small, also check messages
        if (!text && disc.result_json) {
          try {
            const rj = JSON.parse(disc.result_json)
            text = rj.adoptedProposal || rj.result || ''
          } catch { /* ignore */ }
        }
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
      if ((e as Error).message.startsWith('Discussion failed')) throw e
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('NCO Discussion timeout (3 min)')
}

// Poll task table until completed (used by conductor + hive)
async function pollTask(taskId: string, maxWait = 180000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const data = await httpRequest(`${NCO_URL}/api/tasks/${taskId}`, { method: 'GET', timeout: 5000 })
      const d = JSON.parse(data)
      const task = d.task || d
      if (task.status === 'completed') return task.response || task.result || ''
      if (task.status === 'failed') throw new Error(task.error || 'Task failed')
    } catch (e) {
      if ((e as Error).message === 'Task failed' || (e as Error).message.startsWith('Task failed:')) throw e
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('NCO Task timeout')
}

// Multi-AI Discussion
export async function startDiscussion(prompt: string, ais?: string[]): Promise<NCOCollabResult> {
  if (!(await isNCOAvailable())) throw new Error('NCO is not running')

  const body = JSON.stringify({
    prompt,
    providers: ais,
    rounds: 2,
    mode: 'discussion'
  })
  const data = await httpRequest(`${NCO_URL}/api/realtime/discussion`, { method: 'POST', body, timeout: 15000 })
  const result = JSON.parse(data)
  const sessionId = result.sessionId || result.discussionId

  console.log(`[NCO Discussion] Started session=${sessionId}, polling for result...`)
  return await pollDiscussion(sessionId)
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
  return await pollDiscussion(sessionId, 240000)  // hive takes longer (4 min)
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

// Smart Conductor (auto-selects best mode + AI)
export async function startConductor(prompt: string): Promise<NCOCollabResult> {
  if (!(await isNCOAvailable())) throw new Error('NCO is not running')

  const body = JSON.stringify({ prompt })
  // /api/conductor returns immediately with { taskId, mode, providers, status:'dispatched' }
  const data = await httpRequest(`${NCO_URL}/api/conductor`, { method: 'POST', body, timeout: 15000 })
  const result = JSON.parse(data)
  const taskId = result.taskId

  console.log(`[NCO Conductor] Dispatched taskId=${taskId} mode=${result.mode} providers=${result.providers?.join(',')}`)

  // For multi-agent modes, the conductor also creates a discussion session
  // Poll task table for the final result
  const text = await pollTask(taskId, 180000)
  return {
    text: text || '(결과 없음)',
    sessionId: taskId,
    mode: result.mode || 'conductor'
  }
}
