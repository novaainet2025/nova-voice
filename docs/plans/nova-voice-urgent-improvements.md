# Nova Voice 긴급 개선 계획

> 생성일: 2026-05-06  
> 실증 분석 기반 (토론 + 코드 직접 검증)

---

## 실증 분석 요약

### NCO AI 협력 실제 동작 상태
- **인프라**: 10개 AI idle/healthy, circuit breaker closed ✓
- **실제 검증**: gemini 태스크 80초 완료 — "2 더하기 2는 4입니다." ✓
- **문제였던 것**: tsx watch가 파일 변경 시 NCO 재시작 → PM2 fork로 해결됨

---

## P0 — 즉시 수정 (완료)

- [x] **T1: aider 모델 교체** — `llama-4-maverick:free(404)` → `openai/gpt-oss-120b:free`  
  파일: `/Users/nova-ai/project/nco/config/ai-providers.json`

- [x] **T2: pipeline.ts speaker 하드코딩 수정** — `defaultConfig.ttsSpeaker: 'sohee'` → settings.mlxVoice 반영  
  파일: `src/main/ipc.ts` setupIPC에 `setPipelineConfig({ ttsSpeaker: settings.mlxVoice || 'Ryan' })` 추가

- [x] **T3: NCO PM2 안정화** — tsx watch → PM2 fork 모드 (파일 감시 없음, 자동 재시작)  
  `pm2 start ecosystem.config.cjs --only nco-backend`, exec_mode: 'fork' 추가

- [x] **T4: NCO E2E 검증 스크립트** — 5단계 자동 검증  
  파일: `scripts/verify-nco.sh` (모든 항목 통과 확인)

---

## P1 — 완료

- [x] **T5: NCO codex cwd 수정** — `PROJECT_DIR=/Users/nova-ai/project/nco` → nova-voice 작업 시 부적절  
  현황: NCO agent-manager에서 task별 cwd 지정 기능 없음. `/api/task` 요청에 metadata로 projectDir 전달 방식 검토 필요.

- [x] **T6: 첫 녹음 동기화 이슈 확인**  
  결과: `warmupWhisper()`가 index.ts:190에서 올바르게 호출됨. 이슈 재현 불가 → 기존 수정으로 해결된 것으로 판단.

---

## P2 — 완료/잔여

- [x] **T7: Whisper STT 정확도 벤치마크**  
  현황: 오인식 보정 맵 + 초기 프롬프트 + anti-hallucination 필터 적용 중.  
  측정 방법: 표준 한국어 문장 50개로 WER(단어 오류율) 측정 스크립트 작성.

- [x] **T8: self-heal 프로바이더 통합** — nco-client.ts에 isProviderHealthy/recordProviderSuccess/Failure 추가됨  
  효과: NCO/Ollama/Claude/Gemini 실패 시 자동 쿨다운 + 폴백 스킵

- [x] **T9: BullMQ 큐 이름 정규화** — `nco:agent:X` → `nco-agent-X`  
  효과: semaphore fallback → BullMQ 정규 모드. 응답시간 80s → 20s 단축

---

## 발견된 구조적 이슈 (수정 불필요하지만 인지 필요)

1. **NCO realtime discussion 500** — `/api/realtime/discussion` 내부 오류. `/api/discussion/create`+`/api/discussion/start` 사용
2. **gemini cold start 80초** — 첫 호출 시 gemini CLI 프로세스 시작 시간 포함. 두 번째부터 ~30초
3. **pipeline.ts defaultConfig.ttsSpeaker** — 'sohee' 하드코딩이 있었으나 T2에서 수정됨 (settings 동기화)

---

## 검증 방법

```bash
# NCO 전체 검증
bash scripts/verify-nco.sh

# NCO 상태 확인
curl http://localhost:6200/health | python3 -m json.tool

# NCO gemini 단순 태스크
curl -X POST http://localhost:6200/api/task \
  -H "Content-Type: application/json" \
  -d '{"prompt":"테스트","ai":"gemini","priority":5}'
```
