import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'

export function HistoryPanel() {
  const { history, setHistory } = useAppStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeqRef = useRef(0)
  const hasMountedSearchEffectRef = useRef(false)

  const loadHistory = useCallback(async (seq?: number) => {
    const items = await window.electronAPI.getHistory(100, 0)
    if (typeof seq === 'number' && seq !== searchSeqRef.current) return
    setHistory(items)
  }, [setHistory])

  useEffect(() => {
    const seq = ++searchSeqRef.current
    void loadHistory(seq)
  }, [loadHistory])

  useEffect(() => {
    if (!hasMountedSearchEffectRef.current) {
      hasMountedSearchEffectRef.current = true
      return
    }
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)

    const seq = ++searchSeqRef.current
    searchDebounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          if (searchQuery.trim()) {
            const results = await window.electronAPI.searchHistory(searchQuery)
            if (seq !== searchSeqRef.current) return
            setHistory(results)
            return
          }
          await loadHistory(seq)
        } catch (error) {
          console.warn('[HistoryPanel] Search refresh failed; keeping current results', error)
        }
      })()
    }, 300)

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
    }
  }, [loadHistory, searchQuery, setHistory])

  const handleDelete = async (id: string) => {
    await window.electronAPI.deleteHistory(id)
    setHistory(history.filter((item) => item.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const handleCopy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    window.setTimeout(() => setCopiedId((current) => current === id ? null : current), 1400)
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp)
    const diff = Date.now() - date.getTime()
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)
    if (minutes < 1) return '방금 전'
    if (minutes < 60) return `${minutes}분 전`
    if (hours < 24) return `${hours}시간 전`
    if (days < 7) return `${days}일 전`
    return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="px-7 pt-7 pb-5 border-b border-white/[0.06] flex-shrink-0">
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="nova-eyebrow">VOICE ARCHIVE</p>
            <h2 className="nova-page-title">기록</h2>
            <p className="nova-page-copy">말로 남긴 생각을 다시 찾고, 복사하고, 이어가세요.</p>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-[10px] text-white/35 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-primary-400 shadow-[0_0_8px_rgba(109,139,255,.7)]" />
            {history.length} CLIPS
          </div>
        </div>

        <label className="mt-5 relative block group">
          <span className="sr-only">받아쓰기 기록 검색</span>
          <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 group-focus-within:text-primary-300 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" d="m20 20-4.5-4.5m2-5A7 7 0 1 1 3.5 10.5a7 7 0 0 1 14 0Z" />
          </svg>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="기억나는 단어나 문장을 검색하세요"
            className="w-full h-10 bg-white/[0.025] border border-white/[0.09] rounded-xl pl-10 pr-4 text-sm text-white/85 focus:outline-none focus:border-primary-400/50 focus:bg-white/[0.04] transition-all placeholder:text-white/25"
          />
        </label>
      </header>

      <div className="flex-1 overflow-y-auto min-h-0 p-5 sm:p-6">
        {history.length === 0 ? (
          <div className="h-full min-h-[250px] flex flex-col items-center justify-center text-center">
            <div className="relative w-20 h-20 mb-5 flex items-center justify-center">
              <span className="absolute inset-1 rounded-full border border-primary-400/15 rotate-[-12deg]" />
              <span className="absolute inset-3 rounded-full border border-purple-400/10 rotate-[18deg]" />
              <svg className="w-8 h-8 text-white/25" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35" d="M6 12h2l1.2-3.3 2.1 7 2.2-9 1.8 7.1L17 12h1" />
              </svg>
            </div>
            <p className="text-sm font-medium text-white/65">아직 저장된 목소리가 없습니다.</p>
            <p className="mt-2 text-xs text-white/30">⌃ ⇧ Space를 눌러 첫 받아쓰기를 시작하세요.</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-2.5">
            {history.map((item, index) => {
              const isSelected = selectedId === item.id
              return (
                <article
                  key={item.id}
                  onClick={() => setSelectedId(isSelected ? null : item.id)}
                  className={`group relative rounded-2xl px-4 py-4 cursor-pointer transition-all border ${
                    isSelected
                      ? 'border-primary-400/35 bg-primary-400/[0.065] shadow-[0_16px_38px_rgba(0,0,0,.18)]'
                      : 'border-white/[0.07] bg-white/[0.022] hover:border-white/[0.13] hover:bg-white/[0.038]'
                  }`}
                >
                  <div className="flex gap-3.5">
                    <div className="flex-shrink-0 w-8 pt-0.5 text-right font-mono text-[9px] tracking-wide text-white/20">
                      {String(index + 1).padStart(2, '0')}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={`text-[13px] leading-6 text-white/78 select-text ${isSelected ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
                        {item.text}
                      </p>
                      {isSelected && item.inputMode === 'meta' && item.sourceText && item.sourceText !== item.text && (
                        <p className="mt-3 border-l border-violet-300/20 pl-3 text-[10px] leading-5 text-white/30">
                          원문 · {item.sourceText}
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-white/28 font-mono uppercase tracking-wide">
                        <span>{formatDate(item.timestamp)}</span>
                        <span className="text-white/12">/</span>
                        {item.inputMode === 'meta' && (
                          <span className={item.metaPromptOutcome === 'fallback' ? 'text-amber-200/55' : 'text-violet-200/60'}>
                            {item.metaPromptOutcome === 'local-ai'
                              ? `META · ${(item.metaPromptProvider || 'Local AI · qwen3:14b').replace(/^Local AI\s*·\s*/i, '').toUpperCase()}`
                              : item.metaPromptOutcome === 'local'
                                ? 'META · SAFE'
                              : item.metaPromptOutcome === 'fallback'
                                ? 'META · LEGACY'
                                : `META · ${(item.metaPromptProvider || 'NCO').replace(/^NCO\s*·\s*/i, '').toUpperCase()}`}
                          </span>
                        )}
                        <span>{item.language || 'AUTO'}</span>
                        <span>{item.duration.toFixed(1)} SEC</span>
                        <span>{item.modelUsed}</span>
                      </div>
                    </div>
                    <div className={`flex flex-shrink-0 items-start gap-1 transition-opacity ${isSelected ? 'opacity-100' : 'opacity-30 group-hover:opacity-100'}`}>
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); void handleCopy(item.id, item.text) }}
                        className="min-w-8 h-8 px-2 rounded-lg inline-flex items-center justify-center text-white/50 hover:text-white hover:bg-white/8 transition-colors"
                        title="텍스트 복사"
                        aria-label="텍스트 복사"
                      >
                        {copiedId === item.id ? (
                          <span className="text-[9px] text-emerald-300 font-semibold">완료</span>
                        ) : (
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" d="M8 16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2m-6 12h8a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2Z" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); void handleDelete(item.id) }}
                        className="w-8 h-8 rounded-lg inline-flex items-center justify-center text-white/35 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                        title="기록 삭제"
                        aria-label="기록 삭제"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" d="m6 7 .8 13h10.4L18 7M9.5 11v5m5-5v5M4 7h16m-8-4h2.4c.9 0 1.6.7 1.6 1.6V7H8V4.6C8 3.7 8.7 3 9.6 3H12Z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
