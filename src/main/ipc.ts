import { ipcMain, BrowserWindow } from 'electron'
import { getHistory, searchHistory, deleteTranscription, saveTranscription } from './db'
import { transcribe, getModelsDir, getAvailableModels } from './whisper'
import { injectText } from './injector'
import { restoreFrontApp, getOverlayWindow, hideOverlay } from './appState'
import { processWithAI, getProviderStatus, startDiscussion, startParallel, startAgent, startHive } from './nco-client'
import { parseVoiceCommand, parseCommand } from './voice-commands'
import { showNotification } from './system-control'
import { pipelineSpeak, pipelineSpeakStreaming, getPipelineStatus, initPipeline, setPipelineConfig, getPipelineConfig } from './pipeline'
import { smartSpeak, getSpeakers, MLX_VOICES, setMLXVoice, getMLXVoice } from './tts-client'
import { BUILTIN_MODES } from '../shared/types'
import type { AppSettings, TranscriptionResult, AIMode } from '../shared/types'
import path from 'path'
import crypto from 'crypto'

let settings: AppSettings = {
  shortcut: 'Ctrl+Shift+Space',
  language: 'auto',
  modelPath: '',
  modelName: 'base',
  autoInject: true,
  showOverlay: true,
  theme: 'dark',
  overlayPosition: 'center',
  aiMode: 'direct',
  aiProvider: 'auto',
  customModes: []
}

let isRecording = false

function getActiveMode(): AIMode | undefined {
  const allModes = [...BUILTIN_MODES, ...settings.customModes]
  return allModes.find(m => m.id === settings.aiMode)
}

