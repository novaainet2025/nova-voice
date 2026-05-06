import React, { useEffect, useCallback, useRef, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useRecorder } from '../../hooks/useRecorder'
import type { Attachment } from '../../../shared/types'

const BAR_COUNT = 32

// File types we can handle as text
const TEXT_MIME_TYPES = new Set([
  'text/plain', 'text/html', 'text/css', 'text/javascript', 'text/typescript',
  'text/csv', 'text/markdown', 'text/xml',
  'application/json', 'application/xml', 'application/javascript',
])

function isTextMime(mime: string): boolean {
  return TEXT_MIME_TYPES.has(mime) || mime.startsWith('text/')
}

function fileIcon(mime: string): string {
  if (mime.startsWith('image/')) return '🖼️'
  if (mime === 'application/pdf') return '📄'
  if (mime.includes('json')) return '📋'
  if (mime.startsWith('text/')) return '📝'
  return '📎'
}

async function readFileAsAttachment(file: File): Promise<Attachment | null> {
  const id = crypto.randomUUID()
  const mimeType = file.type || 'application/octet-stream'

  if (file.type.startsWith('image/')) {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string
        // Strip the "data:image/...;base64," prefix
        const base64 = dataUrl.split(',')[1] || ''
        resolve({ id, name: file.name, mimeType, size: file.size, base64 })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
  }

  if (isTextMime(mimeType)) {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const content = e.target?.result as string
        resolve({ id, name: file.name, mimeType, size: file.size, content })
      }
      reader.onerror = () => resolve(null)
      reader.readAsText(file)
    })
  }

  // Unknown type — try as text (best effort)
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const content = e.target?.result as string
      resolve({ id, name: file.name, mimeType: 'text/plain', size: file.size, content })
    }
    reader.onerror = () => resolve(null)
    reader.readAsText(file)
  })
}

