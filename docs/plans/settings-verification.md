# Nova Voice 설정 검증 플랜

> 생성일: 2026-05-07
> 목적: TTS/Whisper/화자 설정의 저장·로드·적용이 올바르게 작동하는지 전체 검증

---

## 발견된 문제 (사전 분석)

| # | 문제 | 심각도 |
|---|------|--------|
| 1 | `ipc.ts` DEFAULT `ttsModel: 'mlx_ko'` vs `types.ts` DEFAULT `ttsModel: 'qwen3'` 불일치 | HIGH |
| 2 | `AppSettings` 인터페이스에 `ttsSpeed`, `ttsEnabled` 없음 (pipeline에서 사용 중) | MED |
| 3 | `tts:mlx-voice:set` IPC와 `settings:set({mlxVoice})` 둘 다 `setMLXVoice` 호출 — 이중 경로 | LOW |

---

## 검증 태스크 목록

### T1: Settings 영속화 라운드트립
- [ ] `settings:set` → `saveSettingsToDisk` 호출 확인
- [ ] 앱 재시작 후 `loadSettingsFromDisk` → `settings:get` 일치 확인
- [ ] JSON 파일 경로: `~/Library/Application Support/nova-voice/nova-settings.json`

### T2: DEFAULT_SETTINGS 불일치 수정
- [ ] `ipc.ts` DEFAULT_SETTINGS `ttsModel` → `types.ts`와 통일 (`mlx_ko` 유지 또는 `qwen3`으로 통일)
- [ ] `types.ts` DEFAULT_SETTINGS import로 교체하거나 명시적 동기화

### T3: TTS 모델 전환 검증
- [ ] `settings:set({ttsModel})` → `setActiveTTSModel` 호출 확인 (ipc.ts:296)
- [ ] `_ttsModel` 변수 실제 업데이트 확인 (tts-client.ts)
- [ ] mlx/mlx_ko/mlx_en/mlx_mix/qwen3/say/cosyvoice 각 경로 확인

### T4: MLX 화자 선택 저장 검증
- [ ] SettingsPanel에서 화자 선택 → `updateSetting('mlxVoice', voiceId)` 호출
- [ ] `settings:set({mlxVoice})` → `setMLXVoice` + `setPipelineConfig({ttsSpeaker})` 동시 적용
- [ ] `tts:mlx-voice:set` IPC (line 1558) vs `settings:set` 이중 경로 정리

### T5: macOS say 화자 선택 검증
- [ ] `sayVoice` 변경 → `setActiveSayVoice` 적용 확인
- [ ] say 모델 선택 시 화자 목록 표시 확인
- [ ] 미리듣기(`previewSayVoice`) 동작 확인

### T6: Whisper 모델 설정 검증
- [ ] `modelName` 변경 → 다음 녹음 시 올바른 모델 사용 확인
- [ ] `modelPath` 자동 생성 로직 확인 (ipc.ts:387 `ggml-${modelName}.bin`)
- [ ] 모델 파일 존재 여부 체크 후 폴백 로직 확인

### T7: TTS 서버 상태 표시 검증
- [ ] `getTTSServerStatuses` → 3서버(8800/8801/8802) 포트별 상태 반환
- [ ] `startTTSServer` / `stopTTSServer` IPC 핸들러 동작
- [ ] SettingsPanel 서버 상태 UI 실시간 업데이트

### T8: TTS 미리듣기 검증
- [ ] `previewTTSVoice(serverId, voice)` 각 서버별 동작
- [ ] 미리듣기 중 busy 상태 UI 표시
- [ ] 미리듣기 실패 시 에러 처리

### T9: SettingsPanel UI 일관성
- [ ] `localSettings.ttsModel`이 `settings:get` 결과와 일치
- [ ] 화자 선택 후 새로고침 없이 UI 반영
- [ ] `mlx_en` 모델에 mlxVoice 적용 여부 (현재 af_heart 고정)

### T10: AppSettings 타입 완전성
- [ ] `ttsSpeed`, `ttsEnabled` 필드 추가 필요 여부
- [ ] `pipeline.ts`의 PipelineConfig와 AppSettings 동기화

---

## 상태

| 태스크 | 담당 | 상태 |
|--------|------|------|
| T1 Settings 영속화 | aider | [x] 정상 — settings:set → saveSettingsToDisk 호출 확인 |
| T2 DEFAULT 불일치 수정 | aider | [x] 완료 — types.ts ttsModel → 'mlx_ko' 통일 |
| T3 TTS 모델 전환 | 직접 | [x] 정상 — setActiveTTSModel → _ttsModel 업데이트 확인 |
| T4 MLX 화자 저장 | codex | [x] 정상 — tts:mlx-voice:set에 saveSettingsToDisk 포함됨 |
| T5 say 화자 | 직접 | [x] 정상 — setActiveSayVoice + SAY_VOICES IPC 확인 |
| T6 Whisper 모델 | 직접 | [x] **BUG 수정** — modelName 무시 버그 수정 (설정 모델 우선) |
| T7 서버 상태 | 직접 | [x] 정상 — tts:server-status/start/stop/preview 모두 동작 |
| T8 TTS 미리듣기 | 직접 | [x] 정상 — previewTTSVoice IPC 핸들러 확인 |
| T9 UI 일관성 | codex | [x] 정상 — SettingsPanel localSettings.ttsModel 동기화 확인 |
| T10 타입 완전성 | 직접 | [x] 현재 수준 허용 — ttsSpeed/ttsEnabled는 pipeline 내부 사용만 |
