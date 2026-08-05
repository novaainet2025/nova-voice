/**
 * Finds the installed application a spoken name refers to.
 *
 * A hand-written map covered ten names against 122 installed applications, so
 * anything the author had not anticipated simply failed. This scans what is
 * actually on the machine and matches by similarity, which means a new app
 * becomes reachable by voice the moment it is installed.
 *
 * Matching is deliberately conservative. A wrong match launches the wrong
 * program, which is worse than reporting that nothing was found, so a candidate
 * has to clear a similarity floor before it is offered.
 */
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { logInfo } from './logger.ts'

const SEARCH_DIRECTORIES = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  path.join(os.homedir(), 'Applications'),
  // Finder and a few other system surfaces live outside the Applications
  // folders, so a scan limited to those never sees them.
  '/System/Library/CoreServices',
]

const CATALOG_TTL_MS = 5 * 60_000
/** Below this a match is closer to a coincidence than to a name. */
const MIN_SIMILARITY = 0.62
const MAX_SUGGESTIONS = 3

export interface AppEntry {
  /** Name `open -a` expects — the bundle's filename without .app. */
  name: string
  /** Lower-cased, space-free form used for comparison. */
  key: string
  /**
   * Localized display name, when macOS has one.
   *
   * This is what the user actually says: Calculator shows as "계산기" and Notes
   * as "메모". Neither is derivable from the bundle name, and both come from
   * the system rather than from a list maintained here.
   */
  displayKey?: string
}

let catalog: { entries: AppEntry[]; at: number } | null = null

/**
 * Rewrites a Korean transliteration back into the Latin letters it came from.
 *
 * Users say app names phonetically — "옵시디언" for Obsidian, "디스코드" for
 * Discord — so comparing Hangul against a Latin bundle name always scores zero.
 * Rather than maintaining a list of apps (which is what previously limited this
 * to ten names against 122 installs), each Hangul syllable is decomposed into
 * its initial/medial/final jamo and mapped to the roman letters that produce
 * that sound. The result is compared with the real bundle names, so any newly
 * installed app becomes reachable without being registered anywhere.
 */
const INITIALS = [
  'g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's',
  'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h',
]
const MEDIALS = [
  'a', 'ae', 'ya', 'yae', 'e', 'e', 'ye', 'ye', 'o', 'wa',
  'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'u', 'ui', 'i',
]
const FINALS = [
  '', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'l',
  'l', 'l', 'l', 'l', 'l', 'l', 'm', 'p', 'p', 't',
  't', 'ng', 't', 't', 'k', 't', 'p', 't',
]

function romanizeHangul(value: string): string {
  let out = ''
  for (const char of value.normalize('NFC')) {
    const code = char.charCodeAt(0)
    if (code < 0xac00 || code > 0xd7a3) {
      out += char
      continue
    }
    const offset = code - 0xac00
    out += INITIALS[Math.floor(offset / 588)]
    out += MEDIALS[Math.floor((offset % 588) / 28)]
    out += FINALS[offset % 28]
  }
  return out
}

function normalize(value: string): string {
  // macOS returns Hangul in decomposed form (NFD): "계산기" arrives as separate
  // jamo, which never equals the composed text a user types or Whisper emits.
  // Composing first makes the two comparable at all.
  return value.normalize('NFC').toLowerCase().replace(/[\s._-]+/g, '')
}

/** Scans the application directories, or returns the cached result. */
export function listInstalledApps(): AppEntry[] {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.entries

  const byKey = new Map<string, AppEntry>()
  const paths: string[] = []
  for (const directory of SEARCH_DIRECTORIES) {
    let files: string[]
    try {
      files = fs.readdirSync(directory)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.app')) continue
      // Backups kept alongside the real app would otherwise compete with it and
      // occasionally win on similarity.
      if (/\.(bak|backup|old)$/i.test(file.replace(/\.app$/, ''))) continue
      const name = file.slice(0, -4)
      const key = normalize(name)
      if (!key || byKey.has(key)) continue
      byKey.set(key, { name, key, ...(paths.push(path.join(directory, file)) ? {} : {}) })
    }
  }

  const entries = [...byKey.values()]
  applyDisplayNames(entries, paths)
  catalog = { entries, at: Date.now() }
  logInfo('[AppCatalog] Scanned installed applications', { count: entries.length })
  return entries
}

/**
 * Attaches the localized name macOS already knows for each bundle.
 *
 * One `mdls` call covers every path: spawning per app would cost ~80ms each
 * across 200+ bundles. A failure here only costs Korean-name matching, so it is
 * swallowed rather than allowed to break the scan.
 */
function applyDisplayNames(entries: AppEntry[], paths: string[]): void {
  if (!paths.length) return
  try {
    const stdout = execFileSync(
      'mdls',
      ['-name', 'kMDItemDisplayName', '-raw', ...paths],
      { encoding: 'utf8', timeout: 8_000, maxBuffer: 4 * 1024 * 1024 },
    )
    // -raw with several files emits values back to back separated by NUL.
    const values = stdout.split('\0')
    entries.forEach((entry, index) => {
      const display = (values[index] ?? '').trim()
      if (!display || display === '(null)') return
      const displayKey = normalize(display)
      if (displayKey && displayKey !== entry.key) entry.displayKey = displayKey
    })
  } catch {
    // Without display names only Korean translations stop matching; romanized
    // and English names still work.
  }
}

export function invalidateAppCatalog(): void {
  catalog = null
}

