#!/bin/bash
# nova-voice TTS 출력 스크립트
# 사용법: ./scripts/tts-speak.sh "말할 내용" [화자]
# 화자: sohee (기본값), 다른 화자도 가능

TEXT="${1:-안녕하세요}"
SPEAKER="${2:-sohee}"
TTS_URL="http://localhost:7860"

# Qwen3-TTS 시도
response=$(curl -s -X POST "${TTS_URL}/api/voices/qwen3-tts/tts" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"${TEXT}\", \"speaker\": \"${SPEAKER}\"}" 2>/dev/null)

if echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('url') else 1)" 2>/dev/null; then
  audio_url=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])" 2>/dev/null)
  ms=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ms',0))" 2>/dev/null)
  echo "[TTS] Qwen3-TTS(${SPEAKER}) | ${ms}ms | ${audio_url}"
  tmp_file=$(mktemp /tmp/tts_XXXXXX.wav)
  curl -s "${TTS_URL}${audio_url}" -o "$tmp_file"
  afplay "$tmp_file" 2>/dev/null || aplay "$tmp_file" 2>/dev/null
  rm -f "$tmp_file"
else
  # macOS say 폴백
  echo "[TTS] Qwen3-TTS 실패 → say 폴백"
  say "$TEXT" 2>/dev/null
fi
