# Nova Voice 개선 방향 — NCO 멀티AI 토론

> 생성일: 2026-05-06  
> 참여 AI: Gemini 2.0 Flash (OpenRouter), DeepSeek Chat V3 (OpenRouter), MLX Gemma 4 26B (로컬)  
> 토론 주제: Nova Voice 전반적 개선 방향

---

## 토론 요약

### 합의된 핵심 개선 방향

| 우선순위 | 항목 | 3개 AI 공통 결론 |
|---------|------|----------------|
| 1 | **Streaming Pipeline** | LLM 토큰 → TTS 실시간 전달로 TTFA 최소화 |
| 2 | **Kokoro MLX TTS** | Apple Silicon MLX 활용, Qwen3-TTS와 병행 모듈형 구조 |
| 3 | **Whisper + VAD** | Silero VAD + faster-whisper-large-v3-turbo |
| 4 | **화면 인식** | Electron desktopCapturer + Vision LLM (GPT-4o/Claude) |
| 5 | **아키텍처 분리** | Electron UI ↔ 로컬 추론 서버 분리 (IPC/WebSocket) |

---

## AI별 상세 의견

### 🤖 Gemini 2.0 Flash (OpenRouter)

**1. Kokoro MLX TTS 통합**
- MLX 런타임을 Node.js Native Modules 또는 WebAssembly로 Electron에 통합
- 한국어 데이터셋으로 추가 파인튜닝 (OpenSLR Korean Speech Corpus 활용)
- MLX Quantization으로 모델 크기 축소, inference 속도 향상
- Qwen3-TTS와 사용자 선택 가능한 UI 제공

**2. Whisper 정확도 향상**
- WebRTC Noise Suppression + VAD 모듈 통합
- KoELECTRA/KR-BERT 한국어 언어 모델과 결합하여 오탈자 수정
- Federated Learning으로 사용자 개인화 모델 구축 (프라이버시 보호)
- 도메인별 데이터 증강 (노이즈 추가, 속도/피치 변경)

**3. AI 응답속도 최적화**
- 자주 사용되는 질문 SQLite 캐싱 (레이턴시 80% 감소)
- Claude/Gemini 병렬 요청 후 빠른 결과 우선 출력 (Race Mode)
- 첫 토큰부터 점진적 TTS 렌더링

**4. 화면 인식 기능**
- Electron screencapture API + Tesseract.js로 화면 텍스트 추출
- DOM 요소 분석으로 버튼/링크 음성 안내
- 접근성 연동 (스크린 리더 API)

**5. 아키텍처 최적화**
- IPC 대신 SharedArrayBuffer 활용한 메모리 공유 모델
- 에너지 효율 모드 (백그라운드 CPU 스로틀링)
- CLI 버전 Docker 컨테이너화 (헤드리스 서버 모드)

---

### 🤖 DeepSeek Chat V3 (OpenRouter)

**1. Kokoro MLX TTS 통합**
- Apple 실리콘 NPU/GPU 활용으로 기존 Qwen3-TTS 대비 낮은 레이턴시
- 경량 모델 내장으로 오프라인 지원 강화 (네트워크 의존성 제거)
- pitch/speed 조절 API 노출로 사용자 음성 프로필 설정 지원

**2. Whisper 정확도 향상**
- RNNoise 노이즈 감소 + VAD 전처리로 무음 구간 제거
- 언어별/도메인별 초기 프롬프트 동적 주입 ("기술 관련 질문" 등)
- 온디바이스 Whisper ↔ Google Speech-to-Text 하이브리드 모드 (네트워크 상태 기반)

**3. AI 응답속도 최적화**
- 빈발 질문 SQLite 캐싱 (레이턴시 80% 감소)
- **Race Mode**: Gemini + Claude 동시 요청 → 빠른 결과 우선 출력
- 스트리밍 개선: TTS 생성과 텍스트 출력 병렬 처리

**4. 화면인식 기능**
- Electron desktopCapture + OCR으로 화면 텍스트 추출
- 마우스 포인터 주변 DOM 요소 분석 ("'제출' 버튼을 클릭할까요?")
- 시스템 스크린 리더 API 연동 (접근성 강화)

