# NOVA-VOICE 맥락 노트

> 최종 업데이트: 2026-05-06

## 프로젝트 개요

**NOVA-VOICE**는 SuperWhisper에서 영감받은 크로스 플랫폼(macOS/Windows) 음성 AI 앱이다.
음성 입력(귀) → AI 처리(뇌) → 텍스트 삽입(손) + 음성 출력(입) + PC 제어(눈)를 통합한다.

- **폴더**: `/Users/nova-ai/project/nova-voice/`
- **이전 이름**: `superwhisper-custom` → `voicetype` → **`nova-voice`**
- **스택**: Electron + React 19 + TypeScript + Tailwind CSS + Vite

---

## 아키텍처: 5감 시스템

```
👂 귀(Ear)    Whisper STT         whisper-cli + ggml-small (465MB)
👁️ 눈(Eye)    Screen Awareness    AppleScript / PowerShell + 키보드 단축키
🧠 뇌(Brain)  AI Processing       NCO(9AI) → Ollama → Claude CLI → Gemini CLI
👄 입(Mouth)  TTS Output          Qwen3-TTS(:7860) → macOS say 폴백
✋ 손(Hand)   Text Injection      클립보드 + Cmd/Ctrl+V + 이전 앱 복원
```

---

## 핵심 파일 구조

```
src/main/
├── index.ts            앱 진입점, 윈도우 생성, 파이프라인 초기화
├── pipeline.ts         귀+눈+뇌+입 중앙 파이프라인, TTS 설정
├── tts-client.ts       Qwen3-TTS 서버 클라이언트 (:7860)
├── whisper.ts          Whisper STT (whisper-cli + ffmpeg)
├── voice-commands.ts   음성 명령 파서 (Regex 30개+ → LLM 폴백)
├── system-control.ts   OS 제어 (macOS AppleScript / Win PowerShell)
├── nco-client.ts       NCO REST API + Ollama + Claude/Gemini CLI
├── ipc.ts              IPC 핸들러 (모든 모듈 연결)
├── injector.ts         텍스트 주입 (클립보드 + 붙여넣기)
├── appState.ts         공유 상태 (이전 앱 기억, 오버레이 참조)
├── db.ts               SQLite (nova-voice.db, 히스토리)
├── tray.ts             시스템 트레이
└── shortcuts.ts        글로벌 단축키 (Ctrl+Shift+Space)

src/renderer/
├── App.tsx             메인 앱 + 오버레이 분기, IPC 리스너
├── main.tsx            React 진입점
├── stores/appStore.ts  Zustand 상태 관리
├── hooks/useRecorder.ts  마이크 녹음 + 오디오 레벨 감지
└── components/
    ├── home/HomePage.tsx       홈 (모드 선택 + 녹음 + 이퀄라이저)
    ├── overlay/RecordingOverlay.tsx  녹음 오버레이 팝업
    ├── settings/SettingsPanel.tsx    설정 (단축키/언어/모델/AI프로바이더)
    └── history/HistoryPanel.tsx      히스토리 검색/삭제

src/shared/types.ts     타입 정의, 16개 AI 모드, 카테고리 정의
src/preload/index.ts    Electron preload (IPC API 브릿지)
```

---

## 16개 AI 모드 (4개 카테고리)

### ✏️ Text (텍스트 입력 → 커서 위치에 삽입)
| ID | 이름 | 기능 |
|----|------|------|
| direct | Direct | 음성 그대로 텍스트 |
| rewrite | Rewrite | 문법/맞춤법 교정 |
| email | Email | 비즈니스 이메일 변환 |
| summarize | Summarize | 요약 |
| translate_en | English | 영어 번역 |
| translate_ko | 한국어 | 한국어 번역 |
| translate_ja | 日本語 | 일본어 번역 |
| code | Code | 코드 생성 |
| formal | Formal | 격식체 변환 |
| casual | Casual | 캐주얼 변환 |

### 🔊 Voice (음성 출력 — 결과를 TTS로 읽어줌)
| ID | 이름 | 기능 |
|----|------|------|
| answer | Answer | 질문에 답변 + 음성 출력 |

### 🎮 Control (에이전틱 — PC/앱 제어)
| ID | 이름 | 기능 |
|----|------|------|
| command | Command | 음성으로 앱 열기/닫기, 볼륨, 브라우저 등 제어 |

### 🤝 NCO Collab (멀티 AI 협업)
| ID | 이름 | 기능 |
|----|------|------|
| nco_discuss | Discussion | 멀티 AI 토론 |
| nco_team | Team | 병렬 팀 작업 |
| nco_agent | Agent | 자율 에이전트 |
| nco_hive | Hive | 전체 9개 AI 동시 |

