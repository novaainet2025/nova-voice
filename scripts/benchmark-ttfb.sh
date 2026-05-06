#!/usr/bin/env bash
# Nova Voice TTS TTFB benchmark
REPEAT=${1:-5}
TEXT_KO="hello nova voice"
TEXT_EN="hello nova voice today"

measure() {
  local name=$1 port=$2 model=$3 text=$4 voice=$5 target=$6
  local total=0 ok=0 min=99999 max=0

  echo ""
  echo "[$name] :$port"
  if ! curl -sf --max-time 2 "http://localhost:$port/v1/models" >/dev/null; then
    echo "  [DOWN]"
    return
  fi

  for i in $(seq 1 "$REPEAT"); do
    ms=$(curl -sf --max-time 10 \
      -X POST "http://localhost:$port/v1/audio/speech" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$model\",\"input\":\"$text\",\"voice\":\"$voice\",\"response_format\":\"wav\"}" \
      -o /tmp/ttfb.wav \
      -w "%{time_starttransfer}" 2>/dev/null | awk '{printf "%d", $1*1000}')
    if [ -n "$ms" ] && [ "$ms" -gt 0 ] 2>/dev/null; then
      total=$((total + ms))
      ok=$((ok + 1))
      [ "$ms" -lt "$min" ] && min=$ms
      [ "$ms" -gt "$max" ] && max=$ms
      echo "  run $i: ${ms}ms"
    else
      echo "  run $i: FAIL"
    fi
  done

  if [ "$ok" -gt 0 ]; then
    avg=$((total / ok))
    echo "  avg=${avg}ms min=${min}ms max=${max}ms ($ok/$REPEAT)"
    if [ "$avg" -le "$target" ]; then
      echo "  OK: target ${target}ms achieved"
    else
      echo "  MISS: target ${target}ms, got ${avg}ms"
    fi
  fi
}

echo "=== Nova Voice TTS TTFB Benchmark ==="
echo "Repeat: $REPEAT | $(date '+%Y-%m-%d %H:%M:%S')"

measure "Qwen3-TTS (KO)" 8800 "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit"  "$TEXT_KO" "Ryan"     500
measure "Kokoro-82M (EN)" 8801 "mlx-community/Kokoro-82M-bf16"                 "$TEXT_EN" "af_heart"  200
measure "Spark-TTS (MIX)" 8802 "mlx-community/Spark-TTS-0.5B-bf16"            "$TEXT_KO" "ko_female"  500

echo ""
echo "=== Done ==="
rm -f /tmp/ttfb.wav