**5. 전체 아키텍처 최적화**
- IPC 대신 SharedArrayBuffer로 메인/렌더러 프로세스 간 통신 부하 감소
- 백그라운드 TTS/STT 활성 시 CPU 스로틀링으로 배터리 최적화
- Docker 헤드리스 모드 지원으로 서버용 CLI 버전 확장

---

### 🤖 MLX Gemma 4 26B (로컬, Apple Silicon)

**1. Kokoro MLX TTS 통합**
- Apple Silicon 최적화 MLX 프레임워크로 로컬 음성 합성 지연 시간 획기적 단축
- 기존 Qwen3-TTS와 병행 모듈형 구조 설계 (고성능/저지연 상황별 선택)
- 즉각적 피드백으로 자연스러운 대화 흐름 구축

**2. Whisper 정확도 향상**
- `faster-whisper` 또는 `whisper-large-v3-turbo` 도입 (속도-정확도 균형 최적화)
- Silero VAD 통합으로 배경 소음과 실제 음성 정밀 분리
- 이전 대화 맥락을 Whisper `prompt` 인자로 전달 → 고유 명사/특정 문맥 인식률 향상

**3. AI 응답속도 최적화**
- LLM 텍스트 생성과 TTS 음성 합성 병렬 처리 **Streaming Pipeline** 구축
- 의미 단위(Sentence/Phrase) 텍스트 분할 → 즉시 TTS 전달 버퍼링 전략
- **TTFA(Time To First Audio)** 최소화로 대화 흐름 유지

**4. 화면인식 기능**
- Electron desktop capture API로 화면 스냅샷 + Multimodal LLM 통합
- 선택적 캡처 모드: 활성 창/사용자 지정 영역만 처리 (프라이버시 보호)
- GPT-4o 또는 Claude 3.5 Sonnet Vision API 연동

**5. 전체 아키텍처 최적화**
- Electron UI ↔ 로컬 추론 서버(Python/C++) 분리 (UI 스레드 프리징 방지)
- 마이크로서비스 아키텍처: IPC/WebSocket 통신
- 인터랙션 모드 기반 동적 모델 로드/언로드 (리소스 관리 최적화)

---

## 종합 결론 및 구현 우선순위

### Phase 1 (즉각 구현 가능)
1. **Streaming Pipeline** — LLM → TTS 실시간 스트리밍 (응답 체감 속도 최대 효과)
2. **Silero VAD + faster-whisper** — Whisper 전처리 개선 (정확도 즉시 향상)
3. **SQLite 응답 캐싱** — 빈발 질문 캐싱 (레이턴시 감소)

### Phase 2 (1-2주 내)
4. **Kokoro MLX TTS 통합** — `mlx-audio` + Kokoro 모델 (이미 MLX 서버 실행 중)
5. **화면 인식 기능** — Electron desktopCapturer + Claude/GPT-4o Vision

### Phase 3 (장기)
6. **아키텍처 분리** — Electron UI ↔ 로컬 추론 서버 독립 프로세스
7. **Race Mode** — 다중 AI 경쟁 응답 모드
8. **개인화 모델** — 사용자별 Whisper fine-tuning

### 토론에서 발견된 핵심 인사이트
- **TTFA(Time To First Audio)** 지표를 KPI로 설정해야 함 (MLX Gemma 제안)
- **Race Mode** (DeepSeek 제안): Claude + Gemini 동시 실행 → 빠른 것 우선 — NCO와 자연스럽게 통합 가능
- **맥락 기반 Whisper 프롬프팅** (MLX Gemma 제안): 이전 대화를 hint로 주입하면 전문 용어 인식률 향상
- MLX TTS 서버가 이미 실행 중 (`Spark-TTS-0.5B`, `Qwen3-TTS-12Hz`) — Kokoro 통합 전 Spark-TTS 활용 검토 필요

---

*이 문서는 NCO 멀티AI 토론 시스템을 통해 자동 생성되었습니다.*
