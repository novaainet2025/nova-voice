# Plan: VoiceType 음성 PC 제어 + NCO 고급 협업

## Part 1: Voice Command Engine
- [x] T1.1 `src/main/voice-commands.ts` — 한국어/영어 명령 패턴 레지스트리 + LLM 폴백
- [x] T1.2 `src/main/system-control.ts` — macOS AppleScript / Windows PowerShell 실행기
- [x] T1.3 IPC에 Command 모드 연결 (음성 → 파싱 → 실행 → 피드백)
- [x] T1.4 안전 확인 시스템 (위험 명령 알림)

## Part 2: NCO 고급 협업 연동
- [x] T2.1 `nco-client.ts` 확장 — discussion, parallel, agent, hive API
- [x] T2.2 AI 모드에 NCO 협업 모드 추가 (Discussion, Team, Agent, Hive)
- [x] T2.3 NCO 결과 실시간 표시 (스테이지 라벨)

## Part 3: UI + 통합
- [x] T3.1 홈 화면에 Command/NCO 모드 버튼 추가
- [x] T3.2 오버레이에 명령 실행/NCO 결과 피드백 표시
- [x] T3.3 빌드 + 통합 테스트

## 테스트 결과
- "브라우저를 열어" → Google Chrome 열기 ✅
- "네이버에 접속해봐" → https://naver.com 열기 ✅
- macOS/Windows 크로스 플랫폼 제어 ✅
- LLM 폴백 파싱 (Ollama) ✅