---

## 외부 의존성

### 런타임 서비스
| 서비스 | 포트 | 용도 | 필수 |
|--------|------|------|------|
| whisper-cli | — | STT (brew install whisper-cpp) | 필수 |
| ffmpeg | — | 오디오 변환 webm→wav | 필수 |
| TTS Server | :7860 | Qwen3-TTS 음성 합성 | 선택 (say 폴백) |
| NCO Backend | :6200 | 9개 AI 오케스트레이터 | 선택 (Ollama 폴백) |
| Ollama | :11434 | 로컬 LLM (llama3.2:3b) | 선택 |
| Redis | :6379 | NCO 큐 관리 | NCO 필요시 |

### Whisper 모델
- 위치: `/Users/nova-ai/project/nova-voice/models/ggml-small.bin` (465MB)
- 한국어 인식 최적: small 이상

### TTS 서버
- 위치: `/Users/nova-ai/project/@@gentop/lib/tts/`
- 모델: Qwen3-TTS (sohee 등 9명 화자), VoxCPM2 (음성 클로닝)
- 실행: `./start.sh --no-open`
- API: `POST /api/voices/qwen3-tts/tts`

---

## 주요 데이터 흐름

### 일반 모드 (Direct/Rewrite/Email 등)
```
Ctrl+Shift+Space → 녹음 시작
  → 마이크 캡처 (Web Audio API)
  → 이퀄라이저 표시 (메인 + 오버레이)
Ctrl+Shift+Space → 녹음 정지
  → webm → ffmpeg → wav (16kHz mono)
  → whisper-cli → 텍스트
  → [AI 모드 처리] NCO/Ollama/Claude
  → 이전 앱 복원 → 클립보드 + Cmd+V
  → 히스토리 저장 (SQLite)
```

### Command 모드
```
음성 → Whisper → "크롬 열어"
  → Regex 패턴 매칭 (Tier 1, <50ms)
  → 매칭 실패 시 → Ollama LLM 파싱 (Tier 2, 1-3s)
  → system-control.ts → AppleScript/PowerShell 실행
  → 결과 알림 + TTS 음성 피드백
```

### NCO 협업 모드
```
음성 → Whisper → 텍스트
  → POST http://localhost:6200/api/realtime/discussion
  → NCO가 Claude+Gemini+Codex 토론 진행
  → 결과 텍스트를 커서에 삽입
```

---

## 작업 히스토리

### 2026-05-04 (Day 1)
1. **리서치**: SuperWhisper 분석, 기술 스택 비교, 오픈소스 프로젝트 조사
2. **프로젝트 생성**: Electron + React + Tailwind + electron-vite 초기 설정
3. **코어 구현**: Whisper STT, 오디오 녹음, 글로벌 단축키, 시스템 트레이
4. **Tailwind 빌드 수정**: PostCSS 플러그인 누락 → 설정 화면 안 보이던 버그 수정
5. **텍스트 주입 구현**: 클립보드 + Cmd+V + 이전 앱 복원 → TextEdit 테스트 성공
6. **이퀄라이저 구현**: Canvas → div 기반으로 변경, 오버레이 IPC 전달 추가
7. **AI 모드 시스템**: NCO 클라이언트 + 11개 AI 모드 + 프로바이더 자동 선택
8. **음성 PC 제어**: voice-commands.ts + system-control.ts, 한국어/영어 30개+ 명령
9. **NCO 고급 협업**: Discussion/Team/Agent/Hive 모드 연동
10. **NCO 토론**: 화면 인식 문제 → CDP/Accessibility/VLM 비교 → 키보드 단축키 해결책
11. **프로젝트 리브랜딩**: superwhisper-custom → nova-voice
12. **TTS 통합**: Qwen3-TTS 서버 연결 (:7860), 9명 자연 음성 화자
13. **모드 카테고리화**: Text/Voice/Control/NCO 4개 그룹으로 분류

---

## 테스트 결과 (검증 완료)

