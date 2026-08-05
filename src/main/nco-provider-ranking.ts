/**
 * Pure ranking logic for NCO provider auto-selection.
 *
 * Deliberately free of Electron, fs and network access so it can be exercised
 * directly against a captured `/health` + `/api/ai-providers` pair.
 */
import { asRecord, asStringArray } from './nco-core-client.ts'
import type { JsonRecord } from './nco-core-client.ts'
import type { NcoProviderRanking } from '../shared/types.ts'

export const LOCAL_FAILURE_COOLDOWN_MS = 90_000
/** Providers with no measurement yet still get tried, otherwise the first one
 *  measured would keep winning and the rest could never prove themselves. */
export const EXPLORATION_BONUS = 20
/**
 * Weight of measured speed. Deliberately larger than the combined static
 * signals (catalog prestige, queue capacity, heartbeat) so that what a provider
 * actually did for this user outranks what the catalog claims about it.
 */
export const LATENCY_WEIGHT = 55
/** Extra penalty for unreliability, on top of its effect on expected time. */
export const RELIABILITY_WEIGHT = 25
/**
 * Cost of a saturated queue.
 *
 * Measured in production: claude-code was chosen first on every request while
 * its queue was reported saturated, because a catalogue score of 95 dwarfed the
 * old −18 penalty. Those requests then failed with `queue_wait_timeout: provider
 * claude-code busy for 10000ms` and fell through to the next provider, so the
 * user paid the full wait before any work started. Saturation is a direct
 * predictor of that failure, so it has to outweigh catalogue prestige.
 */
export const SATURATION_PENALTY = 120
/** Floor for the success rate so a fully failing provider stays comparable. */
const MIN_SUCCESS_RATE = 0.1

/**
 * Expected time to a *successful* answer. A provider that answers in a second
 * but fails two attempts out of three is slower in practice than a steady
 * two-second one, because every failure costs a full attempt before the ranking
 * can fall through to the next provider.
 */
function expectedSuccessMs(stat: ProviderStat | undefined): number {
  if (!stat?.avgMs) return 0
  const successRate = stat.runs > 0 ? Math.max(MIN_SUCCESS_RATE, stat.ok / stat.runs) : 1
  return stat.avgMs / successRate
}

export interface ProviderStat {
  avgMs: number
  runs: number
  ok: number
  lastFailureAt: number
  lastFailure?: string
}

export interface ProviderFacts {
  id: string
  name: string
  /**
   * Cheapest enabled model the provider offers.
   *
   * Meta mode rewrites one spoken sentence into a prompt. Left unspecified,
   * NCO applies each provider's default, which for claude-code is a frontier
   * model — far more capability, cost and latency than a sentence rewrite
   * needs.
   */
  lightModel?: string
  catalogScore: number
  general: boolean
  enabled: boolean
  registered: boolean
  heartbeatAlive: boolean
  queueFree: boolean
  queueSaturated: boolean
  gated: boolean
  gateReason: string
  cooldownUntil: number
}

