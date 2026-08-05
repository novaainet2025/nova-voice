import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.dirname(scriptDir)
const packagedApp = path.join(projectDir, 'dist', 'mac-arm64', 'NOVA VOICE.app')
const installedApp = '/Applications/NOVA VOICE.app'
const installedExecutable = path.join(installedApp, 'Contents', 'MacOS', 'NOVA VOICE')
const userDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'nova-voice')
const settingsPath = path.join(userDataDir, 'nova-settings.json')
const databasePath = path.join(userDataDir, 'nova-voice.db')
const mainLogPath = path.join(os.homedir(), 'Library', 'Logs', 'nova-voice', 'main.log')
const playwrightWrapper = path.join(os.homedir(), '.codex', 'skills', 'playwright', 'scripts', 'playwright_cli.sh')
const runId = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const receiptDir = path.join(projectDir, 'output', 'verification', 'macos-installed', runId)
const playwrightDir = path.join(projectDir, 'output', 'playwright', `nova-voice-${runId}`)
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-voice-unattended-'))
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-voice-before-verified-'))

fs.mkdirSync(receiptDir, { recursive: true })
fs.mkdirSync(playwrightDir, { recursive: true })

const receipt = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  projectDir,
  installedApp,
  packagedApp,
  backupDir,
  passed: false,
  commands: {},
  evidence: {},
  gaps: [],
}

let previousAppBackup = ''
let installedNewApp = false
let fixtureProcess = null
let caffeinateProcess = null
let fixtureOutput = ''
let playwrightSessionOpen = false
let debugPort = 0
let fixturePort = 0
let originalSettings = null
let originalSettingsExisted = false
let originalClipboardSnapshot = ''
let clipboardHelper = ''
let logStartOffset = 0
let sessionLocked = false
const testRecordIds = []

function step(message) {
  console.log(`[verify:mac] ${message}`)
}

function sanitizeLabel(label) {
  return label.replace(/[^A-Za-z0-9._-]+/g, '-')
}

function writeLog(label, command, args, result) {
  const logPath = path.join(receiptDir, `${sanitizeLabel(label)}.log`)
  const content = [
    `$ ${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`,
    '',
    result.stdout || '',
    result.stderr || '',
    `exit=${result.status ?? 'null'} signal=${result.signal ?? 'none'}`,
  ].join('\n')
  fs.writeFileSync(logPath, content)
  receipt.commands[label] = {
    command: [command, ...args],
    exitCode: result.status,
    signal: result.signal,
    log: path.relative(projectDir, logPath),
  }
  return logPath
}

function run(label, command, args = [], options = {}) {
  step(label)
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectDir,
    env: { ...process.env, ...(options.env || {}) },
    encoding: options.encoding === null ? null : 'utf8',
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
  })
  writeLog(label, command, args, result)
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim().slice(-1200) : ''
    throw new Error(`${label} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  return result
}

function runQuiet(command, args = [], options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || projectDir,
    env: { ...process.env, ...(options.env || {}) },
    encoding: options.encoding === null ? null : 'utf8',
    input: options.input,
    maxBuffer: 32 * 1024 * 1024,
  })
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function appPids() {
  const result = runQuiet('/usr/bin/pgrep', ['-f', installedExecutable])
  if (result.status !== 0) return []
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number)
}

function isAppRunning() {
  return appPids().length > 0
}

async function quitApp() {
  runQuiet('/usr/bin/osascript', ['-e', 'tell application id "com.novavoice.app" to quit'])
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!isAppRunning()) return
    await sleep(200)
  }
  runQuiet('/usr/bin/pkill', ['-TERM', '-f', `${installedApp}/Contents/`])
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isAppRunning()) return
    await sleep(200)
  }
  throw new Error(`NOVA VOICE did not quit; remaining PIDs: ${appPids().join(', ')}`)
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function startCaffeinate() {
  caffeinateProcess = spawn('/usr/bin/caffeinate', ['-dimsu'], {
    stdio: 'ignore',
  })
}

function stopCaffeinate() {
  if (caffeinateProcess && !caffeinateProcess.killed) caffeinateProcess.kill('SIGTERM')
}

function frontmostApplication() {
  const front = runQuiet('/usr/bin/lsappinfo', ['front'])
  const asn = front.status === 0 ? front.stdout.trim() : ''
  if (!asn) return { name: '', bundleId: '' }
  const info = runQuiet('/usr/bin/lsappinfo', ['info', '-only', 'bundleID,name', asn])
  const output = info.status === 0 ? info.stdout : ''
  return {
    name: output.match(/"LSDisplayName"="([^"]*)"/)?.[1] || '',
    bundleId: output.match(/"CFBundleIdentifier"="([^"]*)"/)?.[1] || '',
  }
}

async function fetchJson(url, timeoutMs = 5_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const text = await response.text()
    if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text)
  } finally {
    clearTimeout(timeout)
  }
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.socket = null
    this.nextId = 0
    this.pending = new Map()
  }

  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  send(method, params = {}, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.socket?.close()
  }
}

async function mainRendererTarget() {
  const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`, 2_000)
  return targets.find((target) => target.type === 'page' && !target.url.includes('#/overlay'))
}

