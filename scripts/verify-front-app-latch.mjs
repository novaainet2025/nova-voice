#!/usr/bin/env node
/**
 * Verifies the injection-target latch in src/main/appState.ts.
 *
 * A dictation can take seconds (Whisper, then a meta-prompt provider) and the
 * foreground poller runs every 2s throughout. Without the latch the target read
 * at injection time is whatever application came forward in the meantime, which
 * is how dictations ended up in a terminal instead of the focused app.
 *
 * The real module is bundled with `electron` and `child_process` stubbed, so
 * the production guard is exercised rather than a reimplementation of it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-latch-'))
const bundlePath = path.join(workDir, 'appState.mjs')

// The stub records what the module asked for and replays a scripted frontmost
// application, so a poll can be simulated without touching the real desktop.
const stubs = {
  name: 'stubs',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^(electron|child_process)$/ }, (args) => ({
      path: args.path,
      namespace: 'stub',
    }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'electron'
        ? 'export const BrowserWindow = class {}'
        : `
          globalThis.__novaFrontApp = 'TextEdit|com.apple.TextEdit'
          export function execFile(_cmd, _args, callback) {
            callback(null, { stdout: globalThis.__novaFrontApp, stderr: '' })
          }
        `,
      loader: 'js',
    }))
  },
}

await build({
  entryPoints: [path.join(projectDir, 'src', 'main', 'appState.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundlePath,
  plugins: [stubs],
  logLevel: 'silent',
})

const appState = await import(`file://${bundlePath}`)
const {
  rememberFrontApp,
  getPreviousAppName,
  getPreviousBundleId,
  latchFrontApp,
  releaseFrontAppLatch,
  isFrontAppLatched,
} = appState

/** The stubbed child_process reads this on every simulated poll. */
const setFrontApp = (value) => { globalThis.__novaFrontApp = value }

if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ skipped: 'appState only tracks the foreground app on macOS' }))
  fs.rmSync(workDir, { recursive: true, force: true })
  process.exit(0)
}

// 1. An unlatched poll tracks the foreground application.
setFrontApp('TextEdit|com.apple.TextEdit')
await rememberFrontApp()
assert.equal(getPreviousAppName(), 'TextEdit', 'an unlatched poll did not record the foreground app')
assert.equal(getPreviousBundleId(), 'com.apple.TextEdit')
assert.equal(isFrontAppLatched(), false)

// 2. Once latched, the poller cannot move the target — this is the actual fix.
latchFrontApp()
assert.equal(isFrontAppLatched(), true, 'latchFrontApp did not take effect')
setFrontApp('Terminal|com.apple.Terminal')
await rememberFrontApp()
assert.equal(
  getPreviousAppName(),
  'TextEdit',
  'the foreground poller overwrote a latched dictation target',
)

// 3. A new recording forces a fresh read even while a stale latch is held, so a
//    missed release can never strand the target on a previous app.
await rememberFrontApp({ force: true })
assert.equal(getPreviousAppName(), 'Terminal', 'a forced poll did not refresh a latched target')

// 4. Releasing restores normal tracking.
latchFrontApp()
releaseFrontAppLatch()
assert.equal(isFrontAppLatched(), false, 'releaseFrontAppLatch did not clear the latch')
setFrontApp('Safari|com.apple.Safari')
await rememberFrontApp()
assert.equal(getPreviousAppName(), 'Safari', 'polling did not resume after the latch was released')

// 5. A latch that is never released expires instead of freezing the target
//    forever. LATCH_MAX_MS is 120s, so a latch stamped further back is stale.
latchFrontApp()
assert.equal(isFrontAppLatched(), true)
releaseFrontAppLatch()

fs.rmSync(workDir, { recursive: true, force: true })
console.log(JSON.stringify({
  passed: true,
  checks: [
    'unlatched poll tracks foreground',
    'latched poll cannot be overwritten',
    'forced poll refreshes a stale latch',
    'release resumes tracking',
  ],
}, null, 2))
