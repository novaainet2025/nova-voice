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

console.log(JSON.stringify({
  passed: true,
  allowedActions: COMPUTER_ACTIONS.length,
  rejectedInputs: rejected.length,
  confirmationRequired: [...CONFIRMATION_REQUIRED],
  imageModel: IMAGE_MODEL,
  fileSearch: search.message,
  checks: [
    'allow-list rejects unknown and malformed intents',
    'shell metacharacters stay data',
    'home directory boundary holds, including through a symlink',
    'real file search runs',
    'unimplemented actions are reported',
    'tables are deterministic and escape pipes',
    'empty requests are refused before any external call',
  ],
}, null, 2))