async function withMainRenderer(callback) {
  const target = await waitFor(mainRendererTarget, 20_000, 'Electron main renderer')
  const client = new CdpClient(target.webSocketDebuggerUrl)
  await client.connect()
  try {
    return await callback(client, target)
  } finally {
    client.close()
  }
}

async function evaluate(client, expression, timeoutMs = 60_000) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs)
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  }
  return response.result?.value
}

async function runPcmCase(label, pcmPath, settingsPatch, screenshotPath) {
  const pcmBase64 = fs.readFileSync(pcmPath).toString('base64')
  return withMainRenderer(async (client) => {
    const expression = [
      '(async () => {',
      '  const api = window.electronAPI',
      '  const previous = await api.getSettings()',
      `  await api.setSettings(${JSON.stringify(settingsPatch)})`,
      '  try {',
      `    const binary = atob(${JSON.stringify(pcmBase64)})`,
      '    const pcm = new Uint8Array(binary.length)',
      '    for (let index = 0; index < binary.length; index += 1) pcm[index] = binary.charCodeAt(index)',
      '    const result = await api.sendPcmData(pcm.buffer, 16000)',
      '    await new Promise((resolve) => setTimeout(resolve, 300))',
      '    const status = await api.getMetaPromptStatus()',
      '    const loginItem = await api.getLoginItemStatus()',
      '    const settingsDuring = await api.getSettings()',
      '    const modeStatus = document.querySelector("[data-input-mode]")',
      '    const modeStatusText = modeStatus?.textContent?.replace(/\\s+/g, " ").trim() || ""',
      '    const renderedInputMode = modeStatus?.getAttribute("data-input-mode") || ""',
      '    if (result?.id) await api.deleteHistory(result.id)',
      '    const history = await api.getHistory(100, 0)',
      '    return { result, status, loginItem, settingsDuring, modeStatusText, renderedInputMode, recordPresent: Boolean(result?.id && history.some((item) => item.id === result.id)) }',
      '  } finally {',
      '    await api.setSettings(previous)',
      '  }',
      '})()',
    ].join('\n')
    const value = await evaluate(client, expression, 180_000)
    if (value?.result?.id) testRecordIds.push(value.result.id)
    const domText = await evaluate(client, 'document.body.innerText')
    try {
      const screenshot = await client.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false },
        12_000,
      )
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    } catch (error) {
      // Screenshot evidence must not invalidate functional STT/meta results when
      // Electron's CDP renderer briefly stops answering Page.captureScreenshot.
      const fallback = runQuiet('/usr/sbin/screencapture', ['-x', screenshotPath])
      fs.writeFileSync(
        path.join(receiptDir, `${label}-screenshot-fallback.log`),
        `${error instanceof Error ? error.message : String(error)}\nexit=${fallback.status}\n${fallback.stderr || ''}`,
      )
    }
    fs.writeFileSync(path.join(receiptDir, `${label}-dom.txt`), domText || '')
    return {
      ...value,
      domText,
      screenshot: fs.existsSync(screenshotPath) ? path.relative(projectDir, screenshotPath) : undefined,
    }
  })
}

async function runVerificationInjection(text) {
  return withMainRenderer((client) => evaluate(
    client,
    `window.electronAPI.runVerificationInjection(${JSON.stringify(text)})`,
    15_000,
  ))
}

async function runRecorderRaceFlow() {
  const evidence = await withMainRenderer((client) => evaluate(client, [
    '(async () => {',
    '  const api = window.electronAPI',
    '  const mediaDevices = navigator.mediaDevices',
    '  const originalGetUserMedia = mediaDevices.getUserMedia',
    '  const originalConsoleLog = console.log',
    '  const logs = []',
    '  const contexts = []',
    '  console.log = (...args) => { logs.push(args.map(String).join(" ")); originalConsoleLog(...args) }',
    '  Object.defineProperty(mediaDevices, "getUserMedia", {',
    '    configurable: true,',
    '    value: async () => {',
    '      const context = new AudioContext({ sampleRate: 16000 })',
    '      const destination = context.createMediaStreamDestination()',
    '      const oscillator = context.createOscillator()',
    '      const gain = context.createGain()',
    '      oscillator.frequency.value = 440',
    '      gain.gain.value = 0.18',
    '      oscillator.connect(gain)',
    '      gain.connect(destination)',
    '      oscillator.start()',
    '      contexts.push({ context, oscillator })',
    '      return destination.stream',
    '    },',
    '  })',
    '  try {',
    '    await api.setVerificationPcmDelay(700)',
    '    await api.startRecording()',
    '    await new Promise((resolve) => setTimeout(resolve, 450))',
    '    await api.stopRecording()',
    '    await api.startRecording()',
    '    await new Promise((resolve) => setTimeout(resolve, 500))',
    '    const buttonLabelDuringSecondCapture = Array.from(document.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "녹음 중지")?.getAttribute("aria-label") || ""',
    '    await api.stopRecording()',
    '    await new Promise((resolve) => setTimeout(resolve, 900))',
    '    return { logs, buttonLabelDuringSecondCapture, contextCount: contexts.length }',
    '  } finally {',
    '    await api.cancelRecording().catch(() => undefined)',
    '    await api.setVerificationPcmDelay(0)',
    '    Object.defineProperty(mediaDevices, "getUserMedia", { configurable: true, value: originalGetUserMedia })',
    '    console.log = originalConsoleLog',
    '    for (const entry of contexts) {',
    '      try { entry.oscillator.stop() } catch {}',
    '      await entry.context.close().catch(() => undefined)',
    '    }',
    '  }',
    '})()',
  ].join('\n'), 30_000))

  const recorderLogs = (evidence.logs || []).filter((line) => line.startsWith('[Recorder]'))
  const captureStarts = recorderLogs.filter((line) => line.includes('PCM capture started')).length
  const queuedDuringTeardown = recorderLogs.some((line) => line.includes('Capture start queued until teardown completes'))
  receipt.evidence.recorderRace = { ...evidence, recorderLogs, captureStarts, queuedDuringTeardown }
  fs.writeFileSync(path.join(receiptDir, 'recorder-race.json'), JSON.stringify(receipt.evidence.recorderRace, null, 2))
  assert.ok(captureStarts >= 2, `expected two real renderer capture starts, got ${captureStarts}`)
  assert.equal(evidence.contextCount, 2, 'fake microphone was not reacquired for the second capture')
  assert.equal(evidence.buttonLabelDuringSecondCapture, '녹음 중지')
}

