import fs from 'fs'
import os from 'os'
import path from 'path'

export interface CommandCatalogEntry {
  command: string
  provider: string
  domain: string
  description: string
  usage: string
  aliases: string[]
  kind: 'slash-command'
  source: string
}

export interface MetaCommandCandidate {
  command: string
  usage: string
  description: string
  providers: string[]
  reason: string
}

export interface MetaToolCandidate {
  name: string
  description: string
  reason: string
}

interface NovaAxToolEntry {
  name: string
  description: string
  kind: 'mcp-tool'
  source: string
}

interface CommandCatalogFile {
  schemaVersion: number
  commands: CommandCatalogEntry[]
  novaAxTools?: NovaAxToolEntry[]
}

const MAX_CATALOG_ENTRIES = 2_000
const MAX_FIELD_LENGTH = 500
const COMMAND_PATTERN = /^\/[A-Za-z0-9가-힣][A-Za-z0-9가-힣:_-]{0,80}$/
const REFRESH_INTERVAL_MS = 5_000

let cachedCommands: CommandCatalogEntry[] = []
let cachedNovaAxTools: NovaAxToolEntry[] = []
let cachedPath = ''
let cachedMtimeMs = -1
let lastCheckedAt = 0

const SPOKEN_TECH_TERMS: Array<[RegExp, string]> = [
  [/(?:엔\s*씨\s*오|엔시어|엔시오|앤씨오)/gi, 'nco'],
  [/(?:노바\s*유즈|노바\s*유스)/gi, 'novause'],
  [/(?:노바\s*에이\s*엑스|노바\s*에이엑스)/gi, 'novaax'],
  [/(?:인터\s*세션)/gi, 'intersession'],
  [/(?:태스크|테스크)/gi, 'task'],
  [/(?:패러럴|파라렐|병렬)/gi, 'parallel'],
  [/(?:디스커션|토론)/gi, 'discussion'],
  [/(?:컨센서스|합의)/gi, 'consensus'],
  [/(?:커맨더|지휘관)/gi, 'commander'],
  [/(?:컨덕터|지휘)/gi, 'conductor'],
  [/(?:컴퍼니|회사)/gi, 'company'],
  [/(?:브로드캐스트|전체전송)/gi, 'broadcast'],
  [/(?:프로바이더즈?|공급자)/gi, 'providers'],
  [/(?:인보케이션즈?|호출현황)/gi, 'invocations'],
  [/(?:메트릭스|지표)/gi, 'metrics'],
  [/(?:리더보드|순위)/gi, 'leaderboard'],
  [/(?:스테이터스|상태)/gi, 'status'],
  [/(?:리커버|복구)/gi, 'recover'],
  [/(?:디버그)/gi, 'debug'],
  [/(?:캔슬|취소)/gi, 'cancel'],
  [/(?:클리어|지우기)/gi, 'clear'],
  [/(?:서치|검색)/gi, 'search'],
  [/(?:클릭)/gi, 'click'],
  [/(?:타입|입력)/gi, 'type'],
  [/(?:스크롤)/gi, 'scroll'],
  [/(?:내비게이트|이동)/gi, 'navigate'],
  [/(?:키프레스|키입력)/gi, 'keypress'],
  [/(?:하이브)/gi, 'hive'],
  [/(?:갭|누락)/gi, 'gap'],
  [/(?:검증)/gi, 'verify'],
  [/(?:분석)/gi, 'analyze'],
]

