# TTS 화자 통일 & 잘림 버그 수정 플랜

> 생성일: 2026-05-07
> 목표: 화자 일관성 + 잘림 버그 완전 해결 + NCO TTS 알림 + 설정 UI 정확성

---

## 근본 원인 분석

| # | 버그 | 파일 | 위치 |
|---|------|------|------|
| 1 | 200자 하드 컷 | pipeline.ts | line 66-68 |
| 2 | Kokoro 화자 `af_heart` 하드코딩 | tts-client.ts | line 422, 769, 873, 1196 |
| 3 | Spark 화자 `ko_female` 하드코딩 | tts-client.ts | line 781, 891, 1198 |
| 4 | answer/search 300자 제한 | ipc.ts | smartSpeak 호출부 |
| 5 | NCO 시작 알림 없음 | ipc.ts | line 877-978 |
| 6 | mlx_en 선택 시 화자 목록 미표시 | SettingsPanel.tsx | line 191-265 |

---

## 화자 매핑 설계

```
mlxVoice(Qwen3) → Kokoro 매핑
  남성: Ryan, Aiden, Eric, Dylan, Ethan → bm_george
  여성: Chelsie, Vivian, Serena          → af_heart

mlxVoice(Qwen3) → Spark 매핑
  남성 → male_1  (Spark gender param)
  여성 → female_1
```

---

## 태스크 목록

### T1: TTS 잘림 수정 (pipeline.ts)
- [x] `pipelineSpeak` 200자 → 제거 (sanitizeTTSText가 처리)
- [x] chunk 실패 시 skip 처리 (speakMLXKoChunked + speakMLXEnChunked — safeSynthChunk 래핑)

### T2: 화자 일관성 (tts-client.ts)
- [x] `getKokoroVoice(mlxVoice)` 매핑 함수 추가
- [x] `getSparkVoice(mlxVoice)` 매핑 함수 추가
- [x] `synthesizeMLXMultilingual` English/Mixed 경로에 매핑 적용
- [x] `speakMLXEnChunked` 기본 voice에 매핑 적용
- [x] `previewTTSVoice` mlx_en/mlx_mix 미리듣기에 매핑 적용

### T3: NCO TTS 알림 (ipc.ts)
- [x] discussion 시작 전 TTS "토론 시작합니다" 추가
- [x] team 시작 전 TTS "팀 작업 시작합니다" 추가
- [x] hive 시작 전 TTS "하이브 시작합니다" 추가
- [x] answer/search 300자 제한 제거 → sanitizeTTSText에 위임

### T4: Settings UI 화자 표시 (SettingsPanel.tsx)
- [x] ttsModel === 'mlx_en' 선택 시 Kokoro 화자 목록 표시
- [x] ttsModel === 'mlx_mix' 선택 시 Spark 화자 목록 표시
- [x] 화자 선택 시 해당 서버로 미리듣기

---

## 수정 파일

- `src/main/tts-client.ts`
- `src/main/pipeline.ts`
- `src/main/ipc.ts`
- `src/renderer/components/settings/SettingsPanel.tsx`