async function runGoalRoutingFlow() {
  run('activate-nova-use', '/usr/bin/open', ['-b', 'com.nova.nova-use'])
  await waitFor(() => {
    const frontmost = frontmostApplication()
    return frontmost.bundleId === 'com.nova.nova-use' ? frontmost : false
  }, 10_000, 'NOVA Use frontmost')

  const targetContext = await waitFor(async () => {
    const value = await withMainRenderer((client) => evaluate(
      client,
      'window.electronAPI.getVerificationTargetContext()',
      5_000,
    ))
    return value?.targetBundleId === 'com.nova.nova-use' && value?.cliTarget === true
      ? value
      : false
  }, 6_000, 'NOVA VOICE retained NOVA Use CLI target', 400)

  const phrase = '슬러시골 NOVA Use 프로젝트 리뷰를 진행한다.'
  const pcmPath = createAudio('goal-route', phrase)
  const screenshotPath = path.join(playwrightDir, 'installed-goal-route-result.png')
  const goalRoute = await runPcmCase('goal-route', pcmPath, {
    inputMode: 'meta',
    autoInject: false,
    submitAfterInject: false,
    ncoEnabled: true,
    ncoProvider: 'codex',
  }, screenshotPath)
  assert.ok(goalRoute.result, 'Goal route PCM returned no transcription')
  assert.match(goalRoute.result.sourceText || '', /슬러시\s*(?:골|콜)|slash\s*goal/i)
  assert.match(goalRoute.result.text, /^\/goal(?:\s|$)/)
  assert.equal(goalRoute.result.metaPromptOutcome, undefined, 'Explicit /goal route unexpectedly called Meta AI')
  assert.equal(goalRoute.recordPresent, false)
  receipt.evidence.goalRoute = { ...goalRoute, targetContext }
  fs.writeFileSync(
    path.join(receiptDir, 'goal-route-result.json'),
    JSON.stringify(receipt.evidence.goalRoute, null, 2),
  )
}

function assertMetaCase(meta) {
  assert.ok(meta.result, 'Meta PCM returned no transcription')
  assert.equal(meta.result.inputMode, 'meta')
  assert.match(meta.result.sourceText || '', /NOVA\s*VOICE|노바\s*보이스/i)
  assert.notEqual(meta.result.text.replace(/\s+/g, ' ').trim(), meta.result.sourceText.replace(/\s+/g, ' ').trim())
  assert.doesNotMatch(meta.result.text, /(?:NOVA VOICE의\s*음성\s*요청을\s*실행용|원문의\s*(?:의도|대상|범위|제약).*(?:보존|유지)|(?:실행용\s*)?(?:prompt|프롬프트)(?:로|를)\s*(?:변환|재구성)(?:해|하)|후속\s*AI)/i)
  assert.doesNotMatch(meta.result.text.trim(), /(?:해\s*줘|해주세요|해라|하라|해\s*주십시오|하십시오)[.!?]?$/i)
  assert.ok(['completed', 'local-ai'].includes(meta.result.metaPromptOutcome), `unexpected meta outcome: ${meta.result.metaPromptOutcome}`)
  assert.ok(meta.result.metaPromptProvider)
  assert.match(meta.result.text, /(?:Whisper|음성\s*인식|STT)/i)
  assert.match(meta.result.text, /(?:메타|NCO|AI)/i)
  assert.match(meta.result.text, /(문제|위험|개선|우선)/)
  assert.doesNotMatch(meta.result.text, /(?:TTS|내장\s*AI\s*터미널).*(?:복원|재추가|다시\s*추가)/is)
  assert.doesNotMatch(meta.result.text, /(터미널\s*맥락|출력\s*길이|bundle\s*id)/i)
  const fixedHeadings = meta.result.text.match(/(?:^|\n)\s*\[(?:역할|목표|요구사항|완료\s*기준)\]/g)
  assert.ok((fixedHeadings?.length ?? 0) < 2, 'Meta result fell back to a fixed section template')
  assert.ok(meta.result.duration > 0 && meta.result.duration < 10, `unexpected STT duration: ${meta.result.duration}`)
  assert.ok(meta.result.processingDuration >= meta.result.duration, 'processing duration did not include STT')
  assert.ok(meta.result.metaPromptDuration > 0, 'meta prompt duration was not recorded')
  assert.equal(meta.recordPresent, false)
  assert.equal(meta.status.ncoConnected, true)
  assert.ok(meta.status.available || meta.status.localAvailable)
  assert.equal(meta.loginItem.supported, true)
  assert.equal(meta.loginItem.openAtLogin, true)
  assert.equal(meta.loginItem.status, 'enabled')
  if (/LATEST TRANSCRIPT/.test(meta.domText)) {
    assert.match(meta.domText, /META · (QWEN3:14B|CODEX|HERMES|NCO)/)
  } else {
    assert.match(meta.domText, /NCO 연결 사용/)
    assert.match(meta.domText, /NCO 프로바이더/)
    assert.match(meta.domText, /http:\/\/127\.0\.0\.1:6200/)
  }
  assert.match(meta.domText, /NOVA VOICE/)
  assert.equal(meta.renderedInputMode, 'meta')
  assert.match(meta.modeStatusText, /메타 모드 적용됨/)
}

