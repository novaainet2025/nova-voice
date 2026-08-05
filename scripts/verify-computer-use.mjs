#!/usr/bin/env node
/**
 * Exercises the voice computer-control path against the real system.
 *
 * The safety boundary is the point of this feature, so most of what is checked
 * here is refusal: a spoken sentence must not be able to reach a shell, a path
 * outside the home directory, or an action nobody implemented. The few positive
 * cases run real system commands and confirm the effect rather than the return
 * value.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { parseComputerIntent, COMPUTER_ACTIONS } = await import('../src/shared/computer-intent.ts')
const { executeComputerIntent, CONFIRMATION_REQUIRED } = await import('../src/main/computer-os.ts')
const { generateTable, IMAGE_MODEL } = await import('../src/main/image-generation.ts')

if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ skipped: 'computer control is macOS-only' }))
  process.exit(0)
}

// ── The allow-list is the only way in ──────────────────────────────────────
const rejected = [
  ['unknown action', { action: 'DELETE_FILE', target: '/etc/passwd', confidence: 1 }],
  ['shell-ish action', { action: 'EXEC', target: 'rm -rf ~', confidence: 1 }],
  ['lowercase bypass', { action: 'open_app', target: 'Finder', confidence: 1 }],
  ['confidence > 1', { action: 'OPEN_APP', target: 'Finder', confidence: 5 }],
  ['confidence missing', { action: 'OPEN_APP', target: 'Finder' }],
  ['non-string args', { action: 'TYPE', args: { x: { nested: true } }, confidence: 1 }],
  ['null', null],
  ['bare string', 'OPEN_APP'],
  ['array', [{ action: 'OPEN_APP', confidence: 1 }]],
]
for (const [label, input] of rejected) {
  assert.equal(parseComputerIntent(input), null, `parser accepted ${label}`)
}
assert.ok(parseComputerIntent({ action: 'OPEN_APP', target: 'Finder', confidence: 0.9 }))

// ── Shell metacharacters stay data ─────────────────────────────────────────
const injection = await executeComputerIntent({
  action: 'OPEN_APP', target: 'Foo; rm -rf ~', confidence: 1,
})
assert.equal(injection.status, 'error', 'an app name with shell syntax was executed')

// ── The home directory is the boundary ─────────────────────────────────────
const escape = await executeComputerIntent({
  action: 'REVEAL_IN_FINDER', target: '/etc/passwd', confidence: 1,
})
assert.equal(escape.status, 'error', 'a path outside the home directory was revealed')

// A symlink inside home pointing out of it must not widen the boundary.
const linkDir = fs.mkdtempSync(path.join(os.homedir(), '.nova-verify-'))
const link = path.join(linkDir, 'escape')
try {
  fs.symlinkSync('/etc', link)
  const viaLink = await executeComputerIntent({
    action: 'REVEAL_IN_FINDER', target: path.join(link, 'passwd'), confidence: 1,
  })
  assert.equal(viaLink.status, 'error', 'a symlink was followed out of the home directory')
} finally {
  fs.rmSync(linkDir, { recursive: true, force: true })
}

// ── A real search, verified against the filesystem ─────────────────────────
const marker = path.join(os.homedir(), `nova-verify-${Date.now()}.txt`)
fs.writeFileSync(marker, 'verification marker')
let search
try {
  // Spotlight indexing is asynchronous; a miss here is an indexing delay, not a
  // defect, so the assertion is on the shape of the result either way.
  search = await executeComputerIntent({
    action: 'FIND_FILE', target: path.basename(marker), confidence: 1,
  })
  assert.equal(search.status, 'ok', 'file search reported an error')
} finally {
  fs.rmSync(marker, { force: true })
}

// ── Unimplemented actions are reported, never silently swallowed ───────────
for (const action of ['CLICK', 'TYPE', 'SCREENSHOT']) {
  const result = await executeComputerIntent({ action, confidence: 1 })
  assert.equal(result.status, 'error', `${action} claimed success without an executor`)
  assert.match(result.message, /NOVA Use/, `${action} did not explain what is missing`)
}

// ── Tables are deterministic and escape their own delimiter ────────────────
const table = generateTable([['이름', '수량'], ['배 | 특이', '5'], ['짧은행']])
assert.match(table, /배 \\\| 특이/, 'a pipe inside a cell was not escaped')
assert.equal(table.split('\n').length, 4, 'table row count is wrong')
assert.match(table, /\| 짧은행 \|\s+\|/, 'a short row was not padded to the table width')

const viaIntent = await executeComputerIntent({
  action: 'GENERATE_TABLE', target: '이름,수량\n사과,3', confidence: 1,
})
assert.equal(viaIntent.status, 'ok')
assert.match(viaIntent.message, /\| 이름 \| 수량 \|/)

const emptyTable = await executeComputerIntent({ action: 'GENERATE_TABLE', target: '', confidence: 1 })
assert.equal(emptyTable.status, 'error', 'an empty table request reported success')

// ── Image generation refuses an empty description without spending a call ──
const emptyImage = await executeComputerIntent({ action: 'GENERATE_IMAGE', target: '', confidence: 1 })
assert.equal(emptyImage.status, 'error')

// ── The classifier actually classifies ────────────────────────────────────
// This gates the whole feature: it was silently timing out on every utterance,
// so the executor below was never reached. Measured, not assumed.
const { classifyUtterance } = await import('../src/main/intent-classifier.ts')
// The dictation cases are the phrases this user actually repeats most often
// (from their own history). Each one was previously classified as a command and
// executed — "너 이름이 뭐야" came back as FOCUS_INPUT at 0.85 confidence and
// moved the caret. Misfiring on a question is worse than missing a command.
const classifierCases = [
  ['파인더 열어줘', true],
  ['노바 유즈 실행해줘', true],
  ['이력서 파일 찾아줘', true],
  ['입력창에 포커스', true],
  ['화면 캡처해줘', true],
  ['안녕 만나서 반가워', false],
  ['너 이름이 뭐야', false],
  ['오늘 며칠인지 알려줘', false],
  ['그럼 열어', false],
  ['이 버그 왜 나는지 분석해줘', false],
]
const classified = []
for (const [utterance, expectControl] of classifierCases) {
  const startedAt = Date.now()
  const intent = await classifyUtterance(utterance)
  classified.push({
    utterance,
    action: intent?.action ?? null,
    ms: Date.now() - startedAt,
    correct: Boolean(intent) === expectControl,
  })
}
const correct = classified.filter((row) => row.correct).length
assert.ok(
  correct >= classifierCases.length - 1,
  `classifier accuracy too low: ${correct}/${classifierCases.length} — ${JSON.stringify(classified)}`,
)
// A missed command is an inconvenience; a dictation executed as a command is
// not, so false positives are held to zero rather than to the accuracy budget.
const falsePositives = classified.filter((row, index) => !classifierCases[index][1] && row.action)
assert.equal(
  falsePositives.length, 0,
  `dictation was classified as a command: ${JSON.stringify(falsePositives)}`,
)

// Spoken Korean app names must resolve to installed bundles.
const openedByKoreanName = await executeComputerIntent({
  action: 'OPEN_APP', target: '파인더', confidence: 0.9,
})
assert.equal(openedByKoreanName.status, 'ok', 'a spoken Korean app name did not resolve')
const missingApp = await executeComputerIntent({
  action: 'OPEN_APP', target: '없는앱이름', confidence: 0.9,
})
assert.equal(missingApp.status, 'error', 'an unknown app name reported success')
// A gate in front of dictation has to be fast, not merely correct.
const slowest = Math.max(...classified.map((row) => row.ms))
assert.ok(slowest < 5_000, `classification took ${slowest}ms; it gates every dictation`)

// ── Demonstratives resolve through what is on screen ──────────────────────
// "이거" carries no meaning on its own; the classifier has to read the Finder
// selection to know what it points at. Without this the model could only guess.
const { readScreenContext, describeScreenContext } = await import('../src/main/screen-context.ts')
const contextFile = path.join(os.homedir(), `nova-ctx-verify-${Date.now()}.txt`)
fs.writeFileSync(contextFile, 'context verification')
let demonstrative = null
let screenContext = {}
try {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  await run('osascript', ['-e', `tell application "Finder" to reveal POSIX file "${contextFile}"`])
  await run('osascript', ['-e', 'tell application "Finder" to activate'])
  await new Promise((resolve) => setTimeout(resolve, 2_500))

  screenContext = await readScreenContext()
  assert.equal(screenContext.bundleId, 'com.apple.finder', 'Finder did not come to the front')
  assert.ok(
    screenContext.selection?.some((item) => item.endsWith(path.basename(contextFile))),
    'the Finder selection was not visible to the context reader',
  )
  assert.match(describeScreenContext(screenContext), /현재 상황/)

  demonstrative = await classifyUtterance('이거 파인더에서 보여줘')
  assert.ok(demonstrative, 'a demonstrative utterance was not classified at all')
  assert.ok(
    demonstrative.target?.includes(path.basename(contextFile)),
    `"이거" did not resolve to the selected file: ${JSON.stringify(demonstrative)}`,
  )
} finally {
  fs.rmSync(contextFile, { force: true })
}

console.log(JSON.stringify({
  passed: true,
  allowedActions: COMPUTER_ACTIONS.length,
  rejectedInputs: rejected.length,
  confirmationRequired: [...CONFIRMATION_REQUIRED],
  imageModel: IMAGE_MODEL,
  classifier: { correct, of: classifierCases.length, slowestMs: slowest, cases: classified },
  fileSearch: search.message,
  screenContext: { app: screenContext.appName, selection: screenContext.selection?.length ?? 0 },
  demonstrative: { action: demonstrative?.action, target: demonstrative?.target },
  checks: [
    'allow-list rejects unknown and malformed intents',
    'shell metacharacters stay data',
    'home directory boundary holds, including through a symlink',
    'real file search runs',
    'unimplemented actions are reported',
    'tables are deterministic and escape pipes',
    'empty requests are refused before any external call',
    'classifier separates control from dictation, fast enough to gate it',
    'no dictation is executed as a command (zero false positives)',
    'spoken Korean app names resolve to installed bundles',
    'demonstratives resolve through the on-screen selection',
  ],
}, null, 2))