| 기능 | 상태 | 비고 |
|------|------|------|
| 음성 녹음 (마이크) | ✅ | Web Audio API + MediaRecorder |
| Whisper 한국어 인식 | ✅ | ggml-small, 0.6초 처리 |
| 이퀄라이저 (메인) | ✅ | div 기반, 오디오 레벨 반응 |
| 이퀄라이저 (오버레이) | ✅ | IPC로 오디오 레벨 전달 |
| 텍스트 주입 (TextEdit) | ✅ | 클립보드 + Cmd+V |
| 이전 앱 복원 | ✅ | AppleScript |
| AI 모드 (Rewrite/번역) | ✅ | Ollama 폴백 동작 |
| 음성 명령 (Command) | ✅ | "크롬 열어" → Chrome 열기, "네이버 접속" → URL |
| TTS (Qwen3-TTS) | ✅ | :7860 서버 연결, sohee 화자 |
| TTS (시스템 폴백) | ✅ | macOS say -v Yuna |
| NCO 토론 | ✅ | 3AI 토론 결과 수신 |
| 글로벌 단축키 | ✅ | Ctrl+Shift+Space |
| 설정 화면 | ✅ | 단축키/언어/모델/AI프로바이더 |
| 히스토리 | ✅ | SQLite 저장/검색/삭제 |

---

## 알려진 제한사항

1. **TTS 서버 콜드 스타트**: Qwen3-TTS 첫 로드 ~107초 (앱 시작 시 타임아웃 가능 → say 폴백)
2. **NCO 의존성**: NCO 백엔드가 실행 중이어야 Discussion/Team/Agent/Hive 사용 가능
3. **Windows 미테스트**: Windows PowerShell 제어 코드 작성됨, 실기기 테스트 미완
4. **화면 인식**: 브라우저 내부 DOM 접근은 CDP(Phase 2)로 해결 예정
5. **첫 녹음 동기화**: Main/Renderer 녹음 상태 동기화에서 첫 번째 toggle이 skip될 수 있음

---

## 2026-05-06 추가 작업

### PTY Claude 직접 통합
- `src/main/pty.ts` — node-pty로 Claude CLI 직접 실행, 응답 캡처 → TTS 파이프
- 신뢰 프롬프트(Trust prompt) 자동 승인 처리
- 라우팅: voice-answer 모드 → PTY Claude 우선, NCO 폴백

### TTS 진행상황 알림 (ProgressMessages)
- `src/main/pipeline.ts` — `speakProgress()` + `runParallelWithProgress()` 추가
- TTS 서버 시작/완료/에러 시 음성 피드백
- `ipc.ts:1479-1484` — `tts:server-start` 핸들러에 speakProgress 통합

### NCO 토론 결과 (2026-05-06)
> 세션: sess__hZfTG-DihFM1r8m (Gemini), 참고: task_pk1DxiQmFtJ48AWw (MLX)

| 우선순위 | 개선 항목 | 핵심 전략 | 예상 기간 |
|---------|----------|----------|---------|
| **최상** | 스트리밍 TTS 파이프라인 | 문장 단위 LLM→TTS 실시간 전달, E2E < 800ms | 3주 |
| **최상** | Kokoro MLX TTS 통합 | 콜드스타트 107초→50ms, Apple Silicon 최적화 | 2주 |
| **상** | AI 라우팅 지능화 | 로컬 SLM으로 50ms 내 로컬/클라우드 분기 | 2주 |
| **상** | STT 정확도 향상 | Faster-Whisper + Silero VAD + RNNoise | 1-2주 |
| **상** | 화면 인식 완성 | ScreenCaptureKit + Privacy Guard 레이어 | 8-10주 |
| **중** | NCO 비동기 UX | 진행중 TTS 피드백, 스트리밍 결과 표시 | 1주 |

### TTS 검증 결과 (2026-05-06)
| 항목 | 결과 |
|------|------|
| Qwen3-TTS(:7860) | 정상 — sohee 화자, 7998ms~64632ms 생성 |
| macOS say 폴백 | 정상 |
| 오디오 재생 (afplay) | 정상 |

---

## 문서 목록

| 파일 | 내용 |
|------|------|
| `docs/01-superwhisper-analysis.md` | SuperWhisper 기능/UI/가격 분석 |
| `docs/02-tech-research.md` | 기술 스택 비교, 라이브러리 조사 |
| `docs/03-architecture.md` | 프로젝트 아키텍처, MVP 범위, 디렉토리 구조 |
| `docs/04-ai-integration-research.md` | NCO/Ollama/Claude/Gemini 연동 연구 |
| `docs/05-voice-control-research.md` | 음성 PC 제어 연구 (AppleScript/PowerShell) |
| `docs/06-screen-awareness-discussion.md` | NCO 토론 결과: 화면 인식 해결 전략 |
| `docs/07-nova-voice-improvement-discussion.md` | NCO 토론: 노바 보이스 전체 개선 방향 |
| `docs/IMPROVEMENT-NOTE.md` | 개선 노트 (우선순위별 액션 아이템) |
| `docs/plans/voice-control-nco-collab.md` | 구현 Plan 체크리스트 |
| `docs/CONTEXT-NOTE.md` | 이 맥락 노트 |
