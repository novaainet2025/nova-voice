import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import type { Attachment } from '../../../shared/types'
import { TerminalPanel } from '../terminal/TerminalPanel'

// ─── NCO Provider Health Types ───────────────────────────────────────────────

interface ProviderHealth {
  id: string
  name: string
  role: string
  type: string
  status: 'online' | 'offline' | 'degraded'
  latencyMs: number
  version?: string
  model?: string
  error?: string
  checkedAt: number
}

// ─── Message Types ───────────────────────────────────────────────────────────

type MsgType =
  | 'system'      // dim italic — status/mode changes
  | 'voice'       // cyan — voice transcription
  | 'typed'       // white — typed user input
  | 'ai'          // primary — AI text answer
  | 'cmd'         // green mono — $ command
  | 'stdout'      // white/65 mono — command output
  | 'stderr'      // yellow mono — stderr
  | 'inject'      // dim — "injected to cursor"
  | 'attachment'  // file info
  | 'error'       // red

interface Msg {
  id: number
  type: MsgType
  text: string
  ts: number
  label?: string
}

let msgId = 0

// ─── Attachment helpers ───────────────────────────────────────────────────────

const TEXT_MIMES = new Set([
  'text/plain', 'text/html', 'text/css', 'text/javascript', 'text/typescript',
  'text/csv', 'text/markdown', 'text/xml', 'application/json', 'application/xml',
])
const isTextMime = (m: string) => TEXT_MIMES.has(m) || m.startsWith('text/')
const fileIcon = (m: string) =>
  m.startsWith('image/') ? '🖼️' : m === 'application/pdf' ? '📄' : m.includes('json') ? '📋' : '📎'

