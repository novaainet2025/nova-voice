#!/usr/bin/env node
/**
 * Exercises pattern learning against a real SQLite database.
 *
 * The learning modules are bundled with `electron` stubbed so the production
 * schema, queries and thresholds run unchanged — only the userData path is
 * redirected to a scratch directory, and the real user's history is never
 * touched.
 *
 * Run through Electron (`npm run verify:learning`): better-sqlite3 is a native
 * module built against Electron's ABI, so plain Node cannot load it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-learn-'))
// The bundle keeps better-sqlite3 external, so it must sit inside the project
// for Node to resolve the native module from node_modules.
const bundleDir = fs.mkdtempSync(path.join(projectDir, '.verify-learn-'))
const bundlePath = path.join(bundleDir, 'learning.mjs')

const stubElectron = {
  name: 'stub-electron',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const app = { getPath: () => process.env.NOVA_TEST_USERDATA }`,
      loader: 'js',
    }))
  },
}

// One entry point re-exporting both modules keeps them sharing a single
// database handle, exactly as they do in the main process.
const entry = path.join(bundleDir, 'entry.ts')
fs.writeFileSync(entry, `
  export { initDB, getPatternStats, saveTranscription, getHistory } from '${projectDir}/src/main/db.ts'
  export {
    observeDictation, getLearnedAliases, findLearnedCommand,
    getAppUsageHint, normalizePhrase, ALIAS_CONFIDENCE_THRESHOLD,
  } from '${projectDir}/src/main/pattern-learning.ts'
`)

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundlePath,
  plugins: [stubElectron],
  external: ['better-sqlite3'],
  logLevel: 'silent',
})

process.env.NOVA_TEST_USERDATA = workDir
const mod = await import(`file://${bundlePath}`)
mod.initDB()

const TERMINAL = 'com.apple.Terminal'
const EDITOR = 'com.sublimetext.4'

// 1. Normalisation absorbs the spacing drift Korean STT produces between takes.
assert.equal(
  mod.normalizePhrase('엔씨오 토론 진행해'),
  mod.normalizePhrase('엔씨오토론 진행해.'),
  'spacing/punctuation drift must not split one phrase into two',
)

// 2. A phrase is only an alias once it has repeated enough times.
const PHRASE = '엔씨오 토론 진행해'
for (let i = 0; i < mod.ALIAS_CONFIDENCE_THRESHOLD - 1; i++) {
  mod.observeDictation({
    spokenText: PHRASE, phrase: mod.normalizePhrase(PHRASE),
    command: '/nco-discussion', bundleId: TERMINAL,
  })
}
assert.equal(mod.findLearnedCommand(PHRASE), null, 'alias fired below the confidence threshold')

mod.observeDictation({
  spokenText: PHRASE, phrase: mod.normalizePhrase(PHRASE),
  command: '/nco-discussion', bundleId: TERMINAL,
})
const learned = mod.findLearnedCommand(PHRASE)
assert.ok(learned, 'alias never became confident')
assert.equal(learned.command, '/nco-discussion')
assert.equal(learned.hits, mod.ALIAS_CONFIDENCE_THRESHOLD)

// 3. A learned phrase followed by extra words is the same request with an
//    argument, so it must still resolve.
const withArgs = mod.findLearnedCommand(`${PHRASE} REST와 GraphQL 비교`)
assert.ok(withArgs, 'a learned phrase with trailing arguments stopped matching')
assert.equal(withArgs.command, '/nco-discussion')

// 4. An ambiguous phrase must never be acted on: routing half the attempts to
//    the wrong command is worse than not learning at all.
const AMBIGUOUS = '상태 확인해줘'
for (let i = 0; i < 5; i++) {
  mod.observeDictation({
    spokenText: AMBIGUOUS, phrase: mod.normalizePhrase(AMBIGUOUS),
    command: i % 2 ? '/nco-status' : '/status', bundleId: TERMINAL,
  })
}
assert.equal(mod.findLearnedCommand(AMBIGUOUS), null, 'an ambiguous phrase became an alias')

// 5. Habits are scoped per application.
for (let i = 0; i < 3; i++) {
  mod.observeDictation({
    spokenText: '오탈자 고쳐줘', phrase: mod.normalizePhrase('오탈자 고쳐줘'), bundleId: EDITOR,
  })
}
const terminalHint = mod.getAppUsageHint(TERMINAL)
const editorHint = mod.getAppUsageHint(EDITOR)
assert.ok(terminalHint?.commands.includes('/nco-discussion'), 'terminal habit not learned')
assert.ok(
  !editorHint?.commands.includes('/nco-discussion'),
  'a habit leaked across applications',
)
assert.ok(
  editorHint?.phrases.some((p) => p.includes('오탈자')),
  'editor phrase habit not learned',
)
assert.equal(mod.getAppUsageHint(undefined), null)
assert.equal(mod.getAppUsageHint('com.unknown.app'), null)

// 6. Too-short phrases are not learned — they would match almost anything.
mod.observeDictation({ spokenText: '응', phrase: mod.normalizePhrase('응'), command: '/yes' })
assert.equal(mod.findLearnedCommand('응'), null, 'a trivially short phrase became an alias')

// 7. The context columns actually persist and come back.
mod.saveTranscription({
  id: 'test-1', text: '/nco-discussion 주제', language: 'ko', duration: 1,
  timestamp: Date.now(), modelUsed: 'test', inputMode: 'normal',
  targetApp: 'Terminal', targetBundleId: TERMINAL,
  cliTarget: true, isSlashCommand: true, injected: true,
})
const [row] = mod.getHistory(1)
assert.equal(row.targetApp, 'Terminal')
assert.equal(row.targetBundleId, TERMINAL)
assert.equal(Boolean(row.cliTarget), true)
assert.equal(Boolean(row.isSlashCommand), true)
assert.equal(Boolean(row.injected), true)

const aliases = mod.getLearnedAliases()
fs.rmSync(workDir, { recursive: true, force: true })
fs.rmSync(bundleDir, { recursive: true, force: true })
console.log('NOVA_VERIFY_RESULT ' + JSON.stringify({
  passed: true,
  confidenceThreshold: mod.ALIAS_CONFIDENCE_THRESHOLD,
  learnedAliases: aliases,
  checks: [
    'spacing drift normalised',
    'threshold enforced',
    'trailing arguments preserved',
    'ambiguous phrase rejected',
    'habits scoped per application',
    'trivial phrase rejected',
    'context columns persist',
  ],
}))
// Electron keeps its event loop alive; this script is a one-shot check.
process.exit(0)
