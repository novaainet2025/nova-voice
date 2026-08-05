/**
 * Picks the NCO provider that is most likely to answer a meta prompt quickly.
 *
 * NCO Core reports three independent health dimensions (`/health`) plus a static
 * catalog (`/api/ai-providers`). Neither is a ranking, so this module combines
 * them with what NOVA VOICE itself has measured — observed latency and success
 * rate of previous meta prompts — and produces an ordered shortlist. The
 * shortlist matters as much as the winner: a submit that fails can move to the
 * next provider immediately instead of waiting out a cooldown.
 *
 * The scoring itself lives in {@link ./nco-provider-ranking} so it can be run
 * against captured NCO payloads without Electron.
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { asRecord, ncoRequestJson, safeErrorMessage } from './nco-core-client'
import type { JsonRecord } from './nco-core-client'
import { buildProviderFacts, scoreProviders } from './nco-provider-ranking'
import type { ProviderFacts, ProviderStat } from './nco-provider-ranking'
import { logInfo, logWarn } from './logger'
import type { NcoProviderRanking } from '../shared/types'

const SNAPSHOT_TTL_MS = 5_000
const SNAPSHOT_TIMEOUT_MS = 2_500
const STATS_ALPHA = 0.3

interface ProviderSnapshot {
  fetchedAt: number
  facts: ProviderFacts[]
  error?: string
}

export interface AutoProviderDecision {
  provider: string
  ranked: string[]
  reason: string
  ranking: NcoProviderRanking[]
}

let snapshot: ProviderSnapshot | null = null
let snapshotInFlight: Promise<ProviderSnapshot> | null = null
let stats: Record<string, ProviderStat> | null = null
let statsPath: string | null = null

function getStatsPath(): string {
  if (!statsPath) statsPath = path.join(app.getPath('userData'), 'nova-provider-stats.json')
  return statsPath
}

function loadStats(): Record<string, ProviderStat> {
  if (stats) return stats
  try {
    const raw = asRecord(JSON.parse(fs.readFileSync(getStatsPath(), 'utf8')) as unknown)
    const loaded: Record<string, ProviderStat> = {}
    for (const [id, value] of Object.entries(raw)) {
      const entry = asRecord(value)
      const avgMs = Number(entry.avgMs)
      const runs = Number(entry.runs)
      const ok = Number(entry.ok)
      if (!Number.isFinite(avgMs) || !Number.isFinite(runs) || !Number.isFinite(ok)) continue
      loaded[id] = {
        avgMs: Math.max(0, avgMs),
        runs: Math.max(0, Math.round(runs)),
        ok: Math.max(0, Math.round(ok)),
        lastFailureAt: Number.isFinite(Number(entry.lastFailureAt)) ? Number(entry.lastFailureAt) : 0,
        ...(typeof entry.lastFailure === 'string' ? { lastFailure: entry.lastFailure } : {}),
      }
    }
    stats = loaded
  } catch {
    stats = {}
  }
  return stats
}

function saveStats(): void {
  try {
    fs.writeFileSync(getStatsPath(), JSON.stringify(loadStats(), null, 2), 'utf8')
  } catch (error) {
    logWarn('[ProviderSelect] Failed to persist provider stats', { error: safeErrorMessage(error) })
  }
}

/** Records how a real meta-prompt attempt went so the next pick can use it. */
export function recordProviderOutcome(
  providerId: string,
  outcome: { ok: boolean; elapsedMs: number; failure?: string },
): void {
  if (!providerId || providerId === 'auto') return
  const table = loadStats()
  const previous = table[providerId]
  const elapsedMs = Math.max(0, Math.round(outcome.elapsedMs))
  table[providerId] = {
    // Only successful runs describe how fast a provider answers. A failure that
    // returns in 200ms must not make a provider look like the fastest one.
    avgMs: outcome.ok
      ? previous?.avgMs
        ? Math.round(previous.avgMs * (1 - STATS_ALPHA) + elapsedMs * STATS_ALPHA)
        : elapsedMs
      : previous?.avgMs ?? 0,
    runs: (previous?.runs ?? 0) + 1,
    ok: (previous?.ok ?? 0) + (outcome.ok ? 1 : 0),
    lastFailureAt: outcome.ok ? 0 : Date.now(),
    ...(outcome.ok ? {} : { lastFailure: (outcome.failure || 'unknown failure').slice(0, 240) }),
  }
  saveStats()
}

