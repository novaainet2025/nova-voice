# NOVA-VOICE 개선 노트

> 최종 업데이트: 2026-05-06  
> 출처: NCO 멀티AI 토론 (Gemini, MLX, OpenRouter) + Claude 직접 분석

---

## 토론 세션 이력

| 날짜 | 세션 ID | 참여 AI | 주제 |
|------|---------|---------|------|
| 2026-05-06 | sess__hZfTG-DihFM1r8m | Gemini | 전체 개선점 분석 |
| 2026-05-06 | task_pk1DxiQmFtJ48AWw | MLX Gemma 4 26B | AI라우팅/화면인식/속도 |
| 2026-05-06 | task_GF1MyA0E2-upHIn_ | OpenRouter | STT/TTS 개선 |
| 이전 세션 | 07-nova-voice-improvement | Gemini+MLX+DeepSeek | 전체 방향 |

---

## 우선순위별 개선 액션 아이템

### 🔴 최상 우선순위

#### 1. 스트리밍 TTS 파이프라인 (E2E < 800ms)
**목표**: 사용자가 느끼는 지연 = "첫 음성이 나오는 시간"

- **문장 단위 스트리밍**: LLM이 문장(`.` 기준) 완성 즉시 TTS로 전달
- **비동기 파이프라인**: STT 종료 전 LLM 준비, LLM 생성 중 TTS Warm-up
- **예측 프리페치**: "알려줘" 등 패턴 감지 시 TTS 엔진 미리 로드
- 난이도: 어려움 | 예상: 3주

```
STT(스트리밍) → [첫 문장 완성] → TTS 즉시 재생
                              → [두 번째 문장 생성 중...]
```

#### 2. Kokoro MLX TTS 통합
**목표**: TTS 콜드스타트 107초 → ~50ms

- Kokoro MLX: 82M 파라미터, Apple Silicon MLX 네이티브
- Python 브릿지 서버 패턴 (포트: 8803)
- Qwen3-TTS와 병행 운용 (한국어는 Qwen3, 영어는 Kokoro)
- 스트리밍 지원 (Qwen3는 전체 생성 후 전달)

```typescript
// 추가할 엔드포인트: tts-client.ts
// POST http://localhost:8803/v1/audio/speech (OpenAI 호환)
// { model: "kokoro", input: "...", voice: "af_heart", stream: true }
```

**설치**:
```bash
pip install mlx-audio
python -c "from mlx_audio.tts.models.kokoro import KokoroModel"
```

---

### 🟠 상 우선순위

#### 3. AI 라우팅 지능화 (Router-first 아키텍처)

- **쿼리 복잡도 분류기**: 로컬 SLM(MLX Gemma)으로 50ms 내 판단
  - 단순(시간/날씨/계산) → MLX 로컬
  - 복잡(추론/코드/분석) → Claude/Gemini
- **시맨틱 캐싱**: 벡터 DB(ChromaDB/FAISS)로 유사 질문 캐시
- **Token Budgeting**: 월 예산 초과 시 자동 로컬 전환
- **컨텍스트 압축**: 요약 + 핵심 엔티티 추출로 긴 대화 관리
- 난이도: 보통 | 예상: 2주

#### 4. STT 정확도 향상 (한영 혼용)

- **Silero VAD**: 경량 ONNX, 발화 감지 정확도 향상 (3-5일)
- **Faster-Whisper**: whisper.cpp 대비 WER 개선, large-v3-turbo 권장
- **WebRTC AEC + RNNoise**: 에코 제거 + 노이즈 캔슬링
- **한국어 특화**: KoELECTRA로 오탈자 후처리
- 현재 모델: ggml-small (465MB) → large-v3-turbo 고려 (속도/정확도 균형)

#### 5. 화면 인식 완성 (CDP Phase 2)

- **ScreenCaptureKit**: macOS 고성능 캡처 API, 활성 창만 캡처
- **Hybrid Vision**: 텍스트/UI는 로컬 OCR, 복잡한 추론만 Claude Vision
- **Privacy Guard**: 클라우드 전송 전 로컬에서 민감정보(비번/카드) 마스킹
- 난이도: 어려움 | 예상: 8-10주

---

### 🟡 중 우선순위

#### 6. NCO 비동기 UX 개선

- **진행 피드백**: "AI 분석 중... 30초 정도 걸려요" TTS 알림
- **스트리밍 결과**: 토론 완료 전 중간 결과 표시
- **타임아웃 UX**: 2분 이상 시 "계속 진행 중..." 주기적 알림
- 현재: pollTask 1초 간격, 완료 전까지 응답 없음

#### 7. PTY Claude 안정성 강화

- **세션 재시작**: Claude PTY 프로세스 크래시 시 자동 재시작
- **타임아웃 처리**: 응답 30초 초과 시 강제 종료 + 재시도
- **신뢰 프롬프트 캐싱**: 매번 승인 대신 세션별 1회만

#### 8. Windows 지원

- Windows PowerShell 제어 코드 실기기 테스트
- node-pty Windows 호환성 확인
- Whisper CLI Windows 빌드 테스트

---

## TTS 검증 결과 (2026-05-06)

### Qwen3-TTS (:7860) 정상 작동 확인
```
텍스트: "노바 보이스 개선 토론을 시작합니다"
생성시간: 7,998ms
파일크기: 259KB (WAV, 16bit mono 24kHz)
화자: sohee
상태: 정상
```

### TTS API 호출 방법
```bash
# 생성
curl -X POST http://localhost:7860/api/voices/qwen3-tts/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "말할 내용", "speaker": "sohee"}' > response.json

# 오디오 URL 추출 및 재생
URL=$(cat response.json | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
curl -s "http://localhost:7860${URL}" -o output.wav
afplay output.wav
```

### macOS say 폴백
```bash
say -v Yuna "말할 내용"  # 한국어
say "Hello"              # 영어
```

---

## 개선 로드맵 (제안)

```
Week 1-2:  Kokoro MLX 서버 구축 + tts-client.ts 통합
Week 3-4:  문장 단위 스트리밍 TTS 파이프라인
Week 5-6:  AI 라우팅 지능화 (로컬 분류기)
Week 7-8:  STT 개선 (Silero VAD + Faster-Whisper)
Week 9+:   화면 인식 Phase 2 (ScreenCaptureKit)
```

---

## 참고 문서

- `docs/07-nova-voice-improvement-discussion.md` — 이전 NCO 토론 상세 결과
- `docs/06-screen-awareness-discussion.md` — 화면 인식 전략
- `src/main/pipeline.ts` — 현재 TTS/STT 파이프라인
- `src/main/tts-client.ts` — Qwen3-TTS 클라이언트 (추후 Kokoro 추가 예정)
