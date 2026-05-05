import * as sc from './system-control'
import { processWithAI, searchWithGemini } from './nco-client'
import { executeWithClaude } from './claude-terminal'
import { getCapturedSelectedText, getPreviousAppName, getPreviousBundleId } from './appState'
import { injectText } from './injector'
import { clipboard } from 'electron'
import type { CommandResult } from './system-control'
import os from 'os'

// OS-aware primary modifier (Cmd on Mac, Ctrl on Win/Linux)
const MOD = process.platform === 'darwin' ? 'command' : 'control'

// ==================== Command Definition ====================

export interface VoiceCommand {
  id: string
  patterns: RegExp[]
  action: (match: RegExpMatchArray) => Promise<CommandResult>
  dangerous: boolean
  description: string
}

// App name aliases (Korean → actual app name)
const APP_ALIASES: Record<string, string> = {
  '크롬': 'Google Chrome', '구글': 'Google Chrome', 'chrome': 'Google Chrome',
  '사파리': 'Safari', 'safari': 'Safari',
  '파이어폭스': 'Firefox', 'firefox': 'Firefox',
  '파인더': 'Finder', 'finder': 'Finder',
  '터미널': 'Terminal', 'terminal': 'Terminal',
  '메모': 'Notes', '노트': 'Notes', 'notes': 'Notes',
  '캘린더': 'Calendar', '달력': 'Calendar', 'calendar': 'Calendar',
  '메일': 'Mail', 'mail': 'Mail',
  '메시지': 'Messages', '문자': 'Messages', 'messages': 'Messages',
  '음악': 'Music', 'music': 'Music',
  '설정': 'System Settings', 'settings': 'System Settings',
  '카카오톡': 'KakaoTalk', '카톡': 'KakaoTalk',
  '슬랙': 'Slack', 'slack': 'Slack',
  '디스코드': 'Discord', 'discord': 'Discord',
  '노션': 'Notion', 'notion': 'Notion',
  '코드': 'Visual Studio Code', 'vscode': 'Visual Studio Code',
  '커서': 'Cursor', 'cursor': 'Cursor',
  '텍스트편집기': 'TextEdit', 'textedit': 'TextEdit',
  '미리보기': 'Preview', 'preview': 'Preview',
  '계산기': 'Calculator', 'calculator': 'Calculator',
  '활성상태보기': 'Activity Monitor',
  '브라우저': 'Google Chrome', 'browser': 'Google Chrome',
  '인터넷': 'Google Chrome', 'internet': 'Google Chrome',
  '웹': 'Google Chrome', 'web': 'Google Chrome',
  '스포티파이': 'Spotify', 'spotify': 'Spotify',
  '줌': 'zoom.us', 'zoom': 'zoom.us',
  '팀즈': 'Microsoft Teams', 'teams': 'Microsoft Teams',
}

// 음성 인식에서 흔한 필러/잡음 단어 제거
const FILLER_WORDS = /^(그럼|그러면|음|어|자|좀|이제|그|저|한번|혹시|그냥)\s+/g

// Whisper 오인식 보정 맵 (발음 유사 오탈자 → 올바른 단어)
const MISRECOGNITION_MAP: Record<string, string> = {
  '보라우저': '브라우저',
  '부라우저': '브라우저',
  '브라우져': '브라우저',
  '크로음': '크롬',
  '크로옴': '크롬',
  '크룸': '크롬',
  '그롬': '크롬',
  '크론': '크롬',
  '그론': '크롬',
  '크롱': '크롬',
  '그럼': '크롬',
  '크라운': '크롬',
  '클롬': '크롬',
  '크름': '크롬',
  '사파이': '사파리',
  '파인드': '파인더',
  '파이어폭스': '파이어폭스',
  '카카오톡': '카카오톡',
  '카카오': '카카오톡',
  '디스코트': '디스코드',
  '디코': '디스코드',
  '노숀': '노션',
  '스포티파이': '스포티파이',
  '스포티파': '스포티파이',
}