const INTENT_RULES: Array<{ command: string; pattern: RegExp; reason: string }> = [
  { command: '/nco-company-cancel', pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스|회사).*(?:실행|작업|오케스트레이션).*(?:취소|중단)/i, reason: 'NOVA-AX 회사 실행 취소' },
  { command: '/nco-company', pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스|회사\s*(?:팀|조직)).*(?:위임|실행|작업|오케스트레이션)/i, reason: 'NOVA-AX 회사/팀 작업 위임' },
  { command: '/nco-discussion', pattern: /(?:여러|복수|멀티)?\s*(?:AI|프로바이더)?.*(?:토론|논의|찬반)/i, reason: '다중 AI 토론' },
  { command: '/nco-consensus', pattern: /(?:AI|프로바이더|에이전트)?.*(?:합의|투표|컨센서스)/i, reason: '다중 AI 합의' },
  { command: '/nco-hive', pattern: /(?:모든|전체)\s*(?:AI|프로바이더|에이전트).*(?:동원|실행|분석|검토)/i, reason: '전체 AI Hive 실행' },
  { command: '/nco-parallel', pattern: /(?:여러|복수|각각|동시에)\s*(?:AI|프로바이더|에이전트)?.*(?:병렬|동시|검토|실행)/i, reason: '다중 provider 병렬 실행' },
  { command: '/nco-task', pattern: /(?:codex|claude|opencode|cursor|ollama|hermes|gemini|copilot).*(?:에게|로|한테).*(?:위임|맡겨|실행|검토|작업)/i, reason: '지정 provider 단일 위임' },
  { command: '/nco-commander', pattern: /(?:복잡|대규모|여러\s*단계|4\s*layer|4계층).*(?:작업|구현|프로젝트|지휘|실행)/i, reason: '복합 작업 Commander 실행' },
  { command: '/nco-conductor', pattern: /(?:최적|알아서|자동).*(?:AI|프로바이더|모드).*(?:선택|배정|라우팅|실행)/i, reason: 'NCO 자동 라우팅' },
  { command: '/nco-gap', pattern: /(?:갭|gap|누락|빠진\s*(?:부분|것)|미완료).*(?:분석|확인|검사|찾)/i, reason: 'Gap/누락 분석' },
  { command: '/nco-verify', pattern: /(?:NCO|납품|변경|결과).*(?:검증\s*영수증|delivery\s*gate|통합\s*검증)/i, reason: 'NCO 검증 게이트' },
  { command: '/nco-providers', pattern: /(?:NCO\s*)?(?:프로바이더|AI).*(?:목록|상태|준비|연결)/i, reason: 'NCO provider 상태 조회' },
  { command: '/nco-status', pattern: /NCO.*(?:상태|헬스|정상|가동)/i, reason: 'NCO 상태 조회' },
  { command: '/nco-inter-session', pattern: /(?:inter[- ]?session|인터\s*세션).*(?:연결|목록|전송|메시지|상태|해제)/i, reason: 'NOVA-AX inter-session 제어' },
  { command: '/search', pattern: /(?:NOVA\s*Use|노바\s*유즈|이\s*사이트|현재\s*페이지|브라우저).*(?:검색|찾아)/i, reason: 'NOVA Use 브라우저 즉시 검색' },
  { command: '/click', pattern: /(?:NOVA\s*Use|노바\s*유즈|이\s*사이트|현재\s*페이지|브라우저).*(?:클릭|눌러)/i, reason: 'NOVA Use 브라우저 즉시 클릭' },
  { command: '/navigate', pattern: /(?:NOVA\s*Use|노바\s*유즈|브라우저).*(?:이동|열어|접속)/i, reason: 'NOVA Use 브라우저 즉시 이동' },
]

const NOVA_AX_TOOL_RULES: Array<{ name: string; pattern: RegExp; reason: string }> = [
  { name: 'ax_health', pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스).*(?:상태|헬스|정상|가동|연결)/i, reason: 'NOVA-AX 서버 상태 확인' },
  { name: 'ax_dashboard', pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스).*(?:대시보드|전체\s*요약)/i, reason: 'NOVA-AX 대시보드 요약' },
  { name: 'ax_agents', pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스).*(?:에이전트).*(?:목록|현황|조회)/i, reason: 'NOVA-AX 에이전트 목록' },
  { name: 'ax_engines_backends', pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스).*(?:provider|프로바이더|backend|백엔드|세션).*(?:상태|목록|현황)/i, reason: 'NOVA-AX backend 세션 상태' },
  { name: 'ax_metrics', pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스).*(?:metrics?|메트릭|지표)/i, reason: 'NOVA-AX 런타임 지표' },
  { name: 'ax_logs', pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스).*(?:로그|오류\s*기록)/i, reason: 'NOVA-AX 로그 조회' },
  { name: 'ax_report', pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스).*(?:보고서|리포트|종합\s*결과)/i, reason: 'NOVA-AX 종합 보고서' },
  { name: 'ax_router_select', pattern: /(?:NOVA[- ]?AX|노바\s*에이\s*엑스).*(?:provider|프로바이더|AI).*(?:선택|라우팅|배정)/i, reason: 'NOVA-AX provider 라우팅' },
]

function catalogPaths(): string[] {
  const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    path.join(os.homedir(), 'obsidian', 'mac-obsidian', '10-CLI-COMMANDER', 'command-catalog.json'),
    ...(electronResources
      ? [path.join(electronResources, 'app.asar', 'resources', 'command-catalog.json')]
      : []),
    path.join(process.cwd(), 'resources', 'command-catalog.json'),
  ]
  return [...new Set(candidates)]
}

function cleanField(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LENGTH)
    : ''
}

