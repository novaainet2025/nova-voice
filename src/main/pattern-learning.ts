/**
 * Learns from what the user actually dictates.
 *
 * Two things are learned, both from data the app already produces:
 *
 *  1. **Spoken aliases.** When a phrase gets routed to a slash command, the
 *     pairing is counted. Once the same phrasing has led to the same command
 *     often enough, it is treated as an alias — so the static catalogue of 205
 *     commands stops being the only way a command can be recognised. Measured
 *     baseline: only 2.2% of 678 dictations ever reached a slash command.
 *
 *  2. **Per-app habits.** Which phrases and commands recur in which application,
 *     so the meta prompt can be told what this user tends to ask for *here*
 *     rather than in general.
 *
 * Everything is derived from the transcription history, which means learning
 * survives restarts without a second source of truth, and deleting a history
 * entry also removes what was learned from it.
 */
import { getPatternStats, recordPatternObservation } from './db'
import type { PatternObservation } from './db'
import { logInfo } from './logger'

/** How often a phrase must lead to the same command before it counts as one. */
export const ALIAS_CONFIDENCE_THRESHOLD = 3
/** Phrases shorter than this are too generic to be a useful alias. */
const MIN_ALIAS_LENGTH = 4
const MAX_ALIAS_LENGTH = 60
/** Phrases suggested to the meta prompt as this app's usual requests. */
const MAX_APP_HINTS = 4

export interface LearnedAlias {
  phrase: string
  command: string
  hits: number
}

export interface AppUsageHint {
  bundleId: string
  /** Commands the user runs here, most frequent first. */
  commands: string[]
  /** Recent distinct requests made in this application. */
  phrases: string[]
}

/**
 * Normalises a spoken phrase for counting.
 *
 * Spacing in Korean speech-to-text is unstable — the same sentence comes back
 * with different word breaks between takes — so spacing and punctuation are
 * dropped before two utterances are compared.
 */
export function normalizePhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,!?~…"'`]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function isLearnablePhrase(phrase: string): boolean {
  const normalized = normalizePhrase(phrase)
  if (normalized.length < MIN_ALIAS_LENGTH || normalized.length > MAX_ALIAS_LENGTH) return false
  // A phrase that already *is* the command teaches nothing.
  return !normalized.startsWith('/')
}

/**
 * Records one completed dictation. Called after injection so that only
 * utterances that actually reached an application are learned from.
 */
export function observeDictation(observation: PatternObservation): void {
  if (!isLearnablePhrase(observation.spokenText)) return
  recordPatternObservation(observation)
}

/**
 * Aliases confident enough to act on: the same phrase led to the same command
 * at least {@link ALIAS_CONFIDENCE_THRESHOLD} times and never to a different one.
 */
export function getLearnedAliases(): LearnedAlias[] {
  const stats = getPatternStats()
  const byPhrase = new Map<string, Map<string, number>>()
  for (const row of stats.commandPairs) {
    const commands = byPhrase.get(row.phrase) ?? new Map<string, number>()
    commands.set(row.command, (commands.get(row.command) ?? 0) + row.hits)
    byPhrase.set(row.phrase, commands)
  }

  const learned: LearnedAlias[] = []
  for (const [phrase, commands] of byPhrase) {
    // An ambiguous phrase is worse than no alias: it would route half the
    // user's attempts to the wrong command.
    if (commands.size !== 1) continue
    const [command, hits] = [...commands][0]
    if (hits >= ALIAS_CONFIDENCE_THRESHOLD) learned.push({ phrase, command, hits })
  }
  learned.sort((left, right) => right.hits - left.hits)
  return learned
}

/**
 * Resolves a spoken phrase through what has been learned. Returns null when no
 * confident alias matches, which leaves the static catalogue in charge.
 */
export function findLearnedCommand(spokenText: string): LearnedAlias | null {
  const normalized = normalizePhrase(spokenText)
  if (!normalized) return null
  const aliases = getLearnedAliases()
  const exact = aliases.find((alias) => alias.phrase === normalized)
  if (exact) return exact
  // A learned phrase followed by extra words is the same request with an
  // argument attached ("엔씨오 토론" → "엔씨오 토론 REST와 GraphQL").
  return aliases.find((alias) => normalized.startsWith(alias.phrase)) ?? null
}

/** What the user usually asks for in a given application. */
export function getAppUsageHint(bundleId: string | undefined): AppUsageHint | null {
  if (!bundleId) return null
  const stats = getPatternStats()
  const commands = stats.appCommands
    .filter((row) => row.bundleId === bundleId)
    .sort((left, right) => right.hits - left.hits)
    .slice(0, MAX_APP_HINTS)
    .map((row) => row.command)
  const phrases = stats.appPhrases
    .filter((row) => row.bundleId === bundleId)
    .slice(0, MAX_APP_HINTS)
    .map((row) => row.phrase)
  if (!commands.length && !phrases.length) return null
  return { bundleId, commands, phrases }
}

/** One-line summary for the logs; keeps learning observable in production. */
export function describeLearningState(): string {
  const aliases = getLearnedAliases()
  const summary = `${aliases.length} aliases`
  logInfo('[Learning] State', { aliases: aliases.length, top: aliases.slice(0, 3) })
  return summary
}
