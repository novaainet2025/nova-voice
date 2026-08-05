type TranscriptRule = readonly [replacement: string, variants: readonly string[]]

// Product phrases come first so a mistaken brand word is repaired in context
// before the standalone `nova` rule runs.
const SYSTEM_TERM_RULES: readonly TranscriptRule[] = [
  ['NOVA VOICE', ['노바 보이스', '로바 보이스', '노바보이스', '로바보이스', 'nova voice', 'nova 보이스', 'rova voice']],
  ['NOVA Use', ['노바 유즈', '로바 유즈', '노바 유스', '로바 유스', '노바유즈', '로바유즈', 'nova use']],
  ['NOVA AX', ['노바 에이 엑스', '로바 에이 엑스', '노바 에이엑스', '로바 에이엑스']],
  ['NOVA Dashboard', ['노바 대시보드', '로바 대시보드']],
  ['NCO Orchestrator', ['엔 씨 오 오케스트레이터', '엔씨오 오케스트레이터', '엔시어 오케스트레이터', '엔시오 오케스트레이터', 'ncio 오케스트레이터']],
  ['NCO Dashboard', ['엔 씨 오 대시보드', '엔씨오 대시보드', '엔시어 대시보드', '엔시오 대시보드', 'ncio 대시보드']],
  ['Claude Code', ['클로드 코드']],
  ['cursor-agent', ['커서 에이전트', '커서에이전트']],
  ['OpenCode', ['오픈 코드', '오픈코드']],
  ['meta prompt', [
    '메타 프롬프트',
    '메타프롬프트',
    '메타 프로프트',
    '메타 프로포트',
    '메탈 프롬프트',
    '메탈 프로프트',
    '메탈 프로포트',
  ]],
  ['nova', ['노바', '로바']],
  ['NCO', ['엔 씨 오', '엔씨오', '앤씨오', '엔시어', '엔시오', 'ncio']],
  ['Inter-session', ['인터 세션', '인터세션']],
  ['Obsidian', ['옵시디언', '오브시디언']],
  ['Ollama', ['올라마']],
  ['Hermes', ['헤르메스']],
]