// 한국어 조사 제거 (을/를/이/가/은/는/의/에/에서/으로/로/도/만/좀)
const PARTICLES = /(을|를|이|가|은|는|의|에서|에|으로|로|도|만|좀)$/

function cleanVoiceInput(name: string): string {
  let cleaned = name.trim().toLowerCase()
  // 필러 단어를 반복 제거 (앞쪽에 여러 개 붙을 수 있음)
  let prev = ''
  while (prev !== cleaned) {
    prev = cleaned
    cleaned = cleaned.replace(FILLER_WORDS, '')
  }
  // 오인식 보정
  for (const [wrong, right] of Object.entries(MISRECOGNITION_MAP)) {
    if (cleaned.includes(wrong)) {
      cleaned = cleaned.replace(wrong, right)
    }
  }
  // 조사 제거 ("브라우저를" → "브라우저", "크롬을" → "크롬")
  cleaned = cleaned.replace(PARTICLES, '')
  return cleaned.trim()
}

function resolveApp(name: string): string {
  const cleaned = cleanVoiceInput(name)

  // 1. 전체 문자열로 먼저 매칭
  if (APP_ALIASES[cleaned]) return APP_ALIASES[cleaned]

  // 2. 원본(소문자)으로 매칭
  const lower = name.trim().toLowerCase()
  if (APP_ALIASES[lower]) return APP_ALIASES[lower]

  // 3. 복합 이름: 각 단어별로 매칭 시도 ("크롬 브라우저" → "크롬" 또는 "브라우저")
  const words = cleaned.split(/\s+/)
  for (const word of words) {
    const cleanedWord = word.replace(PARTICLES, '')
    if (APP_ALIASES[cleanedWord]) return APP_ALIASES[cleanedWord]
  }

  // 4. 매칭 실패 — 정리된 이름 반환
  return cleaned || name.trim()
}

// ==================== Command Registry ====================

