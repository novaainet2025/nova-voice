# Nova Voice 실시간 음성 응답 최적화

> 현재 47초 → 목표 4초 (12배 개선)

## Phase 1: Kokoro MLX TTS 설치 및 통합
- [x] pip install mlx-audio 설치 (v0.4.3)
- [x] Kokoro MLX 서버 시작 스크립트 (--model 버그 수정)
- [x] tts-client.ts에 Kokoro 엔드포인트 추가 (speakMLXEnChunked :8801)
- [x] 기존 Qwen3-TTS → Kokoro 우선 순위 전환 — 3-Server 라우팅 복원 (EN→:8801, Mixed→:8802, KO→:8800)
- [x] 실측 벤치마크: 목표 TTFB < 200ms (Kokoro 8ms ✓, Spark 11ms ✓)

## Phase 2: AI 프로바이더 최적화
- [x] voice 모드 NCO 우회 — answer/search는 Gemini → Claude CLI 직접 호출
- [x] Answer 모드 프롬프트 최적화 — VOICE_ANSWER_GUIDE "2-3문장 간결 답변" (nova-context.ts)
- [x] nco-client.ts voice fast-path — voiceFastPath 플래그 + processWithClaudeStreaming

## Phase 3: 문장 단위 스트리밍 TTS
- [x] splitSentences + splitForQwen3Streaming — pipeline.ts + tts-client.ts
- [x] 첫 문장 즉시 TTS — processWithClaudeStreaming (문장 경계 감지 → smartSpeak 콜백)
- [x] pipelineSpeakStreaming — 문장별 순차 speak (150자 truncation 제거)
- [x] sanitizeTTSText — URL/파일경로/ID/마크다운 자동 정제

## 남은 작업
- [x] 실측 벤치마크: TTFB 측정 스크립트 작성 (scripts/benchmark-ttfb.sh)
- [x] 실측 결과: Kokoro 8ms / Spark 11ms — 목표 달성
- [x] CosyVoice2-0.5B macOS 패치 — matcha-tts 설치 완료, CausalConditionalDecoder import OK

## 수정 대상 파일
- `src/main/tts-client.ts` — Kokoro MLX 엔드포인트 + 스트리밍
- `src/main/nco-client.ts` — voice fast-path
- `src/main/pipeline.ts` — 문장 스트리밍 TTS
- `src/main/ipc.ts` — 파이프라인 통합
- `src/shared/types.ts` — Answer 프롬프트 최적화