function parseCooldown(value: unknown): number {
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Folds NCO Core's health dimensions and static catalog into one fact table. */
export function buildProviderFacts(health: JsonRecord, catalog: JsonRecord): ProviderFacts[] {
  const dimensions = asRecord(asRecord(health).providerHealthDimensions)
  const registered = new Set(asStringArray(asRecord(dimensions.registered).providers))
  const alive = new Set(asStringArray(asRecord(dimensions.heartbeatLiveness).providers))
  const queue = asRecord(dimensions.queueCapacity)
  const queueFree = new Set(asStringArray(queue.providers))
  const queueSaturated = new Set(asStringArray(queue.saturated))
  const admission = asRecord(dimensions.admission)

  const gates = new Map<string, { reason: string; cooldownUntil: number }>()
  if (Array.isArray(admission.unavailable)) {
    for (const item of admission.unavailable) {
      const record = asRecord(item)
      if (typeof record.id !== 'string') continue
      gates.set(record.id, {
        reason: typeof record.status === 'string'
          ? record.status
          : typeof record.reason === 'string' ? record.reason : 'unavailable',
        cooldownUntil: parseCooldown(record.cooldownUntil),
      })
    }
  }

  const providers = Array.isArray(asRecord(catalog).providers)
    ? (asRecord(catalog).providers as unknown[]).map(asRecord).filter((item) => typeof item.id === 'string')
    : []

  return providers.map((provider) => {
    const id = provider.id as string
    const routing = asRecord(provider.routing)
    const gate = gates.get(id)
    const models = Array.isArray(provider.models) ? provider.models.map(asRecord) : []
    const light = models.find((model) => model.workload === 'light' && model.enabled !== false)
    return {
      id,
      name: typeof provider.name === 'string' ? provider.name : id,
      ...(typeof light?.id === 'string' ? { lightModel: light.id } : {}),
      catalogScore: Number.isFinite(Number(provider.score)) ? Number(provider.score) : 50,
      general: asStringArray(routing.taskTypes).includes('general'),
      enabled: provider.enabled !== false,
      // An empty registry means the health route was unreadable, not that every
      // provider is missing.
      registered: registered.size === 0 || registered.has(id),
      heartbeatAlive: alive.has(id),
      queueFree: queueFree.has(id),
      queueSaturated: queueSaturated.has(id),
      gated: Boolean(gate),
      gateReason: gate?.reason ?? '',
      cooldownUntil: gate?.cooldownUntil ?? 0,
    }
  })
}

function describe(entry: ProviderFacts, stat: ProviderStat | undefined, eligible: boolean, now: number): string {
  if (!entry.enabled) return '카탈로그에서 비활성'
  if (!entry.registered) return 'NCO 런타임 미등록'
  if (entry.gated && (entry.cooldownUntil === 0 || entry.cooldownUntil > now)) {
    const remainingMs = entry.cooldownUntil - now
    const remaining = remainingMs > 0 ? ` · ${Math.ceil(remainingMs / 60_000)}분 남음` : ''
    return `${entry.gateReason || '차단됨'}${remaining}`
  }
  if (stat?.lastFailureAt && now - stat.lastFailureAt < LOCAL_FAILURE_COOLDOWN_MS) {
    return `최근 실패 후 대기 · ${stat.lastFailure || '원인 미상'}`
  }
  if (!eligible) return '사용 불가'
  const parts: string[] = [stat?.avgMs ? `평균 ${(stat.avgMs / 1000).toFixed(1)}초` : '측정 전']
  if (entry.queueSaturated) parts.push('큐 포화')
  else if (entry.queueFree) parts.push('큐 여유')
  if (entry.heartbeatAlive) parts.push('하트비트 정상')
  return parts.join(' · ')
}

/**
 * Scores every provider, highest first. Ineligible providers stay in the list
 * so the settings screen can explain *why* one is not being used.
 */
export function scoreProviders(
  facts: ProviderFacts[],
  stats: Record<string, ProviderStat>,
  now: number,
): NcoProviderRanking[] {
  const rows = facts.map((entry) => {
    const stat = stats[entry.id]
    const gatedNow = entry.gated && (entry.cooldownUntil === 0 || entry.cooldownUntil > now)
    const locallyCoolingDown = Boolean(stat?.lastFailureAt)
      && now - (stat?.lastFailureAt ?? 0) < LOCAL_FAILURE_COOLDOWN_MS
    return {
      entry,
      stat,
      eligible: entry.enabled && entry.registered && !gatedNow && !locallyCoolingDown,
    }
  })

  const measured = rows
    .map((row) => expectedSuccessMs(row.stat))
    .filter((value) => value > 0)
  const fastestMs = measured.length ? Math.min(...measured) : 0

  const ranking: NcoProviderRanking[] = rows.map(({ entry, stat, eligible }) => {
    let score = entry.catalogScore
    if (entry.general) score += 6
    if (entry.queueFree) score += 12
    if (entry.queueSaturated) score -= SATURATION_PENALTY
    if (entry.heartbeatAlive) score += 8

    const effectiveMs = expectedSuccessMs(stat)
    if (effectiveMs && fastestMs) {
      // The fastest observed provider keeps the whole bonus; one that takes
      // twice as long to produce a successful answer keeps half of it.
      score += LATENCY_WEIGHT * (fastestMs / effectiveMs)
    } else {
      score += EXPLORATION_BONUS
    }
    if (stat && stat.runs > 0) score -= RELIABILITY_WEIGHT * (1 - stat.ok / stat.runs)
    if (!eligible) score -= 1_000

    return {
      id: entry.id,
      name: entry.name,
      score: Math.round(score * 10) / 10,
      eligible,
      reason: describe(entry, stat, eligible, now),
      ...(stat?.avgMs ? { avgSeconds: Math.round(stat.avgMs / 100) / 10 } : {}),
      ...(stat && stat.runs > 0 ? { successRate: Math.round((stat.ok / stat.runs) * 100) / 100 } : {}),
    }
  })

  ranking.sort((left, right) => right.score - left.score)
  return ranking
}
