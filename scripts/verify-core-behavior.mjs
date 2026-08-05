import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isCliTarget, routeVoicePrompt } from '../src/main/cli-command-router.ts'
import {
  findSpokenCatalogCommand,
  getCommandCatalog,
  getMetaCommandCandidates,
  getMetaToolCandidates,
  isCatalogCommand,
} from '../src/main/command-catalog.ts'
import { normalizeTranscript } from '../src/main/transcript-normalizer.ts'
import { shouldRememberFrontApp } from '../src/main/front-app-policy.ts'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.dirname(scriptDir)

const normalized = normalizeTranscript('로바 보이스에서 엔시어 오케스트레이터의 인터세션 프로바이더를 확인해')
assert.equal(normalized, 'NOVA VOICE에서 NCO Orchestrator의 Inter-session provider를 확인해')
assert.equal(normalizeTranscript('노바라는 일반 명사가 아닌 노바 보이스 앱'), 'nova라는 일반 명사가 아닌 NOVA VOICE 앱')
assert.equal(normalizeTranscript('Nova Voice 자동 입력 기능'), 'NOVA VOICE 자동 입력 기능')
assert.equal(normalizeTranscript('메탈 프로포트 작동 확인'), 'meta prompt 작동 확인')

assert.equal(isCliTarget('Terminal', 'com.apple.Terminal'), true)
assert.equal(isCliTarget('NOVA Use', 'com.nova.use'), true)
assert.equal(isCliTarget('', 'com.nova.nova-use'), true)
assert.equal(shouldRememberFrontApp('NOVA VOICE', 'com.novavoice.app'), false)
assert.equal(shouldRememberFrontApp('nova-voice', ''), false)
assert.equal(shouldRememberFrontApp('NOVA Use', 'com.nova.nova-use'), true)
// Every unpackaged Electron app reports the process name "Electron". Matching
// on the name alone made NOVA VOICE treat other Electron apps as itself and
// refuse to dictate into them, so the process id decides instead.
assert.equal(shouldRememberFrontApp('Electron', 'com.github.Electron', 87772), true)
assert.equal(shouldRememberFrontApp('Electron', 'com.github.Electron', process.pid), false)
assert.equal(shouldRememberFrontApp('NOVA VOICE', 'com.novavoice.app', 4242), false)
// Without a usable pid the ambiguous name list is the only safeguard left.
assert.equal(shouldRememberFrontApp('Electron', 'com.github.Electron'), false)
assert.equal(shouldRememberFrontApp('Electron', 'com.github.Electron', 0), false)
assert.deepEqual(
  routeVoicePrompt('슬러시 클리어', 'Terminal', 'com.apple.Terminal'),
  { text: '/clear', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('슬래시 컴팩트', 'NOVA Use', 'com.nova.use'),
  { text: '/compact', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('슬러시 콜', 'Terminal', 'com.apple.Terminal'),
  { text: '/goal', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('슬러시 콜 사용자의 원래 입력을 그대로 유지해', 'NOVA Use', 'com.nova.use'),
  { text: '/goal 사용자의 원래 입력을 그대로 유지해', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('슬러시 골 다음 작업도 계속 진행해', 'Terminal', 'com.apple.Terminal'),
  { text: '/goal 다음 작업도 계속 진행해', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('슬러시골', 'Terminal', 'com.apple.Terminal'),
  { text: '/goal', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('슬러시클리어', 'Terminal', 'com.apple.Terminal'),
  { text: '/clear', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('slashgoal NOVA Voice를 최적화해', 'NOVA Use', 'com.nova.nova-use'),
  { text: '/goal NOVA VOICE를 최적화해', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('슬러시골프 결과를 알려줘', 'Terminal', 'com.apple.Terminal'),
  { text: '슬러시골프 결과를 알려줘', isSlashCommand: false, shouldExecuteInCli: false },
)
assert.deepEqual(
  routeVoicePrompt('슬러시 골NOVA Use 프로젝트 리뷰를 진행한다.', 'NOVA Use', 'com.nova.nova-use'),
  { text: '/goal NOVA Use 프로젝트 리뷰를 진행한다.', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('슬러시 골노바 유즈 프로젝트 리뷰를 진행한다.', 'NOVA Use', 'com.nova.nova-use'),
  { text: '/goal NOVA Use 프로젝트 리뷰를 진행한다.', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('슬러시 골노바 유즈 프로젝트 리뷰를 진행한다.', 'NOVA Use', 'com.nova.nova-use'),
  { text: '/goal NOVA Use 프로젝트 리뷰를 진행한다.', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('슬라시 골 NOVA Use 프로젝트 리뷰를 진행한다.', 'NOVA Use', 'com.nova.nova-use'),
  { text: '/goal NOVA Use 프로젝트 리뷰를 진행한다.', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('일반 문장을 그대로 입력해', 'TextEdit', 'com.apple.TextEdit'),
  { text: '일반 문장을 그대로 입력해', isSlashCommand: false, shouldExecuteInCli: false },
)

const commandCatalog = getCommandCatalog()
assert.ok(commandCatalog.length >= 180, `command catalog is unexpectedly small: ${commandCatalog.length}`)
assert.equal(isCatalogCommand('/nco-discussion'), true)
assert.equal(isCatalogCommand('/goal'), true)
assert.equal(isCatalogCommand('/made-up-command'), false)
assert.deepEqual(
  findSpokenCatalogCommand('엔씨오 태스크 codex 로그인 버그 수정'),
  { command: '/nco-task', arguments: 'codex 로그인 버그 수정' },
)
assert.deepEqual(
  routeVoicePrompt('슬러시 엔씨오 태스크 codex 로그인 버그 수정', 'NOVA Use', 'com.nova.use'),
  { text: '/nco-task codex 로그인 버그 수정', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('/nco-discussion REST와 GraphQL을 토론해', 'Terminal', 'com.apple.Terminal'),
  { text: '/nco-discussion REST와 GraphQL을 토론해', isSlashCommand: true, shouldExecuteInCli: true },
)
assert.deepEqual(
  routeVoicePrompt('/made-up-command 실행', 'Terminal', 'com.apple.Terminal'),
  { text: '/made-up-command 실행', isSlashCommand: false, shouldExecuteInCli: false },
)
assert.equal(
  getMetaCommandCandidates('여러 AI가 REST와 GraphQL의 장단점을 토론해')[0]?.command,
  '/nco-discussion',
)
assert.equal(
  getMetaCommandCandidates('NOVA-AX 회사 팀에게 릴리스 검증 작업을 위임해')[0]?.command,
  '/nco-company',
)
assert.equal(
  getMetaCommandCandidates('NOVA Use 브라우저에서 로그인 버튼을 클릭해')[0]?.command,
  '/click',
)
assert.equal(
  getMetaToolCandidates('NOVA-AX 서버 상태와 연결을 확인해')[0]?.name,
  'ax_health',
)

const obsidianCommandDir = path.join(
  process.env.HOME ?? '',
  'obsidian',
  'mac-obsidian',
  '10-CLI-COMMANDER',
)
for (const fileName of ['README.md', 'NCO.md', 'NOVA Use.md', 'NOVA-AX.md', 'command-catalog.json']) {
  assert.equal(fs.existsSync(path.join(obsidianCommandDir, fileName)), true, `missing command reference: ${fileName}`)
}

const sourceFiles = fs.readdirSync(path.join(projectDir, 'src', 'main'))
assert.equal(sourceFiles.some((name) => /tts|terminal|pty/i.test(name)), false)

const ipcRuntime = fs.readFileSync(path.join(projectDir, 'src', 'main', 'ipc.ts'), 'utf8')
const sourceText = [
  ipcRuntime,
  fs.readFileSync(path.join(projectDir, 'src', 'preload', 'index.ts'), 'utf8'),
].join('\n')
for (const removedSurface of ["'tts:", "'pty:", "'ai:process", 'smartSpeak', 'node-pty']) {
  assert.equal(sourceText.includes(removedSurface), false, `removed surface returned: ${removedSurface}`)
}

const metaRuntime = fs.readFileSync(path.join(projectDir, 'src', 'main', 'nco-meta-prompt.ts'), 'utf8')
assert.equal(metaRuntime.includes('compileLocalMetaPrompt'), false, 'hard-coded meta prompt fallback is still wired')
assert.equal(metaRuntime.includes("provider: 'Local Prompt Compiler'"), false, 'template compiler is still reported as AI')
assert.match(metaRuntime, /META_PROMPT_AI_UNAVAILABLE/)
assert.match(metaRuntime, /TOTAL_TIMEOUT_MS = 120_000/)
assert.match(metaRuntime, /Promise\.any\(candidates\)/)
// Meta mode enriches the spoken request into a prompt for another AI. Output
// that reads as a finished answer is the failure this mode exists to avoid.
assert.match(metaRuntime, /answered the request instead of turning it into a prompt/)
assert.match(metaRuntime, /does not read as a request/)
assert.match(metaRuntime, /adds nothing to the transcript/)
assert.match(metaRuntime, /const REQUEST_ENDING =/)
assert.equal(metaRuntime.includes('downstream instruction instead of the final answer'), false, 'meta mode still rejects prompt-shaped output')
assert.equal(metaRuntime.includes('최종 답변만 출력한다'), false, 'meta instruction still asks for an answer')
assert.match(metaRuntime, /요청을 수행하지 말고, 요청을 수행할 AI가 받을 프롬프트를 작성한다/)
// 'auto' no longer means a hard-coded codex submit. It resolves through the
// provider selector and walks a ranked fallback list within the same request.
assert.equal(
  /ai: requestedProvider === 'auto' \? 'codex' : requestedProvider/.test(metaRuntime),
  false,
  'auto provider is still hard-coded to codex',
)
assert.match(metaRuntime, /requestedProvider !== 'auto'/)
assert.match(metaRuntime, /await resolveAutoProvider\(\)/)
assert.match(metaRuntime, /decision\.ranked\.slice\(0, MAX_AUTO_PROVIDER_ATTEMPTS\)/)
assert.match(metaRuntime, /recordProviderOutcome\(/)
assert.match(metaRuntime, /allowProviderFailover,/)
assert.match(metaRuntime, /pollDelayMs\(Date\.now\(\) - startedAt\)/)
assert.match(metaRuntime, /requestJson\('\/api\/ai-providers'/)
assert.match(metaRuntime, /reconnectNcoProvider/)
assert.match(metaRuntime, /requestJsonWithRetry\('\/health'/)
assert.equal(metaRuntime.includes('.nova-use'), false, 'Nova Use sidecar/token dependency remains in NCO meta runtime')
assert.equal(metaRuntime.includes('process.env.NCO_BASE'), false, 'NCO Core endpoint can still be redirected by an inherited environment variable')

const selectorRuntime = fs.readFileSync(path.join(projectDir, 'src', 'main', 'nco-provider-selector.ts'), 'utf8')
assert.match(selectorRuntime, /export function recordProviderOutcome/)
assert.match(selectorRuntime, /export async function resolveAutoProvider/)
// A failed attempt must not be able to make a provider look like the fastest.
assert.match(selectorRuntime, /avgMs: outcome\.ok/)

const rankingRuntime = fs.readFileSync(path.join(projectDir, 'src', 'main', 'nco-provider-ranking.ts'), 'utf8')
assert.match(rankingRuntime, /providerHealthDimensions/)
assert.match(rankingRuntime, /cooldownUntil/)
assert.match(rankingRuntime, /export function buildProviderFacts/)
assert.match(rankingRuntime, /export function scoreProviders/)
// The ranking must stay runnable outside Electron so it can be verified
// directly against a live NCO payload (scripts/verify-provider-ranking.mjs).
assert.equal(rankingRuntime.includes("from 'electron'"), false, 'ranking logic pulled in an Electron dependency')
assert.equal(rankingRuntime.includes("from 'fs'"), false, 'ranking logic pulled in a filesystem dependency')

const clientRuntime = fs.readFileSync(path.join(projectDir, 'src', 'main', 'nco-core-client.ts'), 'utf8')
assert.equal(clientRuntime.includes('process.env.NCO_BASE'), false, 'NCO Core endpoint can still be redirected by an inherited environment variable')
assert.match(clientRuntime, /REDACTED/)
assert.equal(metaRuntime.includes('버그 수정이면 재현·원인·근본 수정·회귀 검증'), false, 'canned bug workflow is still forced')
const localMetaRuntime = fs.readFileSync(path.join(projectDir, 'src', 'main', 'local-ai-meta-prompt.ts'), 'utf8')
assert.equal(localMetaRuntime.includes('intentGuidance'), false, 'regex-based prompt template routing is still present')
assert.equal(localMetaRuntime.includes('버그 수정 요청:'), false, 'canned local AI bug workflow is still forced')
assert.match(localMetaRuntime, /warmupLocalAiMetaPrompt/)
assert.match(localMetaRuntime, /qwen3:14b/)
assert.match(localMetaRuntime, /OLLAMA_CHAT_URL/)
assert.match(localMetaRuntime, /forceRevision/)
assert.match(localMetaRuntime, /const REQUEST_ENDING =/)
assert.match(localMetaRuntime, /answered the request instead of turning it into a prompt/)
assert.equal(localMetaRuntime.includes('downstream instruction instead of the final answer'), false, 'local meta still rejects prompt-shaped output')
assert.match(localMetaRuntime, /메타 프롬프트 작성 엔진/)
assert.match(ipcRuntime, /settings:changed/)
assert.match(ipcRuntime, /getMetaCommandCandidates\(routedPrompt\.text\)/)
assert.match(ipcRuntime, /getMetaToolCandidates\(routedPrompt\.text\)/)
assert.match(ipcRuntime, /rewrittenRoute = routeVoicePrompt/)
// The mode comes from the hotkey that started this capture, not the saved
// default, so Ctrl+Shift+Alt+Space cannot leak into the next dictation.
assert.match(ipcRuntime, /const requestSettings = \{ \.\.\.settings, inputMode: getActiveInputMode\(\) \}/)
assert.match(ipcRuntime, /setActiveInputMode\(null\)/)
assert.match(ipcRuntime, /export function setActiveInputMode/)
assert.match(ipcRuntime, /inputMode: requestSettings\.inputMode/)
assert.match(ipcRuntime, /metaPromptDuration/)
assert.match(ipcRuntime, /requestSettings\.inputMode !== 'meta'/)
assert.match(ipcRuntime, /shouldExecuteInCli/)
assert.equal(ipcRuntime.includes('warmupLocalAiMetaPrompt'), false, 'Meta AI warmup can still overlap Whisper after a mode change')
// The injection target is latched at recording start; the 2s foreground poller
// must not be able to redirect a dictation to whatever came forward since.
assert.match(ipcRuntime, /releaseFrontAppLatch\(\)/)
assert.match(ipcRuntime, /finishLiveCapture\(streamedByteCount, controller\.signal\)/)
assert.match(ipcRuntime, /pushLiveAudio\(toBuffer\(chunk\)\)/)

const appStateRuntime = fs.readFileSync(path.join(projectDir, 'src', 'main', 'appState.ts'), 'utf8')
assert.match(appStateRuntime, /export function latchFrontApp/)
assert.match(appStateRuntime, /export function releaseFrontAppLatch/)
assert.match(appStateRuntime, /if \(!options\.force && isFrontAppLatched\(\)\) return/)

const recorderRuntime = fs.readFileSync(path.join(projectDir, 'src', 'renderer', 'hooks', 'useRecorder.ts'), 'utf8')
assert.match(recorderRuntime, /Capture start queued until teardown completes/)
assert.match(recorderRuntime, /Starting queued capture after teardown/)
assert.match(recorderRuntime, /transcriptionSequenceRef/)
assert.match(recorderRuntime, /sendPcmChunk\(encoded\.buffer as ArrayBuffer\)/)
assert.match(recorderRuntime, /sendAudioSpectrum\(spectrum\)/)
assert.match(recorderRuntime, /buildSpectrum\(frequencyData, spectrum, minBin, maxBin\)/)
const rendererRuntime = [
  fs.readFileSync(path.join(projectDir, 'src', 'renderer', 'components', 'unified', 'UnifiedPanel.tsx'), 'utf8'),
  fs.readFileSync(path.join(projectDir, 'src', 'renderer', 'components', 'history', 'HistoryPanel.tsx'), 'utf8'),
].join('\n')
assert.equal(rendererRuntime.includes('QWEN3:4B'), false, 'stale hard-coded Meta provider badge remains')
assert.match(rendererRuntime, /메타 모드 적용됨 · 말한 요청을 AI가 알아듣기 좋은 프롬프트로 다듬어 입력합니다/)
assert.match(rendererRuntime, /PROCESS LATENCY/)
assert.match(localMetaRuntime, /127\.0\.0\.1:11435/)
assert.match(localMetaRuntime, /shutdownLocalAiMetaPrompt/)
const mainRuntime = fs.readFileSync(path.join(projectDir, 'src', 'main', 'index.ts'), 'utf8')
assert.equal(mainRuntime.includes('warmupLocalAiMetaPrompt'), false, 'Meta AI warmup can still overlap Whisper at startup')
assert.match(mainRuntime, /isE2eVerification/)
assert.match(mainRuntime, /Global shortcuts disabled for isolated E2E run/)
assert.match(mainRuntime, /recordingRequestVersion/)
assert.match(mainRuntime, /if \(!getRecordingState\(\)\) \{\s*\n\s*await startRecording\(/)
assert.match(mainRuntime, /await rememberFrontApp\(\{ force: true \}\)/)
assert.match(mainRuntime, /latchFrontApp\(\)/)
assert.match(mainRuntime, /beginLiveCapture\(\)/)
// A hidden window stops requestAnimationFrame outright (measured 120Hz -> 0Hz)
// and throttles timers to 1Hz, which freezes the capture loop that decides
// when speech ended. Closing the window must not break dictation.
assert.equal((mainRuntime.match(/backgroundThrottling: false/g) || []).length, 2, 'both windows must opt out of background throttling')

const shortcutRuntime = fs.readFileSync(path.join(projectDir, 'src', 'main', 'shortcuts.ts'), 'utf8')
assert.match(shortcutRuntime, /registerToggle\(bindings\.shortcut, 'normal'/)
assert.match(shortcutRuntime, /registerToggle\(bindings\.metaShortcut, 'meta'/)
assert.match(shortcutRuntime, /bindings\.metaShortcut !== bindings\.shortcut/)
// A packaged build has no stdout, so hotkey registration must reach the log file.
assert.match(shortcutRuntime, /logInfo\('\[Shortcuts\] Global hotkey registered'/)
assert.equal(shortcutRuntime.includes('console.'), false, 'shortcut diagnostics still go to stdout only')

const sharedTypes = fs.readFileSync(path.join(projectDir, 'src', 'shared', 'types.ts'), 'utf8')
assert.match(sharedTypes, /metaShortcut: 'Ctrl\+Shift\+Alt\+Space'/)
assert.match(sharedTypes, /shortcut: 'Ctrl\+Shift\+Space'/)

const whisperRuntime = fs.readFileSync(path.join(projectDir, 'src', 'main', 'whisper.ts'), 'utf8')
assert.match(whisperRuntime, /restartSttServer/)
assert.match(whisperRuntime, /RECOVERY_TRANSCRIPTION_TIMEOUT_MS/)
// Streamed capture: the engine echo is the only deterministic terminator once a
// segment final has already been sent, and every segment has to be kept.
assert.match(whisperRuntime, /export function beginLiveCapture/)
assert.match(whisperRuntime, /export async function finishLiveCapture/)
assert.match(whisperRuntime, /JSON\.stringify\(\{ engine: 'mlx' \}\)/)
assert.match(whisperRuntime, /capture\.finals\.join\(' '\)/)
assert.match(whisperRuntime, /falling back to buffered upload/)

const visualizerRuntime = fs.readFileSync(
  path.join(projectDir, 'src', 'renderer', 'components', 'visualizer', 'AudioVisualizer.tsx'),
  'utf8',
)
assert.match(visualizerRuntime, /useAppStore\.getState\(\)/)
assert.match(visualizerRuntime, /requestAnimationFrame\(draw\)/)
assert.match(visualizerRuntime, /devicePixelRatio/)

const settingsRuntime = fs.readFileSync(path.join(projectDir, 'src', 'renderer', 'components', 'settings', 'SettingsPanel.tsx'), 'utf8')
assert.match(settingsRuntime, /NCO 연결 사용/)
assert.match(settingsRuntime, /NCO 프로바이더/)
assert.match(settingsRuntime, /ncoProvider/)
assert.match(settingsRuntime, /NCO Core/)
assert.match(settingsRuntime, /NCO 다시 연결/)
assert.match(settingsRuntime, /메타 프롬프트 단축키/)
assert.match(settingsRuntime, /AUTO SELECTION RANKING/)

console.log(JSON.stringify({
  passed: true,
  normalization: normalized,
  cliClear: '/clear',
  cliCompact: '/compact',
  catalogCommands: commandCatalog.length,
  commandRouting: ['/nco-task', '/nco-discussion', '/nco-company', '/click'],
  removedSurfaces: ['TTS IPC', 'PTY IPC', 'AI process IPC', 'node-pty'],
  metaPromptContract: 'internal request reconstruction followed by a validated final AI answer; slash routes stay explicit',
}, null, 2))
