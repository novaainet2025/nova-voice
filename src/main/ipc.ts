import { ipcMain, BrowserWindow, app } from 'electron'
import { initClaudeTerminal, executeWithClaude, sendClaudeInput, getClaudeStatus } from './claude-terminal'
import { getHistory, searchHistory, deleteTranscription, saveTranscription } from './db'
import { transcribe, getModelsDir, getAvailableModels } from './whisper'
import { injectText } from './injector'
import { getOverlayWindow, hideOverlay, getCapturedSelectedText, getPreviousAppName, getPreviousBundleId } from './appState'
import { processWithAI, processWithClaude, searchWithGemini, processImageWithGemini, processImageWithOllama, isOllamaAvailable, getProviderStatus, startDiscussion, startParallel, startAgent, startHive, startConductor, summarizeWithGemini, checkAllProviders } from './nco-client'
import { parseVoiceCommand, parseCommand } from './voice-commands'
import { showNotification, captureScreenBase64 } from './system-control'
import { pipelineSpeak, pipelineSpeakStreaming, getPipelineStatus, initPipeline, setPipelineConfig, getPipelineConfig } from './pipeline'
import { createPTY, writeToPTY, resizePTY, destroyPTY, typeCommandInPTY, isPTYReady, startPTYResponseCapture } from './pty'
import { smartSpeak, getSpeakers, MLX_VOICES, setMLXVoice, getMLXVoice,
  getTTSServerStatuses, startTTSServer, stopTTSServer, previewTTSVoice,
  SAY_VOICES, setActiveTTSModel, setActiveSayVoice, getActiveTTSModel } from './tts-client'
import { BUILTIN_MODES } from '../shared/types'
import type { AppSettings, TranscriptionResult, AIMode } from '../shared/types'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import {
  isProviderHealthy, recordProviderSuccess, recordProviderFailure,
  describeAppliedFix, getHealthSnapshots
} from './self-heal'
import { NCO_FULL_CONTEXT, NCO_CODING_CONTEXT, VOICE_ANSWER_GUIDE } from './nova-context'

const DEFAULT_SETTINGS: AppSettings = {
  shortcut: 'Ctrl+Shift+Space',
  language: 'auto',
  modelPath: '',
  modelName: 'large-v3-turbo',
  autoInject: true,
  showOverlay: true,
  theme: 'dark',
  overlayPosition: 'center',
  aiMode: 'direct',
  aiProvider: 'auto',
  customModes: [],
  ttsModel: 'mlx',
  sayVoice: 'Yuna',
  mlxVoice: 'Ryan',
}

// 설정 파일 경로 — app.ready 이후에만 호출 가능
let _settingsPath: string | null = null
function getSettingsPath(): string {
  if (!_settingsPath) {
    _settingsPath = path.join(app.getPath('userData'), 'nova-settings.json')
  }
  return _settingsPath
}

function loadSettingsFromDisk(): AppSettings {
  try {
    const p = getSettingsPath()
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw)
    console.log('[Settings] Loaded from', p)
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    console.log('[Settings] No saved settings, using defaults')
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettingsToDisk(s: AppSettings): void {
  try {
    const p = getSettingsPath()
    fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf-8')
    console.log('[Settings] Saved to', p)
  } catch (e) {
    console.error('[Settings] Failed to save:', e)
  }
}

// 모듈 레벨에서는 기본값만 — setupIPC에서 파일로부터 로드
let settings: AppSettings = { ...DEFAULT_SETTINGS }

let isRecording = false

function getActiveMode(): AIMode | undefined {
  const allModes = [...BUILTIN_MODES, ...settings.customModes]
  return allModes.find(m => m.id === settings.aiMode)
}

// Smart Mode intent 분류 결과 캐시 (50-slot LRU, TTL 없음 — 세션 내 재사용)
const intentCache = new Map<string, { intent: string; ncoSubtype: string }>()
const INTENT_CACHE_MAX = 50

// ── Debug log ring buffer (main → renderer 실시간 스트리밍) ──────────────────
export interface DebugLogEntry { ts: number; level: 'info' | 'warn' | 'error' | 'success'; msg: string }
const debugLogBuffer: DebugLogEntry[] = []
const DEBUG_LOG_MAX = 300

function debugBroadcast(level: DebugLogEntry['level'], msg: string) {
  const entry: DebugLogEntry = { ts: Date.now(), level, msg }
  debugLogBuffer.push(entry)
  if (debugLogBuffer.length > DEBUG_LOG_MAX) debugLogBuffer.splice(0, debugLogBuffer.length - DEBUG_LOG_MAX)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('debug:log', entry)
  }
}

// Claude 폴백 실패 시 자가개선 분석 — Claude CLI에게 에러 원인+해결책 문의
// Rate-limit: 최소 60초 간격 (비용·지연 방지)
let _lastAskClaudeForFixTs = 0
const ASK_CLAUDE_FIX_INTERVAL = 60_000

async function askClaudeForFix(errorContext: string, originalQuery: string): Promise<void> {
  const now = Date.now()
  if (now - _lastAskClaudeForFixTs < ASK_CLAUDE_FIX_INTERVAL) {
    const remainSec = Math.ceil((ASK_CLAUDE_FIX_INTERVAL - (now - _lastAskClaudeForFixTs)) / 1000)
    debugBroadcast('info', `[자가개선] 쿨다운 중 — ${remainSec}초 후 재요청 가능`)
    return
  }
  _lastAskClaudeForFixTs = now
  try {
    const healthInfo = getHealthSnapshots().map(h =>
      `${h.provider}: ${h.healthy ? '정상' : `쿨다운 ${h.cooldownRemainSec}s, 에러: ${h.lastError.substring(0, 80)}`}`
    ).join('\n')
    const prompt = `Nova Voice 앱에서 다음 에러가 발생했습니다:\n\n${errorContext}\n\n프로바이더 상태:\n${healthInfo}\n\n사용자 질문: "${originalQuery}"\n\n에러 원인과 즉시 적용 가능한 해결책을 2-3줄로 알려줘. 코드 변경이 필요하면 파일명과 핵심 코드만.`
    debugBroadcast('info', '[자가개선] Claude에게 에러 분석 요청 중...')
    const result = await processWithClaude(prompt)
    if (result.text) {
      debugBroadcast('success', `[자가개선 제안]\n${result.text}`)
    }
  } catch (e) {
    debugBroadcast('warn', `[자가개선] Claude 분석 실패: ${(e as Error).message}`)
  }
}

/**
 * TTS 출력 필터 — 짧은 답변/알림/명령 완료만 음성으로 읽음.
 * 긴 터미널 출력, 코드, NCO 토론 결과는 건너뜀.
 * @returns 읽을 텍스트 (또는 null = 건너뜀)
 */
