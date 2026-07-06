# Nova Voice 설정 검증 플랜

> 생성일: 2026-05-07
> 목적: TTS/Whisper/화자 설정의 저장·로드·적용이 올바르게 작동하는지 전체 검증
> 최종 재검증: 2026-07-05 (claude-5, T1 코드 증거 기반 — grep/read/tsc)

---

## 발견된 문제 (사전 분석 → 현재 상태로 정정)

| # | 문제 | 심각도 | 현재 상태 (2026-07-05 재검증) |
|---|------|--------|------|
| 1 | ~~`ipc.ts` DEFAULT `ttsModel:'mlx_ko'` vs `types.ts` `'qwen3'` 불일치~~ | HIGH | **해소** — 양쪽 이미 `all_tts`였고(초기 진술 stale), ipc 로컬 복제본 삭제 후 `types.ts`에서 단일 import (dedup) |
| 2 | `AppSettings`에 `ttsSpeed`/`ttsEnabled` 없음 (pipeline에서 사용) | MED | **의도적** — 두 필드는 `PipelineConfig` 내부 전용(pipeline.ts:24/27). AppSettings 노출은 미구현(아래 T10-2 open) |
| 3 | `tts:mlx-voice:set`와 `settings:set({mlxVoice})` 이중 경로 | LOW | **버그 아님** — 둘 다 `setMLXVoice`+`setPipelineConfig`+`saveSettingsToDisk` 동일 수행. 중복이나 불일치 없음. 정리는 선택 |

---

## 검증 태스크 목록

> `[x]` = 코드 정적 검증(grep/read/tsc, T1/T2) 완료 · `[ ]` = 앱 실행 필요(UI/런타임, 미검증)

### T1: Settings 영속화 라운드트립
- [x] `settings:set` → `saveSettingsToDisk` 호출 확인 (ipc.ts handler)
- [x] `loadSettingsFromDisk` → `{...DEFAULT_SETTINGS, ...parsed}` 병합 → `settings:get` 반환 (코드 경로 검증; 실제 재시작은 앱 실행 시)
- [x] JSON 파일 경로: `userData/nova-settings.json` (getSettingsPath)

### T2: DEFAULT_SETTINGS 불일치 수정
- [x] `ipc.ts` 로컬 DEFAULT_SETTINGS 삭제 → `../shared/types`에서 import (단일 소스, tsc 0err)
- [x] `types.ts` DEFAULT_SETTINGS를 런타임 유일 소스로 확정 (`voiceCorrection` dead value true→false 정정)

### T3: TTS 모델 전환 검증
- [x] `settings:set({ttsModel})` → `setActiveTTSModel` 호출 확인 (ipc.ts)
- [x] `_ttsModel` 실제 업데이트 확인 (tts-client.ts:2028 set → 2111 read)
- [x] 각 경로 확인: say/mlx_ko/mlx_en/mlx_mix/all_tts/qwen3 분기 존재 (tts-client.ts:2120-2203). 주의: `cosyvoice`는 별도 분기 없이 qwen3 기본 폴백으로 처리됨

### T4: MLX 화자 선택 저장 검증
- [x] SettingsPanel 화자 선택 → `updateSetting('mlxVoice', voiceId)` 호출 (SettingsPanel.tsx:283/444)
- [x] `settings:set({mlxVoice})` → `setMLXVoice` + `setPipelineConfig({ttsSpeaker})` 동시 적용 (ipc.ts)
- [x] `tts:mlx-voice:set`(ipc.ts:1607) vs `settings:set` 이중 경로 — 둘 다 save 포함, 불일치 없음 확인

### T5: macOS say 화자 선택 검증
- [x] `sayVoice` 변경 → `setActiveSayVoice` 적용 확인 (ipc.ts)
- [ ] say 모델 선택 시 화자 목록 표시 확인 (UI — 앱 실행 필요)
- [ ] 미리듣기(`previewSayVoice`) 동작 확인 (런타임 — 앱 실행 필요)

### T6: Whisper 모델 설정 검증
- [x] `modelName` 변경 → 다음 녹음 시 해당 모델 선택 (ipc.ts:389 `models.find(name===settings.modelName)`)
- [x] `modelPath` 자동 생성 로직 확인 (ipc.ts:400 `ggml-${modelName}.bin`)
- [x] 모델 파일 미지정 시 폴백 로직 확인 (ipc.ts:385-397 best/first 폴백)

### T7: TTS 서버 상태 표시 검증
- [x] `getTTSServerStatuses` → `tts:server-status` 핸들러 존재 (ipc.ts:1596)
- [x] `startTTSServer`/`stopTTSServer` → `tts:server-start/stop` 핸들러 존재 (ipc.ts:1597/1603)
- [ ] SettingsPanel 서버 상태 UI 실시간 업데이트 (UI — 앱 실행 필요)

### T8: TTS 미리듣기 검증
- [x] `previewTTSVoice(serverId, voice)` → `tts:preview` 핸들러 존재 (ipc.ts:1605)
- [ ] 미리듣기 중 busy 상태 UI 표시 (UI — 앱 실행 필요)
- [ ] 미리듣기 실패 시 에러 처리 (런타임 — 앱 실행 필요)

### T9: SettingsPanel UI 일관성
- [ ] `localSettings.ttsModel`이 `settings:get` 결과와 일치 (UI 상태 — 앱 실행 필요)
- [ ] 화자 선택 후 새로고침 없이 UI 반영 (UI — 앱 실행 필요)
- [ ] `mlx_en` 모델에 mlxVoice 적용 여부 (현재 af_heart 고정 — 런타임 확인 필요)

### T10: AppSettings 타입 완전성
- [x] `ttsSpeed`/`ttsEnabled` 위치 확인 — 기존 `PipelineConfig` 전용 (pipeline.ts:24/27)
- [x] `pipeline.ts` PipelineConfig ↔ AppSettings 동기화 — **구현 완료** (2026-07-05): AppSettings 인터페이스+DEFAULT_SETTINGS에 `ttsSpeed:1.0`/`ttsEnabled:true` 추가, ipc init 및 `settings:set`에서 `setPipelineConfig`로 반영 (tsc 0err). 단, SettingsPanel 슬라이더/토글 UI 노출은 별도 후속(선택)

---

## 상태 (2026-07-05 재검증)

- **코드 정적 검증 완료 (T1/T2 증거)**: 19/28 항목 — 검증 도구: grep(심볼 배선) + read(로직) + `tsc --noEmit` 0err
- **앱 실행 필요 (미검증, 정직 표기)**: 9/28 항목 — say 화자목록/미리듣기, 서버상태 실시간 UI, busy·실패 UI, UI 리렌더, mlx_en 적용, PipelineConfig↔AppSettings 동기화
- **이번 세션 실제 수정**: DEFAULT_SETTINGS 중복 제거(ipc→types import) + `voiceCorrection` dead value 정정

> ⚠️ 이전(2026-05-07) 상태표는 T5/T7/T8/T9 UI 항목까지 [x]로 표기했으나 이는 에이전트 자기보고(T4)였고 일부(T2 mlx_ko 주장)는 stale로 판명됨. 본 재검증은 코드로 확인 가능한 항목만 [x] 처리하고 UI/런타임 항목은 앱 실행 검증 전까지 [ ]로 유지.
