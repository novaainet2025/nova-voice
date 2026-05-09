import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import type { AppSettings } from '../../../shared/types'

interface TTSServerStatus {
  id: 'cosyvoice' | 'qwen3' | 'mlx' | 'mlx_ko' | 'mlx_en' | 'mlx_mix'
  name: string
  port: number
  running: boolean
  device?: string
  model?: string
  latencyMs?: number
}

const LANGUAGES = [
  { code: 'auto', name: 'Auto Detect' },
  { code: 'en', name: 'English' },
  { code: 'ko', name: '한국어' },
  { code: 'ja', name: '日本語' },
  { code: 'zh', name: '中文' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'it', name: 'Italiano' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'th', name: 'ไทย' }
]

const MODELS = [
  { name: 'tiny', desc: 'Fastest, lower accuracy (~75MB)', size: '75MB' },
  { name: 'base', desc: 'Good balance of speed and accuracy (~142MB)', size: '142MB' },
  { name: 'small', desc: 'Better accuracy, moderate speed (~466MB)', size: '466MB' },
  { name: 'medium', desc: 'High accuracy, slower (~1.5GB)', size: '1.5GB' },
  { name: 'large', desc: 'Best accuracy, slowest (~3GB)', size: '3GB' }
]

const MLX_VOICE_LABELS: Record<string, string> = {
  'Chelsie': 'Chelsie (여성, 밝고 활기찬)',
  'Ethan': 'Ethan (남성, 차분하고 안정적)',
  'Serena': 'Serena (여성, 부드럽고 따뜻한)',
  'Vivian': 'Vivian (여성, 프로페셔널)',
  'Ryan': 'Ryan (남성, 명확하고 전문적)',
  'Aiden': 'Aiden (남성, 젊고 에너지틱)',
  'Eric': 'Eric (남성, 깊고 차분한)',
  'Dylan': 'Dylan (남성, 친근하고 캐주얼)'
}

// KOKORO_VOICE_LABELS 키는 KOKORO_VOICE_MAP 키와 동일한 nova 카드명으로 통일
// → mlxVoice에 Kokoro ID가 아닌 nova 카드명이 저장되어 모델 전환 시 매핑 일관성 유지
const KOKORO_VOICE_LABELS: Record<string, string> = {
  'Ryan':    'Ryan (am_adam · 남성)',
  'Chelsie': 'Chelsie (af_bella · 여성)',
  'Vivian':  'Vivian (af_heart · 여성, 활기찬)',
  'Aiden':   'Aiden (am_adam · 남성)',
  'Ethan':   'Ethan (bm_george · 남성, 영국)',
  'Serena':  'Serena (bf_emma · 여성)',
  'Eric':    'Eric (am_adam · 남성)',
  'Dylan':   'Dylan (bm_george · 남성)',
}

const SPARK_VOICE_LABELS: Record<string, string> = {
  'Ryan':    'Ryan (ko_male · 한국어 남성)',
  'Chelsie': 'Chelsie (ko_female · 한국어 여성)',
  'Vivian':  'Vivian (female_1 · 여성 variant)',
  'Aiden':   'Aiden (ko_male · 한국어 남성)',
  'Ethan':   'Ethan (male_1 · 남성 variant)',
  'Serena':  'Serena (ko_female · 한국어 여성)',
  'Eric':    'Eric (male_1 · 남성 variant)',
  'Dylan':   'Dylan (ko_male · 한국어 남성)',
}

// @@gentop Qwen3-TTS CustomVoice 9화자 — 화자카드 레이블
// 서버: http://localhost:7860  모델: qwen3-tts
const QWEN3_VOICE_LABELS: Record<string, string> = {
  Ryan:    'Ryan (ryan · 남성, 안정적)',
  Chelsie: 'Chelsie (sohee · 여성, 밝고 자연스러운)',
  Vivian:  'Vivian (vivian · 여성)',
  Aiden:   'Aiden (aiden · 남성)',
  Ethan:   'Ethan (uncle_fu · 남성, 중후한)',
  Serena:  'Serena (serena · 여성)',
  Eric:    'Eric (eric · 남성)',
  Dylan:   'Dylan (dylan · 남성)',
}

const TTS_SERVER_INFO: Record<string, { label: string; badge: string; desc: string; color: string; port: number }> = {
  mlx_ko:    { label: 'MLX-Qwen3',  badge: 'MPS', desc: '한국어 전용 · Qwen3-TTS 4bit · :8800 · ~0.9초', color: 'blue',    port: 8800 },
  mlx_en:    { label: 'MLX-Kokoro', badge: 'MPS', desc: '영어 전용 · Kokoro-82M 82MB 상주 · :8801 · ~0.9초', color: 'cyan', port: 8801 },
  mlx_mix:   { label: 'MLX-Spark',  badge: 'MPS', desc: '한영 혼용 전용 · Spark-TTS-0.5B · :8802 · ~2초', color: 'indigo',  port: 8802 },
  cosyvoice: { label: 'CosyVoice2', badge: 'MPS', desc: 'Zero-Shot 음성 클로닝 · 최고 음질 · :8900 · ~6초', color: 'violet', port: 8900 },
  qwen3:     { label: 'Qwen3-TTS',  badge: '9화자', desc: '@@gentop :7860 · CustomVoice 9화자 · ryan/sohee/vivian 등 · ~1.5초', color: 'emerald', port: 7860 },
}