function prepareSpeakText(text: string, aiResult?: string): string | null {
  if (!text?.trim()) return null

  // Claude CLI 라우팅 결과 — 터미널 출력이므로 TTS 건너뜀
  if (aiResult?.startsWith('[Smart→Claude]')) return null

  // Smart→Answer/Search/Screen/Error — smartSpeak()이 이미 직접 호출했으므로 중복 방지
  if (aiResult?.startsWith('[Smart→Answer') ||
      aiResult?.startsWith('[Smart→Search') ||
      aiResult?.startsWith('[Smart→Screen')) return null

  // NCO 협업/코딩 결과 — 길고 구조적이어서 음성 부적합
  if (aiResult?.startsWith('[Smart→Discussion]') ||
      aiResult?.startsWith('[Smart→Team]') ||
      aiResult?.startsWith('[Smart→Agent]') ||
      aiResult?.startsWith('[Smart→Hive]') ||
      aiResult?.startsWith('[Smart→NCO:') ||
      aiResult?.startsWith('[Discussion]') ||
      aiResult?.startsWith('[Team]') ||
      aiResult?.startsWith('[Agent]') ||
      aiResult?.startsWith('[Hive]')) return null

  // 코드 블록 포함 시 건너뜀
  if (text.includes('```') || (text.includes('    ') && text.includes('\n'))) return null

  // 파일 경로 포함 시 건너뜀 (/var/folders/, /tmp/, ~/..., C:\...)
  if (/\/(?:var|tmp|usr|etc|home|Users|private|Library|Applications)\//i.test(text)) return null
  if (/[A-Za-z]:\\/.test(text)) return null // Windows 경로

  // URL 포함 시 건너뜀
  if (/https?:\/\/|file:\/\//.test(text)) return null

  // 임시 파일명 패턴 (NSIRD_, TemporaryItems, 긴 랜덤 hex 등)
  if (/NSIRD_|TemporaryItems|\.tmp\b|\.png\b|\.jpg\b|\.pdf\b|\.mov\b|\.mp4\b/.test(text)) return null

  // 300자 이하 → 전체 읽기
  if (text.length <= 300) return text

  // 300~600자 → 첫 문장만 읽기
  if (text.length <= 600) {
    const firstSentence = text.split(/(?<=[.!?。])\s|(?<=다)\.\s|(?<=요)\.\s/)[0]?.trim()
    if (firstSentence && firstSentence.length <= 200) return firstSentence
  }

  // 600자 초과 → TTS 건너뜀
  return null
}

export function setupIPC(mainWindow: BrowserWindow): void {
  // app.ready 이후이므로 이 시점에 파일 로드 가능
  settings = loadSettingsFromDisk()
  // 저장된 TTS 설정 즉시 적용
  setActiveTTSModel(settings.ttsModel || 'mlx')
  setActiveSayVoice(settings.sayVoice || 'Yuna')
  if (settings.mlxVoice) setMLXVoice(settings.mlxVoice)
  // pipeline speaker를 settings에서 동기화 (defaultConfig의 'sohee' 하드코딩 덮어쓰기)
  setPipelineConfig({ ttsSpeaker: settings.mlxVoice || 'Ryan' })

  // Claude Terminal 초기화
  initClaudeTerminal(mainWindow)

  // ── Claude Terminal IPC ──────────────────────────────────────────
  ipcMain.handle('claude:send', async (_event, text: string) => {
    return await sendClaudeInput(text)
  })
  ipcMain.handle('claude:status', () => getClaudeStatus())

  // 뷰 네비게이션 (main → renderer)
  ipcMain.on('view:navigate', (_event, view: string) => {
    mainWindow.webContents.send('view:navigate', view)
  })

  // Debug log history (renderer가 연결 후 과거 로그 요청)
  ipcMain.handle('debug:logs', () => debugLogBuffer.slice())

  // NCO AI 프로바이더 헬스 체크
  ipcMain.handle('nco:health', async () => {
    debugBroadcast('info', '[NCO Health] 전체 프로바이더 헬스 체크 시작...')
    const results = await checkAllProviders()
    const online = results.filter(r => r.status === 'online').length
    const offline = results.filter(r => r.status === 'offline').length
    debugBroadcast(
      offline > 0 ? 'warn' : 'success',
      `[NCO Health] 완료: ${online}/${results.length} 온라인${offline > 0 ? `, ${offline}개 오프라인` : ''}`
    )
    return results
  })

  // Settings
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_event, newSettings: Partial<AppSettings>) => {
    settings = { ...settings, ...newSettings }
    saveSettingsToDisk(settings)
    // TTS 모델/화자 변경 즉시 반영
    if (newSettings.ttsModel) setActiveTTSModel(newSettings.ttsModel)
    if (newSettings.sayVoice) setActiveSayVoice(newSettings.sayVoice)
    if (newSettings.mlxVoice) setMLXVoice(newSettings.mlxVoice)
  })

  // History
  ipcMain.handle('history:get', (_event, limit?: number, offset?: number) => {
    return getHistory(limit, offset)
  })
  ipcMain.handle('history:search', (_event, query: string) => {
    return searchHistory(query)
  })
  ipcMain.handle('history:delete', (_event, id: string) => {
    deleteTranscription(id)
  })

  // AI modes list
  ipcMain.handle('ai:modes', () => {
    return [...BUILTIN_MODES, ...settings.customModes]
  })

  // AI provider status
  ipcMain.handle('ai:status', async () => {
    return await getProviderStatus()
  })

  // Manual AI processing (for reprocessing history items etc.)
  ipcMain.handle('ai:process', async (_event, text: string, modeId: string) => {
    const allModes = [...BUILTIN_MODES, ...settings.customModes]
    const mode = allModes.find(m => m.id === modeId)
    if (!mode || mode.id === 'direct') return text

    const result = await processWithAI({
      text,
      prompt: mode.prompt,
      provider: mode.provider || settings.aiProvider
    })
    return result.text
  })

  // Audio data from renderer → transcribe → AI process → inject
  ipcMain.handle('audio:data', async (_event, buffer: ArrayBuffer) => {
    const overlayWindow = getOverlayWindow()

    try {
      const audioBuffer = Buffer.from(buffer)

      // Get model path — 가장 큰(정확한) 모델 우선 선택
      let modelPath = settings.modelPath
      if (!modelPath) {
        const models = getAvailableModels()
        if (models.length > 0) {
          // 모델 우선순위: large-v3-turbo > large > medium > small > base > tiny
          const priority = ['large-v3-turbo', 'large-v3', 'large', 'medium', 'small', 'base', 'tiny']
          const best = priority
            .map(name => models.find(m => m.name === name))
            .find(m => m !== undefined)
          modelPath = best ? best.path : models[0].path
        } else {
          modelPath = path.join(getModelsDir(), `ggml-${settings.modelName}.bin`)
        }
      }

      // Notify: transcribing
      const sendProgress = (stage: string, progress: number) => {
        mainWindow.webContents.send('transcription:progress', progress)
        mainWindow.webContents.send('ai:stage', stage)
        if (overlayWindow) {
          overlayWindow.webContents.send('transcription:progress', progress)
          overlayWindow.webContents.send('ai:stage', stage)
        }
      }

      sendProgress('transcribing', 0.3)
      debugBroadcast('info', `[Pipeline] 음성 처리 시작 — 모드: ${settings.aiMode}, 오디오: ${(audioBuffer.byteLength / 1024).toFixed(0)}KB`)
      debugBroadcast('info', `[Whisper] 음성 인식 시작... (모델: ${settings.modelName})`)

      console.log('Starting transcription...')
      const result = await transcribe(audioBuffer, {
        modelPath,
        language: settings.language
      })
      console.log(`Transcription: "${result.text}" (${result.duration.toFixed(1)}s)`)
      debugBroadcast('success', `[Whisper] 인식 완료: "${result.text.substring(0, 100)}" (${result.duration.toFixed(1)}s, lang=${result.language})`)

      let finalText = result.text
      let aiMode = settings.aiMode
      let aiResult = ''

      // ========== 선택 텍스트 요약 — 글로벌 음성 명령 ==========
      // Works in any mode: say "선택 텍스트 요약" while text is selected
      const SELECTION_SUMMARIZE_RE = /선택\s*(된\s*)?텍스트\s*(요약|정리|줄여|줄여줘|해줘)|선택한\s*(텍스트|내용|거)\s*(요약|정리|줄여)|selected\s*text\s*(summarize|summary)/i
      if (SELECTION_SUMMARIZE_RE.test(result.text.trim())) {
        const selectedText = getCapturedSelectedText()
        console.log(`[SelectionSummarize] Triggered. Captured text: ${selectedText ? `"${selectedText.substring(0, 60)}..."` : '(none)'}`)

        if (selectedText) {
          sendProgress('ai_processing', 0.5)
          try {
            const aiResponse = await processWithAI({
              text: selectedText,
              prompt: '다음 텍스트의 핵심을 3줄 이내로 간결하게 요약해주세요:\n\n',
              provider: settings.aiProvider,
              voiceFastPath: true
            })
            finalText = aiResponse.text
            aiResult = aiResponse.text
            aiMode = 'summarize'
            sendProgress('done', 1.0)

            const transcriptionResult: TranscriptionResult = {
              id: crypto.randomUUID(),
              text: `[선택 텍스트 요약] ${selectedText.substring(0, 100)}${selectedText.length > 100 ? '...' : ''}`,
              language: result.language,
              duration: result.duration,
              timestamp: Date.now(),
              modelUsed: settings.modelName,
              aiMode: 'summarize',
              aiResult: finalText
            }
            saveTranscription(transcriptionResult)
            mainWindow.webContents.send('transcription:result', transcriptionResult)
            if (overlayWindow) overlayWindow.webContents.send('transcription:result', transcriptionResult)

            await injectText(finalText, getPreviousAppName(), getPreviousBundleId())

            pipelineSpeakStreaming(finalText, 'ai_result').catch(e =>
              console.error('[TTS] SelectionSummarize speak failed:', (e as Error).message)
            )
          } catch (e) {
            console.error('[SelectionSummarize] AI failed:', (e as Error).message)
            finalText = '요약에 실패했습니다.'
          }
        } else {
          finalText = '선택된 텍스트가 없습니다. 먼저 마우스로 텍스트를 드래그해서 선택한 후 단축키를 누르세요.'
          console.log('[SelectionSummarize] No captured text')
          pipelineSpeakStreaming(finalText, 'notification').catch(() => {})
        }

        setTimeout(() => hideOverlay(), 2500)
        return finalText
      }
      // ================================================================

      const mode = getActiveMode()

      if (mode && result.text.trim()) {
        // ============= SMART MODE (3-Tier 분류: Regex → Keyword → AI) =============
        if (mode.id === 'smart') {
          const text = result.text.trim()
          console.log(`[Smart] Classifying: "${text}"`)
          debugBroadcast('info', `[Smart] 인텐트 분류 시작: "${text.substring(0, 80)}"`)

          let intent = '' // 빈 문자열 = 아직 미분류
          let ncoSubtype = '' // NCO일 때 세부 타입
          let cmdParsed: Awaited<ReturnType<typeof parseVoiceCommand>> = null

          // ── Tier 0: Regex 패턴 매칭 (0ms, 명확한 PC 명령 즉시 판별) ──
          // 짧은 입력(10자 이하)이거나, 입력 대부분이 명령 패턴인 경우에만 신뢰
          const regexMatch = parseCommand(text)
          if (regexMatch) {
            const matchLen = regexMatch.match[0].length
            const inputLen = text.length
            // 매치가 입력의 60% 이상 차지하면 명령으로 확정
            if (matchLen / inputLen >= 0.6) {
              intent = 'command'
              cmdParsed = regexMatch
              console.log(`[Smart→Tier0] Regex match: ${regexMatch.command.id} (coverage: ${Math.round(matchLen / inputLen * 100)}%)`)
              debugBroadcast('info', `[Tier0] Regex 명령 감지: ${regexMatch.command.id} (coverage ${Math.round(matchLen / inputLen * 100)}%)`)
            }
          }

          // ── Tier 0.5: screen 키워드 (0ms, 화면 분석 요청 즉시 판별) ──
          if (!intent) {
            const SCREEN_PATTERN = /화면.*(?:뭐|무엇|어떻|보여|분석|에러|오류)|지금\s*뭐\s*하고\s*있|화면\s*좀\s*봐/
            if (SCREEN_PATTERN.test(text)) {
              intent = 'screen'
              console.log(`[Smart→Tier0.5] Screen keyword detected`)
              debugBroadcast('info', '[Tier0.5] Screen 키워드 감지 → 화면 분석 모드')
            }
          }

          // ── Tier 0.5: 검색/날씨/뉴스 키워드 (0ms, 실시간 데이터가 필요한 쿼리) ──
          if (!intent) {
            const SEARCH_PATTERNS = [
              /날씨|기온|온도/, /뉴스|최신|오늘의|속보/, /주가|환율|코인|비트코인/,
              /검색해줘|찾아줘|알아봐줘/, /지금.*어때|현재.*상황/, /몇\s*도야|비.*와/
            ]
            if (SEARCH_PATTERNS.some(p => p.test(text))) {
              intent = 'search'
              console.log(`[Smart→Tier0.5] Search keyword detected`)
              debugBroadcast('info', '[Tier0.5] 검색 키워드 감지 → 실시간 검색 모드')
            }
          }

          // ── Tier 0.5: 코딩 키워드 (0ms, NCO coding 에이전트로 즉시 라우팅) ──
          if (!intent) {
            const CODE_PATTERN = /코드.*(?:고쳐|수정|작성|짜|개선|리팩터|최적화)|버그.*(?:고쳐|수정|찾아)|파일.*(?:편집|수정|만들어|고쳐)|함수.*(?:추가|만들어|고쳐)|클래스.*만들어|타입스크립트.*수정|aider|codex|코딩해줘|구현해줘/
            if (CODE_PATTERN.test(text)) {
              intent = 'nco'
              ncoSubtype = 'code'
              console.log(`[Smart→Tier0.5] Coding keyword → NCO code`)
              debugBroadcast('info', '[Tier0.5] 코딩 키워드 감지 → NCO 코딩 에이전트')
            }
          }

          // ── Tier 0.5: NCO 키워드 맵 (0ms, 명시적 NCO 요청 즉시 판별) ──
          if (!intent) {
            const NCO_KEYWORDS: Record<string, { intent: string; subtype: string }> = {
              // discuss
              '토론해': { intent: 'nco', subtype: 'discuss' },
              '토론': { intent: 'nco', subtype: 'discuss' },
              '논의해': { intent: 'nco', subtype: 'discuss' },
              '논의': { intent: 'nco', subtype: 'discuss' },
              '의견을 나눠': { intent: 'nco', subtype: 'discuss' },
              '토의': { intent: 'nco', subtype: 'discuss' },
              // team
              '팀으로': { intent: 'nco', subtype: 'team' },
              '병렬로': { intent: 'nco', subtype: 'team' },
              '동시에': { intent: 'nco', subtype: 'team' },
              '같이 분석': { intent: 'nco', subtype: 'team' },
              '팀 작업': { intent: 'nco', subtype: 'team' },
              '나눠서': { intent: 'nco', subtype: 'team' },
              // agent
              '에이전트': { intent: 'nco', subtype: 'agent' },
              '자율적으로': { intent: 'nco', subtype: 'agent' },
              '알아서 해': { intent: 'nco', subtype: 'agent' },
              '알아서': { intent: 'nco', subtype: 'agent' },
              '자동으로 해': { intent: 'nco', subtype: 'agent' },
              // hive
              '하이브': { intent: 'nco', subtype: 'hive' },
              '전체 AI': { intent: 'nco', subtype: 'hive' },
              '모든 AI': { intent: 'nco', subtype: 'hive' },
              'AI 총동원': { intent: 'nco', subtype: 'hive' },
              '다같이': { intent: 'nco', subtype: 'hive' },
              // code (explicit coding request)
              'aider': { intent: 'nco', subtype: 'code' },
              'codex': { intent: 'nco', subtype: 'code' },
              'NCO로 코딩': { intent: 'nco', subtype: 'code' },
            }

            // 긴 키워드부터 매칭 (더 구체적인 것 우선)
            const sortedKeywords = Object.keys(NCO_KEYWORDS).sort((a, b) => b.length - a.length)
            for (const kw of sortedKeywords) {
              if (text.includes(kw)) {
                const match = NCO_KEYWORDS[kw]
                intent = match.intent
                ncoSubtype = match.subtype
                console.log(`[Smart→Tier0.5] NCO keyword: "${kw}" → ${ncoSubtype}`)
                debugBroadcast('info', `[Tier0.5] NCO 키워드: "${kw}" → ${ncoSubtype}`)
                break
              }
            }
          }

          // ── Tier 1: AI 분류 (Tier 0/0.5에서 미분류된 경우만) ──
          if (!intent) {
            const cacheKey = text.trim().toLowerCase().substring(0, 100)
            if (intentCache.has(cacheKey)) {
              const cached = intentCache.get(cacheKey)!
              intent = cached.intent
              ncoSubtype = cached.ncoSubtype
              console.log(`[Smart→Cache] Hit: ${intent}${ncoSubtype ? '/' + ncoSubtype : ''}`)
              debugBroadcast('info', `[Cache Hit] ${intent}${ncoSubtype ? '/' + ncoSubtype : ''} (이전 분류 재사용)`)
            } else {
            sendProgress('ai_processing', 0.4)
            try {
              const classifyPrompt = `사용자의 음성 입력을 분류하세요. JSON만 응답하세요.

## 분류 규칙 (우선순위 순)

1. **command** — PC를 직접 조작하는 행위
   - 앱 열기/닫기/전환: "크롬 열어", "사파리 닫아"
   - 볼륨/밝기 조절: "볼륨 올려", "소리 꺼"
   - 키보드 단축키: "복사해", "붙여넣기", "저장"
   - 브라우저 검색 실행: "네이버 검색해", "구글에서 찾아"
   - 스크린샷, 잠금, 절전: "스크린샷 찍어", "화면 잠가"
   - 시스템 정보 조회: "메모리 사용량", "CPU", "디스크"
   → {"intent":"command"}

2. **screen** — 현재 화면을 보고 분석해야 하는 요청
   - 화면 상태: "화면에 뭐 있어", "지금 뭐 하고 있어"
   - 에러 분석: "이 에러 뭐야", "화면 에러 분석해줘"
   → {"intent":"screen"}

3. **nco/code** — 코드 파일 작성·수정·버그수정 (aider/codex 에이전트)
   - 코드 수정: "이 코드 버그 고쳐줘", "함수 추가해줘"
   - 파일 편집: "파일 수정해줘", "리팩터링해줘"
   - 구현: "이 기능 구현해줘", "타입스크립트로 만들어줘"
   → {"intent":"nco","subtype":"code"}

4. **nco** — 여러 AI가 협업/토론/분석해야 하는 작업
   - 토론/논의: "이 주제로 토론해", "찬반 의견 들어봐"
   - 팀 병렬: "팀으로 분석해", "병렬로 처리해"
   - 에이전트: "에이전트가 알아서 해", "자율적으로 해결해"
   - 하이브: "전체 AI 동원해", "하이브 모드", "모든 AI"
   - 복합 분석: "설계 검토해줘", "아키텍처 분석해줘"
   - NCO 사용: "NCO로 해줘", "여러 AI가 같이"
   → {"intent":"nco","subtype":"discuss|team|agent|hive"}

5. **search** — 실시간 인터넷 정보가 필요한 것
   - 날씨: "서울 날씨", "오늘 날씨 어때", "비 와?"
   - 뉴스: "최신 뉴스", "트럼프 소식"
   - 주가/환율: "삼성 주가", "달러 환율", "비트코인"
   - 실시간 데이터: "현재 미세먼지", "지금 기온"
   → {"intent":"search"}

6. **answer** — AI가 지식을 설명/생성해야 하는 것 (기본값)
   - 질문: "파이썬 리스트 설명해", "양자컴퓨터가 뭐야"
   - 번역/작문: "영어로 번역해줘", "이메일 써줘"
   - 의견/조언: "어떻게 생각해?", "추천해줘"
   → {"intent":"answer"}

## 핵심 판단 기준
- "~열어/닫아/켜/꺼" + 앱/시스템 → command
- "화면에 뭐/화면 분석/이 에러" → screen
- "코드 고쳐/버그 수정/파일 편집/구현해줘" → nco/code
- "토론/논의/팀/병렬/에이전트/하이브/설계검토" → nco
- "날씨/뉴스/주가/환율" → search
- "설명해/뭐야/알려줘" (일반 지식) → answer
- 판단 불가 → answer

입력: "${text}"
JSON만:`
              const classResult = await processWithAI({
                text: '',
                prompt: classifyPrompt,
                provider: settings.aiProvider,
                voiceFastPath: true
              })
              const parsed = JSON.parse(classResult.text.replace(/```json?\n?|\n?```/g, '').trim())
              intent = parsed.intent || 'answer'
              if (parsed.subtype) ncoSubtype = parsed.subtype
              console.log(`[Smart→Tier1] AI classified: ${intent}${ncoSubtype ? '/' + ncoSubtype : ''}`)
              debugBroadcast('info', `[Tier1 AI] 인텐트 분류: ${intent}${ncoSubtype ? '/' + ncoSubtype : ''} (AI 판단)`)
              // 캐시 저장 (LRU: 최대 50개)
              intentCache.set(cacheKey, { intent, ncoSubtype })
              if (intentCache.size > INTENT_CACHE_MAX) {
                intentCache.delete(intentCache.keys().next().value!)
              }
            } catch (e) {
              intent = 'answer'
              console.log(`[Smart] AI classification failed, defaulting to answer: ${(e as Error).message}`)
              debugBroadcast('warn', `[Tier1 AI] 분류 실패 → answer 기본값: ${(e as Error).message.substring(0, 80)}`)
            }
            } // end else (cache miss)
          }

          console.log(`[Smart] Final intent: ${intent}${ncoSubtype ? '/' + ncoSubtype : ''}`)
          debugBroadcast('info', `[Smart] 최종 인텐트: ${intent}${ncoSubtype ? '/' + ncoSubtype : ''}`)

          // ── 의도별 실행 ──

          if (intent === 'command') {
            sendProgress('command_parsing', 0.6)
            debugBroadcast('info', `[Command] 명령 파싱 시작: "${text.substring(0, 60)}"`)
            // Tier 0에서 이미 파싱된 경우 재사용, 아니면 LLM 파싱
            if (!cmdParsed) {
              cmdParsed = await parseVoiceCommand(text, true)
            }
            if (cmdParsed) {
              // 내장 명령어 매칭 → 즉시 실행 (빠름)
              console.log(`[Smart→Command] ${cmdParsed.command.id}`)
              debugBroadcast('info', `[Command] 실행: ${cmdParsed.command.id} — "${cmdParsed.command.description}"`)

              if (cmdParsed.command.dangerous) {
                await showNotification('VoiceType', `실행: ${cmdParsed.command.description}`)
              }
              const cmdResult = await cmdParsed.command.action(cmdParsed.match)
              finalText = cmdResult.message
              aiResult = `[Smart→CMD:${cmdParsed.command.id}] ${cmdResult.message}`
              await showNotification('VoiceType', cmdResult.message)
            } else {
              // ── 내장 명령어 없음 → Claude CLI로 라우팅 ──
              console.log(`[Smart→Claude] No built-in match, routing to Claude CLI: "${text}"`)
              sendProgress('ai_processing', 0.7)
              mainWindow.webContents.send('view:navigate', 'terminal')
              try {
                const claudeResult = await executeWithClaude(
                  `다음 사용자 음성 명령을 실행해주세요. 필요한 경우 터미널 명령, 앱 실행, 파일 조작 등을 직접 수행하세요:\n\n사용자 명령: "${text}"`,
                  { notify: false }
                )
                finalText = claudeResult || `[Claude 실행 완료: ${text}]`
                aiResult = `[Smart→Claude] ${finalText}`
              } catch (e) {
                console.error('[Smart→Claude] Failed:', (e as Error).message)
                finalText = `[오류] Claude 실행 실패: ${(e as Error).message}`
                aiResult = finalText
              }
            }
          }

          if (intent === 'nco') {
            sendProgress('nco_processing', 0.5)
            debugBroadcast('info', `[NCO] 모드: ${ncoSubtype || 'conductor'}, NCO 서버 요청 중...`)

            // NOVA Voice 컨텍스트를 프롬프트 앞에 주입
            const ncoPrompt = ncoSubtype === 'code'
              ? `${NCO_CODING_CONTEXT}\n\n## 사용자 요청\n${text}`
              : `${NCO_FULL_CONTEXT}\n\n## 사용자 음성 요청\n${text}`

            // NCO 결과 TTS 헬퍼 — 긴 결과의 첫 2-3문장만 읽어줌
            const speakNCOResult = (text: string, label: string) => {
              if (!text?.trim()) return
              // 마크다운 제거 후 첫 150자만
              const stripped = text
                .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
                .replace(/```[\s\S]*?```/g, '').replace(/`([^`]+)`/g, '$1')
                .replace(/^#+\s+/gm, '').replace(/^[-*•]\s+/gm, '')
                .replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim()
              // 코드 블록이 주인 경우 알림만
              const hasCode = text.includes('```') || text.includes('function ') || text.includes('const ')
              const ttsSnippet = hasCode
                ? `${label} 완료. 결과를 확인하세요.`
                : stripped.substring(0, 150)
              smartSpeak(ttsSnippet, { lang: 'ko' }).catch(e => console.error('[TTS NCO]', (e as Error).message))
            }

            try {
              if (ncoSubtype === 'code') {
                // 코딩 → conductor (복잡도 분석 후 aider/codex 자동 선택)
                console.log('[Smart→NCO Code] conductor 라우팅')
                debugBroadcast('info', '[NCO] code → conductor (aider/codex 자동 선택)')
                const r = await startConductor(ncoPrompt)
                finalText = r.text
                aiResult = `[Smart→NCO:Code] ${r.text}`
                debugBroadcast('success', `[NCO] Code 완료 (${r.mode}, ${r.text.length}자)`)
                speakNCOResult(r.text, 'NCO 코딩')
              } else if (ncoSubtype === 'discuss') {
                console.log('[Smart→NCO Discussion]')
                debugBroadcast('info', '[NCO] discussion 시작 (다중 AI 토론)...')
                const r = await startDiscussion(ncoPrompt)
                finalText = r.text
                aiResult = `[Smart→Discussion] ${r.text}`
                debugBroadcast('success', `[NCO] Discussion 완료 (참가자: ${r.participants?.join(', ')})`)
                speakNCOResult(r.text, `토론 완료 (${r.participants?.length || 0}명 참가)`)
              } else if (ncoSubtype === 'team') {
                console.log('[Smart→NCO Team]')
                debugBroadcast('info', '[NCO] parallel 시작 (병렬 처리)...')
                const r = await startParallel(ncoPrompt)
                finalText = r.text
                aiResult = `[Smart→Team] ${r.text}`
                debugBroadcast('success', `[NCO] Parallel 완료 (${r.text.length}자)`)
                speakNCOResult(r.text, 'NCO 팀')
              } else if (ncoSubtype === 'agent') {
                console.log('[Smart→NCO Agent]')
                debugBroadcast('info', '[NCO] agent 시작 (자율 작업)...')
                const r = await startAgent(ncoPrompt)
                finalText = r.text
                aiResult = `[Smart→Agent] ${r.text}`
                debugBroadcast('success', `[NCO] Agent 완료 (session: ${r.sessionId})`)
                speakNCOResult(r.text, 'NCO 에이전트')
              } else if (ncoSubtype === 'hive') {
                console.log('[Smart→NCO Hive]')
                debugBroadcast('info', '[NCO] hive 시작 (전체 AI 동원)...')
                const r = await startHive(ncoPrompt)
                finalText = r.text
                aiResult = `[Smart→Hive] ${r.text}`
                debugBroadcast('success', `[NCO] Hive 완료 (${r.text.length}자)`)
                speakNCOResult(r.text, '하이브 완료')
              } else {
                // subtype 미지정 → conductor (자동 모드+AI 선택)
                console.log('[Smart→NCO Conductor (auto)]')
                debugBroadcast('info', '[NCO] conductor 시작 (자동 모드 선택)...')
                const r = await startConductor(ncoPrompt)
                finalText = r.text
                aiResult = `[Smart→NCO:${r.mode}] ${r.text}`
                debugBroadcast('success', `[NCO] Conductor 완료 (모드: ${r.mode}, ${r.text.length}자)`)
                speakNCOResult(r.text, `NCO ${r.mode}`)
              }
            } catch (e) {
              const errMsg = (e as Error).message
              aiResult = `[NCO Error] ${errMsg}`
              debugBroadcast('error', `[NCO] 실패 (${ncoSubtype}): ${errMsg.substring(0, 100)}`)
              console.error(`[Smart→NCO] ${ncoSubtype} failed:`, errMsg)
              smartSpeak('NCO 처리에 실패했습니다.', { lang: 'ko' }).catch(() => {})
            }
          }

          // 현재 날짜 (모든 AI 프롬프트에 주입 — 실시간 검색과 함께 쓸 때 날짜 기준 명확화)
          const nowDate = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })

          // stripMarkdown 헬퍼 (answer/search/screen 공통)
          const stripMd = (s: string) => s
            .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
            .replace(/^[-*•]\s+/gm, '').replace(/^#+\s+/gm, '')
            .replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim()

          // ── Screen: 화면 캡처 → Gemini Vision (await — 오버레이 유지) ──
          if (intent === 'screen') {
            sendProgress('screen_capture', 0.5)
            debugBroadcast('info', '[Screen] 화면 캡처 시작...')
            try {
              const base64 = await captureScreenBase64()
              const imgKB = Math.round(base64.length * 0.75 / 1024)
              debugBroadcast('info', `[Screen] 캡처 완료 (약 ${imgKB}KB) → Gemini Vision 분석 중...`)
              sendProgress('screen_analyzing', 0.7)
              const geminiKey = 'gemini-vision'
              if (!isProviderHealthy(geminiKey)) {
                const snap = getHealthSnapshots().find(h => h.provider === geminiKey)
                debugBroadcast('warn', `[Screen] Gemini Vision 쿨다운 중 (${snap?.cooldownRemainSec}s) — 스킵`)
                throw new Error(`Gemini Vision in cooldown (${snap?.cooldownRemainSec}s remain)`)
              }
              const screenPrompt = text
                ? `오늘은 ${nowDate}입니다.\n사용자 질문: "${text}"\n\n위 질문의 맥락에서 화면을 분석해줘. 핵심만 2-3문장으로 자연스럽게.`
                : `오늘은 ${nowDate}입니다.\n이 화면에 무엇이 있는지 핵심만 2-3문장으로 자연스럽게 설명해줘.`
              const visionResult = await processImageWithGemini(base64, 'image/png', screenPrompt)
              recordProviderSuccess(geminiKey)
              const stripped = stripMd(visionResult).substring(0, 300)
              console.log(`[Smart→Screen] "${stripped.substring(0, 80)}..."`)
              debugBroadcast('success', `[Screen] 분석 완료: "${stripped.substring(0, 120)}"`)
              smartSpeak(stripped, { lang: 'ko' }).catch(e => console.error('[TTS] Screen:', (e as Error).message))
              finalText = visionResult
              aiResult = `[Smart→Screen] ${visionResult}`
            } catch (e) {
              const errMsg = (e as Error).message
              recordProviderFailure('gemini-vision', errMsg)
              const fixDesc = describeAppliedFix(errMsg)
              console.error('[Smart→Screen] Failed:', errMsg)
              debugBroadcast('error', `[Screen] 분석 실패: ${errMsg.substring(0, 100)}${fixDesc ? ` → ${fixDesc}` : ''}`)
              finalText = `화면 분석 실패`
              aiResult = `[Smart→Screen Error]`
              smartSpeak('화면 분석에 실패했습니다.', { lang: 'ko' }).catch(() => {})
            }
          }

          // ── Answer + Search: Gemini(1순위) → Claude CLI(폴백) ──────────────────
          if (intent === 'answer' || intent === 'search') {
            const isSearch = intent === 'search'
            const label = isSearch ? 'Search' : 'Answer'
            const geminiProvider = 'gemini-search'
            const claudeProvider = 'claude-cli'
            sendProgress(isSearch ? 'ai_searching' : 'ai_answering', 0.6)

            // Tier 1 health check — skip Gemini if in cooldown
            const geminiHealthy = isProviderHealthy(geminiProvider)
            if (!geminiHealthy) {
              const snap = getHealthSnapshots().find(h => h.provider === geminiProvider)
              debugBroadcast('warn', `[${label}] Gemini 쿨다운 (${snap?.cooldownRemainSec}s) — Claude 직행`)
            } else {
              debugBroadcast('info', `[${label}] Gemini 검색 시작: "${text.substring(0, 60)}"`)
            }

            let geminiOk = false
            if (geminiHealthy) {
              try {
                const query = `오늘은 ${nowDate}입니다. ${VOICE_ANSWER_GUIDE}\n\n질문: ${text}`
                const result = await searchWithGemini(query)
                if (result) {
                  recordProviderSuccess(geminiProvider)
                  const stripped = stripMd(result).substring(0, 300)
                  debugBroadcast('success', `[${label}] Gemini 성공 (${result.length}자): "${stripped.substring(0, 80)}"`)
                  smartSpeak(stripped, { lang: 'ko' }).catch(e => console.error('[TTS]', (e as Error).message))
                  debugBroadcast('info', `[TTS] 음성 출력: "${stripped.substring(0, 60)}"`)
                  finalText = result
                  aiResult = `[Smart→${label}] ${result.substring(0, 100)}`
                  geminiOk = true
                }
              } catch (geminiErr) {
                const errMsg = (geminiErr as Error).message
                const cooldownMs = recordProviderFailure(geminiProvider, errMsg)
                const fixDesc = describeAppliedFix(errMsg)
                console.warn(`[Smart→${label}] Gemini failed:`, errMsg)
                debugBroadcast('error', `[${label}] Gemini 실패: ${errMsg.substring(0, 120)}`)
                if (fixDesc) debugBroadcast('warn', `[자가치유 Tier2] ${fixDesc} (쿨다운: ${Math.round(cooldownMs / 1000)}s)`)
              }
            }

            // ── Claude CLI 폴백 ─────────────────────────────────────────────
            if (!geminiOk) {
              const claudeHealthy = isProviderHealthy(claudeProvider)
              if (!claudeHealthy) {
                const snap = getHealthSnapshots().find(h => h.provider === claudeProvider)
                debugBroadcast('warn', `[${label}] Claude도 쿨다운 중 (${snap?.cooldownRemainSec}s) — 전체 실패`)
              } else {
                sendProgress('ai_processing', 0.75)
                debugBroadcast('warn', `[${label}] Claude CLI 폴백 시도 중...`)
                try {
                  const claudeQuery = `오늘은 ${nowDate}입니다. ${VOICE_ANSWER_GUIDE}\n\n질문: ${text}`
                  const claudeResult = await processWithClaude(claudeQuery)
                  if (claudeResult.text) {
                    recordProviderSuccess(claudeProvider)
                    const stripped = stripMd(claudeResult.text).substring(0, 300)
                    debugBroadcast('success', `[${label}] Claude 폴백 성공 (${claudeResult.text.length}자): "${stripped.substring(0, 80)}"`)
                    smartSpeak(stripped, { lang: 'ko' }).catch(e => console.error('[TTS]', (e as Error).message))
                    debugBroadcast('info', `[TTS] 음성 출력 (Claude 폴백): "${stripped.substring(0, 60)}"`)
                    finalText = claudeResult.text
                    aiResult = `[Smart→${label}:Claude] ${claudeResult.text.substring(0, 100)}`
                  }
                } catch (claudeErr) {
                  const claudeErrMsg = (claudeErr as Error).message
                  const cooldownMs = recordProviderFailure(claudeProvider, claudeErrMsg)
                  const fixDesc = describeAppliedFix(claudeErrMsg)
                  console.warn(`[Smart→${label}] Claude fallback failed:`, claudeErrMsg)
                  debugBroadcast('error', `[${label}] Claude 폴백도 실패: ${claudeErrMsg.substring(0, 80)}`)
                  if (fixDesc) debugBroadcast('warn', `[자가치유 Tier2] ${fixDesc} (쿨다운: ${Math.round(cooldownMs / 1000)}s)`)

                  // Tier 3: 자가개선 — 두 프로바이더 모두 실패, Claude에게 분석 요청
                  const errorCtx = `Gemini 에러: ${geminiHealthy ? '실패' : '쿨다운 중'}\nClaude 에러: ${claudeErrMsg}`
                  debugBroadcast('info', '[자가치유 Tier3] 미지의 오류 — Claude 진단 요청 (백그라운드)')
                  askClaudeForFix(errorCtx, text).catch(() => {})

                  finalText = ''
                  aiResult = `[Smart→${label} Error]`
                  smartSpeak('검색에 실패했습니다. 잠시 후 다시 시도해 주세요.', { lang: 'ko' }).catch(() => {})
                }
              }
            }
            debugBroadcast('info', `[${label}] 완료 — geminiOk=${geminiOk}, aiResult="${aiResult.substring(0, 60)}"`)
          }

        // ============= COMMAND MODE =============
        } else if (mode.id === 'command') {
          sendProgress('command_parsing', 0.6)
          console.log(`[Command] Parsing: "${result.text}"`)

          const parsed = await parseVoiceCommand(result.text)
          if (parsed) {
            if (parsed.command.dangerous) {
              // Show confirmation for dangerous commands
              sendProgress('confirm_required', 0.8)
              console.log(`[Command] Dangerous: ${parsed.command.id} — executing with warning`)
              await showNotification('VoiceType', `실행: ${parsed.command.description}`)
            }
            const cmdResult = await parsed.command.action(parsed.match)
            finalText = cmdResult.message
            aiResult = `[CMD:${parsed.command.id}] ${cmdResult.message}`
            console.log(`[Command] ${cmdResult.success ? 'OK' : 'FAIL'}: ${cmdResult.message}`)

            // Don't inject text for commands — show notification instead
            await showNotification('VoiceType Command', cmdResult.message)
          } else {
            finalText = result.text
            aiResult = '[CMD] 인식되지 않은 명령'
            console.log('[Command] No command recognized, keeping raw text')
          }

        // ============= NCO COLLABORATION MODES =============
        } else if (mode.id === 'nco_discuss') {
          sendProgress('nco_discussion', 0.5)
          console.log(`[NCO] Starting discussion: "${result.text}"`)
          try {
            const r = await startDiscussion(result.text)
            finalText = r.text
            aiResult = `[Discussion] ${r.text}`
            console.log(`[NCO] Discussion done. Participants: ${r.participants?.join(', ')}`)
          } catch (e) {
            aiResult = `[NCO Error] ${(e as Error).message}`
            console.error('[NCO] Discussion failed:', (e as Error).message)
          }

        } else if (mode.id === 'nco_team') {
          sendProgress('nco_parallel', 0.5)
          console.log(`[NCO] Starting parallel: "${result.text}"`)
          try {
            const r = await startParallel(result.text)
            finalText = r.text
            aiResult = `[Team] ${r.text}`
          } catch (e) {
            aiResult = `[NCO Error] ${(e as Error).message}`
            console.error('[NCO] Parallel failed:', (e as Error).message)
          }

        } else if (mode.id === 'nco_agent') {
          sendProgress('nco_agent', 0.5)
          console.log(`[NCO] Starting agent: "${result.text}"`)
          try {
            const r = await startAgent(result.text)
            finalText = r.text
            aiResult = `[Agent] ${r.text}`
          } catch (e) {
            aiResult = `[NCO Error] ${(e as Error).message}`
            console.error('[NCO] Agent failed:', (e as Error).message)
          }

        } else if (mode.id === 'nco_hive') {
          sendProgress('nco_hive', 0.5)
          console.log(`[NCO] Starting hive: "${result.text}"`)
          try {
            const r = await startHive(result.text)
            finalText = r.text
            aiResult = `[Hive] ${r.text}`
          } catch (e) {
            aiResult = `[NCO Error] ${(e as Error).message}`
            console.error('[NCO] Hive failed:', (e as Error).message)
          }

        // ============= STANDARD AI MODES =============
        } else if (mode.id !== 'direct') {
          sendProgress('ai_processing', 0.6)
          console.log(`AI Mode: ${mode.name} (${settings.aiProvider})`)

          try {
            // Voice/answer modes use fast-path (skip NCO, use Claude CLI)
            const isVoiceMode = mode.ttsOutput || mode.category === 'voice'
            const aiResponse = await processWithAI({
              text: result.text,
              prompt: mode.prompt,
              provider: mode.provider || settings.aiProvider,
              voiceFastPath: isVoiceMode
            })
            finalText = aiResponse.text
            aiResult = aiResponse.text
            console.log(`AI Result (${aiResponse.provider}): "${finalText.substring(0, 100)}..."`)
          } catch (e) {
            console.error('AI failed, using raw text:', (e as Error).message)
          }
        }
      }

      sendProgress('done', 1.0)

      const transcriptionResult: TranscriptionResult = {
        id: crypto.randomUUID(),
        text: result.text,
        language: result.language,
        duration: result.duration,
        timestamp: Date.now(),
        modelUsed: settings.modelName,
        aiMode,
        aiResult
      }

      saveTranscription(transcriptionResult)

      mainWindow.webContents.send('transcription:result', transcriptionResult)
      if (overlayWindow) overlayWindow.webContents.send('transcription:result', transcriptionResult)

      // Inject text (skip for command mode and smart→command results)
      const isCommandResult = mode?.id === 'command'
        || (aiResult && aiResult.startsWith('[Smart→CMD'))
        || (aiResult && aiResult.startsWith('[Smart→Screen'))
        || (aiResult && aiResult.startsWith('[Smart→Answer'))
        || (aiResult && aiResult.startsWith('[Smart→Search'))
        || (aiResult && aiResult.startsWith('[Smart→NCO:'))
        || (aiResult && aiResult.startsWith('[Smart→Discussion'))
        || (aiResult && aiResult.startsWith('[Smart→Team'))
        || (aiResult && aiResult.startsWith('[Smart→Agent'))
        || (aiResult && aiResult.startsWith('[Smart→Hive'))
      if (!isCommandResult && settings.autoInject && finalText.trim()) {
        await injectText(finalText, getPreviousAppName(), getPreviousBundleId())
        const targetApp = getPreviousAppName() || '(frontmost)'
        console.log('Text injected into:', targetApp, '/ bundle:', getPreviousBundleId() || '(none)')
        debugBroadcast('info', `[Inject] 텍스트 주입 → ${targetApp} (${finalText.length}자)`)
      }

      // TTS output (입) — speak only brief answers/notifications, not terminal/code output
      if (mode?.ttsOutput || mode?.category === 'voice') {
        const ttsText = prepareSpeakText(finalText, aiResult)
        if (ttsText) {
          const ttsType = mode.id === 'command' ? 'command'
            : (mode.category === 'voice' ? 'notification' : 'ai_result')
          debugBroadcast('info', `[TTS] Pipeline 음성 출력 (${ttsType}): "${ttsText.substring(0, 60)}"`)
          pipelineSpeakStreaming(ttsText, ttsType).catch((e) => {
            console.error('[TTS] Speech output failed:', (e as Error).message)
            debugBroadcast('error', `[TTS] Pipeline 출력 실패: ${(e as Error).message.substring(0, 80)}`)
          })
        } else {
          console.log('[TTS] Skipped — output too long or is terminal/code output')
          debugBroadcast('info', '[TTS] 건너뜀 — 출력이 너무 길거나 터미널/코드 결과')
        }
      }

      setTimeout(() => hideOverlay(), 2500)
      return transcriptionResult
    } catch (error) {
      console.error('Pipeline error:', error)
      debugBroadcast('error', `[Pipeline] 치명적 에러: ${(error as Error).message?.substring(0, 120)}`)
      setTimeout(() => hideOverlay(), 3000)
      throw error
    }
  })

  // ── Attachment processing (drag & drop / paste) ──
  ipcMain.handle('attachment:process', async (_event, opts: {
    name: string
    mimeType: string
    content?: string
    base64?: string
    modeId: string
    extraText?: string
  }) => {
    const overlayWindow = getOverlayWindow()
    const sendProgress = (stage: string, progress: number) => {
      mainWindow.webContents.send('transcription:progress', progress)
      mainWindow.webContents.send('ai:stage', stage)
      if (overlayWindow) {
        overlayWindow.webContents.send('transcription:progress', progress)
        overlayWindow.webContents.send('ai:stage', stage)
      }
    }

    const allModes = [...BUILTIN_MODES, ...settings.customModes]
    const mode = allModes.find(m => m.id === opts.modeId) ?? allModes.find(m => m.id === 'direct')!
    const isImage = opts.mimeType.startsWith('image/')

    let finalText = ''
    let aiResult = ''

    sendProgress('ai_processing', 0.3)
    console.log(`[Attachment] Processing "${opts.name}" (${opts.mimeType}) with mode=${opts.modeId}`)

    try {
      if (isImage && opts.base64) {
        // ── Image: vision AI → describe + apply mode prompt ──
        const visionPrompt = opts.extraText
          ? `${opts.extraText}\n\n위 요청을 이미지를 분석하여 수행해주세요.`
          : (mode.id === 'direct'
              ? '이 이미지를 자세히 설명해주세요.'
              : `${mode.prompt}이미지를 분석하여 위 작업을 수행해주세요.`)

        sendProgress('ai_processing', 0.4)

        // 1순위: Gemini Vision (gemini-2.5-flash — API 키 기반, 설치 불필요)
        try {
          finalText = await processImageWithGemini(opts.base64, opts.mimeType || 'image/jpeg', visionPrompt)
          aiResult = finalText
          console.log(`[Attachment] Gemini vision done (${finalText.length} chars)`)
        } catch (e) {
          console.log('[Attachment] Gemini vision failed:', (e as Error).message)
        }

        // 2순위: Ollama vision (llava 등 vision 모델이 설치된 경우)
        if (!finalText && await isOllamaAvailable()) {
          try {
            finalText = await processImageWithOllama(opts.base64, visionPrompt)
            aiResult = finalText
            console.log(`[Attachment] Ollama vision done (${finalText.length} chars)`)
          } catch (e) {
            console.log('[Attachment] Ollama vision failed:', (e as Error).message)
          }
        }

        if (!finalText) {
          finalText = '[이미지 분석 실패] Gemini API 키(nco/.env)를 확인하거나 Ollama vision 모델(llava 등)을 설치해주세요.'
          aiResult = finalText
        }

      } else {
        // ── Text / file: read content, apply mode ──
        let inputText = opts.content || ''
        if (opts.extraText) {
          inputText = `${opts.extraText}\n\n파일 내용:\n${inputText}`
        }

        if (mode.id === 'direct') {
          finalText = inputText
        } else {
          sendProgress('ai_processing', 0.5)
          const aiResponse = await processWithAI({
            text: inputText,
            prompt: mode.prompt,
            provider: mode.provider || settings.aiProvider,
            voiceFastPath: false
          })
          finalText = aiResponse.text
          aiResult = aiResponse.text
          console.log(`[Attachment] AI (${aiResponse.provider}) done (${finalText.length} chars)`)
        }
      }
    } catch (e) {
      finalText = `[처리 오류] ${(e as Error).message}`
      aiResult = finalText
      console.error('[Attachment] Processing error:', e)
    }

    sendProgress('done', 1.0)

    const result: TranscriptionResult = {
      id: crypto.randomUUID(),
      text: `[첨부: ${opts.name}]`,
      language: 'auto',
      duration: 0,
      timestamp: Date.now(),
      modelUsed: settings.modelName,
      aiMode: opts.modeId,
      aiResult: finalText
    }

    saveTranscription(result)
    mainWindow.webContents.send('transcription:result', result)
    if (overlayWindow) overlayWindow.webContents.send('transcription:result', result)

    if (settings.autoInject && finalText.trim() && mode.id !== 'command') {
      await injectText(finalText, getPreviousAppName(), getPreviousBundleId())
    }

    if (mode?.ttsOutput || mode?.category === 'voice') {
      pipelineSpeakStreaming(finalText, 'ai_result').catch(e =>
        console.error('[TTS] Attachment speak failed:', (e as Error).message)
      )
    }

    setTimeout(() => hideOverlay(), 2500)
    return result
  })

  // Audio level forwarding: main renderer → overlay
  ipcMain.on('audio:level', (_event, level: number) => {
    const overlay = getOverlayWindow()
    if (overlay && !overlay.isDestroyed()) {
      overlay.webContents.send('audio:level', level)
    }
  })

  // Models
  ipcMain.handle('models:list', () => getAvailableModels())
  ipcMain.handle('models:dir', () => getModelsDir())

  // TTS (입)
  ipcMain.handle('tts:speak', async (_event, text: string, options?: any) => {
    await smartSpeak(text, options)
  })
  ipcMain.handle('tts:speakers', async (_event, lang?: string) => {
    return getSpeakers(lang)
  })
  ipcMain.handle('tts:mlx-voices', () => [...MLX_VOICES])
  ipcMain.handle('tts:mlx-voice:get', () => getMLXVoice())
  ipcMain.handle('tts:mlx-voice:set', (_event, voice: string) => {
    setMLXVoice(voice)
  })

  // TTS Server management
  ipcMain.handle('tts:server-status', async () => getTTSServerStatuses())
  ipcMain.handle('tts:server-start', async (_event, id: string) => startTTSServer(id as any))
  ipcMain.handle('tts:server-stop', async (_event, id: string) => stopTTSServer(id))
  ipcMain.handle('tts:server-preview', async (_event, id: string, voice?: string) => {
    await previewTTSVoice(id, voice)
  })
  ipcMain.handle('tts:say-voices', () => [...SAY_VOICES])
  ipcMain.handle('tts:say-preview', async (_event, voice: string, text?: string) => {
    const { execFile: ef } = require('child_process')
    ef('say', ['-v', voice, text || '안녕하세요. 저는 노바입니다.'])
  })

  // Pipeline status (귀+눈+입 상태)
  ipcMain.handle('pipeline:status', async () => {
    return getPipelineStatus()
  })
  ipcMain.handle('pipeline:config', () => getPipelineConfig())
  ipcMain.handle('pipeline:setConfig', (_event, config: any) => {
    setPipelineConfig(config)
  })
  ipcMain.handle('pipeline:init', async () => {
    return initPipeline()
  })

  // ── Real PTY Terminal (node-pty) ────────────────────────────────────────
  // 렌더러에서 키 입력 → PTY에 전달
  ipcMain.on('pty:input', (_event, data: string) => {
    writeToPTY(data)
  })
  // 터미널 크기 변경
  ipcMain.on('pty:resize', (_event, cols: number, rows: number) => {
    resizePTY(cols, rows)
  })
  // 터미널 초기화/재시작 — 이미 실행 중이면 재생성 안 함 (멱등)
  ipcMain.handle('pty:create', (_event, cols?: number, rows?: number, force = false) => {
    if (!isPTYReady() || force) {
      createPTY(cols, rows)
    }
    return { ok: true }
  })
  // 터미널 상태
  ipcMain.handle('pty:status', () => ({ ready: isPTYReady(), shell: process.env.SHELL || '/bin/zsh' }))
  // 음성 명령을 PTY에 타이핑 (Claude Code 실행 등)
  ipcMain.handle('pty:type', async (_event, command: string) => {
    await typeCommandInPTY(command)
    return { ok: true }
  })
}

export function getRecordingState(): boolean {
  return isRecording
}

export function setRecordingState(state: boolean): void {
  isRecording = state
}

export function getSettings(): AppSettings {
  return settings
}
