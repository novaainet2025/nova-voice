# 프로젝트 아키텍처 설계

## 프로젝트명: SuperWhisper Custom (VoiceType)

## 1. 기술 스택

| 레이어 | 기술 | 버전 |
|--------|------|------|
| Desktop Framework | Electron | 최신 |
| Frontend | React + TypeScript | React 19 |
| Styling | Tailwind CSS + shadcn/ui | v4 |
| STT Engine | whisper.cpp (@fugood/whisper.node) | 최신 |
| State Management | Zustand | 최신 |
| Build Tool | Vite | 최신 |
| Electron Builder | electron-builder | 최신 |
| DB (히스토리) | better-sqlite3 | 최신 |

## 2. 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────┐
│                   Electron App                   │
│                                                  │
│  ┌──────────────┐     ┌──────────────────────┐  │
│  │  Main Process │     │   Renderer Process    │  │
│  │              │     │                      │  │
│  │ ┌──────────┐ │     │  ┌────────────────┐  │  │
│  │ │ Global   │ │ IPC │  │   React UI     │  │  │
│  │ │ Shortcut │ │◄───►│  │                │  │  │
│  │ └──────────┘ │     │  │ ┌────────────┐ │  │  │
│  │              │     │  │ │ Recording  │ │  │  │
│  │ ┌──────────┐ │     │  │ │ Overlay    │ │  │  │
│  │ │ System   │ │     │  │ └────────────┘ │  │  │
│  │ │ Tray     │ │     │  │                │  │  │
│  │ └──────────┘ │     │  │ ┌────────────┐ │  │  │
│  │              │     │  │ │ Settings   │ │  │  │
│  │ ┌──────────┐ │     │  │ │ Window     │ │  │  │
│  │ │ Whisper  │ │     │  │ └────────────┘ │  │  │
│  │ │ Engine   │ │     │  │                │  │  │
│  │ └──────────┘ │     │  │ ┌────────────┐ │  │  │
│  │              │     │  │ │ History    │ │  │  │
│  │ ┌──────────┐ │     │  │ │ View       │ │  │  │
│  │ │ Text     │ │     │  │ └────────────┘ │  │  │
│  │ │ Injector │ │     │  └────────────────┘  │  │
│  │ └──────────┘ │     │                      │  │
│  │              │     │                      │  │
│  │ ┌──────────┐ │     │                      │  │
│  │ │ SQLite   │ │     │                      │  │
│  │ │ DB       │ │     │                      │  │
│  │ └──────────┘ │     │                      │  │
│  └──────────────┘     └──────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## 3. MVP 기능 범위

### Phase 1 (MVP) - 현재 구현 대상
1. **시스템 트레이 앱** - 메뉴바/시스템 트레이에 상주
2. **글로벌 단축키** - `⌥+Space` (Mac) / `Alt+Space` (Win) 녹음 시작/정지
3. **오디오 캡처** - 마이크 입력 녹음
4. **Whisper 트랜스크립션** - 로컬 오프라인 STT
5. **텍스트 주입** - 클립보드 + 붙여넣기로 활성 앱에 텍스트 삽입
6. **녹음 오버레이** - 녹음 상태 + 트랜스크립션 텍스트 표시
7. **설정 창** - 단축키, 모델, 언어 설정
8. **히스토리** - 트랜스크립션 기록 저장/검색

### Phase 2 (향후)
- 커스텀 모드 시스템
- AI 텍스트 리포맷팅 (GPT/Claude 연동)
- 미팅 녹음
- 파일 트랜스크립션
- Push-to-Talk
- 커스텀 어휘

## 4. 디렉토리 구조

```
superwhisper-custom/
├── docs/                    # 문서
├── src/
│   ├── main/               # Electron Main Process
│   │   ├── index.ts        # 앱 진입점
│   │   ├── tray.ts         # 시스템 트레이
│   │   ├── shortcuts.ts    # 글로벌 단축키
│   │   ├── whisper.ts      # Whisper 엔진 래퍼
│   │   ├── injector.ts     # 텍스트 주입
│   │   ├── recorder.ts     # 오디오 녹음 (메인 프로세스 측)
│   │   ├── db.ts           # SQLite DB
│   │   └── ipc.ts          # IPC 핸들러
│   ├── renderer/           # Electron Renderer Process (React)
│   │   ├── App.tsx
│   │   ├── main.tsx        # React 진입점
│   │   ├── components/
│   │   │   ├── overlay/    # 녹음 오버레이
│   │   │   ├── settings/   # 설정 창
│   │   │   └── history/    # 히스토리 뷰
│   │   ├── hooks/          # React 훅
│   │   ├── stores/         # Zustand 스토어
│   │   └── styles/         # Tailwind 설정
│   ├── shared/             # Main/Renderer 공유 타입
│   │   └── types.ts
│   └── preload/            # Preload 스크립트
│       └── index.ts
├── resources/              # 앱 리소스 (아이콘 등)
├── models/                 # Whisper 모델 파일
├── electron.vite.config.ts
├── package.json
├── tsconfig.json
└── tailwind.config.ts
```

## 5. 데이터 흐름

```
사용자 단축키 입력 (⌥+Space)
    │
    ▼
Main Process: 글로벌 단축키 감지
    │
    ▼
IPC → Renderer: 녹음 오버레이 표시
    │
    ▼
Renderer: Web Audio API로 마이크 캡처 시작
    │
    ▼
사용자 다시 단축키 입력 (⌥+Space)
    │
    ▼
Renderer: 녹음 중지 → 오디오 데이터 → IPC → Main
    │
    ▼
Main Process: whisper.cpp로 트랜스크립션
    │
    ▼
IPC → Renderer: 트랜스크립션 텍스트 표시
    │
    ▼
Main Process: 클립보드에 복사 + Cmd/Ctrl+V 시뮬레이션
    │
    ▼
활성 앱에 텍스트 삽입 완료
    │
    ▼
Main Process: SQLite에 히스토리 저장
```

## 6. Whisper 모델 전략

| 모델 | 크기 | 속도 | 정확도 | 용도 |
|------|------|------|--------|------|
| tiny | 75MB | 매우 빠름 | 보통 | 빠른 메모 |
| base | 142MB | 빠름 | 좋음 | 일반 사용 |
| small | 466MB | 보통 | 매우 좋음 | 정확한 받아쓰기 |
| medium | 1.5GB | 느림 | 우수 | 전문 용도 |
| large | 3GB | 매우 느림 | 최고 | 최고 품질 필요 시 |

MVP에서는 `base` 모델을 기본으로 제공하고, 설정에서 모델 선택 가능하게 한다.
