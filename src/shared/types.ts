// AI Mode definitions
export type ModeCategory = 'text' | 'agentic' | 'voice' | 'collab'

export interface AIMode {
  id: string
  name: string
  icon: string
  prompt: string
  description: string
  category: ModeCategory  // text=텍스트입력, agentic=PC제어, voice=음성출력, collab=NCO협업
  provider?: string       // 'nco' | 'ollama' | 'claude' | 'gemini'
  ttsOutput?: boolean     // true면 결과를 음성으로도 출력
}

export const BUILTIN_MODES: AIMode[] = [
  // ═══════ TEXT (텍스트 입력 모드) ═══════
  {
    id: 'direct', name: 'Direct', icon: '✏️',
    prompt: '', description: '음성을 그대로 텍스트로 변환',
    category: 'text'
  },
  {
    id: 'rewrite', name: 'Rewrite', icon: '✨',
    prompt: '다음 텍스트의 문법, 맞춤법, 어색한 표현을 자연스럽게 교정해주세요. 교정된 텍스트만 출력하세요:\n\n',
    description: '문법/맞춤법 교정', category: 'text'
  },
  {
    id: 'email', name: 'Email', icon: '📧',
    prompt: '다음 내용을 정중하고 전문적인 비즈니스 이메일 형식으로 작성해주세요. 인사말과 맺음말을 포함하세요:\n\n',
    description: '비즈니스 이메일 변환', category: 'text'
  },
  {
    id: 'summarize', name: 'Summarize', icon: '📋',
    prompt: '다음 내용을 핵심만 간결하게 3줄 이내로 요약해주세요:\n\n',
    description: '내용 요약', category: 'text'
  },
  {
    id: 'translate_en', name: 'English', icon: '🇺🇸',
    prompt: 'Translate the following text to natural English. Output only the translation:\n\n',
    description: '영어로 번역', category: 'text'
  },
  {
    id: 'translate_ko', name: '한국어', icon: '🇰🇷',
    prompt: '다음 텍스트를 자연스러운 한국어로 번역해주세요. 번역된 텍스트만 출력하세요:\n\n',
    description: '한국어로 번역', category: 'text'
  },
  {
    id: 'translate_ja', name: '日本語', icon: '🇯🇵',
    prompt: '次のテキストを自然な日本語に翻訳してください。翻訳されたテキストのみ出力してください:\n\n',
    description: '일본어로 번역', category: 'text'
  },
  {
    id: 'code', name: 'Code', icon: '💻',
    prompt: '다음 설명에 맞는 코드를 작성해주세요. 코드만 출력하세요:\n\n',
    description: '코드 생성', category: 'text'
  },
  {
    id: 'formal', name: 'Formal', icon: '👔',
    prompt: '다음 텍스트를 격식체로 변환해주세요. 변환된 텍스트만 출력하세요:\n\n',
    description: '격식체로 변환', category: 'text'
  },
  {
    id: 'casual', name: 'Casual', icon: '😊',
    prompt: '다음 텍스트를 친근하고 캐주얼한 말투로 변환해주세요. 변환된 텍스트만 출력하세요:\n\n',
    description: '캐주얼 말투로 변환', category: 'text'
  },

  // ═══════ SMART (통합 모드 — 질문/명령/NCO 자동 판별) ═══════
  {
    id: 'smart', name: 'Smart', icon: '🧠',
    prompt: '__SMART_MODE__',
    description: '질문→답변, 명령→실행, NCO→협업 자동 판별', category: 'voice', ttsOutput: true
  },

  // ═══════ VOICE (음성 출력 모드 — 결과를 TTS로 읽어줌) ═══════
  {
    id: 'answer', name: 'Answer', icon: '💡',
    prompt: '다음 질문에 대해 2-3문장으로 정확하고 간결하게 답변해주세요. 핵심만 말해주세요:\n\n',
    description: '질문에 답변 (음성으로 읽어줌)', category: 'voice', ttsOutput: true
  },

  // ═══════ AGENTIC (PC/앱 제어 모드) ═══════
  {
    id: 'command', name: 'Command', icon: '🎮',
    prompt: '__VOICE_COMMAND__',
    description: '음성으로 PC/앱 제어', category: 'agentic', ttsOutput: true
  },

  // ═══════ COLLAB (NCO 협업 모드) ═══════
  {
    id: 'nco_discuss', name: 'Discussion', icon: '🗣️',
    prompt: '__NCO_DISCUSSION__',
    description: 'NCO 멀티 AI 토론', category: 'collab'
  },
  {
    id: 'nco_team', name: 'Team', icon: '👥',
    prompt: '__NCO_PARALLEL__',
    description: 'NCO 팀 병렬 작업', category: 'collab'
  },
  {
    id: 'nco_agent', name: 'Agent', icon: '🤖',
    prompt: '__NCO_AGENT__',
    description: 'NCO 자율 에이전트', category: 'collab'
  },
  {
    id: 'nco_hive', name: 'Hive', icon: '🐝',
    prompt: '__NCO_HIVE__',
    description: 'NCO 전체 AI 협업', category: 'collab'
  }
]