export function HomePage() {
  const {
    isRecording, recordingDuration, audioLevel,
    currentTranscription, isTranscribing, aiStage,
    aiModes, currentMode, settings,
    setCurrentMode, setAIModes, setSettings, setAIProviderStatus,
    pendingAttachments, isProcessingAttachment,
    addAttachment, removeAttachment, clearAttachments, setProcessingAttachment,
    setAIStage,
  } = useAppStore()
  const { startRecording, stopRecording, cancelRecording } = useRecorder()

  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounter = useRef(0)

  // Load AI modes on mount
  useEffect(() => {
    if (!window.electronAPI) return
    window.electronAPI.getAIModes?.().then((modes: any[]) => setAIModes(modes))
    window.electronAPI.getAIStatus?.().then((status: any) => setAIProviderStatus(status))
  }, [setAIModes, setAIProviderStatus])

  // ── Paste handler ──
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (!file) continue
          const attachment = await readFileAsAttachment(file)
          if (attachment) addAttachment(attachment)
        }
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [addAttachment])

  // ── Drag & Drop handlers ──
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

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)

    // Claude Terminal이 사용 가능하면 파일을 직접 Claude에 전달
    if (window.electronAPI?.claudeSend) {
      for (const file of files) {
        const filePath = (file as any).path as string | undefined
        let msg = ''
        if (filePath) {
          msg = `파일을 첨부합니다: ${filePath}`
        } else {
          const att = await readFileAsAttachment(file)
          if (att?.content) {
            msg = `파일: ${file.name}\n\`\`\`\n${att.content.slice(0, 8000)}\n\`\`\``
          } else {
            msg = `파일 첨부: ${file.name}`
          }
        }
        if (msg) {
          try { await window.electronAPI.claudeSend(msg) }
          catch (err) { console.error('[Drop→Claude] 전송 실패:', err) }
        }
      }
      return
    }

    // Claude Terminal 미사용 시 기존 동작 (대기열 추가)
    for (const file of files) {
      const attachment = await readFileAsAttachment(file)
      if (attachment) addAttachment(attachment)
    }
  }, [addAttachment])

  // ── Process attachments with AI ──
  const handleProcessAttachments = useCallback(async () => {
    if (!window.electronAPI || pendingAttachments.length === 0 || isProcessingAttachment) return

    setProcessingAttachment(true)
    setAIStage('ai_processing')

    for (const att of pendingAttachments) {
      try {
        await (window.electronAPI as any).processAttachment({
          name: att.name,
          mimeType: att.mimeType,
          content: att.content,
          base64: att.base64,
          modeId: currentMode,
        })
      } catch (e) {
        console.error('[Attachment] Process error:', e)
      }
    }

    clearAttachments()
    setProcessingAttachment(false)
  }, [pendingAttachments, currentMode, isProcessingAttachment, setProcessingAttachment, setAIStage, clearAttachments])

  const handleModeChange = async (modeId: string) => {
    setCurrentMode(modeId)
    if (window.electronAPI) {
      await window.electronAPI.setSettings({ aiMode: modeId })
    }
  }

  const formattedDuration = (() => {
    const mins = Math.floor(recordingDuration / 60)
    const secs = Math.floor(recordingDuration % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  })()

  const stageLabels: Record<string, string> = {
    'transcribing': 'Transcribing...',
    'ai_processing': `AI Processing (${currentMode})...`,
    'command_parsing': '🎮 Parsing command...',
    'confirm_required': '⚠️ Confirming...',
    'nco_discussion': '🗣️ NCO Discussion running...',
    'nco_parallel': '👥 NCO Team executing...',
    'nco_agent': '🤖 NCO Agent working...',
    'nco_hive': '🐝 NCO Hive collaborating...',
    'done': ''
  }
  const stageLabel = stageLabels[aiStage] || ''

  const isBusy = isTranscribing || isProcessingAttachment || (aiStage && aiStage !== 'idle' && aiStage !== 'done')

  return (
    <div
      className="h-full flex flex-col items-center justify-center p-6 relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center rounded-xl
          bg-primary-600/20 border-2 border-dashed border-primary-400 backdrop-blur-sm pointer-events-none">
          <div className="text-4xl mb-2">📂</div>
          <p className="text-primary-300 font-medium text-sm">파일을 여기에 놓으세요</p>
          <p className="text-white/40 text-xs mt-1">이미지, 텍스트, 코드 파일 지원</p>
        </div>
      )}

      {/* App title */}
      <div className="text-center mb-4">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-primary-400 to-primary-600 bg-clip-text text-transparent">
          NOVA-VOICE
        </h1>
        <p className="text-xs text-white/40 mt-1">Voice to Text, Everywhere</p>
      </div>

      {/* AI Mode selector — grouped by category */}
      <div className="mb-5 w-full max-w-lg">
        {(['text', 'voice', 'agentic', 'collab'] as const).map((cat) => {
          const catModes = aiModes.filter((m: any) => (m.category || 'text') === cat)
          if (catModes.length === 0) return null
          const catLabels: Record<string, string> = {
            text: '✏️ Text', voice: '🔊 Voice', agentic: '🎮 Control', collab: '🤝 NCO'
          }
          return (
            <div key={cat} className="mb-2">
              <div className="text-[10px] text-white/30 uppercase tracking-wider mb-1 ml-1">
                {catLabels[cat]}
              </div>
              <div className="flex flex-wrap gap-1">
                {catModes.map((mode: any) => (
                  <button
                    key={mode.id}
                    onClick={() => handleModeChange(mode.id)}
                    title={mode.description}
                    className={`px-2 py-1 rounded-lg text-xs font-medium transition-all ${
                      currentMode === mode.id
                        ? cat === 'agentic' ? 'bg-orange-600 text-white shadow-md'
                        : cat === 'collab' ? 'bg-green-600 text-white shadow-md'
                        : cat === 'voice' ? 'bg-purple-600 text-white shadow-md'
                        : 'bg-primary-600 text-white shadow-md'
                        : 'bg-white/5 text-white/50 hover:bg-white/10'
                    }`}
                  >
                    <span className="mr-0.5">{mode.icon}</span>
                    {mode.name}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
        {currentMode !== 'direct' && (
          <p className="text-center text-xs text-primary-400/60 mt-2">
            {aiModes.find((m: any) => m.id === currentMode)?.description}
          </p>
        )}
      </div>

      {/* Recording button */}
      <div className="relative mb-6">
        {isRecording && (
          <div className="absolute inset-0 rounded-full bg-red-500/20 animate-ping" />
        )}
        <button
          onClick={isRecording ? stopRecording : startRecording}
          className={`relative w-20 h-20 rounded-full flex items-center justify-center transition-all
            shadow-lg hover:shadow-xl active:scale-95 ${
            isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-primary-600 hover:bg-primary-500'
          }`}
        >
          {isRecording ? (
            <svg className="w-7 h-7 text-white" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m-4-4h8m-4-8a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          )}
        </button>
      </div>

      {/* Recording status + Equalizer */}
      {isRecording && (
        <div className="text-center mb-4 w-full max-w-sm">
          <div className="flex items-center gap-2 justify-center mb-3">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse-recording" />
            <span className="text-sm font-medium">Recording</span>
            <span className="text-sm font-mono text-white/50">{formattedDuration}</span>
          </div>
          <div className="flex items-center justify-center gap-[2px] h-12">
            {Array.from({ length: BAR_COUNT }, (_, i) => {
              const phase = Math.sin(Date.now() / 100 + i * 0.55) * 0.3 + 0.7
              const phase2 = Math.cos(Date.now() / 170 + i * 0.8) * 0.2
              const raw = audioLevel * (phase + phase2)
              const h = 3 + raw * 42
              const centerDist = Math.abs(i - BAR_COUNT / 2) / (BAR_COUNT / 2)
              const opacity = 0.4 + (1 - centerDist) * 0.6
              return (
                <div key={i} className="rounded-full" style={{
                  width: 3, height: Math.max(3, h),
                  backgroundColor: `rgba(116, 143, 252, ${opacity})`,
                  transition: 'height 80ms ease-out',
                }} />
              )
            })}
          </div>
          <button onClick={cancelRecording}
            className="mt-3 text-xs text-white/40 hover:text-white/60 transition-colors">
            Cancel (Esc)
          </button>
        </div>
      )}

      {/* AI processing stage */}
      {isBusy && (
        <div className="flex items-center gap-2 mb-4">
          <div className="w-5 h-5 border-2 border-primary-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-white/60">{stageLabel || 'Processing...'}</span>
        </div>
      )}

      {/* ── Pending attachments ── */}
      {pendingAttachments.length > 0 && (
        <div className="w-full max-w-md mb-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-white/40 uppercase tracking-wider">첨부 파일</span>
            <button
              onClick={clearAttachments}
              className="text-xs text-white/30 hover:text-white/60 transition-colors"
            >
              모두 제거
            </button>
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            {pendingAttachments.map((att) => (
              <div
                key={att.id}
                className="flex items-center gap-1.5 bg-white/8 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs"
              >
                <span>{fileIcon(att.mimeType)}</span>
                <span className="text-white/70 max-w-[120px] truncate">{att.name}</span>
                <span className="text-white/30">{(att.size / 1024).toFixed(0)}KB</span>
                <button
                  onClick={() => removeAttachment(att.id)}
                  className="ml-1 text-white/30 hover:text-white/70 transition-colors"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={handleProcessAttachments}
            disabled={!!isBusy}
            className="w-full py-2 rounded-xl bg-primary-600 hover:bg-primary-500 disabled:opacity-40
              text-sm font-medium transition-all active:scale-98 flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            AI로 분석하기
            {pendingAttachments.length > 1 && (
              <span className="bg-white/20 text-white text-xs px-1.5 py-0.5 rounded-full">
                {pendingAttachments.length}
              </span>
            )}
          </button>
        </div>
      )}

      {/* Last transcription result */}
      {currentTranscription && !isRecording && aiStage !== 'ai_processing' && (
        <div className="glass-light rounded-xl p-4 max-w-md w-full">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-white/80 leading-relaxed">{currentTranscription}</p>
            <button
              onClick={() => navigator.clipboard.writeText(currentTranscription)}
              className="p-1.5 rounded-lg hover:bg-white/10 transition-colors flex-shrink-0"
              title="Copy"
            >
              <svg className="w-4 h-4 text-white/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Shortcut hint + drop hint */}
      {!isRecording && !isTranscribing && !currentTranscription && pendingAttachments.length === 0 && (
        <div className="text-center space-y-2">
          <p className="text-sm text-white/30">
            Press{' '}
            <kbd className="px-2 py-1 bg-white/10 rounded-md text-white/50 text-xs font-mono">
              {window.electronAPI?.platform === 'darwin' ? '⌃' : 'Ctrl'} + Shift + Space
            </kbd>{' '}
            to start
          </p>
          <p className="text-xs text-white/20">
            파일을 드래그하거나 붙여넣기(⌘V)로 첨부
          </p>
        </div>
      )}
    </div>
  )
}