export const COMMANDS: VoiceCommand[] = [
  // --- App Control ---
  {
    id: 'open_app',
    patterns: [
      /(.+?)\s*(열어|실행|켜|시작|열기|실행해|켜줘|시작해|시작하자|열어줘)/,
      /^open\s+(.+)/i,
      /^launch\s+(.+)/i,
    ],
    action: async (m) => sc.openApp(resolveApp(m[1])),
    dangerous: false,
    description: '앱 열기'
  },
  {
    id: 'close_app',
    patterns: [
      /(.+?)\s*(닫아|종료|꺼|닫기|종료해|꺼줘|끄자|닫아줘)/,
      /^close\s+(.+)/i,
      /^quit\s+(.+)/i,
    ],
    action: async (m) => sc.closeApp(resolveApp(m[1])),
    dangerous: true,
    description: '앱 종료'
  },
  {
    id: 'switch_app',
    patterns: [
      /(.+?)\s*(으로|로)\s*(전환|이동|바꿔|가자|가줘|전환해)/,
      /^switch\s+(?:to\s+)?(.+)/i,
    ],
    action: async (m) => sc.switchApp(resolveApp(m[1])),
    dangerous: false,
    description: '앱 전환'
  },

  // --- Window ---
  {
    id: 'minimize',
    patterns: [/최소화/, /minimize/i],
    action: async () => sc.minimizeWindow(),
    dangerous: false,
    description: '창 최소화'
  },
  {
    id: 'maximize',
    patterns: [/최대화|전체\s*화면/, /maximize|full\s*screen/i],
    action: async () => sc.maximizeWindow(),
    dangerous: false,
    description: '창 최대화'
  },

  // --- Volume ---
  {
    id: 'volume_up',
    patterns: [/볼륨\s*(올려|높여|크게|업|올려줘)/, /volume\s*up/i, /louder/i],
    action: async () => sc.volumeUp(10),
    dangerous: false,
    description: '볼륨 올리기'
  },
  {
    id: 'volume_down',
    patterns: [/볼륨\s*(내려|낮춰|작게|다운|내려줘)/, /volume\s*down/i, /quieter/i],
    action: async () => sc.volumeDown(10),
    dangerous: false,
    description: '볼륨 내리기'
  },
  {
    id: 'mute',
    patterns: [/음소거|뮤트|소리\s*꺼/, /^mute$/i],
    action: async () => sc.mute(),
    dangerous: false,
    description: '음소거'
  },
  {
    id: 'unmute',
    patterns: [/음소거\s*해제|뮤트\s*해제|소리\s*켜/, /^unmute$/i],
    action: async () => sc.unmute(),
    dangerous: false,
    description: '음소거 해제'
  },

  // --- Browser ---
  {
    id: 'new_tab',
    patterns: [/새\s*탭|탭\s*열어/, /new\s*tab/i],
    action: async () => sc.sendKeystroke('t', [MOD]),
    dangerous: false,
    description: '새 탭'
  },
  {
    id: 'browser_back',
    patterns: [/뒤로\s*(가|가기|가줘)/, /go\s*back/i],
    action: async () => sc.browserBack(),
    dangerous: false,
    description: '뒤로 가기'
  },
  {
    id: 'refresh',
    patterns: [/새로\s*고침|리프레시|갱신/, /refresh|reload/i],
    action: async () => sc.refreshPage(),
    dangerous: false,
    description: '새로고침'
  },
  {
    id: 'web_search',
    patterns: [
      /(.+?)\s*(검색|찾아|찾아줘|검색해|검색해줘)/,
      /^search\s+(?:for\s+)?(.+)/i,
      /^google\s+(.+)/i,
    ],
    action: async (m) => sc.webSearch(m[1]),
    dangerous: false,
    description: '웹 검색'
  },
  {
    id: 'open_url',
    patterns: [
      /(.+\.(?:com|net|org|io|dev|kr|co\.kr))\s*(열어|열기|가|가자|접속)?/i,
      /^(?:go\s+to|open)\s+(https?:\/\/.+)/i,
    ],
    action: async (m) => sc.openURL(m[1]),
    dangerous: false,
    description: 'URL 열기'
  },

  // --- System ---
  {
    id: 'screenshot',
    patterns: [/스크린샷|캡처|화면\s*캡처|스샷/, /screenshot|capture/i],
    action: async () => sc.takeScreenshot(),
    dangerous: false,
    description: '스크린샷'
  },
  {
    id: 'lock',
    patterns: [/잠금|잠가|잠가줘|화면\s*잠금/, /lock\s*screen|lock/i],
    action: async () => sc.lockScreen(),
    dangerous: true,
    description: '화면 잠금'
  },
  {
    id: 'sleep',
    patterns: [/절전|슬립|재워|잠자기/, /^sleep$/i],
    action: async () => sc.sleepSystem(),
    dangerous: true,
    description: '절전 모드'
  },
  {
    id: 'open_downloads',
    patterns: [/다운로드\s*(폴더)?(\s*열어)?/, /downloads/i],
    action: async () => sc.openFolder(os.homedir() + '/Downloads'),
    dangerous: false,
    description: '다운로드 폴더 열기'
  },
  {
    id: 'open_documents',
    patterns: [/문서\s*(폴더)?(\s*열어)?/, /documents/i],
    action: async () => sc.openFolder(os.homedir() + '/Documents'),
    dangerous: false,
    description: '문서 폴더 열기'
  },
  {
    id: 'open_desktop',
    patterns: [/데스크톱|바탕화면/, /desktop/i],
    action: async () => sc.openFolder(os.homedir() + '/Desktop'),
    dangerous: false,
    description: '바탕화면 열기'
  },

  // --- Keyboard shortcuts ---
  {
    id: 'copy',
    patterns: [/복사|카피/, /^copy$/i],
    action: async () => sc.sendKeystroke('c', [MOD]),
    dangerous: false,
    description: '복사'
  },
  {
    id: 'paste',
    patterns: [/붙여넣기|붙여넣어|페이스트/, /^paste$/i],
    action: async () => sc.sendKeystroke('v', [MOD]),
    dangerous: false,
    description: '붙여넣기'
  },
  {
    id: 'undo',
    patterns: [/실행\s*취소|되돌리기|언두/, /^undo$/i],
    action: async () => sc.sendKeystroke('z', [MOD]),
    dangerous: false,
    description: '실행 취소'
  },
  {
    id: 'select_all',
    patterns: [/전체\s*선택|모두\s*선택/, /select\s*all/i],
    action: async () => sc.sendKeystroke('a', [MOD]),
    dangerous: false,
    description: '전체 선택'
  },
  {
    id: 'save',
    patterns: [/저장|세이브/, /^save$/i],
    action: async () => sc.sendKeystroke('s', [MOD]),
    dangerous: false,
    description: '저장'
  },

  // --- System Info ---
  {
    id: 'memory_info',
    patterns: [
      /(현재\s*)?메모리\s*(얼마|사용량|사용|상태|현황|확인|알려줘|어때|몇)/,
      /(현재\s*)?램\s*(얼마|사용량|사용|상태|확인|알려줘)/,
      /메모리.*사용/,
      /memory\s*(status|usage|check)/i,
    ],
    action: async () => sc.getMemoryInfo(),
    dangerous: false,
    description: '메모리 사용량 확인'
  },
  {
    id: 'cpu_info',
    patterns: [
      /(현재\s*)?cpu\s*(얼마|사용량|사용|상태|확인|알려줘|어때)/i,
      /(현재\s*)?씨피유\s*(얼마|사용|상태|확인)/,
      /cpu.*사용/i,
      /프로세서\s*(상태|사용|확인)/,
    ],
    action: async () => sc.getCpuUsage(),
    dangerous: false,
    description: 'CPU 사용률 확인'
  },
  {
    id: 'disk_info',
    patterns: [
      /(현재\s*)?디스크\s*(얼마|사용량|사용|상태|용량|확인|알려줘)/,
      /(현재\s*)?저장\s*공간\s*(얼마|남았|확인|알려줘)/,
      /디스크.*용량/,
      /disk\s*(usage|status|check)/i,
    ],
    action: async () => sc.getDiskInfo(),
    dangerous: false,
    description: '디스크 사용량 확인'
  },
  {
    id: 'system_info',
    patterns: [
      /(현재\s*)?시스템\s*(상태|정보|현황|확인|알려줘)/,
      /(현재\s*)?컴퓨터\s*(상태|정보|사양|어때)/,
      /system\s*(status|info|check)/i,
    ],
    action: async () => sc.getSystemInfo(),
    dangerous: false,
    description: '시스템 전체 정보'
  },

  // --- Calendar ---
  {
    id: 'calendar_today',
    patterns: [
      /오늘\s*(일정|스케줄|약속)(\s*알려줘|\s*보여줘|\s*확인|\s*뭐야|\s*있어)?/,
      /today'?s?\s*(schedule|calendar|events?)/i,
    ],
    action: async () => sc.getCalendarEvents('today'),
    dangerous: false,
    description: '오늘 일정 확인'
  },
  {
    id: 'calendar_tomorrow',
    patterns: [
      /내일\s*(일정|스케줄|약속)(\s*알려줘|\s*보여줘|\s*확인|\s*뭐야|\s*있어)?/,
      /tomorrow'?s?\s*(schedule|calendar|events?)/i,
    ],
    action: async () => sc.getCalendarEvents('tomorrow'),
    dangerous: false,
    description: '내일 일정 확인'
  },
  {
    id: 'calendar_week',
    patterns: [
      /(이번\s*주|금주)\s*(일정|스케줄|약속)(\s*알려줘|\s*보여줘|\s*확인)?/,
      /this\s*week'?s?\s*(schedule|calendar|events?)/i,
    ],
    action: async () => sc.getCalendarEvents('week'),
    dangerous: false,
    description: '이번 주 일정 확인'
  },
  {
    id: 'calendar_add',
    patterns: [
      /(.+?)\s*(일정|약속)\s*(추가|등록|만들어|넣어)(\s*줘)?/,
      /add\s+(?:event|appointment)\s+(.+)/i,
    ],
    action: async (m) => sc.addCalendarEvent(m[1]),
    dangerous: false,
    description: '일정 추가'
  },

  // --- Contacts ---
  {
    id: 'contacts_search',
    patterns: [
      /(.+?)\s*(연락처|전화번호)(\s*찾아줘|\s*알려줘|\s*검색|\s*뭐야)?/,
      /find\s+contact\s+(.+)/i,
    ],
    action: async (m) => sc.searchContacts(m[1]),
    dangerous: false,
    description: '연락처 검색'
  },

  // --- Weather ---
  {
    id: 'weather',
    patterns: [
      /^(서울|부산|대구|인천|광주|대전|수원|제주|강남|홍대|신촌|강릉|속초|경주|전주|평택|용인|성남|파주|고양|의정부|양주|구리|남양주|하남|광명|시흥|안양|안산|화성|오산|이천|여주|포천|가평|동두천|연천|과천|의왕|군포|안성|김포|광주|양평)\s*날씨(\s*알려줘|\s*어때|\s*확인)?/,
      /^경기도?\s+(\S+?)\s*날씨(\s*알려줘|\s*어때|\s*확인)?$/,
      /^(오늘|지금|현재)\s*날씨(\s*알려줘|\s*어때)?$/,
      /^날씨(\s*알려줘|\s*어때|\s*확인)?$/,
      /weather\s*(?:in|at|for)?\s*(seoul|busan|korea)/i,
    ],
    action: async (m) => {
      const raw = (m[1] || '').trim()
      const skipWords = ['지금', '현재', '오늘', '내일', '이번주', '요즘', '최근', '']
      const location = skipWords.includes(raw) ? '서울' : (raw || '서울')
      try {
        // Claude Code CLI — AI Terminal 패널에 스트리밍 표시
        const result = await executeWithClaude(
          `${location} 현재 날씨를 알려줘. bash로 "curl -s 'wttr.in/${encodeURIComponent(location)}?format=3'" 명령을 실행하거나 WebSearch로 확인해서 기온, 날씨 상태를 1-2줄로 알려줘.`,
          { notify: true }
        )
        if (result && result.trim()) {
          return { success: true, message: result.trim() }
        }
        throw new Error('empty response')
      } catch {
        // Fallback: Open-Meteo API (free, no key)
        return sc.getWeather(location)
      }
    },
    dangerous: false,
    description: '날씨 확인'
  },

  // --- Reminders ---
  {
    id: 'reminder_add',
    patterns: [
      /(.+?)\s*(리마인더|알림)\s*(추가|설정|만들어|등록)(\s*줘)?/,
      /(.+?)\s*기억해줘/,
      /remind\s+(?:me\s+(?:to\s+|about\s+))?(.+)/i,
    ],
    action: async (m) => sc.addReminder(m[1] || m[2] || ''),
    dangerous: false,
    description: '리마인더 추가'
  },

  // --- Translate Selected Text ---
  {
    id: 'translate_selected_en',
    patterns: [
      /선택(된|한)?\s*(텍스트|글|내용|것)?\s*(영어로|영문으로)\s*(번역|translate)/i,
      /선택(된|한)?\s*(텍스트|글|내용|것)?\s*(번역|translate)\s*(영어로|영문으로|to\s*english)?/i,
      /지금\s*(선택된|선택한)?\s*(텍스트|글|내용)?\s*(영어로|영문으로)?\s*(번역|translate)/i,
      /translate\s*(selected|this|the)?\s*(text|selection)?\s*(to\s*english)?/i,
      /(이\s*텍스트|이거|이것)\s*(영어로|영문으로)\s*(번역|translate)/i,
    ],
    action: async (): Promise<CommandResult> => {
      // 1. 캡처된 선택 텍스트 가져오기
      const selectedText = getCapturedSelectedText() || clipboard.readText()
      if (!selectedText || !selectedText.trim()) {
        return { success: false, message: '선택된 텍스트가 없습니다. 번역할 텍스트를 먼저 선택해주세요.' }
      }

      try {
        // 2. AI로 영어 번역
        const result = await processWithAI({
          text: '',
          prompt: `Translate the following text to natural English. Output only the translation:\n\n${selectedText}`,
          provider: 'auto',
          voiceFastPath: true
        })
        const translated = result.text.trim()
        if (!translated) {
          return { success: false, message: '번역 실패: 빈 응답' }
        }

        // 3. 번역 결과를 이전 앱에 주입 (클립보드 경유 Paste)
        const appName = getPreviousAppName()
        const bundleId = getPreviousBundleId()
        await injectText(translated, appName || undefined, bundleId || undefined)

        const preview = translated.length > 60 ? translated.substring(0, 60) + '…' : translated
        return { success: true, message: `번역 완료: ${preview}` }
      } catch (e) {
        return { success: false, message: `번역 오류: ${(e as Error).message.substring(0, 80)}` }
      }
    },
    dangerous: false,
    description: '선택된 텍스트 영어로 번역'
  },
]

