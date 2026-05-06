#!/usr/bin/env bash
# Nova Voice — Whisper STT 정확도 벤치마크
# 실행: bash scripts/whisper-benchmark.sh [모델명]
# 출력: WER(단어 오류율), 정확도, 평균 레이턴시
#
# 사전 요구사항:
#   - whisper-cli 설치 (brew install whisper-cpp)
#   - ffmpeg 설치 (brew install ffmpeg)
#   - say 명령 (macOS 내장)

set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

MODEL_NAME="${1:-large-v3-turbo}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MODELS_DIR="$PROJECT_DIR/models"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo -e "${BLUE}=== Whisper STT 벤치마크 ===${NC}"
echo "모델: $MODEL_NAME"
echo ""

# ── Whisper binary 찾기 ──────────────────────────────────
WHISPER_BIN=""
for p in /opt/homebrew/bin/whisper-cli /usr/local/bin/whisper-cli /usr/bin/whisper-cli; do
  if [ -f "$p" ]; then WHISPER_BIN="$p"; break; fi
done
if [ -z "$WHISPER_BIN" ]; then
  echo -e "${RED}✗ whisper-cli 없음 — brew install whisper-cpp${NC}"
  exit 1
fi
echo "✓ whisper-cli: $WHISPER_BIN"

# ── 모델 파일 찾기 ──────────────────────────────────────
MODEL_PATH=""
for dir in "$MODELS_DIR" "$HOME/Library/Application Support/nova-voice/models"; do
  candidate="$dir/ggml-$MODEL_NAME.bin"
  if [ -f "$candidate" ]; then MODEL_PATH="$candidate"; break; fi
done
if [ -z "$MODEL_PATH" ]; then
  echo -e "${RED}✗ 모델 없음: ggml-$MODEL_NAME.bin${NC}"
  echo "  다운로드: https://huggingface.co/ggerganov/whisper.cpp/tree/main"
  exit 1
fi
echo "✓ 모델: $MODEL_PATH ($(du -sh "$MODEL_PATH" | cut -f1))"
echo ""

# ── 벤치마크 테스트 케이스 (한국어 기준) ─────────────────
declare -a REFERENCE_TEXTS=(
  "크롬 열어줘"
  "볼륨 올려줘"
  "오늘 날씨 어때"
  "이 코드 설명해줘"
  "선택한 텍스트 번역해줘"
  "터미널 열어줘"
  "화면 캡처해줘"
  "디스코드 실행해"
  "지금 뭐 하고 있어"
  "슬랙 닫아줘"
)

# ── TTS로 테스트 오디오 생성 ───────────────────────────
echo "테스트 오디오 생성 중 (macOS say)..."
TOTAL=0
CORRECT=0
TOTAL_WER=0
TOTAL_LATENCY=0
RESULTS=()

for i in "${!REFERENCE_TEXTS[@]}"; do
  REF="${REFERENCE_TEXTS[$i]}"
  WAV_FILE="$TMP_DIR/test_${i}.wav"
  WEBM_FILE="$TMP_DIR/test_${i}.webm"

  # say → aiff → wav (16kHz mono)
  AIFF_FILE="$TMP_DIR/test_${i}.aiff"
  say -v Yuna "$REF" -o "$AIFF_FILE" 2>/dev/null

  # ffmpeg: aiff → 16kHz mono WAV + 오디오 필터 (nova-voice와 동일)
  ffmpeg -i "$AIFF_FILE" \
    -af "highpass=f=100,lowpass=f=8000,anlmdn=s=7,volume=1.5" \
    -ar 16000 -ac 1 -c:a pcm_s16le \
    -y "$WAV_FILE" 2>/dev/null

  # Whisper 전사
  START_T=$(date +%s%3N)
  TRANSCRIPT=$("$WHISPER_BIN" \
    -m "$MODEL_PATH" \
    -f "$WAV_FILE" \
    --no-timestamps \
    --prompt "크롬,사파리,터미널,카카오톡,슬랙,디스코드,볼륨,올려,내려,열어,닫아,실행,종료,캡처,번역" \
    -bs 5 -bo 5 -tp 0 --no-fallback \
    --no-speech-thold 0.3 --entropy-thold 2.8 \
    -l ko 2>/dev/null | grep -v '^\[' | grep -v '^whisper_' | tr '\n' ' ' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
  END_T=$(date +%s%3N)
  LATENCY=$((END_T - START_T))

  # 정확도 계산 (단순 문자 단위 WER 근사)
  REF_WORDS=$(echo "$REF" | wc -w | tr -d ' ')
  TRANS_WORDS=$(echo "$TRANSCRIPT" | wc -w | tr -d ' ')

  # 일치율 (레벤슈타인 대신 단순 비교)
  if [ "$TRANSCRIPT" = "$REF" ]; then
    MATCH="exact"
    CORRECT=$((CORRECT + 1))
    WER=0
  else
    # 간단한 단어 일치 계산
    MATCH_COUNT=0
    for word in $REF; do
      if echo "$TRANSCRIPT" | grep -q "$word"; then
        MATCH_COUNT=$((MATCH_COUNT + 1))
      fi
    done
    WER=$(echo "scale=2; ($REF_WORDS - $MATCH_COUNT) * 100 / $REF_WORDS" | bc 2>/dev/null || echo "?")
    MATCH="partial"
  fi

  TOTAL=$((TOTAL + 1))
  TOTAL_LATENCY=$((TOTAL_LATENCY + LATENCY))

  # 결과 저장
  if [ "$MATCH" = "exact" ]; then
    STATUS="${GREEN}✓${NC}"
  elif [ "$WER" = "0" ] || [ "$WER" = "00" ]; then
    STATUS="${GREEN}✓${NC}"
  else
    STATUS="${YELLOW}~${NC}"
  fi

  echo -e "[$((i+1))/${#REFERENCE_TEXTS[@]}] $STATUS 레이턴시: ${LATENCY}ms"
  echo "    예상: \"$REF\""
  echo "    인식: \"$TRANSCRIPT\""
  [ "$WER" != "?" ] && [ "$WER" != "0" ] && echo "    WER: ${WER}%"

  RESULTS+=("$STATUS|$REF|$TRANSCRIPT|${LATENCY}ms|WER:${WER}%")
done

# ── 요약 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}=== 벤치마크 결과 ===${NC}"
echo "모델: $MODEL_NAME"
echo "총 케이스: $TOTAL"
echo "정확 일치: $CORRECT / $TOTAL ($(echo "scale=0; $CORRECT * 100 / $TOTAL" | bc)%)"
echo "평균 레이턴시: $((TOTAL_LATENCY / TOTAL))ms"
echo ""
echo "결과 파일: $SCRIPT_DIR/whisper-benchmark-$(date +%Y%m%d_%H%M%S).txt"

# 결과 파일 저장
RESULT_FILE="$SCRIPT_DIR/whisper-benchmark-$(date +%Y%m%d_%H%M%S).txt"
{
  echo "=== Whisper Benchmark Results ==="
  echo "Date: $(date)"
  echo "Model: $MODEL_NAME ($MODEL_PATH)"
  echo "Binary: $WHISPER_BIN"
  echo ""
  echo "Results:"
  for r in "${RESULTS[@]}"; do
    echo "$r"
  done
  echo ""
  echo "Summary:"
  echo "Total: $TOTAL, Exact: $CORRECT, Avg Latency: $((TOTAL_LATENCY / TOTAL))ms"
} > "$RESULT_FILE"

echo -e "${GREEN}벤치마크 완료${NC}"
