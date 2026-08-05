import { findSpokenCatalogCommand, isCatalogCommand } from './command-catalog.ts'
import { normalizeTranscript } from './transcript-normalizer.ts'

export interface RoutedVoicePrompt {
  text: string
  isSlashCommand: boolean
  shouldExecuteInCli: boolean
}

const COMMAND_ALIASES = new Map<string, string>([
  ['클리어', 'clear'],
  ['지우기', 'clear'],
  ['화면지우기', 'clear'],
  ['대화지우기', 'clear'],
  ['clear', 'clear'],
  ['컴팩트', 'compact'],
  ['압축', 'compact'],
  ['compact', 'compact'],
  ['헬프', 'help'],
  ['도움말', 'help'],
  ['help', 'help'],
  ['모델', 'model'],
  ['model', 'model'],
  ['스테이터스', 'status'],
  ['상태', 'status'],
  ['status', 'status'],
  ['이니트', 'init'],
  ['초기화', 'init'],
  ['init', 'init'],
  ['리뷰', 'review'],
  ['코드리뷰', 'review'],
  ['review', 'review'],
  ['리줌', 'resume'],
  ['재개', 'resume'],
  ['resume', 'resume'],
  ['뉴', 'new'],
  ['새대화', 'new'],
  ['새세션', 'new'],
  ['new', 'new'],
  ['플랜', 'plan'],
  ['계획', 'plan'],
  ['plan', 'plan'],
  ['에이전트', 'agents'],
  ['에이전츠', 'agents'],
  ['agents', 'agents'],
  ['퍼미션', 'permissions'],
  ['권한', 'permissions'],
  ['permissions', 'permissions'],
  ['디프', 'diff'],
  ['변경사항', 'diff'],
  ['diff', 'diff'],
  ['콜', 'goal'],
  ['골', 'goal'],
  ['goal', 'goal'],
])

const CLI_BUNDLE_IDS = new Set([
  'com.apple.terminal',
  'com.googlecode.iterm2',
  'dev.warp.warp-stable',
  'dev.warp.warp',
  'com.mitchellh.ghostty',
  'net.kovidgoyal.kitty',
  'org.alacritty',
  'com.github.wez.wezterm',
  'co.zeit.hyper',
  'com.nova.nova-use',
])

const CLI_APP_PATTERN = /(?:^|\s)(terminal|iterm|warp|ghostty|kitty|alacritty|wezterm|hyper|nova use)(?:$|\s)/i
// Whisper commonly alternates between 러/라 and 시/쉬 for the spoken word
// "slash". Keep the accepted variants explicit so unrelated Korean words do
// not become commands.
// The separator is optional because Whisper frequently joins a short marker
// and command ("슬러시골", "slashgoal"). The captured body is still accepted
// only when it resolves to a known static/catalog command, preventing arbitrary
// words beginning with "슬러시" from becoming commands.
const SLASH_PREFIX = /^(?:슬러시|슬러쉬|슬라시|슬라쉬|슬래시|슬래쉬|slash)(?:\s*명령어)?\s*(.+)$/i
const LITERAL_SLASH = /^(\/[A-Za-z0-9가-힣][A-Za-z0-9가-힣:_-]*)(?:\s+([\s\S]+))?$/

function normalizeAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s/.,!?。！？'"`~_-]+/g, '')
}

function findStaticCommand(value: string): { command: string; arguments: string } | null {
  const trimmed = value.trim()
  const words = trimmed.split(/\s+/).filter(Boolean)
  for (let count = words.length; count >= 1; count -= 1) {
    const command = COMMAND_ALIASES.get(normalizeAlias(words.slice(0, count).join(' ')))
    if (command) return { command, arguments: words.slice(count).join(' ') }
  }

  // Korean TTS/STT can join a short command and the following product name
  // (for example "골NOVA Use" or "골노바 유즈"). Treat only a measured
  // product-name start as a boundary while refusing Korean continuations such
  // as "골프".
  const aliases = [...COMMAND_ALIASES.entries()]
    .sort(([left], [right]) => right.length - left.length)
  const lower = trimmed.toLowerCase()
  for (const [spokenAlias, command] of aliases) {
    const alias = spokenAlias.toLowerCase()
    if (!/[가-힣]$/.test(alias) || !lower.startsWith(alias)) continue
    const remainder = trimmed.slice(spokenAlias.length)
    if (!/^(?:[A-Za-z0-9/]|(?:노바|로바)\s*(?:유즈|유스))/.test(remainder)) continue
    return { command, arguments: remainder.trim() }
  }
  return null
}

export function isCliTarget(appName?: string, bundleId?: string): boolean {
  const normalizedBundleId = bundleId?.trim().toLowerCase() ?? ''
  if (normalizedBundleId && CLI_BUNDLE_IDS.has(normalizedBundleId)) return true
  return CLI_APP_PATTERN.test(appName?.trim() ?? '')
}

export function routeVoicePrompt(
  text: string,
  appName?: string,
  bundleId?: string,
): RoutedVoicePrompt {
  const trimmed = text.trim()
  const literal = trimmed.match(LITERAL_SLASH)
  if (literal) {
    const staticCommand = [...COMMAND_ALIASES.values()].includes(literal[1].slice(1).toLowerCase())
    if (staticCommand || isCatalogCommand(literal[1])) {
      return {
        text: `${literal[1]}${literal[2] ? ` ${literal[2].trim()}` : ''}`,
        isSlashCommand: true,
        shouldExecuteInCli: isCliTarget(appName, bundleId),
      }
    }
  }

  const match = trimmed.match(SLASH_PREFIX)
  if (!match) {
    return { text: trimmed, isSlashCommand: false, shouldExecuteInCli: false }
  }

  const staticMatch = findStaticCommand(match[1])
  if (!staticMatch) {
    const catalogMatch = findSpokenCatalogCommand(match[1])
    if (!catalogMatch) return { text: trimmed, isSlashCommand: false, shouldExecuteInCli: false }
    return {
      text: `${catalogMatch.command}${catalogMatch.arguments ? ` ${catalogMatch.arguments}` : ''}`,
      isSlashCommand: true,
      shouldExecuteInCli: isCliTarget(appName, bundleId),
    }
  }

  return {
    text: `/${staticMatch.command}${staticMatch.arguments ? ` ${normalizeTranscript(staticMatch.arguments)}` : ''}`,
    isSlashCommand: true,
    shouldExecuteInCli: isCliTarget(appName, bundleId),
  }
}
