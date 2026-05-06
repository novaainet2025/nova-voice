#!/usr/bin/env bash
# Nova Voice — MLX TTS 3-Server 시작 스크립트
# 포트별 단일 모델 상주 → 모델 교체 없음 → Cold Start 제거
#
# :8800  Qwen3-TTS-12Hz-0.6B-Base-4bit  — 한국어 전용 (최고 품질)
# :8801  Kokoro-82M-bf16                 — 영어 전용 (~50ms)
# :8802  Spark-TTS-0.5B-bf16            — 한영 혼용 (단일 모델)

set -e

VENV="/Users/nova-ai/project/nova-voice/.venv-tts/bin/python3"
LOG_DIR="/tmp/nova-mlx-logs"
mkdir -p "$LOG_DIR"

KO_MODEL="mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit"
EN_MODEL="mlx-community/Kokoro-82M-bf16"
MIX_MODEL="mlx-community/Spark-TTS-0.5B-bf16"

# 포트 사용 중인 서버 중지
stop_port() {
  local port=$1
  lsof -ti:"$port" 2>/dev/null | xargs kill -TERM 2>/dev/null || true
  sleep 0.3
}

# MLX Audio 서버 시작 (단일 서버)
start_server() {
  local name=$1
  local port=$2
  local model=$3
  local log="$LOG_DIR/mlx-$port.log"

  # 이미 실행 중이면 스킵
  if curl -s --max-time 1 "http://localhost:$port/v1/models" > /dev/null 2>&1; then
    echo "[OK] $name (:$port) — already running"
    return 0
  fi

  echo "[START] $name (:$port) model=$model"
  nohup "$VENV" -m mlx_audio.server \
    --port "$port" \
    --model "$model" \
    >> "$log" 2>&1 &
  echo $! > "/tmp/nova-mlx-$port.pid"
  echo "[PID] $name (:$port) → PID $(cat /tmp/nova-mlx-$port.pid)"
}

# 서버 준비 대기
wait_ready() {
  local name=$1
  local port=$2
  local max=${3:-40}

  echo -n "[WAIT] $name (:$port)"
  for i in $(seq 1 $max); do
    if curl -s --max-time 1 "http://localhost:$port/v1/models" > /dev/null 2>&1; then
      echo " → ready (${i}s)"
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo " → TIMEOUT after ${max}s"
  return 1
}

case "${1:-start}" in
  start)
    echo "=== Nova MLX TTS Servers — Start ==="
    start_server "MLX-Qwen3(KO)"  8800 "$KO_MODEL"
    start_server "MLX-Kokoro(EN)" 8801 "$EN_MODEL"
    start_server "MLX-Spark(MIX)" 8802 "$MIX_MODEL"

    echo ""
    echo "=== 서버 준비 대기 ==="
    wait_ready "Qwen3(KO)"  8800 40
    wait_ready "Kokoro(EN)" 8801 40
    wait_ready "Spark(MIX)" 8802 40

    echo ""
    echo "=== 서버 상태 ==="
    for port in 8800 8801 8802; do
      model=$(curl -s --max-time 2 "http://localhost:$port/v1/models" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'].split('/')[-1])" 2>/dev/null || echo "?")
      echo "  :$port → $model"
    done
    ;;

  stop)
    echo "=== Nova MLX TTS Servers — Stop ==="
    for port in 8800 8801 8802; do
      stop_port $port
      rm -f "/tmp/nova-mlx-$port.pid"
      echo "  :$port stopped"
    done
    ;;

  status)
    echo "=== Nova MLX TTS Servers — Status ==="
    for port in 8800 8801 8802; do
      result=$(curl -s --max-time 2 "http://localhost:$port/v1/models" 2>/dev/null)
      if [ -n "$result" ]; then
        model=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'].split('/')[-1])" 2>/dev/null || echo "?")
        echo "  [UP]   :$port → $model"
      else
        echo "  [DOWN] :$port"
      fi
    done
    ;;

  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;

  *)
    echo "Usage: $0 {start|stop|status|restart}"
    exit 1
    ;;
esac