// Longer, more specific phrases must run before their component words.
// Whisper often inserts or removes spaces between spelled-out letters, so
// patterns accept both forms and preserve attached Korean particles/endings.
const ENGLISH_TERM_RULES: readonly TranscriptRule[] = [
  ['VS Code', ['비주얼 스튜디오 코드', '브이 에스 코드', '비 에스 코드']],
  ['pull request', ['풀 리퀘스트']],
  ['machine learning', ['머신 러닝']],
  ['deep learning', ['딥 러닝']],
  ['open source', ['오픈 소스']],
  ['frontend', ['프론트 엔드', '프론트엔드']],
  ['backend', ['백 엔드', '백엔드']],
  ['full-stack', ['풀 스택', '풀스택']],
  ['database', ['데이터 베이스', '데이터베이스']],
  ['OpenAI', ['오픈 에이 아이', '오픈 에이아이']],
  ['ChatGPT', ['챗 지피티', '챗지피티']],
  ['GitHub', ['깃 허브', '깃허브']],
  ['GitLab', ['깃 랩', '깃랩']],
  ['Node.js', ['노드 제이 에스', '노드 제이에스']],
  ['Next.js', ['넥스트 제이 에스', '넥스트 제이에스']],
  ['Vue.js', ['뷰 제이 에스', '뷰 제이에스']],
  ['WebSocket', ['웹 소켓', '웹소켓']],
  ['provider', ['프로바이더']],
  ['orchestrator', ['오케스트레이터']],
  ['TypeScript', ['타입 스크립트', '타입스크립트']],
  ['JavaScript', ['자바 스크립트', '자바스크립트']],
  ['Tailwind CSS', ['테일윈드 씨 에스 에스', '테일윈드 씨에스에스']],
  ['AI', ['에이 아이', '에이아이']],
  ['API', ['에이 피 아이', '에이피아이']],
  ['CLI', ['씨 엘 아이', '씨엘아이']],
  ['GUI', ['지 유 아이', '지유아이']],
  ['UI', ['유 아이', '유아이']],
  ['UX', ['유 엑스', '유엑스']],
  ['LLM', ['엘 엘 엠', '엘엘엠']],
  ['STT', ['에스 티 티', '에스티티']],
  ['TTS', ['티 티 에스', '티티에스']],
  ['GPT', ['지 피 티', '지피티']],
  ['RAG', ['래그', '알 에이 지']],
  ['MCP', ['엠 씨 피', '엠시피']],
  ['PTY', ['피 티 와이', '피티와이']],
  ['PM2', ['피 엠 투', '피엠투']],
  ['IDE', ['아이 디 이', '아이디이']],
  ['SDK', ['에스 디 케이', '에스디케이']],
  ['URL', ['유 알 엘', '유알엘']],
  ['HTTPS', ['에이치 티 티 피 에스', '에이치티티피에스']],
  ['HTTP', ['에이치 티 티 피', '에이치티티피']],
  ['HTML', ['에이치 티 엠 엘', '에이치티엠엘']],
  ['CSS', ['씨 에스 에스', '씨에스에스']],
  ['SQL', ['에스 큐 엘', '에스큐엘', '시퀄']],
  ['JSON', ['제이슨', '제이 에스 오 엔']],
  ['YAML', ['야믈', '와이 에이 엠 엘']],
  ['XML', ['엑스 엠 엘', '엑스엠엘']],
  ['CSV', ['씨 에스 브이', '씨에스브이']],
  ['PDF', ['피 디 에프', '피디에프']],
  ['OCR', ['오 씨 알', '오시알']],
  ['CPU', ['씨 피 유', '씨피유']],
  ['GPU', ['지 피 유', '지피유']],
  ['RAM', ['램']],
  ['Claude', ['클로드']],
  ['Codex', ['코덱스', '코댁스']],
  ['Gemini', ['제미나이', '재미나이']],
  ['Whisper', ['위스퍼']],
  ['Copilot', ['코파일럿']],
  ['Git', ['깃']],
  ['React', ['리액트']],
  ['Electron', ['일렉트론']],
  ['Playwright', ['플레이라이트']],
  ['Python', ['파이썬']],
  ['Docker', ['도커']],
  ['Kubernetes', ['쿠버네티스', '쿠버네티즈']],
  ['Markdown', ['마크다운']],
  ['npm', ['엔 피 엠', '엔피엠']],
  ['npx', ['엔 피 엑스', '엔피엑스']],
  ['pnpm', ['피 엔 피 엠', '피엔피엠']],
  ['macOS', ['맥 오 에스', '맥오에스']],
  ['Windows', ['윈도우즈', '윈도우']],
  ['Linux', ['리눅스']],
  ['prompt', ['프롬프트']],
  ['token', ['토큰']],
  ['context', ['컨텍스트']],
  ['agent', ['에이전트']],
  ['workflow', ['워크플로', '워크플로우']],
  ['repository', ['리포지토리', '레포지토리']],
  ['branch', ['브랜치']],
  ['commit', ['커밋']],
  ['merge', ['머지']],
  ['rebase', ['리베이스']],
  ['debug', ['디버그']],
  ['build', ['빌드']],
  ['deploy', ['디플로이']],
  ['release', ['릴리즈']],
  ['plugin', ['플러그인']],
  ['clipboard', ['클립보드']],
  ['screenshot', ['스크린샷']],
  ['download', ['다운로드']],
  ['upload', ['업로드']],
]

const TERM_SEPARATOR = String.raw`[\s.,!?…:;"'“”‘’()[\]{}<>/\\]`
const KOREAN_SUFFIX = String.raw`(?:은|는|이|가|을|를|에|에서|에게|으로|로|와|과|도|만|의|부터|까지|보다|처럼|랑|라는|이라고|라고|하고|해|해서|해도|해줘|해주세요|하면|하며|했다|했어|하는|한|할|하지)`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createTermPattern(variants: readonly string[]): RegExp {
  const alternatives = variants
    .map((variant) => variant.trim().split(/\s+/).map(escapeRegExp).join(String.raw`\s*`))
    .sort((left, right) => right.length - left.length)
    .join('|')
  const suffix = String.raw`(?=$|${TERM_SEPARATOR}|${KOREAN_SUFFIX}(?=$|${TERM_SEPARATOR}))`
  return new RegExp(String.raw`(?<![가-힣A-Za-z0-9])(?:${alternatives})${suffix}`, 'giu')
}

const TRANSCRIPT_RESTORE_MAP: readonly [RegExp, string][] = [
  ...SYSTEM_TERM_RULES,
  ...ENGLISH_TERM_RULES,
].map(([replacement, variants]) => [createTermPattern(variants), replacement])

export function normalizeTranscript(text: string): string {
  return TRANSCRIPT_RESTORE_MAP.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text.trim(),
  )
}
