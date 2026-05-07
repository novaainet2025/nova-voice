/**
 * TerminalPanel — xterm.js + node-pty 실제 터미널 에뮬레이터
 */

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

const CLAUDE_CMD = '/Users/nova-ai/.local/bin/claude --dangerously-skip-permissions\r'

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [shellName, setShellName] = useState('zsh')
  const autoStartedRef = useRef(false)

  // xterm.js 초기화
  useEffect(() => {
    if (!containerRef.current || termRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
        selectionBackground: '#264f78',
      },
      scrollback: 5000,
      allowTransparency: false,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    // 키 입력 → PTY로 전달
    term.onData((data) => {
      window.electronAPI?.ptyInput?.(data)
    })

    // PTY 출력 → xterm.js로 렌더링
    const cleanupData = window.electronAPI?.onPtyData?.((data) => {
      term.write(data)
    })

    // PTY 종료 → 알림
    const cleanupExit = window.electronAPI?.onPtyExit?.((code) => {
      term.writeln(`\r\n\x1b[33m[셸 종료: exit ${code} — 재시작 중...]\x1b[0m`)
    })

    // PTY 생성 (이미 실행 중이면 재생성 안 함)
    window.electronAPI?.ptyCreate?.(term.cols, term.rows).then(() => {
      setIsReady(true)
      term.focus()

      // zsh 초기화 완료를 기다렸다가 claude 자동 실행
      // (.zshrc 로딩 등 충분히 대기 = 2초)
      if (!autoStartedRef.current) {
        autoStartedRef.current = true
        setTimeout(() => {
          window.electronAPI?.ptyInput?.(CLAUDE_CMD)
        }, 2000)
      }
    }).catch((e) => {
      term.writeln(`\r\n\x1b[31m[PTY 초기화 실패: ${e?.message || e}]\x1b[0m`)
    })

    // PTY 상태 조회
    window.electronAPI?.ptyStatus?.().then((s) => {
      if (s?.shell) setShellName(s.shell.split('/').pop() || 'zsh')
    }).catch(() => {})

    return () => {
      cleanupData?.()
      cleanupExit?.()
      term.dispose()
      termRef.current = null
    }
  }, [])

  // 창 크기 변경 → PTY 리사이즈
  useEffect(() => {
    const handleResize = () => {
      if (!fitAddonRef.current || !termRef.current) return
      fitAddonRef.current.fit()
      window.electronAPI?.ptyResize?.(termRef.current.cols, termRef.current.rows)
    }

    const observer = new ResizeObserver(handleResize)
    if (containerRef.current) observer.observe(containerRef.current)
    window.addEventListener('resize', handleResize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  const focusTerminal = useCallback(() => {
    termRef.current?.focus()
  }, [])

  return (
    <div className="flex flex-col h-full bg-[#0d1117]" onClick={focusTerminal}>
      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/8 bg-[#161b22] flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isReady ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'}`} />
          <span className="text-white/60 text-xs">{shellName}</span>
          <span className="text-white/30 text-xs">— node-pty</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              autoStartedRef.current = false
              termRef.current?.clear()
              // force=true: 기존 PTY 종료 후 재시작 → 2초 후 claude 재실행
              window.electronAPI?.ptyCreate?.(termRef.current?.cols, termRef.current?.rows, true).then(() => {
                setTimeout(() => {
                  window.electronAPI?.ptyInput?.(CLAUDE_CMD)
                }, 2000)
              })
            }}
            className="text-xs text-white/30 hover:text-white/60 transition-colors px-2 py-0.5 rounded"
          >
            재시작
          </button>
          <button
            onClick={() => termRef.current?.clear()}
            className="text-xs text-white/30 hover:text-white/60 transition-colors px-2 py-0.5 rounded"
          >
            clear
          </button>
        </div>
      </div>

      {/* xterm.js 컨테이너 — 파일 드래그앤드롭 지원 */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden p-1"
        style={{ background: '#0d1117' }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const files = Array.from(e.dataTransfer.files)
          if (files.length === 0) return
          // Electron에서 File 객체에 path 속성 제공
          const paths = files.map(f => window.electronAPI.getPathForFile(f)).filter(Boolean)
          if (paths.length > 0) {
            // 파일 경로를 PTY 입력으로 삽입 (공백으로 구분)
            const pathStr = paths.map(p => p.includes(' ') ? `"${p}"` : p).join(' ')
            window.electronAPI?.ptyInput?.(pathStr)
            termRef.current?.focus()
          }
        }}
      />

      {/* 하단 힌트 */}
      <div className="px-4 py-1.5 text-[10px] text-white/20 border-t border-white/5 flex-shrink-0">
        실제 {shellName} 터미널 · 음성 명령 시 Claude Code 자동 실행 · <kbd className="bg-white/5 px-1 rounded">Ctrl+C</kbd> 중단
      </div>
    </div>
  )
}
