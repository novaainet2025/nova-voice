# Whisper/STT 지연 진단 (2026-07-05)

> 요청: "위스퍼가 왜 이렇게 느린지 체크"
> 방법: 코드 분석(T1) + 실측(앱과 동일 방식 :8765 WS 전송, T1)

## 결론 (근본 원인)

**서버가 클라이언트가 버리는 `partial` 전사를 매 3청크마다 전체 버퍼에 대해 수행 → 체감 지연의 ~88%.**

- STT 서버: `@@gentop/lib/stt` (FastAPI WS :8765, MLX `whisper-large-v3-turbo`, silero-vad/torch)
- `server/main.py` WS 핸들러: 발화 중 `partial_decimator % 3 == 0`마다 `engine.transcribe(vad.current_audio)` — **누적 전체 오디오를 통째로 재전사**. 발화가 길수록 대상 버퍼가 커져 O(n²)처럼 증가.
- 클라이언트 `nova-voice/src/main/whisper.ts:239` — `partial` 메시지는 **console.log만 하고 폐기**. 오직 `final`만 사용.
- → 서버가 **버려질 결과를 만드느라 CPU/GPU를 소모**하고, 이 전사들이 이벤트 루프를 블록(`await`)해 final을 지연시킴.

## 실측 (7.83초 한국어 클립)

| 지표 | 값 |
|---|---|
| partial 전사 횟수 | 11회 |
| partial 합계 지연 | 2,977ms (버려짐) |
| final 전사 지연 | 281ms (rtf 0.033) |
| 총 wall-clock | 3,364ms |

→ 2977/3364 ≈ **88%가 낭비**. partial 제거 시 ~300ms 예상(약 10배).

## 부차적 기여 요인

1. **배치를 스트리밍에 밀어넣음**: 앱이 전체 녹음 + 1.5초 무음 패딩을 보내고 서버 VAD `silence_limit_s=0.7`이 final을 트리거 → 고정 지연 추가.
2. **per-frame torch silero VAD** (512샘플 프레임마다 torch 추론) — Python 3.14 + torch 2.11(최신, 휠 최적화 미흡 가능).
3. **full-precision large-v3-turbo** — 대안 whisper.cpp `q5_0`(양자화) 엔진 존재하나 미사용.

## 권장 수정 (효과 순)

1. **[최대효과] partial 전사 비활성화 또는 강한 스로틀** — 클라가 안 쓰므로 서버에서 partial 경로 제거/게이트. `main.py`의 `if partial_decimator % 3 == 0` 블록. ⚠️ `@@gentop/lib/stt`는 별도 git repo — 공유 라이브러리 수정이므로 사용자 승인 필요.
2. 무음 패딩/`silence_limit_s` 축소로 final 트리거 단축.
3. (선택) 서버 model 설정을 클라 설정과 연동 or q5_0 whisper.cpp 엔진 옵션.

## 부수 발견 (지연과 무관, 별개 버그)

- 저장된 설정 `modelName: "medium"` vs `modelPath: ".../ggml-large-v3-turbo.bin"` 불일치.
- `transcribeViaWs`가 modelPath/language를 서버로 안 보냄 → **앱의 Whisper 모델 선택이 STT 서버에 반영되지 않음** (서버는 하드코딩된 mlx large-v3-turbo 사용).
