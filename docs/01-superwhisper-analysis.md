# SuperWhisper 분석 보고서

## 1. 개요

SuperWhisper는 macOS/Windows/iOS용 AI 음성-텍스트 변환 앱으로, 로컬 및 클라우드 AI 모델을 활용한 고정밀 음성 받아쓰기(dictation) 도구이다.

- **공식 사이트**: https://superwhisper.com
- **App Store**: https://apps.apple.com/us/app/superwhisper/id6471464415
- **평점**: Product Hunt 4.9/5
- **지원 플랫폼**: macOS (Apple Silicon + Intel), Windows, iOS

## 2. 핵심 기능

### 2.1 음성 받아쓰기
- **활성화**: `⌥ + Space` (커스터마이즈 가능)
- **100+ 언어** 지원, 번역 기능 포함
- **오프라인 동작** 가능 (로컬 모델 사용 시)
- Push-to-Talk 및 Toggle 모드 지원
- 마우스 숏컷 지원

### 2.2 AI 모드 시스템
- **사전 정의 모드**: Voice, Message, Email 등
- **커스텀 모드**: 사용자가 톤, 구조, 포맷을 커스터마이즈
- **Super Mode**: 화면 컨텍스트를 감지하여 스마트 결과 생성
- **Adaptability**: 문맥에 따른 톤 자동 조절 (격식/비격식/법률/채팅)

### 2.3 AI 모델 지원
- **로컬 모델**: Whisper (Nano/Fast/Pro/Ultra/Large)
- **클라우드 모델**: GPT-5, Claude Haiku 4.5, Llama 4, Grok 4.1, Gemini 3.0 Flash
- 사용자 API 키 입력 지원 (BYOK)

### 2.4 추가 기능
- 미팅 녹음 및 자동 노트 생성
- 오디오/비디오 파일 트랜스크립션
- 클립보드 통합 (자동 붙여넣기)
- 커스텀 키보드 숏컷
- 히스토리 (검색, 세그먼트 재생, 재처리)
- 30+ 앱 연동 (Slack, Gmail, Notion, Telegram 등)

## 3. UI/UX 분석

### 3.1 메뉴바 통합
- macOS 메뉴바에 상주
- 미니멀한 디자인
- 클릭 시 녹음 시작/정지

### 3.2 키보드 숏컷
| 기능 | 기본 숏컷 | 설명 |
|------|-----------|------|
| Toggle Recording | `⌥ + Space` | 녹음 시작/정지 |
| Cancel Recording | 커스텀 | 30초 미만: 즉시 취소, 30초 이상: 확인 프롬프트 |
| Change Mode | 커스텀 | 모드 순환 |
| Push-to-Talk | Toggle과 공유 가능 | 누르고 있는 동안 녹음 |
| Mouse Shortcut | 마우스 버튼 | 클릭=토글, 길게=PTT |

### 3.3 녹음 오버레이
- 녹음 중 시각적 피드백 (파형 표시)
- 실시간 트랜스크립션 텍스트 표시
- 모드 전환 UI

### 3.4 설정 창
- Configuration 탭에서 숏컷 커스터마이즈
- 모델 라이브러리 (모델 탐색, 즐겨찾기 관리)
- 모드별 개별 설정

## 4. 가격 정책
- **Free**: 기본 음성-텍스트, 미팅 녹음, 100+ 언어
- **Pro**: $849/월 (또는 연간 할인) - 무제한 프리미엄 AI, 파일 트랜스크립션, 번역
- **Enterprise**: 커스텀 - SOC 2, 중앙 관리

## 5. 기술적 특징
- Apple Silicon 최적화 (로컬 모델)
- 개인정보 보호 우선 (로컬 처리 옵션)
- 커스텀 어휘 저장소
- Privacy Award 수상 (Winter 2025)