export const MODE_CATEGORIES = {
  text:    { label: 'Text Input',  icon: '✏️', desc: '텍스트를 커서 위치에 입력' },
  voice:   { label: 'Voice Output', icon: '🔊', desc: '결과를 음성(TTS)으로 출력' },
  agentic: { label: 'PC Control',  icon: '🎮', desc: '음성으로 PC/앱 제어' },
  collab:  { label: 'NCO Collab',  icon: '🤝', desc: 'NCO 멀티AI 협업' }
} as const

export interface TranscriptionResult {
  id: string
  text: string
  language: string
  duration: number
  timestamp: number
  modelUsed: string
  aiMode?: string
  aiResult?: string
  /** true = 백그라운드 완료 결과 — 음성 버블 중복 방지 (voice msg 추가 안 함) */
  isUpdate?: boolean
}

export interface RecordingState {
  isRecording: boolean
  duration: number
  audioLevel: number
}

export interface AppSettings {
  shortcut: string
  language: string
  modelPath: string
  modelName: string
  autoInject: boolean
  showOverlay: boolean
  voiceCorrection: boolean  // AI 맞춤법·맥락 교정 (direct 모드에서 적용)
  theme: 'light' | 'dark' | 'system'
  overlayPosition: 'top' | 'center' | 'bottom'
  aiMode: string
  aiProvider: string // 'nco' | 'ollama' | 'claude' | 'gemini'
  customModes: AIMode[]
  ttsModel: 'qwen3' | 'mlx' | 'mlx_ko' | 'mlx_en' | 'mlx_mix' | 'cosyvoice' | 'say' // 기본 TTS 엔진
  sayVoice: string  // macOS say 화자 (예: 'Yuna', 'Sora')
  mlxVoice: string  // MLX-Audio 화자
  autoEnter: boolean // 텍스트 주입 후 자동 엔터 (터미널/채팅 자동 실행)
}

export interface WhisperModel {
  name: string
  size: string
  path: string
  downloaded: boolean
}

export interface Attachment {
  id: string
  name: string
  mimeType: string
  size: number
  content?: string   // text files: decoded text content
  base64?: string    // images: raw base64 (no data URI prefix)
}

export type IpcChannels =
  | 'recording:start'
  | 'recording:stop'
  | 'recording:cancel'
  | 'recording:state'
  | 'transcription:result'
  | 'transcription:progress'
  | 'settings:get'
  | 'settings:set'
  | 'history:get'
  | 'history:search'
  | 'history:delete'
  | 'app:quit'
  | 'overlay:show'
  | 'overlay:hide'
  | 'inject:text'
  | 'ai:process'
  | 'ai:status'

export const DEFAULT_SETTINGS: AppSettings = {
  shortcut: process.platform === 'darwin' ? 'Ctrl+Shift+Space' : 'Ctrl+Shift+Space',
  language: 'auto',
  modelPath: '',
  modelName: 'large-v3-turbo',
  autoInject: true,
  showOverlay: true,
  voiceCorrection: false,
  theme: 'dark',
  overlayPosition: 'center',
  aiMode: 'direct',
  aiProvider: 'auto',
  customModes: [],
  ttsModel: 'qwen3',
  sayVoice: 'Yuna',
  mlxVoice: 'Ryan',
  autoEnter: false,
}
