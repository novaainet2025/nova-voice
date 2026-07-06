import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import type { TranscriptionResult } from '../../../shared/types'

export function HistoryPanel() {
  const { history, setHistory } = useAppStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
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

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current)
    }

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

  const handleSearch = (query: string) => {
    setSearchQuery(query)
  }

  const handleDelete = async (id: string) => {
    await window.electronAPI.deleteHistory(id)
    setHistory(history.filter((item) => item.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    if (days < 7) return `${days}d ago`
    return date.toLocaleDateString()
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <h2 className="text-xl font-semibold mb-4">History</h2>

      {/* Search */}
      <div className="relative mb-4">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search transcriptions..."
          className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm
            focus:outline-none focus:border-primary-400 transition-colors placeholder:text-white/30"
        />
      </div>

      {/* History list */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-white/30">
            <svg className="w-12 h-12 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m-4-4h8m-4-8a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <p className="text-sm">No transcriptions yet</p>
            <p className="text-xs mt-1">Start recording to see your history here</p>
          </div>
        ) : (
          history.map((item) => (
            <div
              key={item.id}
              onClick={() => setSelectedId(selectedId === item.id ? null : item.id)}
              className={`glass-light rounded-xl p-4 cursor-pointer transition-all border ${
                selectedId === item.id
                  ? 'border-primary-400/50 bg-primary-400/5'
                  : 'border-transparent hover:border-white/10'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className={`text-sm text-white/80 ${
                  selectedId === item.id ? '' : 'line-clamp-2'
                }`}>
                  {item.text}
                </p>
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCopy(item.text)
                    }}
                    className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                    title="Copy"
                  >
                    <svg className="w-3.5 h-3.5 text-white/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(item.id)
                    }}
                    className="p-1.5 rounded-lg hover:bg-red-500/20 transition-colors"
                    title="Delete"
                  >
                    <svg className="w-3.5 h-3.5 text-white/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-2 text-xs text-white/30">
                <span>{formatDate(item.timestamp)}</span>
                <span>{item.language}</span>
                <span>{item.duration.toFixed(1)}s</span>
                <span className="capitalize">{item.modelUsed}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
