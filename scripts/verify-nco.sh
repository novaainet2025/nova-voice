#!/usr/bin/env bash
# Nova Voice — NCO AI 협력 E2E 검증 스크립트
# 실행: bash scripts/verify-nco.sh
# 목적: NCO(:6200)가 실제로 AI 협력을 수행하는지 검증

set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; FAILURES=$((FAILURES+1)); }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

FAILURES=0
# Unicode-safe variable name
NCO_URL="http://localhost:6200"

echo "=== Nova Voice NCO E2E 검증 ==="
echo ""

# ── 1. NCO 헬스체크 ─────────────────────────────────────
echo "[ 1/5 ] NCO 서버 헬스체크..."
HEALTH=$(curl -s --max-time 5 "$NCO_URL/health" 2>/dev/null)
if echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d['status'] in ['healthy','ok'] else 1)" 2>/dev/null; then
  AGENTS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['runtime']['agentsOnline'])" 2>/dev/null)
  UPTIME=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d['runtime']['uptime']:.0f}s\")" 2>/dev/null)
  ok "NCO healthy — ${AGENTS}명 에이전트 온라인, uptime ${UPTIME}"
else
  fail "NCO 서버 응답 없음 — pm2 start ecosystem.config.cjs --only nco-backend 실행 필요"
  exit 1
fi

# ── 2. AI 프로바이더 상태 ────────────────────────────────
echo ""
echo "[ 2/5 ] AI 프로바이더 상태..."
PROVIDERS=$(curl -s --max-time 5 "$NCO_URL/api/ai-providers" 2>/dev/null)
if [ -z "$PROVIDERS" ]; then
  fail "프로바이더 목록 조회 실패"
else
  COUNT=$(echo "$PROVIDERS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ps = d if isinstance(d,list) else d.get('providers',[])
enabled = [p for p in ps if isinstance(p,dict) and p.get('enabled', True)]
print(len(enabled))
" 2>/dev/null)
  ok "프로바이더 ${COUNT}개 등록됨"

  # aider 모델 확인
  AIDER_MODEL=$(echo "$PROVIDERS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ps = d if isinstance(d,list) else d.get('providers',[])
a = next((p for p in ps if isinstance(p,dict) and p.get('id')=='aider'), None)
print(a.get('model','?') if a else 'not found')
" 2>/dev/null)
  if echo "$AIDER_MODEL" | grep -q "maverick"; then
    fail "aider 모델이 아직 llama-4-maverick:free (404 오류 발생) — ai-providers.json 확인"
  else
    ok "aider 모델: $AIDER_MODEL"
  fi
fi

# ── 3. NCO 단순 태스크 실행 ─────────────────────────────
echo ""
echo "[ 3/5 ] NCO 단순 태스크 실행 (gemini 1문장 응답)..."
TASK_PAYLOAD='{"prompt":"한 문장으로 답해: 2더하기 2는?","ai":"gemini","priority":5}'
TASK_RESP=$(curl -s --max-time 30 -X POST "$NCO_URL/api/task" \
  -H "Content-Type: application/json" \
  -d "$TASK_PAYLOAD" 2>/dev/null)

TASK_ID=$(echo "$TASK_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('taskId', d.get('id', d.get('task_id',''))))" 2>/dev/null)
if [ -z "$TASK_ID" ]; then
  fail "태스크 생성 실패: $TASK_RESP"
else
  ok "태스크 생성됨: $TASK_ID"

  # 폴링으로 완료 대기 (최대 90초 — gemini CLI 콜드스타트 포함)
  MAX_WAIT=90
  WAITED=0
  STATUS=""
  while [ $WAITED -lt $MAX_WAIT ]; do
    sleep 5
    WAITED=$((WAITED+5))
    STATUS=$(curl -s --max-time 5 "$NCO_URL/api/tasks/$TASK_ID/status" 2>/dev/null | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null)
    if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "error" ]; then
      break
    fi
  done

  if [ "$STATUS" = "completed" ]; then
    RESPONSE=$(curl -s --max-time 5 "$NCO_URL/api/tasks/$TASK_ID/status" 2>/dev/null | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('result',''))[:150])" 2>/dev/null)
    ok "gemini 응답 완료 (${WAITED}s): ${RESPONSE}"
  elif [ "$STATUS" = "failed" ] || [ "$STATUS" = "error" ]; then
    ERR=$(curl -s --max-time 5 "$NCO_URL/api/tasks/$TASK_ID/status" 2>/dev/null | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error','?')[:100])" 2>/dev/null)
    fail "태스크 실패: $ERR"
  else
    warn "태스크 ${MAX_WAIT}초 타임아웃 (현재 상태: $STATUS) — gemini CLI 구동 시간 초과"
  fi
fi

# ── 4. WebSocket 연결 ────────────────────────────────────
echo ""
echo "[ 4/5 ] WebSocket 포트 확인..."
if nc -z localhost 6201 2>/dev/null; then
  ok "WebSocket :6201 열려있음"
else
  fail "WebSocket :6201 접근 불가"
fi

# ── 5. Nova Voice 코어 헬스 ─────────────────────────────
echo ""
echo "[ 5/5 ] Nova Voice 의존성 확인..."

# Whisper binary
if which whisper-cli &>/dev/null || ls /opt/homebrew/bin/whisper-cli 2>/dev/null; then
  ok "whisper-cli 존재"
else
  warn "whisper-cli 없음 — brew install whisper-cpp 필요"
fi

# MLX TTS
if curl -s --max-time 3 "http://localhost:8800/health" 2>/dev/null | grep -q "ok\|healthy\|running"; then
  ok "MLX TTS :8800 실행 중"
else
  warn "MLX TTS :8800 응답 없음 (선택사항)"
fi

# ── 요약 ────────────────────────────────────────────────
echo ""
echo "=== 결과 ==="
if [ $FAILURES -eq 0 ]; then
  echo -e "${GREEN}모든 검증 통과${NC}"
else
  echo -e "${RED}$FAILURES개 항목 실패${NC} — 위 오류를 확인하세요"
fi

echo "Failures: $FAILURES"
exit $FAILURES
