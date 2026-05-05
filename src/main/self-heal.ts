/**
 * Nova Voice Self-Heal Module
 *
 * 3-tier self-healing architecture:
 *   Tier 1 — Runtime provider health table (cooldown / backoff)
 *   Tier 2 — Known error pattern registry with pre-coded fixes
 *   Tier 3 — Unknown errors → rate-limited Claude diagnostic (advisory only)
 */

// ──────────────────────────────────────────────────────────────
// Tier 1: Provider health state
// ──────────────────────────────────────────────────────────────

export interface ProviderHealth {
  healthy: boolean
  cooldownUntil: number   // epoch ms; 0 = not in cooldown
  failCount: number
  lastError: string
  lastSuccess: number     // epoch ms; 0 = never succeeded
}

const providerHealth = new Map<string, ProviderHealth>()

function getOrCreate(provider: string): ProviderHealth {
  if (!providerHealth.has(provider)) {
    providerHealth.set(provider, {
      healthy: true,
      cooldownUntil: 0,
      failCount: 0,
      lastError: '',
      lastSuccess: 0,
    })
  }
  return providerHealth.get(provider)!
}

/** Returns true if the provider should be attempted (not in cooldown). */
export function isProviderHealthy(provider: string): boolean {
  const h = getOrCreate(provider)
  if (h.cooldownUntil > 0 && Date.now() >= h.cooldownUntil) {
    // Cooldown expired — reset
    h.healthy = true
    h.cooldownUntil = 0
    h.failCount = 0
  }
  return h.healthy
}

/** Record a successful call — clears cooldown and resets fail count. */
export function recordProviderSuccess(provider: string): void {
  const h = getOrCreate(provider)
  h.healthy = true
  h.cooldownUntil = 0
  h.failCount = 0
  h.lastSuccess = Date.now()
}

/**
 * Record a failed call — applies Tier 2 known fix or exponential backoff.
 * Returns the cooldown duration in ms that was applied.
 */
export function recordProviderFailure(provider: string, error: string): number {
  const h = getOrCreate(provider)
  h.failCount++
  h.lastError = error.substring(0, 200)

  const fix = findKnownFix(error)
  const cooldownMs = fix ? fix.cooldownMs : defaultBackoff(h.failCount)

  h.healthy = false
  h.cooldownUntil = Date.now() + cooldownMs
  return cooldownMs
}

function defaultBackoff(failCount: number): number {
  // 5s, 10s, 20s, 40s … capped at 5 min
  return Math.min(5_000 * Math.pow(2, failCount - 1), 300_000)
}

// ──────────────────────────────────────────────────────────────
// Tier 2: Known error pattern registry
// ──────────────────────────────────────────────────────────────

interface KnownFix {
  pattern: RegExp
  cooldownMs: number
  description: string   // shown in debug panel
}

const KNOWN_FIXES: KnownFix[] = [
  {
    // Gemini/API 무료 티어 일일 한도 완전 소진 (limit: 0) — 자정에 리셋
    // "FreeTier", "PerDay", "per_day", "daily" + 무료 티어 지시어
    pattern: /FreeTier|free.tier|per.?day.*project|GenerateRequests.*Day/i,
    cooldownMs: 86_400_000,  // 24h — 자정 리셋까지 대기
    description: 'Gemini 무료 티어 일일 한도 소진 → 24시간 쿨다운 (유료 결제 필요)',
  },
  {
    // Daily/billing quota exhausted — 1시간 쿨다운 (유료 분당 한도 등)
    pattern: /quota.*exceeded|daily.*limit|per.?day.*limit|billing.*quota/i,
    cooldownMs: 3_600_000,   // 1 hour
    description: 'API 일일 할당량 초과 → 1시간 쿨다운',
  },
  {
    // RPM rate limit — Gemini free tier resets in ~60s
    pattern: /429|RESOURCE_EXHAUSTED|too many requests|rate.?limit/i,
    cooldownMs: 65_000,      // 65s (1분 + 여유)
    description: 'API 분당 요청 초과 (429) → 65초 쿨다운',
  },
  {
    pattern: /timeout|ETIMEDOUT|ECONNRESET|socket hang up/i,
    cooldownMs: 30_000,
    description: '네트워크 타임아웃 → 30초 쿨다운',
  },
  {
    pattern: /ECONNREFUSED|ENOTFOUND|network.*unreachable/i,
    cooldownMs: 60_000,
    description: '연결 거부/네트워크 없음 → 60초 쿨다운',
  },
  {
    pattern: /503|service.*unavailable|server.*overload/i,
    cooldownMs: 120_000,
    description: '서버 과부하 (503) → 2분 쿨다운',
  },
  {
    pattern: /401|403|invalid.*key|API key/i,
    cooldownMs: 86_400_000,  // 24h — likely a permanent key issue
    description: 'API 키 오류 → 24시간 쿨다운 (키 확인 필요)',
  },
]

function findKnownFix(error: string): KnownFix | null {
  return KNOWN_FIXES.find(f => f.pattern.test(error)) ?? null
}

/**
 * Returns a human-readable description of what fix was applied.
 * Returns null if no known fix matched.
 */
export function describeAppliedFix(error: string): string | null {
  const fix = findKnownFix(error)
  return fix ? fix.description : null
}

// ──────────────────────────────────────────────────────────────
// Health snapshot (for debug panel)
// ──────────────────────────────────────────────────────────────

export interface HealthSnapshot {
  provider: string
  healthy: boolean
  cooldownRemainSec: number
  failCount: number
  lastError: string
}

export function getHealthSnapshots(): HealthSnapshot[] {
  return Array.from(providerHealth.entries()).map(([provider, h]) => ({
    provider,
    healthy: h.healthy,
    cooldownRemainSec: h.cooldownUntil > Date.now()
      ? Math.round((h.cooldownUntil - Date.now()) / 1000)
      : 0,
    failCount: h.failCount,
    lastError: h.lastError,
  }))
}

/** Reset a single provider (e.g. after the user manually retries). */
export function resetProvider(provider: string): void {
  providerHealth.delete(provider)
}

/** Reset all providers. */
export function resetAllProviders(): void {
  providerHealth.clear()
}