export function SettingsPanel() {
  const { settings, setSettings: setStoreSettings } = useAppStore()
  const [localSettings, setLocalSettings] = useState<AppSettings | null>(null)
  const [saved, setSaved] = useState(false)
  const [mlxVoices, setMlxVoices] = useState<string[]>([])
  const [ttsServers, setTtsServers] = useState<TTSServerStatus[]>([])
  const [serverBusy, setServerBusy] = useState<Record<string, 'starting' | 'stopping' | 'previewing' | null>>({})
  const [sayVoices, setSayVoices] = useState<{ id: string; name: string; desc: string }[]>([])
  const [sayPreviewBusy, setSayPreviewBusy] = useState(false)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isInitialLoad = useRef(true)

  const refreshServerStatus = useCallback(async () => {
    try {
      const statuses = await window.electronAPI.getTTSServerStatuses()
      setTtsServers(statuses)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    async function loadSettings() {
      const s = await window.electronAPI.getSettings()
      isInitialLoad.current = true
      setStoreSettings(s)
      setLocalSettings(s)
      try {
        const voices = await window.electronAPI.getMLXVoices()
        setMlxVoices(voices)
      } catch { /* MLX not available */ }
      try {
        const sv = await window.electronAPI.getSayVoices()
        setSayVoices(sv)
      } catch { /* ignore */ }
    }
    loadSettings()
    refreshServerStatus()
    const interval = setInterval(refreshServerStatus, 8000)
    return () => clearInterval(interval)
  }, [setStoreSettings, refreshServerStatus])

  // 설정 변경 시 자동저장 (debounce 600ms) — 초기 로드는 제외
  useEffect(() => {
    if (!localSettings) return
    if (isInitialLoad.current) {
      isInitialLoad.current = false
      return
    }
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(async () => {
      await window.electronAPI.setSettings(localSettings)
      setStoreSettings(localSettings)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }, 600)
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    }
  }, [localSettings, setStoreSettings])

  const handleServerToggle = async (id: string, running: boolean) => {
    setServerBusy(b => ({ ...b, [id]: running ? 'stopping' : 'starting' }))
    try {
      if (running) {
        await window.electronAPI.stopTTSServer(id)
      } else {
        await window.electronAPI.startTTSServer(id)
      }
      await refreshServerStatus()
    } finally {
      setServerBusy(b => ({ ...b, [id]: null }))
    }
  }

  const handlePreview = async (id: string, voice?: string) => {
    setServerBusy(b => ({ ...b, [id]: 'previewing' }))
    try {
      await window.electronAPI.previewTTSVoice(id, voice)
    } finally {
      setServerBusy(b => ({ ...b, [id]: null }))
    }
  }

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (localSettings) {
      setLocalSettings({ ...localSettings, [key]: value })
    }
  }

  const saveSettings = async () => {
    if (localSettings) {
      await window.electronAPI.setSettings(localSettings)
      setStoreSettings(localSettings)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }

  if (!localSettings) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-primary-400 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // localSettings.mlxVoice가 단일 소스 — 독립 currentVoice state 제거
  const currentVoice = localSettings.mlxVoice || 'Ryan'

  const mlxKoStatus  = ttsServers.find(s => s.id === 'mlx_ko')
  const mlxEnStatus  = ttsServers.find(s => s.id === 'mlx_en')
  const mlxMixStatus = ttsServers.find(s => s.id === 'mlx_mix')
  const mlxAnyRunning = mlxKoStatus?.running || mlxEnStatus?.running || mlxMixStatus?.running

  // legacy compat
  const mlxServerStatus = mlxKoStatus
  const mlxRunning = mlxKoStatus?.running ?? false
  const mlxBusy = serverBusy['mlx_ko'] || serverBusy['mlx']

  const MLX_SUB_MODELS = [
    { id: 'mlx',     label: 'MLX-Auto',   badge: '권장',    desc: '자동 라우팅 · 한국어→Qwen3, 영어→Kokoro, 혼용→Spark', color: 'blue',   serverId: null as string | null },
    { id: 'mlx_ko',  label: 'MLX-Qwen3',  badge: '한국어',  desc: 'Qwen3-TTS 4bit · :8800', color: 'blue',   serverId: 'mlx_ko' as string },
    { id: 'mlx_en',  label: 'MLX-Kokoro', badge: '영어',    desc: 'Kokoro-82M-bf16 · :8801', color: 'cyan',   serverId: 'mlx_en' as string },
    { id: 'mlx_mix', label: 'MLX-Spark',  badge: '한영혼용', desc: 'Spark-TTS-0.5B-bf16 · :8802', color: 'indigo', serverId: 'mlx_mix' as string },
  ] as const

  return (
    <div className="p-6 h-full overflow-y-auto">
      <h2 className="text-xl font-semibold mb-6">Settings</h2>

      {/* ── TTS 목소리 대시보드 ── */}
      {['mlx','mlx_ko','mlx_en','mlx_mix','qwen3'].includes(localSettings.ttsModel) && (
        <section className="mb-6">
          <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide mb-3">
            목소리 고정 설정
          </h3>

          {/* 현재 고정 목소리 상태 바 */}
          <div className="glass-light rounded-xl p-3 mb-3 border border-primary-400/30 bg-primary-400/5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs text-white/50">현재 고정 목소리</span>
              <span className="text-sm font-bold text-primary-300">{currentVoice}</span>
              <span className="text-xs text-white/40">{(
                localSettings.ttsModel === 'mlx_en' ? KOKORO_VOICE_LABELS :
                localSettings.ttsModel === 'mlx_mix' ? SPARK_VOICE_LABELS :
                localSettings.ttsModel === 'qwen3' ? QWEN3_VOICE_LABELS :
                MLX_VOICE_LABELS
              )[currentVoice]?.replace(/^[^ ]+ /, '') || ''}</span>
            </div>
            <button
              disabled={!!serverBusy[localSettings.ttsModel]}
              onClick={async () => {
                setServerBusy(b => ({ ...b, [localSettings.ttsModel]: 'previewing' }))
                try { await window.electronAPI.previewTTSVoice(localSettings.ttsModel as any, currentVoice) }
                finally { setServerBusy(b => ({ ...b, [localSettings.ttsModel]: null })) }
              }}
              className="text-xs px-3 py-1.5 rounded-lg bg-primary-400/20 hover:bg-primary-400/30 text-primary-300 transition-colors flex items-center gap-1.5"
            >
              {serverBusy[localSettings.ttsModel] === 'previewing'
                ? <span className="w-3 h-3 border border-primary-300/60 border-t-transparent rounded-full animate-spin" />
                : '▶'
              }
              현재 목소리 테스트
            </button>
          </div>

          {/* 목소리 그리드 */}
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(
              localSettings.ttsModel === 'mlx_en' ? KOKORO_VOICE_LABELS :
              localSettings.ttsModel === 'mlx_mix' ? SPARK_VOICE_LABELS :
              localSettings.ttsModel === 'qwen3' ? QWEN3_VOICE_LABELS :
              MLX_VOICE_LABELS
            ).map(([voiceId, label]) => {
              const isActive = currentVoice === voiceId
              const isBusy = serverBusy[`preview_${voiceId}`] === 'previewing'
              return (
                <div
                  key={voiceId}
                  onClick={async () => {
                    updateSetting('mlxVoice', voiceId)
                    // 즉시 저장 — Save 버튼 불필요
                    await window.electronAPI.setMLXVoice(voiceId)
                    const updated = { ...localSettings!, mlxVoice: voiceId }
                    await window.electronAPI.setSettings(updated)
                  }}
                  className={`relative glass-light rounded-xl p-3 cursor-pointer transition-all border ${
                    isActive
                      ? 'border-primary-400 bg-primary-400/10 ring-1 ring-primary-400/30'
                      : 'border-white/5 hover:border-white/20 hover:bg-white/3'
                  }`}
                >
                  {isActive && (
                    <div className="absolute top-2 right-2">
                      <div className="w-2 h-2 rounded-full bg-primary-400" />
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-1">
                    <div className="min-w-0 flex-1">
                      <div className={`font-semibold text-sm ${isActive ? 'text-primary-300' : 'text-white/80'}`}>
                        {voiceId}
                      </div>
                      <div className="text-[11px] text-white/40 mt-0.5 truncate">
                        {label.replace(voiceId + ' ', '')}
                      </div>
                    </div>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        setServerBusy(b => ({ ...b, [`preview_${voiceId}`]: 'previewing' }))
                        // 현재 TTS 모델 서버로 미리듣기 (mlx/mlx_ko는 단일화자라 qwen3으로 대체)
                        const previewMdl = (localSettings.ttsModel === 'mlx' || localSettings.ttsModel === 'mlx_ko' || localSettings.ttsModel === 'qwen3' || localSettings.ttsModel === 'say')
                          ? 'qwen3' : localSettings.ttsModel
                        try { await window.electronAPI.previewTTSVoice(previewMdl as any, voiceId) }
                        finally { setServerBusy(b => ({ ...b, [`preview_${voiceId}`]: null })) }
                      }}
                      className="flex-shrink-0 mt-0.5 text-[10px] px-2 py-1 rounded-md bg-white/8 hover:bg-white/20 transition-colors"
                    >
                      {isBusy ? <span className="w-2.5 h-2.5 border border-white/40 border-t-transparent rounded-full animate-spin inline-block" /> : '▶'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {/* mlx/mlx_ko 단일화자 경고 */}
          {(localSettings.ttsModel === 'mlx' || localSettings.ttsModel === 'mlx_ko') && (
            <div className="mt-2 mb-1 glass-light rounded-xl p-3 border border-yellow-400/20 bg-yellow-400/5">
              <p className="text-[11px] text-yellow-300/70 leading-relaxed">
                ⚠️ MLX-Qwen3(:8800)은 단일화자 모델입니다. 실제 TTS 출력은 선택과 무관하게 동일한 목소리로 재생됩니다. 미리듣기(▶)는 Qwen3-TTS(:7860) 기준으로 재생됩니다.
              </p>
            </div>
          )}

          {/* 고정 안내 */}
          <div className="mt-3 glass-light rounded-xl p-3 border border-green-500/20 bg-green-500/5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-green-400 text-xs">✓</span>
              <span className="text-xs text-green-300 font-medium">목소리 고정 보장</span>
            </div>
            <p className="text-[11px] text-white/40 leading-relaxed">
              선택한 목소리는 앱 TTS · Stop 훅 · 진행 알림 모두에 동일하게 적용됩니다.
              MLX 서버 장애 시 다른 목소리 대신 <strong className="text-white/60">침묵</strong> 처리합니다.
            </p>
          </div>
        </section>
      )}


      {/* TTS 기본 모델 */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide mb-3">
          TTS 기본 모델
        </h3>
        <div className="space-y-2">
          {/* MLX 그룹 */}
          <div className={`glass-light rounded-xl overflow-hidden border transition-all ${
            ['mlx','mlx_ko','mlx_en','mlx_mix'].includes(localSettings.ttsModel)
              ? 'border-primary-400/40' : 'border-white/5'
          }`}>
            <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
              <span className="text-xs text-white/40 font-medium">MLX-Audio</span>
              <div className={`w-1.5 h-1.5 rounded-full ${mlxAnyRunning ? 'bg-green-400' : 'bg-white/20'}`} />
            </div>
            {MLX_SUB_MODELS.map(m => {
              const serverStatus = m.serverId ? ttsServers.find(s => s.id === m.serverId) : null
              const previewServerId = m.serverId || 'mlx_ko'
              const previewBusy = serverBusy[previewServerId]
              const selected = localSettings.ttsModel === m.id
              return (
                <div
                  key={m.id}
                  onClick={() => updateSetting('ttsModel', m.id as AppSettings['ttsModel'])}
                  className={`px-3 py-2.5 cursor-pointer transition-all flex items-center justify-between border-b border-white/5 last:border-0 ${
                    selected ? 'bg-primary-400/10' : 'hover:bg-white/3'
                  }`}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${selected ? 'bg-primary-400' : 'bg-white/20'}`} />
                    {serverStatus && (
                      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${serverStatus.running ? 'bg-green-400' : 'bg-white/15'}`} />
                    )}
                    <span className="font-medium text-sm">{m.label}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0 ${
                      m.color === 'blue'   ? 'bg-blue-500/20 text-blue-300' :
                      m.color === 'cyan'   ? 'bg-cyan-500/20 text-cyan-300' :
                      m.color === 'indigo' ? 'bg-indigo-500/20 text-indigo-300' :
                      'bg-white/10 text-white/50'
                    }`}>{m.badge}</span>
                    <span className="text-[11px] text-white/30 truncate hidden sm:block">{m.desc}</span>
                  </div>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation()
                      setServerBusy(b => ({ ...b, [previewServerId]: 'previewing' }))
                      try {
                        await window.electronAPI.previewTTSVoice(previewServerId, (m.id === 'mlx_ko' || m.id === 'mlx') ? currentVoice : undefined)
                      } finally {
                        setServerBusy(b => ({ ...b, [previewServerId]: null }))
                      }
                    }}
                    disabled={previewBusy === 'previewing'}
                    className="text-xs px-2.5 py-1 rounded bg-white/8 hover:bg-white/15 transition-colors ml-2 flex-shrink-0 flex items-center gap-1"
                  >
                    {previewBusy === 'previewing' ? (
                      <span className="w-3 h-3 border border-white/40 border-t-transparent rounded-full animate-spin inline-block" />
                    ) : '▶ 미리듣기'}
                  </button>
                </div>
              )
            })}

            {/* MLX 화자 선택 — mlx_en/mlx_mix만 표시 (mlx/mlx_ko는 단일화자라 숨김) */}
            {['mlx','mlx_ko'].includes(localSettings.ttsModel) && (
              <div className="px-3 py-2 border-t border-white/8 bg-yellow-400/3">
                <p className="text-[11px] text-yellow-300/60 leading-relaxed">
                  ⚠️ MLX-Auto · MLX-Qwen3은 한국어를 <strong className="text-yellow-200/80">단일화자(:8800)</strong>로 출력합니다.<br/>
                  화자를 선택하려면 아래 <strong className="text-white/60">Qwen3-TTS</strong>를 선택하세요 (9화자 지원).
                </p>
              </div>
            )}
            {['mlx_en','mlx_mix'].includes(localSettings.ttsModel) && (
              <div className="px-3 py-3 border-t border-white/8 bg-white/2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] text-white/40 font-medium">화자 고정</span>
                  <span className="text-[10px] text-white/25">
                    {localSettings.ttsModel === 'mlx_en' ? 'Kokoro(:8801) 화자' : 'Spark(:8802) 화자'}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {Object.entries(
                    localSettings.ttsModel === 'mlx_en' ? KOKORO_VOICE_LABELS :
                    localSettings.ttsModel === 'mlx_mix' ? SPARK_VOICE_LABELS :
                    MLX_VOICE_LABELS
                  ).map(([voiceId, label]) => {
                    const isActive = currentVoice === voiceId
                    return (
                      <div
                        key={voiceId}
                        onClick={async () => {
                          updateSetting('mlxVoice', voiceId)
                          await window.electronAPI.setMLXVoice(voiceId)
                          const updated = { ...localSettings!, mlxVoice: voiceId }
                          await window.electronAPI.setSettings(updated)
                        }}
                        className={`relative text-left rounded-lg px-2 py-1.5 transition-all border text-[11px] cursor-pointer ${
                          isActive
                            ? 'border-primary-400 bg-primary-400/15 text-primary-300 font-medium'
                            : 'border-white/8 hover:border-white/20 text-white/50 hover:text-white/70'
                        }`}
                      >
                        <div className="font-medium">{voiceId}</div>
                        <div className="text-[9px] opacity-60 truncate">{label.split('·')[0].replace(voiceId + ' ', '').trim()}</div>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation()
                            setServerBusy(b => ({ ...b, [`inline_preview_${voiceId}`]: 'previewing' }))
                            try {
                              // mlx/mlx_ko(:8800)는 단일화자 → :7860 Qwen3-TTS로 화자 차이 시연
                              const previewModel = (localSettings.ttsModel === 'mlx' || localSettings.ttsModel === 'mlx_ko')
                                ? 'qwen3' : localSettings.ttsModel as any
                              await window.electronAPI.previewTTSVoice(previewModel, voiceId)
                            } finally {
                              setServerBusy(b => ({ ...b, [`inline_preview_${voiceId}`]: null }))
                            }
                          }}
                          className="absolute top-1 right-1 w-4 h-4 flex items-center justify-center rounded text-[8px] bg-white/10 hover:bg-white/25 transition-colors"
                        >
                          {serverBusy[`inline_preview_${voiceId}`] === 'previewing'
                            ? <span className="w-2 h-2 border border-white/40 border-t-transparent rounded-full animate-spin inline-block" />
                            : '▶'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* 나머지 모델 */}
          {[
            { id: 'cosyvoice', label: 'CosyVoice2', badge: '고품질', desc: 'Zero-Shot 음성 클로닝 · 한영 혼재 네이티브 · ~6초', color: 'violet' },
            { id: 'qwen3',     label: 'Qwen3-TTS',  badge: '9화자',  desc: '@@gentop :7860 · 9화자 한국어 고품질 · ryan/sohee/aiden 등', color: 'emerald' },
            { id: 'say',       label: 'macOS say',  badge: 'System', desc: '즉시 응답 · 오프라인 · 기본 음성', color: 'gray' },
          ].map(m => {
            const qwen3Running = m.id === 'qwen3' ? ttsServers.find(s => s.id === 'qwen3')?.running : undefined
            return (
            <button
              key={m.id}
              onClick={() => updateSetting('ttsModel', m.id as AppSettings['ttsModel'])}
              className={`w-full text-left glass-light rounded-xl p-3 transition-all border ${
                localSettings.ttsModel === m.id
                  ? 'border-primary-400 bg-primary-400/10'
                  : 'border-transparent hover:border-white/10'
              }`}
            >
              <div className="flex items-center gap-2">
                {qwen3Running !== undefined && (
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${qwen3Running ? 'bg-green-400' : 'bg-white/20'}`} />
                )}
                <span className="font-medium text-sm">{m.label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                  m.color === 'emerald' ? 'bg-emerald-500/20 text-emerald-300' :
                  m.color === 'violet'  ? 'bg-violet-500/20 text-violet-300' :
                  'bg-white/10 text-white/50'
                }`}>{m.badge}</span>
              </div>
              <p className="text-xs text-white/40 mt-0.5">{m.desc}</p>
            </button>
            )
          })}
        </div>
      </section>

      {/* macOS say 화자 */}
      {localSettings.ttsModel === 'say' && sayVoices.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide mb-3">
            macOS say 화자
          </h3>
          <div className="space-y-2">
            {sayVoices.map(v => (
              <div key={v.id} className={`glass-light rounded-xl p-3 transition-all border flex items-center justify-between ${
                localSettings.sayVoice === v.id
                  ? 'border-primary-400 bg-primary-400/10'
                  : 'border-transparent hover:border-white/10'
              }`}>
                <button
                  className="flex-1 text-left"
                  onClick={() => updateSetting('sayVoice', v.id)}
                >
                  <span className="font-medium text-sm">{v.name}</span>
                  <span className="text-xs text-white/40 ml-2">{v.desc}</span>
                </button>
                <button
                  disabled={sayPreviewBusy}
                  onClick={async () => {
                    setSayPreviewBusy(true)
                    try { await window.electronAPI.previewSayVoice(v.id) }
                    finally { setSayPreviewBusy(false) }
                  }}
                  className="text-xs px-2 py-1 rounded bg-white/8 hover:bg-white/15 transition-colors ml-2 flex-shrink-0"
                >
                  {sayPreviewBusy ? '▶ ...' : '▶'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Shortcut */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide mb-3">
          Keyboard Shortcut
        </h3>
        <div className="glass-light rounded-xl p-4 space-y-4">
          <div>
            <label className="block text-sm mb-2">Toggle Recording</label>
            <input
              type="text"
              value={localSettings.shortcut}
              onChange={(e) => updateSetting('shortcut', e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm
                focus:outline-none focus:border-primary-400 transition-colors"
              placeholder="Ctrl+Shift+Space"
            />
            <p className="text-xs text-white/40 mt-1">
              Format: Modifier+Key (e.g., Alt+Space, CommandOrControl+Shift+V)
            </p>
          </div>
          <div className="border-t border-white/5 pt-4">
            <label className="block text-sm mb-2">Cancel Task</label>
            <div className="flex items-center gap-2 px-3 py-2 bg-white/5 border border-white/10 rounded-lg">
              {['Ctrl', 'Shift', 'Esc'].map((key) => (
                <kbd
                  key={key}
                  className="px-2 py-0.5 rounded bg-white/10 text-white/70 text-xs font-mono border border-white/15"
                >
                  {key}
                </kbd>
              ))}
            </div>
            <p className="text-xs text-white/40 mt-1">
              처리 중 작업 취소 — 글로벌 단축키 (다른 앱 포커스 시에도 동작)
            </p>
          </div>
        </div>
      </section>

      {/* Language */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide mb-3">
          Language
        </h3>
        <div className="glass-light rounded-xl p-4">
          <select
            value={localSettings.language}
            onChange={(e) => updateSetting('language', e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm
              focus:outline-none focus:border-primary-400 transition-colors"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code} className="bg-surface-800">
                {lang.name}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Model */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide mb-3">
          Whisper Model
        </h3>
        <div className="space-y-2">
          {MODELS.map((model) => (
            <button
              key={model.name}
              onClick={() => updateSetting('modelName', model.name)}
              className={`w-full text-left glass-light rounded-xl p-4 transition-all border ${
                localSettings.modelName === model.name
                  ? 'border-primary-400 bg-primary-400/10'
                  : 'border-transparent hover:border-white/10'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium capitalize">{model.name}</span>
                <span className="text-xs text-white/40">{model.size}</span>
              </div>
              <p className="text-xs text-white/50 mt-1">{model.desc}</p>
            </button>
          ))}
        </div>
      </section>

      {/* AI Provider */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide mb-3">
          AI Provider
        </h3>
        <div className="space-y-2">
          {[
            { id: 'nco', name: 'NCO (Smart Router)', desc: '9개 AI 통합 오케스트레이터 — 자동 최적 AI 선택' },
            { id: 'ollama', name: 'Ollama (Local)', desc: '로컬 LLM — 오프라인, 무료, 빠른 응답' },
            { id: 'claude', name: 'Claude CLI', desc: 'Claude Code — 최고 정확도' },
            { id: 'gemini', name: 'Gemini CLI', desc: 'Google Gemini — 빠르고 정확' }
          ].map((p) => (
            <button
              key={p.id}
              onClick={() => updateSetting('aiProvider', p.id)}
              className={`w-full text-left glass-light rounded-xl p-3 transition-all border ${
                localSettings.aiProvider === p.id
                  ? 'border-primary-400 bg-primary-400/10'
                  : 'border-transparent hover:border-white/10'
              }`}
            >
              <span className="font-medium text-sm">{p.name}</span>
              <p className="text-xs text-white/40 mt-0.5">{p.desc}</p>
            </button>
          ))}
        </div>
      </section>

      {/* TTS Servers */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide">
            TTS 서버
          </h3>
          <button
            onClick={refreshServerStatus}
            className="text-xs text-white/40 hover:text-white/70 transition-colors px-2 py-1 rounded"
          >
            새로고침
          </button>
        </div>

        {/* ── MLX 3-서버 그룹 ── */}
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-white/50">MLX-Audio (3-서버 · 모델 교체 없음)</span>
            <div className={`w-1.5 h-1.5 rounded-full ${mlxAnyRunning ? 'bg-green-400' : 'bg-white/20'}`} />
          </div>
          <div className="space-y-2 pl-2 border-l border-white/10">
            {(['mlx_ko', 'mlx_en', 'mlx_mix'] as const).map((id) => {
              const info = TTS_SERVER_INFO[id]
              const status = ttsServers.find(s => s.id === id)
              const busy = serverBusy[id]
              const running = status?.running ?? false
              const badgeColor =
                id === 'mlx_ko'  ? 'bg-blue-500/20 text-blue-300' :
                id === 'mlx_en'  ? 'bg-cyan-500/20 text-cyan-300' :
                'bg-indigo-500/20 text-indigo-300'

              return (
                <div key={id} className={`glass-light rounded-xl p-3 border transition-all ${
                  running ? 'border-white/15' : 'border-white/5'
                }`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        busy === 'starting' ? 'bg-yellow-400 animate-pulse' :
                        busy === 'stopping' ? 'bg-orange-400 animate-pulse' :
                        running ? 'bg-green-400' : 'bg-white/20'
                      }`} />
                      <span className="font-medium text-sm">{info.label}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0 ${badgeColor}`}>
                        :{info.port}
                      </span>
                      {running && status?.latencyMs && (
                        <span className="text-[10px] text-green-400/70 flex-shrink-0">{status.latencyMs}ms</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                      {running && (
                        <button
                          onClick={() => handlePreview(id, id === 'mlx_ko' ? currentVoice : undefined)}
                          disabled={busy === 'previewing'}
                          className="text-xs px-2.5 py-1 rounded bg-white/8 hover:bg-white/15 transition-colors flex items-center gap-1"
                        >
                          {busy === 'previewing' ? (
                            <><span className="w-3 h-3 border border-white/40 border-t-transparent rounded-full animate-spin inline-block" /> 합성 중</>
                          ) : '▶ 미리듣기'}
                        </button>
                      )}
                      <button
                        onClick={() => handleServerToggle(id, running)}
                        disabled={!!busy}
                        className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-all ${
                          busy ? 'opacity-50 cursor-not-allowed' :
                          running
                            ? 'bg-white/10 hover:bg-red-500/20 hover:text-red-300 text-white/60'
                            : 'bg-primary-600/80 hover:bg-primary-500 text-white'
                        }`}
                      >
                        {busy === 'starting' ? '시작 중' :
                         busy === 'stopping' ? '중지 중' :
                         running ? '중지' : '시작'}
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-white/35 mt-1.5 pl-4">
                    {info.desc}
                    {running && status?.model && (
                      <span className="ml-1 text-white/20">· {status.model}</span>
                    )}
                  </p>
                  {/* mlx_ko: 단일 화자 모델 안내 */}
                  {id === 'mlx_ko' && running && (
                    <p className="mt-1.5 pl-4 text-xs text-white/30">
                      단일 화자 고정 · 화자 선택 미지원 (Qwen3-TTS-Base)
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── 나머지 서버 (CosyVoice2, Qwen3-TTS) ── */}
        <div className="space-y-3">
          {(['cosyvoice', 'qwen3'] as const).map((id) => {
            const info = TTS_SERVER_INFO[id]
            const status = ttsServers.find(s => s.id === id)
            const busy = serverBusy[id]
            const running = status?.running ?? false

            return (
              <div key={id} className={`glass-light rounded-xl p-4 border transition-all ${
                running ? 'border-white/15' : 'border-white/5'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      busy === 'starting' ? 'bg-yellow-400 animate-pulse' :
                      busy === 'stopping' ? 'bg-orange-400 animate-pulse' :
                      running ? 'bg-green-400' : 'bg-white/20'
                    }`} />
                    <span className="font-medium text-sm">{info.label}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                      id === 'cosyvoice' ? 'bg-violet-500/20 text-violet-300' :
                      'bg-emerald-500/20 text-emerald-300'
                    }`}>{info.badge}</span>
                    {running && status?.latencyMs && (
                      <span className="text-[10px] text-green-400/70">{status.latencyMs}ms</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {running && (
                      <button
                        onClick={() => handlePreview(id)}
                        disabled={busy === 'previewing'}
                        className="text-xs px-2 py-1 rounded bg-white/8 hover:bg-white/15 transition-colors"
                      >
                        {busy === 'previewing' ? (
                          <span className="w-3 h-3 border border-white/40 border-t-transparent rounded-full animate-spin inline-block" />
                        ) : '▶ 미리듣기'}
                      </button>
                    )}
                    <button
                      onClick={() => handleServerToggle(id, running)}
                      disabled={!!busy}
                      className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                        busy ? 'opacity-50 cursor-not-allowed' :
                        running
                          ? 'bg-white/10 hover:bg-red-500/20 hover:text-red-300 text-white/60'
                          : 'bg-primary-600/80 hover:bg-primary-500 text-white'
                      }`}
                    >
                      {busy === 'starting' ? '시작 중...' :
                       busy === 'stopping' ? '중지 중...' :
                       running ? '중지' : '시작'}
                    </button>
                  </div>
                </div>
                <p className="text-xs text-white/40">
                  {info.desc}
                  {running && status?.model && (
                    <span className="ml-2 text-white/25">· {status.model}</span>
                  )}
                </p>
              </div>
            )
          })}
        </div>
      </section>

      {/* TTS Voice (MLX voices shown inline above, this section for legacy) */}
      {mlxVoices.length > 0 && false && (
        <section className="mb-6">
          <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide mb-3">
            TTS Voice (화자)
          </h3>
          <div className="space-y-2">
            {mlxVoices.map((voice) => (
              <button
                key={voice}
                onClick={async () => {
                  updateSetting('mlxVoice', voice)
                  await window.electronAPI.setMLXVoice(voice)
                }}
                className={`w-full text-left glass-light rounded-xl p-3 transition-all border ${
                  currentVoice === voice
                    ? 'border-primary-400 bg-primary-400/10'
                    : 'border-transparent hover:border-white/10'
                }`}
              >
                <span className="font-medium text-sm">{MLX_VOICE_LABELS[voice] || voice}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Options */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-white/60 uppercase tracking-wide mb-3">
          Options
        </h3>
        <div className="glass-light rounded-xl p-4 space-y-4">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm">Auto-inject text</span>
            <div
              onClick={() => updateSetting('autoInject', !localSettings.autoInject)}
              className={`w-10 h-6 rounded-full transition-colors relative cursor-pointer ${
                localSettings.autoInject ? 'bg-primary-500' : 'bg-white/20'
              }`}
            >
              <div
                className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-transform ${
                  localSettings.autoInject ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </div>
          </label>

          <div className="flex items-start justify-between gap-4 cursor-pointer"
            onClick={() => updateSetting('voiceCorrection', !localSettings.voiceCorrection)}
          >
            <div className="flex-1">
              <span className="text-sm block">AI 맞춤법·교정</span>
              <p className="text-xs text-white/40 mt-0.5">Direct 모드에서 AI가 오탈자·문법·맥락을 자동 교정</p>
            </div>
            <div
              className={`w-10 h-6 rounded-full transition-colors relative cursor-pointer flex-shrink-0 mt-0.5 ${
                localSettings.voiceCorrection ? 'bg-primary-500' : 'bg-white/20'
              }`}
            >
              <div
                className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-transform ${
                  localSettings.voiceCorrection ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </div>
          </div>

          <div className="flex items-start justify-between gap-4 cursor-pointer"
            onClick={() => updateSetting('autoEnter', !localSettings.autoEnter)}
          >
            <div className="flex-1">
              <span className="text-sm block">자동 엔터</span>
              <p className="text-xs text-white/40 mt-0.5">텍스트 주입 후 Enter 자동 입력 — 터미널·채팅에서 바로 실행</p>
            </div>
            <div
              className={`w-10 h-6 rounded-full transition-colors relative cursor-pointer flex-shrink-0 mt-0.5 ${
                localSettings.autoEnter ? 'bg-primary-500' : 'bg-white/20'
              }`}
            >
              <div
                className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-transform ${
                  localSettings.autoEnter ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </div>
          </div>

          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm">Show overlay</span>
            <div
              onClick={() => updateSetting('showOverlay', !localSettings.showOverlay)}
              className={`w-10 h-6 rounded-full transition-colors relative cursor-pointer ${
                localSettings.showOverlay ? 'bg-primary-500' : 'bg-white/20'
              }`}
            >
              <div
                className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-transform ${
                  localSettings.showOverlay ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </div>
          </label>
        </div>
      </section>

      {/* Save button */}
      <button
        onClick={saveSettings}
        className="w-full bg-primary-600 hover:bg-primary-500 text-white rounded-xl py-3 px-4
          font-medium transition-colors"
      >
        {saved ? '✓ Saved' : 'Save Settings'}
      </button>
    </div>
  )
}
