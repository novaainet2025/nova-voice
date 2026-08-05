#!/usr/bin/env node
/**
 * Exercises the NCO provider auto-selection ranking against the live NCO Core.
 *
 * The ranking module is Electron-free on purpose, so this runs the real
 * scoring code against the real `/health` + `/api/ai-providers` payloads and
 * asserts the guarantees that matter: a quota-gated provider is never picked,
 * measured latency beats catalog prestige, and a provider that just failed
 * locally is skipped.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NCO_BASE = 'http://127.0.0.1:6200'

const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-rank-')), 'ranking.mjs')
await build({
  entryPoints: [path.join(projectDir, 'src', 'main', 'nco-provider-ranking.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: bundlePath,
  logLevel: 'silent',
})
const { buildProviderFacts, scoreProviders } = await import(`file://${bundlePath}`)

async function fetchJson(route) {
  const response = await fetch(`${NCO_BASE}${route}`, { signal: AbortSignal.timeout(4_000) })
  assert.ok(response.ok, `${route} returned ${response.status}`)
  return response.json()
}

const [health, catalog] = await Promise.all([
  fetchJson('/health'),
  fetchJson('/api/ai-providers'),
])

const facts = buildProviderFacts(health, catalog)
assert.ok(facts.length > 0, 'no providers were parsed out of the NCO catalog')

const now = Date.now()
const gatedIds = new Set(
  (health.providerHealthDimensions?.admission?.unavailable ?? [])
    .filter((item) => !item.cooldownUntil || Date.parse(item.cooldownUntil) > now)
    .map((item) => item.id),
)

// 1. Live gating is respected: nothing NCO reports as blocked may be eligible.
const baseline = scoreProviders(facts, {}, now)
for (const entry of baseline) {
  if (gatedIds.has(entry.id)) {
    assert.equal(entry.eligible, false, `gated provider ${entry.id} was still marked eligible`)
  }
}
const eligible = baseline.filter((entry) => entry.eligible)
assert.ok(eligible.length > 0, 'every provider was ruled out; the ranking would always fall back')
assert.equal(baseline[0].id, eligible[0].id, 'an ineligible provider outranked an eligible one')

// 2. Measured latency decides between otherwise identical providers. Cloning
//    one real provider's health facts isolates the latency term from whatever
//    queue/heartbeat state NCO happens to be in during this run.
const template = facts.find((entry) => entry.id === eligible[0].id)
const twins = [
  { ...template, id: 'twin-slow', name: 'Twin Slow' },
  { ...template, id: 'twin-fast', name: 'Twin Fast' },
]
const twinRanking = scoreProviders(twins, {
  'twin-slow': { avgMs: 40_000, runs: 6, ok: 6, lastFailureAt: 0 },
  'twin-fast': { avgMs: 1_200, runs: 6, ok: 6, lastFailureAt: 0 },
}, now)
assert.equal(twinRanking[0].id, 'twin-fast', 'a 33x faster provider did not outrank an identical slow one')

// 2b. Measured speed also has to beat raw catalog prestige, otherwise auto mode
//     would keep choosing the highest-scored provider no matter how slow it is.
const prestigious = { ...template, id: 'prestige', name: 'Prestige', catalogScore: 100 }
const quick = { ...template, id: 'quick', name: 'Quick', catalogScore: 60 }
const prestigeRanking = scoreProviders([prestigious, quick], {
  prestige: { avgMs: 40_000, runs: 6, ok: 6, lastFailureAt: 0 },
  quick: { avgMs: 1_200, runs: 6, ok: 6, lastFailureAt: 0 },
}, now)
assert.equal(prestigeRanking[0].id, 'quick', 'catalog prestige still outranks a 33x faster provider')

// 2c. A provider that keeps failing loses to a slower but reliable one.
const flakyRanking = scoreProviders([
  { ...template, id: 'flaky', name: 'Flaky' },
  { ...template, id: 'steady', name: 'Steady' },
], {
  flaky: { avgMs: 1_000, runs: 10, ok: 3, lastFailureAt: now - 10 * 60_000 },
  steady: { avgMs: 2_000, runs: 10, ok: 10, lastFailureAt: 0 },
}, now)
assert.equal(flakyRanking[0].id, 'steady', 'a provider failing 70% of the time still ranked first')

// 3. A provider that just failed locally is skipped until its cooldown expires.
const afterFailure = scoreProviders(facts, {
  [eligible[0].id]: { avgMs: 900, runs: 4, ok: 3, lastFailureAt: now - 1_000, lastFailure: 'quota' },
}, now)
assert.equal(
  afterFailure.find((entry) => entry.id === eligible[0].id).eligible,
  false,
  'a provider that failed one second ago is still eligible',
)
const recovered = scoreProviders(facts, {
  [eligible[0].id]: { avgMs: 900, runs: 4, ok: 3, lastFailureAt: now - 120_000, lastFailure: 'quota' },
}, now)
assert.equal(
  recovered.find((entry) => entry.id === eligible[0].id).eligible,
  true,
  'a provider never recovers after its local cooldown expires',
)

// 4. Every provider carries a human-readable reason for the settings screen.
for (const entry of baseline) {
  assert.ok(entry.reason.trim().length > 0, `provider ${entry.id} has no explanation`)
}

fs.rmSync(path.dirname(bundlePath), { recursive: true, force: true })
console.log(JSON.stringify({
  passed: true,
  ncoStatus: health.status,
  parsedProviders: facts.length,
  gated: [...gatedIds],
  autoSelected: eligible[0].id,
  ranking: baseline.map((entry) => ({
    id: entry.id,
    score: entry.score,
    eligible: entry.eligible,
    reason: entry.reason,
  })),
}, null, 2))