/** Levenshtein distance, capped implicitly by the short strings involved. */
function editDistance(left: string, right: string): number {
  if (left === right) return 0
  if (!left.length) return right.length
  if (!right.length) return left.length

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[right.length]
}

/**
 * Collapses letters Korean cannot tell apart.
 *
 * Hangul has no f/v, and it renders both as ㅍ/ㅂ — "파인더" romanizes to
 * "painde" against a real bundle named "finder". The same happens with c/k
 * ("크롬" → "keurom" vs "chrome") and l/r. Folding these to one representative
 * letter lets the comparison see through the transliteration instead of scoring
 * a real match as a miss.
 */
function foldPhonetics(value: string): string {
  return value
    .replace(/[fv]/g, 'p')
    .replace(/[ckq]/g, 'k')
    .replace(/[lr]/g, 'r')
    .replace(/[zj]/g, 'j')
    .replace(/x/g, 'ks')
    // Doubled letters only ever come from romanization artefacts.
    .replace(/(.)\1+/g, '$1')
}

function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length)
  if (!longest) return 0
  return 1 - editDistance(left, right) / longest
}

/**
 * Scores one app against a spoken name.
 *
 * A prefix match ranks above a merely similar string: saying "비주얼" should
 * reach "Visual Studio Code" even though the two share little of their length.
 */
function scoreEntry(entry: AppEntry, spokenKey: string, romanizedKey: string): number {
  let best = 0
  // The spoken form is compared both as typed and as romanized, so an English
  // name said in Korean still reaches its bundle.
  const spokenForms = romanizedKey === spokenKey ? [spokenKey] : [spokenKey, romanizedKey]
  const candidates = entry.displayKey ? [entry.key, entry.displayKey] : [entry.key]
  for (const candidate of candidates) {
    for (const spoken of spokenForms) {
      best = Math.max(best, scoreAgainst(candidate, spoken))
    }
  }
  return best
}

function scoreAgainst(candidate: string, spokenKey: string): number {
  if (candidate === spokenKey) return 1
  if (candidate.startsWith(spokenKey) || spokenKey.startsWith(candidate)) {
    // Length ratio keeps a two-letter query from claiming every long name.
    const ratio = Math.min(candidate.length, spokenKey.length)
      / Math.max(candidate.length, spokenKey.length)
    return 0.75 + ratio * 0.24
  }
  if (candidate.includes(spokenKey) && spokenKey.length >= 3) return 0.7

  const direct = similarity(candidate, spokenKey)
  // Compare the consonant skeletons too, so a transliteration that differs only
  // in sounds Korean lacks still lands on its app.
  const foldedCandidate = foldPhonetics(candidate)
  const foldedSpoken = foldPhonetics(spokenKey)
  if (!foldedCandidate || !foldedSpoken) return direct
  if (foldedCandidate === foldedSpoken) return 0.92

  // Vowels still differ after folding — "painde" against "pinder" — so the
  // skeletons are compared by distance rather than equality. A bundle name may
  // also carry a vendor prefix the user omits ("googlechrome" for "krom"), so
  // each word of the name is scored separately and the best one wins.
  let folded = similarity(foldedCandidate, foldedSpoken)
  // "googlechrome" contains a vendor prefix the user omits, so each segment of
  // the bundle name is also scored on its own.
  for (const segment of segmentsOf(foldedCandidate)) {
    folded = Math.max(folded, similarity(segment, foldedSpoken))
  }
  // Scaled below a direct hit: a folded match is a weaker signal, and the floor
  // in matchApps still has to be cleared.
  return Math.max(direct, folded * 0.95)
}

/**
 * Splits a folded name into plausible words.
 *
 * Bundle names run words together ("googlechrome"), and the user usually says
 * only one of them. Without a dictionary the split is approximate: every suffix
 * of reasonable length is offered as a candidate segment.
 */
function segmentsOf(folded: string): string[] {
  const out: string[] = []
  for (let start = 0; start < folded.length - 2; start++) {
    const segment = folded.slice(start)
    if (segment.length >= 3) out.push(segment)
    if (out.length >= 8) break
  }
  return out
}

export interface AppMatch {
  name: string
  score: number
}

/**
 * Ranks installed apps against a spoken name, best first.
 *
 * Returns every candidate above the floor so the caller can decide whether the
 * top one is clear enough to act on or whether it should ask.
 */
export function matchApps(spoken: string): AppMatch[] {
  const spokenKey = normalize(spoken)
  if (!spokenKey) return []
  const romanizedKey = normalize(romanizeHangul(spoken))

  return listInstalledApps()
    .map((entry) => ({ name: entry.name, score: scoreEntry(entry, spokenKey, romanizedKey) }))
    .filter((match) => match.score >= MIN_SIMILARITY)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_SUGGESTIONS)
}

/**
 * The single app a spoken name refers to, or null when it is not clear enough.
 *
 * Ambiguity is reported rather than resolved by guessing: with two close
 * candidates, launching either one has an even chance of being wrong.
 */
export function resolveApp(spoken: string): { name: string; alternatives: string[] } | null {
  const matches = matchApps(spoken)
  if (!matches.length) return null

  const [best, second] = matches
  // A near-tie means the name did not identify one app.
  if (second && best.score - second.score < 0.08 && best.score < 1) {
    return { name: best.name, alternatives: matches.slice(1).map((match) => match.name) }
  }
  return { name: best.name, alternatives: [] }
}