export function setupIPC(mainWindow: BrowserWindow): void {
  // Settings
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_event, newSettings: Partial<AppSettings>) => {
    settings = { ...settings, ...newSettings }
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

      console.log('Starting transcription...')
      const result = await transcribe(audioBuffer, {
        modelPath,
        language: settings.language
      })
      console.log(`Transcription: "${result.text}" (${result.duration.toFixed(1)}s)`)

      let finalText = result.text
      let aiMode = settings.aiMode
      let aiResult = ''

      const mode = getActiveMode()

      if (mode && result.text.trim()) {
        // ============= SMART MODE (3-Tier 분류: Regex → Keyword → AI) =============
        if (mode.id === 'smart') {
          const text = result.text.trim()
          console.log(`[Smart] Classifying: "${text}"`)

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
            }

            // 긴 키워드부터 매칭 (더 구체적인 것 우선)
            const sortedKeywords = Object.keys(NCO_KEYWORDS).sort((a, b) => b.length - a.length)
            for (const kw of sortedKeywords) {
              if (text.includes(kw)) {
                const match = NCO_KEYWORDS[kw]
                intent = match.intent
                ncoSubtype = match.subtype
                console.log(`[Smart→Tier0.5] NCO keyword: "${kw}" → ${ncoSubtype}`)
                break
              }
            }
          }

          // ── Tier 1: AI 분류 (Tier 0/0.5에서 미분류된 경우만) ──
          if (!intent) {
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
   - 시스템 정보 조회: "메모리 사용량 알려줘", "CPU 얼마야", "디스크 얼마 남았어", "시스템 상태"
   → {"intent":"command"}

2. **nco** — 여러 AI가 협업/토론/분석해야 하는 작업
   - 토론/논의: "이 주제로 토론해", "찬반 토론 시작"
   - 팀 병렬 작업: "팀으로 분석해", "병렬로 처리해"
   - 에이전트 자율 작업: "에이전트가 알아서 해결해"
   - 하이브 전체 AI: "전체 AI 동원해", "하이브 모드로"
   → {"intent":"nco","subtype":"discuss|team|agent|hive"}

3. **answer** — AI가 정보를 조사/설명/생성해야 하는 것 (기본값)
   - 질문: "날씨 알려줘", "트럼프 뉴스", "파이썬 리스트 설명해"
   - 번역/작문: "영어로 번역해줘", "이메일 써줘"
   - 의견/조언: "어떻게 생각해?", "추천해줘"
   → {"intent":"answer"}

## 핵심 판단 기준
- "~해줘/열어/닫아/켜/꺼" + 앱/시스템 대상 → command
- "~검색해" → command (브라우저에서 검색 실행)
- "~알려줘/설명해/뭐야" → answer (AI가 답변)
- "토론/논의/팀/병렬/에이전트/하이브" 포함 → nco
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
            } catch (e) {
              intent = 'answer'
              console.log(`[Smart] AI classification failed, defaulting to answer: ${(e as Error).message}`)
            }
          }

          console.log(`[Smart] Final intent: ${intent}${ncoSubtype ? '/' + ncoSubtype : ''}`)

          // ── 의도별 실행 ──

          if (intent === 'command') {
            sendProgress('command_parsing', 0.6)
            // Tier 0에서 이미 파싱된 경우 재사용, 아니면 LLM 파싱
            if (!cmdParsed) {
              cmdParsed = await parseVoiceCommand(text, true)
            }
            if (cmdParsed) {
              console.log(`[Smart→Command] ${cmdParsed.command.id}`)
              if (cmdParsed.command.dangerous) {
                await showNotification('VoiceType', `실행: ${cmdParsed.command.description}`)
              }
              const cmdResult = await cmdParsed.command.action(cmdParsed.match)
              finalText = cmdResult.message
              aiResult = `[Smart→CMD:${cmdParsed.command.id}] ${cmdResult.message}`
              await showNotification('VoiceType', cmdResult.message)
            } else {
              // 명령 파싱 실패 → 답변으로 폴백
              console.log('[Smart] Command parse failed, falling back to answer')
              intent = 'answer'
            }
          }

          if (intent === 'nco') {
            sendProgress('nco_processing', 0.5)
            try {
              if (ncoSubtype === 'discuss') {
                console.log('[Smart→NCO Discussion]')
                const r = await startDiscussion(text)
                finalText = r.text
                aiResult = `[Smart→Discussion] ${r.text}`
              } else if (ncoSubtype === 'team') {
                console.log('[Smart→NCO Team]')
                const r = await startParallel(text)
                finalText = r.text
                aiResult = `[Smart→Team] ${r.text}`
              } else if (ncoSubtype === 'agent') {
                console.log('[Smart→NCO Agent]')
                const r = await startAgent(text)
                finalText = r.text
                aiResult = `[Smart→Agent] ${r.text}`
              } else if (ncoSubtype === 'hive') {
                console.log('[Smart→NCO Hive]')
                const r = await startHive(text)
                finalText = r.text
                aiResult = `[Smart→Hive] ${r.text}`
              } else {
                // subtype 미지정 → 기본 토론
                console.log('[Smart→NCO Discussion (default)]')
                const r = await startDiscussion(text)
                finalText = r.text
                aiResult = `[Smart→Discussion] ${r.text}`
              }
            } catch (e) {
              aiResult = `[NCO Error] ${(e as Error).message}`
              console.error(`[Smart→NCO] ${ncoSubtype} failed:`, (e as Error).message)
            }
          }

          // Answer (질문/대화) — default fallback
          if (intent === 'answer') {
            sendProgress('ai_processing', 0.6)
            console.log('[Smart→Answer]')
            try {
              const answerPrompt = '다음 질문에 대해 2-3문장으로 정확하고 간결하게 답변해주세요. 핵심만 말해주세요:\n\n'
              const aiResponse = await processWithAI({
                text: result.text,
                prompt: answerPrompt,
                provider: settings.aiProvider,
                voiceFastPath: true
              })
              finalText = aiResponse.text
              aiResult = aiResponse.text
              console.log(`[Smart→Answer] (${aiResponse.provider}): "${finalText.substring(0, 80)}..."`)
            } catch (e) {
              console.error('[Smart→Answer] AI failed:', (e as Error).message)
            }
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
      const isCommandResult = mode?.id === 'command' || (aiResult && aiResult.startsWith('[Smart→CMD'))
      if (!isCommandResult && settings.autoInject && finalText.trim()) {
        await restoreFrontApp()
        await injectText(finalText)
        console.log('Text injected')
      }

      // TTS output (입) — speak the result if mode has ttsOutput enabled
      if (mode?.ttsOutput || mode?.category === 'voice') {
        const ttsType = mode.id === 'command' ? 'command'
          : (mode.category === 'voice' ? 'notification' : 'ai_result')
        // Use streaming TTS for faster first-audio
        pipelineSpeakStreaming(finalText, ttsType).catch((e) => {
          console.error('[TTS] Speech output failed:', (e as Error).message)
        })
      }

      setTimeout(() => hideOverlay(), 2500)
      return transcriptionResult
    } catch (error) {
      console.error('Pipeline error:', error)
      setTimeout(() => hideOverlay(), 3000)
      throw error
    }
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