async function fetchSnapshot(): Promise<ProviderSnapshot> {
  const [health, catalog] = await Promise.all([
    ncoRequestJson('/health', {}, SNAPSHOT_TIMEOUT_MS)
      .catch((error) => ({ snapshotError: safeErrorMessage(error) }) as JsonRecord),
    ncoRequestJson('/api/ai-providers', {}, SNAPSHOT_TIMEOUT_MS)
      .catch((error) => ({ snapshotError: safeErrorMessage(error) }) as JsonRecord),
  ])
  const errors = [health.snapshotError, catalog.snapshotError]
    .filter((value): value is string => typeof value === 'string')
  return {
    fetchedAt: Date.now(),
    facts: buildProviderFacts(health, catalog),
    ...(errors.length ? { error: errors.join(' · ') } : {}),
  }
}

async function getSnapshot(): Promise<ProviderSnapshot> {
  if (snapshot && Date.now() - snapshot.fetchedAt < SNAPSHOT_TTL_MS) return snapshot
  if (snapshotInFlight) return snapshotInFlight
  snapshotInFlight = fetchSnapshot()
    .then((fresh) => {
      snapshot = fresh
      return fresh
    })
    .catch((error) => {
      const failed: ProviderSnapshot = {
        fetchedAt: Date.now(),
        facts: snapshot?.facts ?? [],
        error: safeErrorMessage(error),
      }
      snapshot = failed
      return failed
    })
    .finally(() => {
      snapshotInFlight = null
    })
  return snapshotInFlight
}

/** Drops the cached snapshot so the next pick re-reads NCO Core. */
export function invalidateProviderSnapshot(): void {
  snapshot = null
}

/**
 * The cheapest model a provider offers, or undefined when it publishes none.
 * Returning undefined leaves NCO free to apply the provider's own default.
 */
export async function getLightModel(providerId: string): Promise<string | undefined> {
  const current = await getSnapshot()
  return current.facts.find((entry) => entry.id === providerId)?.lightModel
}

export async function rankProviders(): Promise<{ ranking: NcoProviderRanking[]; error?: string }> {
  const current = await getSnapshot()
  return {
    ranking: scoreProviders(current.facts, loadStats(), Date.now()),
    ...(current.error ? { error: current.error } : {}),
  }
}

/**
 * Resolves `ncoProvider: 'auto'` to a concrete provider plus an ordered
 * fallback list. Falls back to the supplied default when NCO Core cannot be
 * read at all, so meta mode never becomes unusable because of a health blip.
 */
export async function resolveAutoProvider(fallback = 'codex'): Promise<AutoProviderDecision> {
  const { ranking, error } = await rankProviders()
  const eligible = ranking.filter((item) => item.eligible)
  if (!eligible.length) {
    return {
      provider: fallback,
      ranked: [fallback],
      reason: error
        ? `NCO 상태를 읽지 못해 기본값 ${fallback} 사용 · ${error}`
        : `사용 가능한 프로바이더가 없어 기본값 ${fallback} 사용`,
      ranking,
    }
  }
  const ranked = eligible.map((item) => item.id)
  const winner = eligible[0]
  logInfo('[ProviderSelect] Auto provider resolved', {
    provider: winner.id,
    score: winner.score,
    ranked: ranked.slice(0, 4),
  })
  return {
    provider: winner.id,
    ranked,
    reason: `${winner.name} · ${winner.reason}`,
    ranking,
  }
}