// ==================== Command Parser ====================

export interface ParsedCommand {
  command: VoiceCommand
  match: RegExpMatchArray
}

export function parseCommand(text: string): ParsedCommand | null {
  const normalized = text.trim().toLowerCase()

  for (const cmd of COMMANDS) {
    for (const pattern of cmd.patterns) {
      const match = normalized.match(pattern)
      if (match) {
        return { command: cmd, match }
      }
    }
  }
  return null
}

// LLM fallback: parse natural language command via AI
export async function parseCommandWithLLM(text: string): Promise<ParsedCommand | null> {
  const appList = Object.entries(APP_ALIASES).filter(([k]) => /[가-힣]/.test(k)).map(([k, v]) => `${k}=${v}`).join(', ')
  const systemPrompt = `You are a voice command parser for ${process.platform === 'darwin' ? 'macOS' : 'Windows'}.
Given a user's voice input, determine if it's a PC control command.
If it IS a command, respond with ONLY a JSON object: {"action":"<action_id>","target":"<actual_app_name>"}
IMPORTANT: For target, use the ACTUAL application name, not the Korean alias.
Known app aliases: ${appList}
Possible actions: open_app, close_app, switch_app, minimize, maximize, volume_up, volume_down, mute, unmute, new_tab, browser_back, refresh, web_search, screenshot, lock, sleep, copy, paste, undo, save, select_all, open_url, memory_info, cpu_info, disk_info, system_info, calendar_today, calendar_tomorrow, calendar_week, calendar_add, contacts_search, weather, reminder_add, translate_selected_en
For web_search, put the search query in "target".
For open_url, put the URL in "target". For "네이버" use "https://naver.com", for "구글" use "https://google.com", for "유튜브" use "https://youtube.com".
For translate_selected_en, use when user says "선택된 텍스트 영어로 번역", "이거 영어로 번역", "translate selected text to English", etc. No target needed.
If it is NOT a command (just regular speech), respond with: {"action":"none"}
Respond with JSON only, no explanation.
User input: "${text}"`

  try {
    const result = await processWithAI({
      text: '',
      prompt: systemPrompt,
      provider: 'auto'
    })

    const parsed = JSON.parse(result.text.trim())
    if (parsed.action === 'none') return null

    // Find matching command by action id
    const cmd = COMMANDS.find(c => c.id === parsed.action)
    if (!cmd) return null

    // Create a synthetic match with the target
    const fakeMatch = [text, parsed.target || ''] as unknown as RegExpMatchArray
    return { command: cmd, match: fakeMatch }
  } catch {
    return null
  }
}

// Full parse pipeline: regex first, then LLM
export async function parseVoiceCommand(text: string, useLLM = true): Promise<ParsedCommand | null> {
  // Tier 1: Pattern matching
  const regexResult = parseCommand(text)
  if (regexResult) {
    console.log(`[VoiceCmd] Regex match: ${regexResult.command.id}`)
    return regexResult
  }

  // Tier 2: LLM fallback
  if (useLLM) {
    console.log(`[VoiceCmd] No regex match, trying LLM...`)
    const llmResult = await parseCommandWithLLM(text)
    if (llmResult) {
      console.log(`[VoiceCmd] LLM match: ${llmResult.command.id}`)
      return llmResult
    }
  }

  console.log(`[VoiceCmd] No command recognized in: "${text}"`)
  return null
}