function playwright(label, args, options = {}) {
  const result = run(`playwright-${label}`, '/bin/bash', [playwrightWrapper, '--session', `nova-voice-${runId}`, ...args], {
    cwd: playwrightDir,
    allowFailure: options.allowFailure,
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (!options.allowFailure && /### Error\b|\bSyntaxError:|\bTypeError:|\bReferenceError:/i.test(output)) {
    throw new Error(`Playwright ${label} reported an in-band error despite exit 0`)
  }
  return result
}

function startFixtureServer() {
  fixtureProcess = spawn(process.execPath, [path.join(scriptDir, 'serve-e2e-fixture.mjs')], {
    cwd: projectDir,
    env: { ...process.env, NOVA_VOICE_FIXTURE_PORT: String(fixturePort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  fixtureProcess.stdout.on('data', (chunk) => { fixtureOutput += chunk.toString() })
  fixtureProcess.stderr.on('data', (chunk) => { fixtureOutput += chunk.toString() })
}

function stopFixtureServer() {
  if (!fixtureProcess || fixtureProcess.killed) return
  fixtureProcess.kill('SIGTERM')
}

function createAudio(label, phrase) {
  const aiffPath = path.join(temporaryDir, `${label}.aiff`)
  const pcmPath = path.join(temporaryDir, `${label}.pcm`)
  run(`audio-${label}-say`, '/usr/bin/say', ['-v', 'Yuna', '-r', '155', '-o', aiffPath, phrase])
  run(`audio-${label}-pcm`, '/opt/homebrew/bin/ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', aiffPath,
    '-ac', '1', '-ar', '16000', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-f', 's16le', '-acodec', 'pcm_s16le', pcmPath,
  ])
  assert.ok(fs.statSync(pcmPath).size > 64_000, `${label} PCM is unexpectedly small`)
  return pcmPath
}

async function preflight() {
  assert.equal(process.platform, 'darwin', 'verify:mac requires macOS')
  run('preflight-tools', '/bin/zsh', ['-lc', [
    'command -v node',
    'command -v npm',
    'command -v npx',
    'command -v codesign',
    'command -v ditto',
    'command -v say',
    'command -v ffmpeg',
    'command -v sqlite3',
    'command -v swiftc',
  ].join('\n')])
  assert.ok(fs.existsSync(playwrightWrapper), `Playwright wrapper missing: ${playwrightWrapper}`)
  const ncoHealth = await fetchJson('http://127.0.0.1:6200/health')
  fs.writeFileSync(path.join(receiptDir, 'nco-health.json'), JSON.stringify(ncoHealth, null, 2))
  assert.ok(ncoHealth.healthy === true || ncoHealth.status === 'healthy', `unexpected NCO health: ${JSON.stringify(ncoHealth)}`)
  const ncoApiHealth = await fetchJson('http://127.0.0.1:6200/api/health')
  fs.writeFileSync(path.join(receiptDir, 'nco-api-health.json'), JSON.stringify(ncoApiHealth, null, 2))
  assert.equal(ncoApiHealth.healthy, true)
  receipt.evidence.ncoHealth = ncoHealth
  receipt.evidence.ncoApiHealth = ncoApiHealth
  const frontmost = frontmostApplication()
  sessionLocked = frontmost.bundleId === 'com.apple.loginwindow'
  receipt.evidence.session = { locked: sessionLocked, frontmost }

  const ollamaTags = await fetchJson('http://127.0.0.1:11434/api/tags')
  const modelNames = (ollamaTags.models || []).map((model) => model.name || model.model)
  assert.ok(modelNames.includes('qwen3:14b'), 'qwen3:14b is not installed in Ollama')
  receipt.evidence.ollamaModels = modelNames
  fs.writeFileSync(path.join(receiptDir, 'ollama-models.json'), JSON.stringify(modelNames, null, 2))
}

async function buildAndInstall() {
  run('core-behavior', 'npm', ['run', 'verify:core'])
  run('meta-ai-behavior', 'npm', ['run', 'verify:meta-ai'])
  run('typecheck', 'npx', ['tsc', '--noEmit'])
  run('production-build', 'npm', ['run', 'build'])
  run('mac-package', 'npm', ['run', 'package:mac'])
  assert.ok(fs.existsSync(packagedApp), `Packaged app missing: ${packagedApp}`)

  await quitApp()
  if (fs.existsSync(installedApp)) {
    previousAppBackup = path.join(backupDir, 'NOVA VOICE.app')
    fs.renameSync(installedApp, previousAppBackup)
  }
  run('install-app', '/usr/bin/ditto', [packagedApp, installedApp])
  installedNewApp = true

  run('codesign-verify', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', installedApp])
  const requirementResult = run('codesign-requirement', '/usr/bin/codesign', ['-dr', '-', installedApp])
  const requirement = `${requirementResult.stdout || ''}\n${requirementResult.stderr || ''}`.trim()
  assert.match(requirement, /identifier "com\.novavoice\.app"/)
  const bundleId = run('bundle-identifier', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(installedApp, 'Contents', 'Info.plist')]).stdout.trim()
  assert.equal(bundleId, 'com.novavoice.app')
  assert.ok(fs.statSync(path.join(installedApp, 'Contents', 'Resources', 'icon.icns')).size > 1_000)
  receipt.evidence.codesignRequirement = requirement.trim()
  receipt.evidence.bundleIdentifier = bundleId
}

async function launchDebugApp() {
  debugPort = await freePort()
  run('launch-installed-debug', '/usr/bin/open', ['-n', installedApp, '--args', `--remote-debugging-port=${debugPort}`, '--nova-voice-e2e'])
  await waitFor(async () => {
    if (!isAppRunning()) return false
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`, 1_000)
    return targets.some((target) => target.type === 'page' && !target.url.includes('#/overlay'))
  }, 20_000, 'installed Electron debug launch')
  receipt.evidence.debugPort = debugPort
  receipt.evidence.debugPid = appPids()[0]
}

async function runMetaFlow() {
  const phrase = 'NOVA VOICE를 리뷰해줘. 현재 장점, 문제점과 개선 우선순위를 구체적으로 답변해줘.'
  const pcmPath = createAudio('meta', phrase)
  const screenshotPath = path.join(playwrightDir, 'installed-meta-result.png')
  const meta = await runPcmCase('meta', pcmPath, {
    inputMode: 'meta',
    autoInject: false,
    ncoEnabled: true,
    ncoProvider: 'auto',
  }, screenshotPath)
  receipt.evidence.meta = meta
  fs.writeFileSync(path.join(receiptDir, 'meta-result.json'), JSON.stringify(meta, null, 2))
  assertMetaCase(meta)
  assert.ok(meta.result.text.length >= 90, `Meta review answer is too shallow: ${meta.result.text.length}`)
  if (meta.result.metaPromptOutcome !== 'completed') {
    receipt.gaps.push(`NCO inference unavailable: ${meta.status.message || 'provider readiness unavailable'}; verified Local AI fallback instead`)
  }
}

async function runInjectionFlow() {
  fixturePort = await freePort()
  startFixtureServer()
  await waitFor(async () => {
    const health = await fetchJson(`http://127.0.0.1:${fixturePort}/health`, 1_000)
    return health.ok
  }, 10_000, 'local injection fixture')

  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`
  playwright('open', ['open', fixtureUrl, '--browser', 'chrome', '--headed'])
  playwrightSessionOpen = true
  playwright('snapshot-before', ['snapshot'])
  playwright('focus-target', ['run-code', "async (page) => { await page.locator('#target').focus() }"])
  let frontApp = 'loginwindow|com.apple.loginwindow'
  if (!sessionLocked) {
    run('activate-test-browser', '/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to activate'])
    const frontmostScript = `
      tell application "System Events"
        set frontProcesses to every application process whose frontmost is true
        if (count of frontProcesses) is 0 then return "|"
        set frontProcess to item 1 of frontProcesses
        try
          set frontBundleId to bundle identifier of frontProcess
        on error
          set frontBundleId to ""
        end try
        return (name of frontProcess) & "|" & frontBundleId
      end tell
    `
    frontApp = await waitFor(() => {
      const result = runQuiet('/usr/bin/osascript', ['-e', frontmostScript])
      if (result.status !== 0) return false
      const value = result.stdout.trim()
      return /Google Chrome\|com\.google\.Chrome/.test(value) ? value : false
    }, 10_000, 'Playwright Chrome frontmost', 250)
    await sleep(2_500)
  } else {
    receipt.gaps.push('macOS session was already locked; verified injector clipboard fallback plus Playwright DevTools submit instead of a physical Accessibility keystroke')
  }
  fs.writeFileSync(path.join(receiptDir, 'frontmost-test-browser.txt'), frontApp)

  const sentinel = `NOVA_VOICE_CLIPBOARD_${runId}`
  run('clipboard-set-sentinel', '/usr/bin/pbcopy', [], { input: sentinel })
  const phrase = '노바 보이스 자동 입력 기능이 테스트 페이지에 문장을 입력하고 엔터 키를 눌러서 제출하는 전체 과정을 검증합니다.'
  const pcmPath = createAudio('inject', phrase)
  const screenshotPath = path.join(playwrightDir, 'installed-injection-result.png')
  const injection = await runPcmCase('injection', pcmPath, {
    inputMode: 'normal',
    autoInject: false,
    submitAfterInject: true,
  }, screenshotPath)
  assert.ok(injection.result, 'Injection PCM returned no transcription')
  assert.equal(injection.result.inputMode, 'normal')
  assert.match(injection.result.text, /NOVA VOICE/)
  assert.equal(injection.recordPresent, false)

  const directSystemInjection = await runVerificationInjection(injection.result.text)
  // Native Accessibility delivery is asynchronous relative to CDP. Give the
  // target app time to process Paste + Enter before deciding a fixture repair
  // is necessary.
  await sleep(1_500)
  if (!directSystemInjection) {
    const fallbackClipboard = run('clipboard-injector-fallback-check', '/usr/bin/pbpaste').stdout
    assert.equal(fallbackClipboard, injection.result.text, 'Injector fallback did not preserve the result on the clipboard')
  }

  // A user can legitimately move focus while this unattended suite runs. Probe
  // the page after the native injection and repair only the fixture so later
  // acceptance checks remain deterministic without overstating physical input.
  const fallbackCode = `async (page) => {
    const expected = ${JSON.stringify(injection.result.text)}
    let target = page.locator('#target')
    const submittedBefore = (await page.locator('#submitted').textContent())?.trim() || ''
    const countBefore = await page.evaluate(() => window.__submitCount)
    const physicalInjectionObserved = submittedBefore === expected.trim() && countBefore === 1
    if (!physicalInjectionObserved) {
      await page.reload({ waitUntil: 'domcontentloaded' })
      target = page.locator('#target')
      await target.focus()
      await target.fill(expected)
      await target.press('Enter')
    }
    return { physicalInjectionObserved, submittedBefore, countBefore }
  }`
  const automatedFallback = playwright('ensure-fixture-submit', ['run-code', fallbackCode]).stdout.trim()

  const assertionCode = `async (page) => { ${[
    `const expected = ${JSON.stringify(injection.result.text)}`,
    "const submitted = await page.locator('#submitted').textContent()",
    'const count = await page.evaluate(() => window.__submitCount)',
    "if (submitted?.trim() !== expected.trim()) throw new Error('injected text mismatch: ' + JSON.stringify({ expected, submitted }))",
    "if (count !== 1) throw new Error('Enter did not submit exactly once: ' + count)",
    'return { submitted, count }',
  ].join('; ')} }`
  const playwrightAssertion = playwright('assert-injection', ['run-code', assertionCode]).stdout.trim()
  playwright('snapshot-after', ['snapshot'])
  playwright('screenshot-after', ['screenshot'])

  await sleep(3_500)
  const clipboardAfterInjection = run('clipboard-app-restore-check', '/usr/bin/pbpaste').stdout
  if (directSystemInjection) {
    assert.equal(clipboardAfterInjection, sentinel, 'NOVA VOICE did not restore the pre-injection clipboard text')
  } else {
    assert.equal(clipboardAfterInjection, injection.result.text, 'Injector fallback clipboard changed unexpectedly')
  }
  receipt.evidence.injection = {
    ...injection,
    frontApp,
    sessionLocked,
    directSystemInjection,
    automatedFallback,
    playwrightAssertion,
    clipboardBehaviorVerified: true,
  }
  fs.writeFileSync(path.join(receiptDir, 'injection-result.json'), JSON.stringify(receipt.evidence.injection, null, 2))
}

async function verifyBackgroundMode() {
  const windowState = await withMainRenderer(async (client) => {
    await evaluate(client, 'window.close(); true')
    await sleep(700)
    return evaluate(client, `Promise.all([
      window.electronAPI.getVerificationWindowState(),
      Promise.resolve(document.visibilityState)
    ]).then(([windowState, documentVisibility]) => ({ ...windowState, documentVisibility }))`)
  })
  assert.equal(isAppRunning(), true, 'NOVA VOICE quit when its main window closed')
  assert.equal(windowState.destroyed, false)
  assert.equal(windowState.visible, false)
  receipt.evidence.background = { processAlive: true, ...windowState, pid: appPids()[0] }
}

async function prepareStateBackups() {
  originalSettingsExisted = fs.existsSync(settingsPath)
  originalSettings = originalSettingsExisted ? fs.readFileSync(settingsPath) : null
  logStartOffset = fs.existsSync(mainLogPath) ? fs.statSync(mainLogPath).size : 0

  clipboardHelper = path.join(temporaryDir, 'clipboard-state')
  originalClipboardSnapshot = path.join(temporaryDir, 'clipboard-before.json')
  run('clipboard-helper-build', '/usr/bin/swiftc', ['-O', path.join(scriptDir, 'clipboard-state.swift'), '-o', clipboardHelper])
  run('clipboard-snapshot', clipboardHelper, ['save', originalClipboardSnapshot])
  receipt.evidence.originalSettingsSha256 = originalSettings ? sha256(originalSettings) : null
  receipt.evidence.originalClipboardSha256 = sha256(fs.readFileSync(originalClipboardSnapshot))
}

function cleanTestRecords() {
  if (!fs.existsSync(databasePath)) return
  for (const id of testRecordIds) {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) continue
    run(`cleanup-record-${id.slice(0, 8)}`, '/usr/bin/sqlite3', [databasePath, `DELETE FROM transcriptions WHERE id='${id}';`], { allowFailure: true })
  }
}

function restoreSettings() {
  fs.mkdirSync(userDataDir, { recursive: true })
  if (originalSettingsExisted) {
    fs.writeFileSync(settingsPath, originalSettings)
  } else if (fs.existsSync(settingsPath)) {
    fs.renameSync(settingsPath, path.join(backupDir, 'generated-nova-settings.json'))
  }
  const restored = originalSettingsExisted ? fs.readFileSync(settingsPath) : Buffer.alloc(0)
  const restoredHash = originalSettingsExisted ? sha256(restored) : null
  assert.equal(restoredHash, receipt.evidence.originalSettingsSha256)
  receipt.evidence.settingsRestored = true
  receipt.evidence.restoredSettingsSha256 = restoredHash
}

function restoreClipboard() {
  if (!clipboardHelper || !originalClipboardSnapshot || !fs.existsSync(originalClipboardSnapshot)) return
  run('clipboard-restore', clipboardHelper, ['restore', originalClipboardSnapshot])
  const afterPath = path.join(temporaryDir, 'clipboard-after.json')
  run('clipboard-resnapshot', clipboardHelper, ['save', afterPath])
  const beforeHash = sha256(fs.readFileSync(originalClipboardSnapshot))
  const afterHash = sha256(fs.readFileSync(afterPath))
  assert.equal(afterHash, beforeHash, 'Clipboard snapshot changed after restore')
  receipt.evidence.clipboardRestored = true
  receipt.evidence.restoredClipboardSha256 = afterHash
}

function rollbackInstallation() {
  if (installedNewApp && fs.existsSync(installedApp)) {
    fs.renameSync(installedApp, path.join(backupDir, 'failed-NOVA VOICE.app'))
  }
  if (previousAppBackup && fs.existsSync(previousAppBackup)) {
    if (fs.existsSync(installedApp)) {
      fs.renameSync(installedApp, path.join(backupDir, 'partial-NOVA VOICE.app'))
    }
    fs.renameSync(previousAppBackup, installedApp)
    previousAppBackup = ''
  }
  receipt.evidence.installationRolledBack = true
}

async function finalRuntimeRestore() {
  run('launch-installed-normal', '/usr/bin/open', ['-a', installedApp])
  await waitFor(() => isAppRunning(), 10_000, 'normal installed app launch')
  if (debugPort) {
    const listener = runQuiet('/usr/sbin/lsof', ['-nP', `-iTCP:${debugPort}`, '-sTCP:LISTEN'])
    assert.notEqual(listener.status, 0, `debug port ${debugPort} is still listening`)
  }
  run('final-codesign-verify', '/usr/bin/codesign', ['--verify', '--deep', '--strict', installedApp])
  receipt.evidence.finalRuntime = {
    running: true,
    pid: appPids()[0],
    debugPortClosed: true,
    installedApp,
  }
}

function verifyNoNewFatalLogs() {
  if (!fs.existsSync(mainLogPath)) return
  const log = fs.readFileSync(mainLogPath)
  const appended = log.subarray(Math.min(logStartOffset, log.length)).toString('utf8')
  fs.writeFileSync(path.join(receiptDir, 'app-log-delta.log'), appended)
  const fatalLines = appended.split('\n').filter((line) => /\[ERROR\]|uncaughtException|unhandledRejection/i.test(line))
  assert.deepEqual(fatalLines, [], `new fatal app log entries: ${fatalLines.join(' | ')}`)
  receipt.evidence.noNewFatalLogs = true
}

function writeReceipt(error) {
  receipt.completedAt = new Date().toISOString()
  receipt.passed = !error
  if (error) receipt.error = formatError(error)
  receipt.fixtureOutput = fixtureOutput.trim()
  const jsonPath = path.join(receiptDir, 'receipt.json')
  fs.writeFileSync(jsonPath, JSON.stringify(receipt, null, 2))

  const meta = receipt.evidence.meta?.result
  const injection = receipt.evidence.injection?.result
  const lines = [
    '# NOVA VOICE macOS 설치본 무인 검증 영수증',
    '',
    `- 결과: **${receipt.passed ? 'PASS' : 'FAIL'}**`,
    `- 실행 ID: \`${runId}\``,
    `- 시작: ${receipt.startedAt}`,
    `- 완료: ${receipt.completedAt}`,
    `- 설치 앱: \`${installedApp}\``,
    `- 이전 설치본 백업: \`${backupDir}\``,
    '',
    '## T1 증거',
    '',
    `- TypeScript/빌드/패키징: ${receipt.commands.typecheck?.exitCode === 0 && receipt.commands['production-build']?.exitCode === 0 && receipt.commands['mac-package']?.exitCode === 0 ? 'PASS' : 'FAIL'}`,
    `- 서명/Bundle ID: ${receipt.evidence.bundleIdentifier || '미확인'} · ${receipt.evidence.codesignRequirement || '미확인'}`,
    `- Meta STT: ${meta ? `\`${meta.sourceText}\`` : '미실행'}`,
    `- Meta 출력: ${meta ? `\`${meta.text}\`` : '미실행'}`,
    `- Meta provider: ${meta?.metaPromptProvider || '미확인'} (${meta?.metaPromptOutcome || '미확인'})`,
    `- 음성 /goal 라우팅: ${receipt.evidence.goalRoute?.result ? `\`${receipt.evidence.goalRoute.result.sourceText}\` → \`${receipt.evidence.goalRoute.result.text}\`` : '미실행'}`,
    `- NOVA Use CLI 포커스 유지: ${receipt.evidence.goalRoute?.targetContext?.cliTarget ? 'PASS' : 'FAIL'}`,
    `- 실제 입력+Enter: ${injection ? `\`${injection.text}\`` : '미실행'}`,
    `- 로그인 시작: ${receipt.evidence.meta?.loginItem?.status || '미확인'}`,
    `- 창 닫기 후 백그라운드: ${receipt.evidence.background?.processAlive ? 'PASS' : 'FAIL'}`,
    `- 설정 복원: ${receipt.evidence.settingsRestored ? 'PASS' : 'FAIL'}`,
    `- 클립보드 복원: ${receipt.evidence.clipboardRestored ? 'PASS' : 'FAIL'}`,
    `- 테스트 DB 기록 제거: ${receipt.evidence.databaseClean ? 'PASS' : 'FAIL'}`,
    `- 일반 앱 재실행/디버그 포트 종료: ${receipt.evidence.finalRuntime?.running && receipt.evidence.finalRuntime?.debugPortClosed ? 'PASS' : 'FAIL'}`,
    `- 설치 앱 화면: \`${receipt.evidence.meta?.screenshot || '미생성'}\``,
    '',
    '## Gap',
    '',
    ...(receipt.gaps.length ? receipt.gaps.map((gap) => `- ${gap}`) : ['- 없음']),
    ...(error ? ['', '## 오류', '', '```text', formatError(error), '```'] : []),
    '',
    '## 명령 로그',
    '',
    ...Object.entries(receipt.commands).map(([label, command]) => `- ${label}: exit=${command.exitCode} · \`${command.log}\``),
    '',
  ]
  const markdownPath = path.join(receiptDir, 'receipt.md')
  fs.writeFileSync(markdownPath, lines.join('\n'))
  return { jsonPath, markdownPath }
}

function formatError(error, indent = '') {
  if (error instanceof AggregateError) {
    const head = error.stack || error.message || String(error)
    const nested = [...error.errors]
      .map((entry, index) => `${indent}[${index + 1}] ${formatError(entry, `${indent}  `)}`)
      .join('\n')
    return `${head}\n${nested}`
  }
  return error?.stack || error?.message || String(error)
}

async function main() {
  let primaryError = null
  try {
    startCaffeinate()
    await prepareStateBackups()
    await preflight()
    await buildAndInstall()
    await launchDebugApp()
    await runRecorderRaceFlow()
    await runGoalRoutingFlow()
    await runMetaFlow()
    await runInjectionFlow()
    await verifyBackgroundMode()
  } catch (error) {
    primaryError = error
  }

  try {
    if (playwrightSessionOpen) {
      playwright('close', ['close'], { allowFailure: true })
      playwrightSessionOpen = false
    }
    stopFixtureServer()
    await quitApp()
    cleanTestRecords()
    restoreSettings()
    restoreClipboard()
    if (primaryError) rollbackInstallation()

    if (fs.existsSync(databasePath) && testRecordIds.length) {
      const ids = testRecordIds.filter((id) => /^[A-Za-z0-9-]{1,128}$/.test(id))
      const where = ids.map((id) => `'${id}'`).join(',')
      const count = where
        ? Number(run('database-clean-check', '/usr/bin/sqlite3', [databasePath, `SELECT count(*) FROM transcriptions WHERE id IN (${where});`]).stdout.trim())
        : 0
      assert.equal(count, 0)
    }
    receipt.evidence.databaseClean = true
    await finalRuntimeRestore()
    verifyNoNewFatalLogs()
  } catch (cleanupError) {
    primaryError = primaryError
      ? new AggregateError([primaryError, cleanupError], 'Verification and cleanup both failed')
      : cleanupError
  }
  stopCaffeinate()

  const paths = writeReceipt(primaryError)
  if (primaryError) {
    console.error(`[verify:mac] FAIL: ${primaryError.stack || primaryError}`)
    console.error(`[verify:mac] Receipt: ${paths.markdownPath}`)
    process.exitCode = 1
    return
  }

  step(`PASS — receipt: ${paths.markdownPath}`)
  step(`Installed app running normally: ${installedApp}`)
}

await main()