async function readFileAsAttachment(file: File): Promise<Attachment | null> {
  const id = crypto.randomUUID()
  const mimeType = file.type || 'application/octet-stream'
  return new Promise((resolve) => {
    const reader = new FileReader()
    if (file.type.startsWith('image/')) {
      reader.onload = (e) => {
        const b64 = (e.target?.result as string).split(',')[1] || ''
        resolve({ id, name: file.name, mimeType, size: file.size, base64: b64 })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    } else if (isTextMime(mimeType)) {
      reader.onload = (e) => resolve({ id, name: file.name, mimeType, size: file.size, content: e.target?.result as string })
      reader.onerror = () => resolve(null)
      reader.readAsText(file)
    } else {
      reader.onload = (e) => resolve({ id, name: file.name, mimeType: 'text/plain', size: file.size, content: e.target?.result as string })
      reader.onerror = () => resolve(null)
      reader.readAsText(file)
    }
  })
}

// ─── Component ───────────────────────────────────────────────────────────────

// ─── Debug Log Types ──────────────────────────────────────────────────────────
interface DebugEntry { ts: number; level: string; msg: string }

export function UnifiedPanel() {
  const {
    isRecording, audioLevel, recordingDuration,
    aiStage, currentMode, setCurrentMode, setAIModes,
    pendingAttachments, isProcessingAttachment,
    addAttachment, removeAttachment, clearAttachments,
    setProcessingAttachment, setAIStage,
  } = useAppStore()

  const [messages, setMessages] = useState<Msg[]>([{
    id: msgId++, type: 'system', ts: Date.now(),
    text: 'NOVA-VOICE  ·  AI Terminal ready\n⌃ Shift Space 녹음 · Smart Mode 자동 라우팅 · Claude 명령 실행',
  }])
  const [input, setInput] = useState('')
  const [claudeRunning, setClaudeRunning] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [debugLogs, setDebugLogs] = useState<DebugEntry[]>([])
  const [showHealth, setShowHealth] = useState(false)
  const [healthResults, setHealthResults] = useState<ProviderHealth[]>([])
  const [healthChecking, setHealthChecking] = useState(false)
  const dragCounter = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const debugBottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // V2T mode = direct (transcription + inject only), Terminal mode = everything else
  const isV2T = currentMode === 'direct'

  const addMsg = useCallback((type: MsgType, text: string, label?: string) => {
    setMessages(prev => [...prev, { id: msgId++, type, text, ts: Date.now(), label }])
  }, [])

  const runHealthCheck = useCallback(async () => {
    if (healthChecking) return
    setHealthChecking(true)
    setShowHealth(true)
    setShowDebug(false)
    try {
      const results = await window.electronAPI.checkNCOHealth()
      setHealthResults(results)
    } catch (e) {
      console.error('[Health] check failed:', e)
    } finally {
      setHealthChecking(false)
    }
  }, [healthChecking])

  // ── IPC listeners ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!window.electronAPI) return

    window.electronAPI.getAIModes?.().then((modes: any[]) => setAIModes(modes))
    // Sync mode from main process settings (main loads from disk, renderer defaults to 'direct')
    window.electronAPI.getSettings?.().then((s: any) => {
      if (s?.aiMode) setCurrentMode(s.aiMode)
    })

    // Transcription + AI result
    const cleanupResult = window.electronAPI.onTranscriptionResult((result) => {
      // isUpdate=true: 백그라운드 완료 결과 — 음성 버블 중복 방지
      if (!result.isUpdate && result.text) addMsg('voice', result.text)
      if (result.aiResult && result.aiResult !== result.text) {
        addMsg('ai', result.aiResult)
      } else if (!result.aiResult && isV2T) {
        addMsg('inject', result.text || '')
      } else if (!result.aiResult && !isV2T && result.text) {
        addMsg('error', '⚠️ AI 응답을 받지 못했습니다 — 우상단 Health 버튼으로 프로바이더 상태를 확인하세요')
      }
      setAIStage('done')
      setClaudeRunning(false)
    })

    // Claude terminal streaming output
    const cleanupClaude = window.electronAPI.onClaudeOutput?.((data) => {
      if (data.type === 'input') {
        addMsg('cmd', data.text)
        setClaudeRunning(true)
      } else if (data.type === 'stdout') {
        addMsg('stdout', data.text)
      } else if (data.type === 'stderr') {
        addMsg('stderr', data.text)
      } else if (data.type === 'system') {
        if (data.text && !data.text.includes('──')) addMsg('system', data.text)
        setClaudeRunning(false)
      } else if (data.type === 'error') {
        addMsg('error', data.text)
        setClaudeRunning(false)
      }
    })

    // AI processing stage → 대화 스레드에 과정(CTS) 단계 메시지 표시
    const STAGE_CTS: Record<string, string> = {
      transcribing:    '🎙️ 음성 인식 중...',
      ai_processing:   '🤖 AI 처리 중...',
      nco_processing:  '🌐 NCO 멀티AI 처리 중...',
      command_parsing: '🎮 명령 파싱 중...',
    }
    const cleanupStage = window.electronAPI.onAIStage?.((stage) => {
      setAIStage(stage)
      if (STAGE_CTS[stage]) addMsg('system', STAGE_CTS[stage])
    })

    // Debug log streaming
    window.electronAPI.getDebugLogs?.().then((logs) => {
      if (logs?.length) setDebugLogs(logs)
    })
    const cleanupDebug = window.electronAPI.onDebugLog?.((entry) => {
      setDebugLogs(prev => {
        const next = [...prev, entry]
        return next.length > 300 ? next.slice(next.length - 300) : next
      })
    })

    // AI 취소 이벤트 (Ctrl+Escape 글로벌 단축키 or main에서 전송)
    const cleanupCancel = window.electronAPI.onAICancelled?.(() => {
      setAIStage('idle')
      addMsg('system', '⏹ AI 작업이 취소됐습니다 (ESC / Ctrl+Escape)')
    })

    // ESC 키 — 앱 포커스 중 즉시 취소 (렌더러 직접 처리)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        window.electronAPI.cancelAI?.()
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      cleanupResult()
      cleanupClaude?.()
      cleanupStage?.()
      cleanupDebug?.()
      cleanupCancel?.()
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [addMsg, setAIModes, setAIStage, isV2T])

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, claudeRunning, aiStage])

  // Auto-scroll debug panel
  useEffect(() => {
    if (showDebug) debugBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [debugLogs, showDebug])

  // ── Paste ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    const handle = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (!file) continue
          const att = await readFileAsAttachment(file)
          if (att) addAttachment(att)
        }
      }
    }
    window.addEventListener('paste', handle)
    return () => window.removeEventListener('paste', handle)
  }, [addAttachment])

  // ── Drag & drop ───────────────────────────────────────────────────────────

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current === 0) setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)

    for (const file of files) {
      const filePath = window.electronAPI.getPathForFile(file) || undefined
      const isImage = file.type.startsWith('image/')

      // 이미지: 첨부 대기열에 추가 (PTY/Claude-p는 텍스트 전용)
      if (isImage && !filePath) {
        const att = await readFileAsAttachment(file)
        if (att) addAttachment(att)
        continue
      }

      // 메시지 포맷 구성 — Claude가 파일을 실제로 읽고 처리할 수 있도록
      let msg = ''
      if (filePath) {
        msg = `이 파일을 읽고 분석해줘: ${filePath}`
      } else {
        const att = await readFileAsAttachment(file)
        if (att?.content) {
          msg = `파일 내용 (${file.name}):\n\`\`\`\n${att.content.slice(0, 8000)}\n\`\`\``
        }
      }
      if (!msg) continue

      // AI Terminal 탭으로 전환 (Claude 응답 확인)
      if (isV2T) {
        switchMode('terminal')
      }

      addMsg('typed', `📎 ${file.name}`)

      // PTY Claude Code 감지 → PTY로 직접 전달 (@file 참조 형식)
      try {
        const ptyStatus = await window.electronAPI?.ptyClaudeRunning?.()
        if (ptyStatus?.claudeDetected) {
          setClaudeRunning(true)
          const ptyMsg = filePath ? `@${filePath} 분석해줘` : msg
          await window.electronAPI!.ptyType(ptyMsg)
          continue
        }
      } catch { /* PTY Claude 감지 실패 → claudeSend 폴백 */ }

      // PTY Claude 없음 → 채팅 뷰 전환 후 claude -p 실행 (출력이 채팅에 보임)
      if (!isV2T) setCurrentMode('direct')
      if (window.electronAPI?.claudeSend) {
        setClaudeRunning(true)
        try { await window.electronAPI.claudeSend(msg) }
        catch { setClaudeRunning(false) }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addAttachment, addMsg, isV2T])

  // ── Mode switch ───────────────────────────────────────────────────────────

  const switchMode = async (mode: 'v2t' | 'terminal') => {
    const aiMode = mode === 'v2t' ? 'direct' : 'smart'
    setCurrentMode(aiMode)
    await window.electronAPI?.setSettings?.({ aiMode })
    addMsg('system',
      mode === 'v2t'
        ? '─ Voice to Text 모드: 음성 → 커서 위치 직접 입력'
        : '─ AI Terminal 모드: 질문 → 답변, 명령 → Claude 실행')
  }

  // ── Recording toggle ──────────────────────────────────────────────────────

  const toggleRecording = async () => {
    if (isRecording) {
      await window.electronAPI?.stopRecording()
    } else {
      await window.electronAPI?.startRecording()
    }
  }

  // ── Send text to Claude ───────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim()
    if (!text || claudeRunning) return
    setInput('')
    addMsg('typed', text)
    setClaudeRunning(true)
    try {
      await window.electronAPI?.claudeSend?.(text)
    } catch {
      setClaudeRunning(false)
      addMsg('error', 'Claude Terminal 전송 실패 — claude CLI가 설치되어 있는지 확인하세요')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── Process attachments ───────────────────────────────────────────────────

  const handleProcessAttachments = useCallback(async () => {
    if (!window.electronAPI || pendingAttachments.length === 0 || isProcessingAttachment) return
    setProcessingAttachment(true)
    setAIStage('ai_processing')
    addMsg('system', `📎 파일 ${pendingAttachments.length}개 AI 분석 중...`)
    for (const att of pendingAttachments) {
      try {
        addMsg('attachment', att.name, `${fileIcon(att.mimeType)} ${(att.size / 1024).toFixed(0)}KB`)
        await (window.electronAPI as any).processAttachment({
          name: att.name, mimeType: att.mimeType,
          content: att.content, base64: att.base64, modeId: currentMode,
        })
      } catch {
        addMsg('error', `처리 실패: ${att.name}`)
      }
    }
    clearAttachments()
    setProcessingAttachment(false)
  }, [pendingAttachments, currentMode, isProcessingAttachment, addMsg, setProcessingAttachment, setAIStage, clearAttachments])

  // ── Derived ───────────────────────────────────────────────────────────────

  const duration = `${Math.floor(recordingDuration / 60)}:${String(Math.floor(recordingDuration % 60)).padStart(2, '0')}`
  const isProcessing = aiStage === 'transcribing' || aiStage === 'ai_processing' || isProcessingAttachment
  const isBusy = claudeRunning || isProcessing

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col h-full bg-[#0d1117] relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* Drag overlay — 오버레이 숨김, 드롭 감지 레이어만 유지 */}
      {isDragOver && (
        <div
          className="absolute inset-0 z-50"
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        />
      )}

      {/* ── Top bar: mode toggle + status ─────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 flex-shrink-0">
        {/* Left: status indicators */}
        <div className="flex items-center gap-3 min-w-[120px]">
          {isRecording && (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse flex-shrink-0" />
              <span className="text-red-400 text-xs font-mono">{duration}</span>
              {/* Mini audio bars */}
              <div className="flex items-center gap-[1.5px] h-3">
                {Array.from({ length: 12 }, (_, i) => {
                  const h = 2 + audioLevel * (Math.sin(i * 0.8) * 0.4 + 0.6) * 9
                  return <div key={i} className="rounded-full bg-red-400/60 flex-shrink-0"
                    style={{ width: 2, height: Math.max(2, h), transition: 'height 80ms ease-out' }} />
                })}
              </div>
            </div>
          )}
          {isBusy && !isRecording && (
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 border border-primary-400/60 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              <span className="text-primary-400/70 text-xs">
                {aiStage === 'transcribing' ? 'Whisper...' :
                 aiStage === 'ai_processing' ? 'AI 처리...' :
                 claudeRunning ? 'Claude...' : '처리 중...'}
              </span>
            </div>
          )}
        </div>

        {/* Center: title */}
        <span className="text-xs text-white/20 font-medium tracking-widest absolute left-1/2 -translate-x-1/2">
          NOVA
        </span>

        {/* Right: mode toggle + debug */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={runHealthCheck}
            title="NCO AI 프로바이더 헬스 체크"
            className={`px-2 py-1 rounded-md text-xs font-mono transition-all ${
              showHealth
                ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500/40'
                : 'text-white/25 hover:text-white/50 hover:bg-white/5'
            }`}
          >
            {healthChecking ? (
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 border border-emerald-400/60 border-t-transparent rounded-full animate-spin" />
                NCO
              </span>
            ) : (
              <>
                NCO
                {healthResults.length > 0 && (
                  <span className={`ml-1 ${healthResults.filter(r => r.status === 'offline').length > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {healthResults.filter(r => r.status === 'online').length}/{healthResults.length}
                  </span>
                )}
              </>
            )}
          </button>
          <button
            onClick={() => { setShowDebug(v => !v); setShowHealth(false) }}
            title="디버그 로그 패널"
            className={`px-2 py-1 rounded-md text-xs font-mono transition-all ${
              showDebug
                ? 'bg-orange-500/30 text-orange-300 border border-orange-500/40'
                : 'text-white/25 hover:text-white/50 hover:bg-white/5'
            }`}
          >
            DBG {debugLogs.filter(l => l.level === 'error').length > 0 && (
              <span className="ml-0.5 text-red-400">
                ×{debugLogs.filter(l => l.level === 'error').length}
              </span>
            )}
          </button>
          <div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5">
            <button
              onClick={() => switchMode('v2t')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                isV2T
                  ? 'bg-white/15 text-white shadow-sm'
                  : 'text-white/35 hover:text-white/55'
              }`}
            >
              V2T
            </button>
            <button
              onClick={() => switchMode('terminal')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                !isV2T
                  ? 'bg-primary-600/80 text-white shadow-sm'
                  : 'text-white/35 hover:text-white/55'
              }`}
            >
              AI Terminal
            </button>
          </div>
        </div>
      </div>

      {/* ── Debug Log Panel (오버레이) ──────────────────────────────────────── */}
      {showDebug && (
        <div className="absolute inset-0 z-40 flex flex-col bg-[#0a0c10] border border-orange-500/20 overflow-hidden"
          style={{ top: 36 }}
        >
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/8 bg-[#0d1117] flex-shrink-0">
            <span className="text-xs text-orange-400/80 font-mono font-semibold">NOVA DEBUG LOG</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/25 font-mono">{debugLogs.length} entries</span>
              <button
                onClick={() => {
                  const text = debugLogs.map(e => {
                    const time = new Date(e.ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    return `[${time}] [${e.level.toUpperCase()}] ${e.msg}`
                  }).join('\n')
                  navigator.clipboard.writeText(text).catch(() => {})
                }}
                className="text-xs text-white/25 hover:text-white/50 px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
                title="로그 복사">
                copy
              </button>
              <button onClick={() => setDebugLogs([])}
                className="text-xs text-white/25 hover:text-white/50 px-2 py-0.5 rounded hover:bg-white/5 transition-colors">
                clear
              </button>
              <button onClick={() => setShowDebug(false)}
                className="text-xs text-white/30 hover:text-white/60 px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors">
                ✕
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 py-2 px-3 space-y-0.5 font-mono text-[11px] select-text">
            {debugLogs.length === 0 && (
              <div className="text-white/20 py-4 text-center">로그 없음 — 음성 명령을 실행하면 여기에 표시됩니다</div>
            )}
            {debugLogs.map((entry, i) => {
              const time = new Date(entry.ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
              const color =
                entry.level === 'error'   ? 'text-red-400/90' :
                entry.level === 'warn'    ? 'text-yellow-400/80' :
                entry.level === 'success' ? 'text-green-400/80' :
                'text-white/45'
              const bg =
                entry.level === 'error'   ? 'bg-red-500/5 border-l border-red-500/30' :
                entry.level === 'success' ? 'bg-green-500/5 border-l border-green-500/20' :
                ''
              return (
                <div key={i} className={`flex gap-2 items-start py-0.5 px-1 rounded ${bg}`}>
                  <span className="text-white/20 flex-shrink-0 w-[56px]">{time}</span>
                  <span className={`flex-shrink-0 w-[6px] ${
                    entry.level === 'error' ? 'text-red-400' :
                    entry.level === 'warn' ? 'text-yellow-400' :
                    entry.level === 'success' ? 'text-green-400' : 'text-white/20'
                  }`}>■</span>
                  <span className={`${color} whitespace-pre-wrap leading-relaxed break-words min-w-0`}>
                    {entry.msg}
                  </span>
                </div>
              )
            })}
            <div ref={debugBottomRef} />
          </div>
        </div>
      )}

      {/* ── NCO Health Panel ───────────────────────────────────────────────── */}
      {showHealth && (
        <div className="absolute inset-0 z-40 flex flex-col bg-[#0a0c10] border border-emerald-500/20 overflow-hidden"
          style={{ top: 36 }}
        >
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/8 bg-[#0d1117] flex-shrink-0">
            <span className="text-xs text-emerald-400/80 font-mono font-semibold">NCO AI PROVIDER HEALTH</span>
            <div className="flex items-center gap-2">
              {healthResults.length > 0 && (
                <span className="text-xs font-mono">
                  <span className="text-emerald-400">{healthResults.filter(r => r.status === 'online').length} online</span>
                  {healthResults.filter(r => r.status === 'offline').length > 0 && (
                    <span className="text-red-400 ml-2">{healthResults.filter(r => r.status === 'offline').length} offline</span>
                  )}
                </span>
              )}
              <button onClick={runHealthCheck} disabled={healthChecking}
                className="text-xs text-white/40 hover:text-white/70 px-2 py-0.5 rounded hover:bg-white/5 transition-colors disabled:opacity-40">
                {healthChecking ? '체크 중...' : '새로고침'}
              </button>
              <button onClick={() => setShowHealth(false)}
                className="text-xs text-white/30 hover:text-white/60 px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors">
                ✕
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 py-2 px-2 select-text">
            {healthChecking && healthResults.length === 0 && (
              <div className="flex items-center gap-2 text-white/30 text-xs py-6 justify-center">
                <span className="w-3 h-3 border border-white/30 border-t-transparent rounded-full animate-spin" />
                프로바이더 헬스 체크 중...
              </div>
            )}
            {healthResults.length > 0 && (
              <div className="grid grid-cols-1 gap-1.5">
                {healthResults.map(p => {
                  const isOnline = p.status === 'online'
                  const isDegraded = p.status === 'degraded'
                  const dotColor = isOnline ? 'bg-emerald-400' : isDegraded ? 'bg-yellow-400' : 'bg-red-500'
                  const borderColor = isOnline ? 'border-emerald-500/15' : isDegraded ? 'border-yellow-500/20' : 'border-red-500/20'
                  const bgColor = isOnline ? 'bg-emerald-500/5' : isDegraded ? 'bg-yellow-500/5' : 'bg-red-500/5'
                  return (
                    <div key={p.id} className={`flex items-start gap-2 px-3 py-2 rounded-lg border ${borderColor} ${bgColor}`}>
                      {/* Status dot */}
                      <div className="flex items-center pt-0.5 flex-shrink-0">
                        <span className={`w-2 h-2 rounded-full ${dotColor} ${isOnline ? 'shadow-sm shadow-emerald-500/50' : ''}`} />
                      </div>
                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-white/80">{p.name}</span>
                          <span className="text-[10px] text-white/25 font-mono bg-white/5 px-1.5 py-0.5 rounded">{p.role}</span>
                          <span className="text-[10px] text-white/20 font-mono">{p.type}</span>
                        </div>
                        {(p.version || p.model) && (
                          <div className="text-[10px] text-white/35 font-mono mt-0.5 truncate">
                            {p.version || p.model}
                          </div>
                        )}
                        {p.error && (
                          <div className="text-[10px] text-red-400/70 font-mono mt-0.5 truncate">{p.error}</div>
                        )}
                      </div>
                      {/* Latency + status */}
                      <div className="flex-shrink-0 text-right">
                        <div className={`text-[10px] font-mono font-semibold ${isOnline ? 'text-emerald-400/80' : isDegraded ? 'text-yellow-400/80' : 'text-red-400/70'}`}>
                          {p.status === 'online' ? 'ONLINE' : p.status === 'degraded' ? 'DEGRADED' : 'OFFLINE'}
                        </div>
                        {p.latencyMs > 0 && (
                          <div className={`text-[10px] font-mono ${p.latencyMs > 2000 ? 'text-yellow-400/60' : 'text-white/25'}`}>
                            {p.latencyMs}ms
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {healthResults.length > 0 && (
              <div className="text-[10px] text-white/20 font-mono px-1 pt-2">
                마지막 체크: {new Date(healthResults[0]?.checkedAt || 0).toLocaleTimeString('ko-KR', { hour12: false })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── V2T: message stream (hidden when terminal mode, but stays mounted) */}
      <div className={`flex-col flex-1 min-h-0 overflow-hidden ${isV2T ? 'flex' : 'hidden'}`}>
        <div className="flex-1 overflow-y-auto min-h-0 py-3 px-4 space-y-1.5 font-mono text-sm select-text">
          {messages.map((msg) => <MessageRow key={msg.id} msg={msg} />)}
          {isProcessing && (
            <div className="flex items-center gap-2 text-white/30 text-xs py-1">
              <span className="w-3 h-3 border border-white/25 border-t-transparent rounded-full animate-spin inline-block flex-shrink-0" />
              <span>
                {aiStage === 'transcribing' ? 'Whisper 변환 중...' :
                 aiStage === 'ai_processing' || aiStage === 'nco_processing' || aiStage === 'nco_discussion' ? 'AI 처리 중...' : 'AI 분석 중...'}
              </span>
              <button
                onClick={() => window.electronAPI.cancelAI?.()}
                className="ml-2 text-red-400/60 hover:text-red-400 text-xs px-1.5 py-0.5 rounded border border-red-400/20 hover:border-red-400/50 transition-colors"
                title="작업 취소 (Ctrl+Shift+Escape)">
                ✕ 취소
              </button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* V2T: full input bar */}
        <div className="border-t border-white/8 px-3 py-2 flex items-center gap-2 flex-shrink-0">
          <label className="cursor-pointer p-1 rounded text-white/25 hover:text-white/50 transition-colors flex-shrink-0" title="파일 첨부">
            <input type="file" multiple className="hidden"
              onChange={async (e) => {
                for (const file of Array.from(e.target.files || [])) {
                  const att = await readFileAsAttachment(file)
                  if (att) addAttachment(att)
                }
                e.target.value = ''
              }}
            />
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          </label>
          <button
            onClick={toggleRecording}
            title={isRecording ? '녹음 중지' : '녹음 시작'}
            className={`relative w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
              isRecording ? 'bg-red-500 shadow-[0_0_14px_rgba(239,68,68,0.45)]' : 'bg-white/10 hover:bg-white/18'
            }`}
          >
            {isRecording && <span className="absolute inset-0 rounded-full bg-red-400/20 animate-ping pointer-events-none" />}
            {isRecording ? (
              <svg className="w-3.5 h-3.5 text-white relative" fill="currentColor" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
            ) : (
              <svg className="w-4 h-4 text-white relative" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m-4-4h8m-4-8a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            )}
          </button>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRecording ? '🎙 녹음 중...' : '음성 입력 대기 중 (⌃ Shift Space)'}
            disabled={isRecording}
            className="flex-1 bg-transparent text-white/85 placeholder-white/20 outline-none text-sm disabled:opacity-30 font-sans"
            autoFocus
          />
        </div>

        <div className="px-4 py-1 flex justify-between text-[10px] text-white/15 border-t border-white/5 flex-shrink-0 font-sans">
          <span>⌃ Shift Space · 전역 녹음 단축키</span>
          <span>직접 입력 모드 · autoInject</span>
        </div>
      </div>

      {/* ── AI Terminal: always mounted, hidden in V2T mode (keeps PTY session) */}
      <div className={`flex-col flex-1 min-h-0 overflow-hidden ${isV2T ? 'hidden' : 'flex'}`}>
        {/* xterm.js PTY terminal — never unmounts, session persists across tab switches */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <TerminalPanel />
        </div>

        {/* minimal mic bar */}
        <div className="border-t border-white/8 px-3 py-1.5 flex items-center gap-3 flex-shrink-0 bg-[#0d1117]">
          <button
            onClick={toggleRecording}
            title={isRecording ? '녹음 중지' : '녹음 시작 (음성 → 터미널)'}
            className={`relative w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
              isRecording ? 'bg-red-500 shadow-[0_0_14px_rgba(239,68,68,0.45)]' : 'bg-white/10 hover:bg-white/18'
            }`}
          >
            {isRecording && <span className="absolute inset-0 rounded-full bg-red-400/20 animate-ping pointer-events-none" />}
            {isRecording ? (
              <svg className="w-3 h-3 text-white relative" fill="currentColor" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
            ) : (
              <svg className="w-3.5 h-3.5 text-white relative" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m-4-4h8m-4-8a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            )}
          </button>
          {isRecording ? (
            <div className="flex items-center gap-1.5 flex-1">
              <span className="text-red-400 text-xs font-mono">{duration}</span>
              <div className="flex items-center gap-[1.5px] h-3">
                {Array.from({ length: 12 }, (_, i) => {
                  const h = 2 + audioLevel * (Math.sin(i * 0.8) * 0.4 + 0.6) * 9
                  return <div key={i} className="rounded-full bg-red-400/60 flex-shrink-0"
                    style={{ width: 2, height: Math.max(2, h), transition: 'height 80ms ease-out' }} />
                })}
              </div>
            </div>
          ) : (
            <span className="text-white/20 text-[10px] font-sans">⌃ Shift Space · 음성 → 터미널 자동 실행</span>
          )}
        </div>
      </div>

      {/* ── Attachment strip (always visible when files pending) ──────────── */}
      {pendingAttachments.length > 0 && (
        <div className="px-3 py-2 border-t border-white/5 bg-white/2 flex items-center gap-2 flex-shrink-0">
          <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
            {pendingAttachments.map(att => (
              <span key={att.id}
                className="flex items-center gap-1 text-xs bg-white/8 border border-white/10 rounded-md px-2 py-0.5 font-sans">
                <span>{fileIcon(att.mimeType)}</span>
                <span className="text-white/60 max-w-[90px] truncate">{att.name}</span>
                <button onClick={() => removeAttachment(att.id)}
                  className="text-white/25 hover:text-white/60 ml-0.5 transition-colors">×</button>
              </span>
            ))}
          </div>
          <button
            onClick={handleProcessAttachments}
            disabled={isProcessingAttachment}
            className="text-xs px-2.5 py-1 bg-primary-600/80 hover:bg-primary-500 text-white rounded-md
              transition-all disabled:opacity-40 flex-shrink-0 font-sans"
          >
            AI 분석
          </button>
          <button onClick={clearAttachments} className="text-white/25 hover:text-white/50 text-xs font-sans flex-shrink-0">취소</button>
        </div>
      )}
    </div>
  )
}

// ─── CopyBtn ─────────────────────────────────────────────────────────────────

function CopyBtn({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = React.useState(false)
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button
      onClick={handleCopy}
      title="복사"
      className={`opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 p-1 rounded hover:bg-white/10 ${className}`}
    >
      {copied ? (
        <svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3 h-3 text-white/35 hover:text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  )
}

// ─── MessageRow ───────────────────────────────────────────────────────────────

function MessageRow({ msg }: { msg: Msg }) {
  switch (msg.type) {
    case 'system':
      return (
        <div className="text-white/22 text-xs italic whitespace-pre-wrap leading-relaxed py-0.5">
          {msg.text}
        </div>
      )

    case 'voice':
      return (
        <div className="group flex items-start gap-2 py-0.5">
          <span className="text-cyan-400/50 flex-shrink-0 text-xs mt-0.5">🎤</span>
          <span className="text-cyan-200/85 leading-relaxed flex-1">{msg.text}</span>
          <CopyBtn text={msg.text} className="mt-0.5" />
        </div>
      )

    case 'typed':
      return (
        <div className="group flex items-start gap-2 py-0.5">
          <span className="text-white/25 flex-shrink-0 text-xs mt-0.5 font-mono">▶</span>
          <span className="text-white/80 leading-relaxed flex-1">{msg.text}</span>
          <CopyBtn text={msg.text} className="mt-0.5" />
        </div>
      )

    case 'ai':
      return (
        <div className="group my-1 pl-3 border-l-2 border-primary-500/35 py-1">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] text-primary-400/50 font-sans font-medium tracking-wide">NOVA</div>
            <CopyBtn text={msg.text} />
          </div>
          <p className="text-white/80 leading-relaxed whitespace-pre-wrap text-sm font-sans">{msg.text}</p>
        </div>
      )

    case 'cmd':
      return (
        <div className="group flex items-start gap-2 bg-green-400/5 border border-green-400/10 rounded-lg px-2.5 py-1.5 my-0.5">
          <span className="text-green-400/60 flex-shrink-0 text-xs mt-0.5">$</span>
          <span className="text-green-300/90 whitespace-pre-wrap break-words flex-1">{msg.text}</span>
          <CopyBtn text={msg.text} className="mt-0.5" />
        </div>
      )

    case 'stdout':
      return (
        <div className="group relative">
          <pre className="text-white/55 whitespace-pre-wrap break-words pl-5 leading-relaxed text-xs py-0 pr-6">
            {msg.text}
          </pre>
          <CopyBtn text={msg.text} className="absolute top-0 right-0" />
        </div>
      )

    case 'stderr':
      return (
        <div className="group relative">
          <pre className="text-yellow-300/65 whitespace-pre-wrap break-words pl-5 leading-relaxed text-xs py-0 pr-6">
            {msg.text}
          </pre>
          <CopyBtn text={msg.text} className="absolute top-0 right-0" />
        </div>
      )

    case 'error':
      return (
        <div className="group flex items-start gap-2 text-red-400/80 text-xs pl-2 py-0.5 border-l-2 border-red-500/30">
          <span className="flex-1">{msg.text}</span>
          <CopyBtn text={msg.text} />
        </div>
      )

    case 'inject':
      return (
        <div className="text-white/22 text-xs py-0.5">
          ✓ 입력됨 — {msg.text.substring(0, 60)}{msg.text.length > 60 ? '…' : ''}
        </div>
      )

    case 'attachment':
      return (
        <div className="flex items-center gap-2 text-xs text-white/40 py-0.5 font-sans">
          <span>{msg.label}</span>
          <span className="text-white/25">{msg.text}</span>
        </div>
      )

    default:
      return null
  }
}