function readCatalog(filePath: string): { commands: CommandCatalogEntry[]; novaAxTools: NovaAxToolEntry[] } {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CommandCatalogFile>
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.commands)) return { commands: [], novaAxTools: [] }
  const commands = parsed.commands.slice(0, MAX_CATALOG_ENTRIES).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const command = cleanField(raw.command)
    if (!COMMAND_PATTERN.test(command)) return []
    const provider = cleanField(raw.provider)
    const domain = cleanField(raw.domain)
    const description = cleanField(raw.description)
    const usage = cleanField(raw.usage) || command
    const source = cleanField(raw.source)
    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.map(cleanField).filter(Boolean).slice(0, 12)
      : []
    return [{ command, provider, domain, description, usage, aliases, kind: 'slash-command' as const, source }]
  })
  const novaAxTools = (Array.isArray(parsed.novaAxTools) ? parsed.novaAxTools : [])
    .slice(0, 200)
    .flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const name = cleanField(raw.name)
      if (!/^ax_[a-z0-9_]{1,80}$/.test(name)) return []
      return [{
        name,
        description: cleanField(raw.description),
        kind: 'mcp-tool' as const,
        source: cleanField(raw.source),
      }]
    })
  return { commands, novaAxTools }
}

export function getCommandCatalog(): CommandCatalogEntry[] {
  const now = Date.now()
  if (cachedCommands.length && now - lastCheckedAt < REFRESH_INTERVAL_MS) return cachedCommands
  lastCheckedAt = now

  for (const filePath of catalogPaths()) {
    try {
      const stat = fs.statSync(filePath)
      if (cachedPath === filePath && cachedMtimeMs === stat.mtimeMs && cachedCommands.length) return cachedCommands
      const catalog = readCatalog(filePath)
      if (!catalog.commands.length) continue
      cachedCommands = catalog.commands
      cachedNovaAxTools = catalog.novaAxTools
      cachedPath = filePath
      cachedMtimeMs = stat.mtimeMs
      return cachedCommands
    } catch {
      // Try the bundled snapshot when the live Obsidian catalog is absent.
    }
  }
  return cachedCommands
}

export function canonicalizeSpokenCommand(value: string): string {
  let normalized = value.toLowerCase()
  for (const [pattern, replacement] of SPOKEN_TECH_TERMS) normalized = normalized.replace(pattern, replacement)
  return normalized.replace(/^\//, '').replace(/[^a-z0-9가-힣]+/g, '')
}

export function findSpokenCatalogCommand(value: string): { command: string; arguments: string } | null {
  const words = value.trim().split(/\s+/).filter(Boolean)
  const byKey = new Map<string, string>()
  for (const entry of getCommandCatalog()) {
    for (const alias of [entry.command, ...entry.aliases]) {
      const key = canonicalizeSpokenCommand(alias)
      if (key && !byKey.has(key)) byKey.set(key, entry.command)
    }
  }

  for (let count = Math.min(7, words.length); count >= 1; count -= 1) {
    const key = canonicalizeSpokenCommand(words.slice(0, count).join(' '))
    const command = byKey.get(key)
    if (command) return { command, arguments: words.slice(count).join(' ') }
  }
  return null
}

export function isCatalogCommand(value: string): boolean {
  const command = value.trim().split(/\s+/, 1)[0]
  return getCommandCatalog().some((entry) => entry.command === command)
}

export function getMetaCommandCandidates(input: string): MetaCommandCandidate[] {
  const catalog = getCommandCatalog()
  const matchedRules = INTENT_RULES.filter((rule) => rule.pattern.test(input))
  return matchedRules.slice(0, 6).flatMap((rule) => {
    const matches = catalog.filter((entry) => entry.command === rule.command)
    if (!matches.length) return []
    const preferred = matches.find((entry) => entry.provider === 'codex') ?? matches[0]
    return [{
      command: rule.command,
      usage: preferred.usage,
      description: preferred.description,
      providers: [...new Set(matches.map((entry) => entry.provider))],
      reason: rule.reason,
    }]
  })
}

export function getMetaToolCandidates(input: string): MetaToolCandidate[] {
  getCommandCatalog()
  const tools = new Map(cachedNovaAxTools.map((tool) => [tool.name, tool]))
  return NOVA_AX_TOOL_RULES
    .filter((rule) => rule.pattern.test(input))
    .slice(0, 4)
    .flatMap((rule) => {
      const tool = tools.get(rule.name)
      return tool ? [{ name: tool.name, description: tool.description, reason: rule.reason }] : []
    })
}

export function isAllowedMetaCommand(output: string, candidates: MetaCommandCandidate[] | undefined): boolean {
  const command = output.trim().split(/\s+/, 1)[0]
  return Boolean(candidates?.some((candidate) => candidate.command === command))
}
