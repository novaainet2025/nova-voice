import React, { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, STT_ENGINE_NAME } from '../../../shared/types'
import type { AppSettings, MetaPromptStatus, SttStatus } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'

interface LoginItemStatus {
  supported: boolean
  openAtLogin: boolean
  status: string
}

export function SettingsPanel() {
  const sharedSettings = useAppStore((state) => state.settings)
  const setStoreSettings = useAppStore((state) => state.setSettings)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loginStatus, setLoginStatus] = useState<LoginItemStatus | null>(null)
  const [sttStatus, setSttStatus] = useState<SttStatus | null>(null)
  const [metaStatus, setMetaStatus] = useState<MetaPromptStatus | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectError, setReconnectError] = useState('')
  const [shortcutError, setShortcutError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.getLoginItemStatus(),
      window.electronAPI.getSttStatus(),
      window.electronAPI.getMetaPromptStatus(),
    ]).then(([loadedSettings, loadedLoginStatus, loadedSttStatus, loadedMetaStatus]) => {
      setSettings(loadedSettings)
      setStoreSettings(loadedSettings)
      setLoginStatus(loadedLoginStatus)
      setSttStatus(loadedSttStatus)
      setMetaStatus(loadedMetaStatus)
    })
    const refreshTimer = window.setInterval(() => {
      void window.electronAPI.getMetaPromptStatus().then(setMetaStatus)
    }, 8_000)
    return () => window.clearInterval(refreshTimer)
  }, [setStoreSettings])

  useEffect(() => {
    if (sharedSettings) setSettings(sharedSettings)
  }, [sharedSettings])

  const persist = async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    setStoreSettings(next)
    const confirmed = await window.electronAPI.setSettings(patch)
    setSettings(confirmed)
    setStoreSettings(confirmed)
    setSaved(true)
    window.setTimeout(() => setSaved(false), 900)
  }

  /**
   * Shortcut writes are the one setting the main process can reject (another
   * app may already own the accelerator), so the rejection is surfaced and the
   * field is restored from the value that is actually registered.
   */
  const persistShortcut = async (patch: Partial<AppSettings>) => {
    setShortcutError('')
    try {
      await persist(patch)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setShortcutError(detail.replace(/^Error invoking remote method '[^']*':\s*Error:\s*/, ''))
      const current = await window.electronAPI.getSettings()
      setSettings(current)
      setStoreSettings(current)
    }
  }

  const toggleLaunchAtLogin = async () => {
    const enabled = !settings.launchAtLogin
    const next = { ...settings, launchAtLogin: enabled }
    setSettings(next)
    setStoreSettings(next)
    setLoginStatus(await window.electronAPI.setLoginItemEnabled(enabled))
  }

  const reconnectNco = async () => {
    if (reconnecting) return
    setReconnecting(true)
    setReconnectError('')
    try {
      setMetaStatus(await window.electronAPI.reconnectNcoProvider(settings.ncoProvider))
      setSaved(true)
      window.setTimeout(() => setSaved(false), 900)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setReconnectError(detail.replace(/^Error invoking remote method '[^']*':\s*Error:\s*/, ''))
    } finally {
      setReconnecting(false)
    }
  }

  const providerStatusLabel = (status: NonNullable<MetaPromptStatus['providers']>[number]['status']) => {
    switch (status) {
      case 'ready': return '사용 가능'
      case 'working': return '작업 중'
      case 'verification-required': return '온라인 · 재연결 필요'
      case 'limited': return '제한됨'
      case 'idle': return '온라인'
      default: return '오프라인'
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-6 sm:px-8 sm:py-7">
      <div className="mx-auto w-full max-w-3xl pb-8">
        <header className="flex items-end justify-between gap-5">
          <div>
            <p className="nova-eyebrow">STT CONTROL</p>
            <h2 className="nova-page-title">설정</h2>
            <p className="nova-page-copy">Whisper 받아쓰기와 NCO 메타 프롬프트 동작을 조정합니다.</p>
          </div>
          <span className={`text-[9px] font-mono tracking-[0.14em] transition-opacity ${saved ? 'text-emerald-300 opacity-100' : 'text-white/20 opacity-60'}`}>
            {saved ? 'SAVED' : 'AUTO SAVE'}
          </span>
        </header>

        <section className="mt-6 rounded-[24px] border border-white/[0.075] bg-white/[0.022] p-5">
          <div className="flex items-start justify-between gap-5">
            <div>
              <p className="text-[10px] font-mono tracking-[0.14em] text-white/28">OPTIMIZED ENGINE</p>
              <h3 className="mt-2 text-sm font-medium text-white/78">{STT_ENGINE_NAME}</h3>
              <p className="mt-1.5 text-xs leading-5 text-white/38">Apple Silicon MLX, 한국어 고정 디코딩, 16kHz 모노 PCM 직접 전송</p>
            </div>
            <span className={`mt-0.5 rounded-full border px-2.5 py-1 text-[9px] ${sttStatus?.ready ? 'border-emerald-300/15 bg-emerald-300/[0.055] text-emerald-200' : 'border-amber-300/15 bg-amber-300/[0.055] text-amber-200'}`}>
              {sttStatus?.ready ? '준비됨' : '시작 중'}
            </span>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2">
            {['16kHz PCM', 'No ffmpeg', 'Warm model'].map((item) => (
              <div key={item} className="rounded-xl border border-white/[0.055] bg-black/10 px-3 py-2 text-center text-[9px] font-mono text-white/38">{item}</div>
            ))}
          </div>
        </section>

        <section className="mt-4 rounded-[24px] border border-violet-300/[0.09] bg-[linear-gradient(145deg,rgba(113,91,220,.055),rgba(255,255,255,.018))] p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-mono tracking-[0.14em] text-violet-200/35">META PROMPT AI</p>
              <h3 className="mt-2 text-sm font-medium text-white/78">NCO 연결</h3>
              <p className="mt-1.5 text-xs leading-5 text-white/35">NCO Core 또는 전용 로컬 AI가 말한 요청을 다른 AI가 알아듣기 좋은 프롬프트로 다듬어 커서 위치에 입력합니다.</p>
            </div>
            <span className={`mt-0.5 rounded-full border px-2.5 py-1 text-[9px] ${metaStatus?.ncoConnected ? 'border-emerald-300/15 bg-emerald-300/[0.055] text-emerald-200' : 'border-amber-300/15 bg-amber-300/[0.055] text-amber-200'}`}>
              {metaStatus?.ncoConnected ? 'NCO 연결됨' : 'NCO 오프라인'}
            </span>
          </div>

          <div className="mt-5 border-t border-white/[0.055] pt-4">
            <SettingSwitch
              label="NCO 연결 사용"
              description="끄면 전용 로컬 AI만 사용합니다. 켜면 선택한 NCO 프로바이더와 로컬 AI 중 먼저 완료된 결과를 사용합니다."
              checked={settings.ncoEnabled}
              badge={settings.ncoEnabled ? '활성' : '로컬 전용'}
              onChange={() => void persist({ ncoEnabled: !settings.ncoEnabled })}
            />
          </div>

          <label className={`mt-4 block transition-opacity ${settings.ncoEnabled ? 'opacity-100' : 'opacity-45'}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-white/68">NCO 프로바이더</span>
              <span className="text-[9px] font-mono text-white/25">{metaStatus?.readyProviders?.length ?? 0} READY</span>
            </div>
            <select
              value={settings.ncoProvider}
              disabled={!settings.ncoEnabled}
              onChange={(event) => void persist({ ncoProvider: event.target.value })}
              className="mt-2 h-10 w-full rounded-xl border border-white/[0.08] bg-[#111520] px-3.5 text-xs text-white/68 outline-none transition-colors focus:border-violet-300/35 disabled:cursor-not-allowed"
            >
              <option value="auto">자동 선택 · 준비된 프로바이더로 전환</option>
              {(metaStatus?.providers ?? []).map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} · {providerStatusLabel(provider.status)}
                </option>
              ))}
            </select>
            <p className="mt-2 text-[10px] leading-5 text-white/28">
              {settings.ncoProvider === 'auto'
                ? `측정된 응답 속도와 NCO 실시간 상태로 프로바이더를 고르고, 실패하면 다음 순위로 즉시 넘어갑니다. 로컬 qwen3:14b도 병렬 대기하며 먼저 검증을 통과한 실제 AI 결과를 사용합니다.${metaStatus?.autoProvider ? ` 지금 선택: ${metaStatus.autoProvider}${metaStatus.autoReason ? ` · ${metaStatus.autoReason}` : ''}` : ''}`
                : `NCO에서는 ${settings.ncoProvider}만 요청합니다. 로컬 qwen3:14b도 병렬 대기하며, 지연·실패 시 먼저 검증된 실제 AI 결과를 사용합니다.`}
            </p>
          </label>

          {settings.ncoProvider === 'auto' && (metaStatus?.autoRanking?.length ?? 0) > 0 && (
            <div className="mt-4 overflow-hidden rounded-2xl border border-white/[0.06] bg-black/15">
              <p className="border-b border-white/[0.05] px-3.5 py-2 text-[9px] font-mono tracking-[0.14em] text-white/25">
                AUTO SELECTION RANKING
              </p>
              <ul>
                {(metaStatus?.autoRanking ?? []).slice(0, 6).map((entry, index) => (
                  <li key={entry.id} className="flex items-center gap-3 border-b border-white/[0.035] px-3.5 py-2 last:border-b-0">
                    <span className={`w-4 flex-shrink-0 text-center font-mono text-[9px] ${index === 0 && entry.eligible ? 'text-emerald-300/80' : 'text-white/22'}`}>
                      {index + 1}
                    </span>
                    <span className={`min-w-0 flex-shrink-0 text-[11px] ${entry.eligible ? 'text-white/70' : 'text-white/28'}`}>
                      {entry.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-white/28" title={entry.reason}>
                      {entry.reason}
                    </span>
                    {entry.avgSeconds != null && (
                      <span className="flex-shrink-0 font-mono text-[9px] text-primary-200/45">{entry.avgSeconds.toFixed(1)}s</span>
                    )}
                    {entry.successRate != null && (
                      <span className="flex-shrink-0 font-mono text-[9px] text-white/22">{Math.round(entry.successRate * 100)}%</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-1.5" aria-label="NCO 프로바이더 상태">
            {(metaStatus?.providers ?? []).map((provider) => (
              <span key={provider.id} title={`${providerStatusLabel(provider.status)}${provider.blockers.length ? ` · ${provider.blockers.join(', ')}` : ''}`} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[8px] font-mono tracking-wide ${provider.ready ? 'border-emerald-300/12 bg-emerald-300/[0.045] text-emerald-200/70' : provider.online ? 'border-sky-300/10 bg-sky-300/[0.035] text-sky-200/55' : 'border-white/[0.055] bg-black/10 text-white/28'}`}>
                <span className={`h-1 w-1 rounded-full ${provider.ready ? 'bg-emerald-300' : provider.online ? 'bg-sky-300/70' : 'bg-white/20'}`} />
                {provider.id.toUpperCase()}
              </span>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="min-w-0 truncate font-mono text-[9px] text-white/20" title={metaStatus?.endpoint}>
              {metaStatus?.source || 'NCO Core'} · neural-cli-orchestrator · {metaStatus?.endpoint || 'http://127.0.0.1:6200'}
            </p>
            <button type="button" onClick={() => void reconnectNco()} disabled={!settings.ncoEnabled || reconnecting || !metaStatus?.ncoConnected} className="flex-shrink-0 rounded-lg border border-violet-300/10 bg-violet-300/[0.045] px-2.5 py-1.5 text-[9px] text-violet-100/60 transition-colors hover:bg-violet-300/[0.09] disabled:cursor-not-allowed disabled:opacity-35">
              {reconnecting ? '확인 중…' : 'NCO 다시 연결'}
            </button>
          </div>
          {reconnectError && <p role="alert" className="mt-2 text-[10px] text-red-200/70">{reconnectError}</p>}
        </section>

        <section className="mt-4 rounded-[24px] border border-white/[0.075] bg-white/[0.022] p-5">
          <p className="text-[10px] font-mono tracking-[0.14em] text-white/28">RECORDING</p>
          <div className="mt-4 space-y-5">
            {shortcutError && <p role="alert" className="text-[11px] text-red-200/75">{shortcutError}</p>}

            <label className="block">
              <span className="text-sm text-white/68">일반 받아쓰기 단축키</span>
              <p className="mt-1 text-xs text-white/32">인식한 문장을 그대로 입력합니다.</p>
              <input
                value={settings.shortcut}
                onChange={(event) => setSettings({ ...settings, shortcut: event.target.value })}
                onBlur={() => void persistShortcut({ shortcut: settings.shortcut })}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                className="mt-2 h-10 w-full rounded-xl border border-white/[0.08] bg-black/15 px-3.5 font-mono text-xs text-white/72 outline-none transition-colors focus:border-primary-300/35"
              />
            </label>

            <label className="block">
              <span className="text-sm text-white/68">메타 프롬프트 단축키</span>
              <p className="mt-1 text-xs text-white/32">같은 방식으로 녹음하되, 이 한 번만 AI가 최종 답변을 만듭니다. 저장된 기본 모드는 바뀌지 않습니다. 비워 두면 사용하지 않습니다.</p>
              <input
                value={settings.metaShortcut}
                onChange={(event) => setSettings({ ...settings, metaShortcut: event.target.value })}
                onBlur={() => void persistShortcut({ metaShortcut: settings.metaShortcut })}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                className="mt-2 h-10 w-full rounded-xl border border-violet-300/12 bg-black/15 px-3.5 font-mono text-xs text-violet-100/70 outline-none transition-colors focus:border-violet-300/35"
              />
            </label>

            <label className="block">
              <span className="text-sm text-white/68">컴퓨터 제어 단축키</span>
              <p className="mt-1 text-xs text-white/32">말한 명령을 이해해 실제로 실행합니다. 비워 두면 사용하지 않습니다.</p>
              <input
                value={settings.computerShortcut}
                onChange={(event) => setSettings({ ...settings, computerShortcut: event.target.value })}
                onBlur={() => void persistShortcut({ computerShortcut: settings.computerShortcut })}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                className="mt-2 h-10 w-full rounded-xl border border-emerald-300/12 bg-black/15 px-3.5 font-mono text-xs text-emerald-100/70 outline-none transition-colors focus:border-emerald-300/35"
              />
            </label>

            <label className="block">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm text-white/68">말이 끝난 뒤 자동 중지</span>
                  <p className="mt-1 text-xs text-white/32">짧을수록 빠르고, 길수록 문장 중간 멈춤에 안전합니다.</p>
                </div>
                <select value={settings.silenceTimeoutMs} onChange={(event) => void persist({ silenceTimeoutMs: Number(event.target.value) })} className="h-9 rounded-xl border border-white/[0.08] bg-[#111520] px-3 text-xs text-white/65 outline-none focus:border-primary-300/35">
                  <option value={700}>0.7초 · 최속</option>
                  <option value={900}>0.9초 · 권장</option>
                  <option value={1200}>1.2초</option>
                  <option value={1600}>1.6초</option>
                  <option value={2000}>2.0초</option>
                </select>
              </div>
            </label>
          </div>
        </section>

        <section className="mt-4 rounded-[24px] border border-white/[0.075] bg-white/[0.022] p-5">
          <p className="text-[10px] font-mono tracking-[0.14em] text-white/28">BEHAVIOR</p>
          <div className="mt-4 divide-y divide-white/[0.055]">
            <SettingSwitch
              label="Mac 시작 시 자동 실행"
              description="로그인하면 메뉴바에서 조용히 시작합니다."
              checked={settings.launchAtLogin}
              badge={loginStatus?.status === 'requires-approval' ? '승인 필요' : settings.launchAtLogin ? '활성' : undefined}
              onChange={() => void toggleLaunchAtLogin()}
            />
            <SettingSwitch
              label="인식 텍스트 자동 입력"
              description="권한이 있으면 이전 앱에 입력하고, 권한이 없으면 클립보드에 복사합니다."
              checked={settings.autoInject}
              onChange={() => void persist({ autoInject: !settings.autoInject })}
            />
            <SettingSwitch
              label="입력 후 Enter"
              description="받아쓰기 결과를 붙여넣은 뒤 Enter를 눌러 CLI·프롬프트 입력을 실행합니다."
              checked={settings.submitAfterInject}
              onChange={() => void persist({ submitAfterInject: !settings.submitAfterInject })}
            />
            <SettingSwitch
              label="녹음 오버레이 표시"
              description="다른 앱 위에 마이크 레벨과 인식 상태를 표시합니다."
              checked={settings.showOverlay}
              onChange={() => void persist({ showOverlay: !settings.showOverlay })}
            />
          </div>
        </section>

        <button type="button" onClick={() => window.electronAPI.quit()} className="mt-4 w-full rounded-2xl border border-red-300/10 bg-red-400/[0.035] py-3 text-xs text-red-200/55 transition-colors hover:bg-red-400/[0.07] hover:text-red-100">
          NOVA VOICE 완전히 종료
        </button>
      </div>
    </div>
  )
}

function SettingSwitch({ label, description, checked, badge, onChange }: {
  label: string
  description: string
  checked: boolean
  badge?: string
  onChange: () => void
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={onChange} className="flex w-full items-start justify-between gap-5 py-4 text-left first:pt-0 last:pb-0">
      <span>
        <span className="flex items-center gap-2 text-sm text-white/68">
          {label}
          {badge && <span className="rounded-full border border-emerald-300/10 bg-emerald-300/[0.045] px-1.5 py-0.5 text-[8px] text-emerald-200/70">{badge}</span>}
        </span>
        <span className="mt-1 block text-xs leading-5 text-white/32">{description}</span>
      </span>
      <span className={`relative mt-0.5 h-6 w-10 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-primary-500' : 'bg-white/15'}`} aria-hidden="true">
        <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : 'translate-x-1'}`} />
      </span>
    </button>
  )
}
