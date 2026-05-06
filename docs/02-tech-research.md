# 기술 리서치 보고서

## 1. 관련 오픈소스 프로젝트

### 1.1 OpenWhispr
- **GitHub**: https://github.com/OpenWhispr/openwhispr
- **스택**: Electron 41 + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui
- **STT 엔진**: whisper.cpp, sherpa-onnx
- **스토리지**: better-sqlite3
- **특징**: 로컬/클라우드 처리, 미팅 트랜스크립션, 화자 분리, MCP 지원
- **빌드**: Node.js 24+, `npm install && npm run dev`

### 1.2 Pothook (Tauri)
- **GitHub**: https://github.com/acknak/pothook
- **스택**: Tauri + TypeScript + Rust + whisper.cpp
- **특징**: 크로스 플랫폼, GUI 트랜스크립션

### 1.3 Light Whisper (Tauri)
- **스택**: Tauri + Rust + whisper.cpp
- **특징**: 글로벌 단축키 (Alt+Space), 활성 앱에 텍스트 주입
- **접근법**: 녹음 → 로컬 트랜스크립션 → 텍스트 주입

### 1.4 Whispering (오픈소스)
- Hacker News에서 주목받은 로컬 우선 받아쓰기 앱

### 1.5 VoiceWriting (Electron)
- **GitHub**: https://github.com/aviaryan/voice-writing-electron
- **스택**: Electron + Whisper + GROQ
- **특징**: 실시간 음성 쓰기, 문법/구두점 자동 교정

## 2. Whisper.cpp Node.js 바인딩

| 패키지 | 최신 버전 | 마지막 업데이트 | 특징 |
|--------|----------|----------------|------|
| `@fugood/whisper.node` | 1.0.16 | 20일 전 | 최신, 활발히 유지보수 |
| `nodejs-whisper` | 0.3.0 | 17일 전 | CPU 최적화 |
| `whisper-node` | 1.1.1 | 2년 전 | 안정적이나 오래됨 |
| `whisper-node-addon` | 1.0.1 | 4개월 전 | .node 애드온 방식 |

**권장**: `@fugood/whisper.node` (최근 유지보수, 활발한 개발)

## 3. 데스크톱 프레임워크 비교

### Electron
- **장점**: 성숙한 생태계, Node.js 통합, 크로스 플랫폼 검증, 풍부한 라이브러리
- **단점**: 메모리 사용량 높음, 바이너리 크기 큼
- **검증**: OpenWhispr가 동일 스택으로 성공적 구현

### Tauri
- **장점**: 작은 바이너리, 낮은 메모리, Rust 백엔드 (whisper.cpp 네이티브)
- **단점**: 생태계 미성숙, 오디오/글로벌 단축키 라이브러리 부족
- **사용 사례**: Pothook, Light Whisper

### 선택: **Electron**
- Node.js 오디오 녹음, 글로벌 단축키, 시스템 텍스트 주입이 더 검증됨
- OpenWhispr의 성공 사례가 스택 검증
- 크로스 플랫폼 UI 일관성 보장

## 4. 핵심 기술 컴포넌트

### 4.1 오디오 캡처
- Web Audio API (브라우저 내장)
- `node-audiorecorder` (Node.js 레벨)
- MediaRecorder API

### 4.2 글로벌 단축키
- Electron `globalShortcut` API (내장)
- 플랫폼별 단축키 매핑 필요 (⌥ → Alt)

### 4.3 텍스트 주입
- **클립보드 + 붙여넣기** 방식 (가장 안정적)
  - macOS: `Cmd+V`
  - Windows: `Ctrl+V`
- `robotjs` / `nut.js`: 키스트로크 시뮬레이션 (불안정)

### 4.4 시스템 트레이
- Electron `Tray` API (내장)
- 크로스 플랫폼 지원

## 5. 플랫폼별 고려사항

### macOS
- 마이크 권한 (entitlements) 필수
- Apple Silicon 최적화 (whisper.cpp Metal 지원)
- 접근성 권한 (텍스트 주입 시)

### Windows
- 오디오 디바이스 열거 방식 차이
- UAC 권한 처리
- 시스템 트레이 동작 차이
