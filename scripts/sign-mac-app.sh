#!/bin/zsh
set -euo pipefail

app_path="${1:-dist/mac-arm64/NOVA VOICE.app}"

if [[ ! -d "$app_path" ]]; then
  print -u2 "NOVA VOICE app bundle not found: $app_path"
  exit 1
fi

# There is no Developer ID certificate on this Mac. Keep the ad-hoc signature's
# designated requirement stable so macOS TCC recognizes rebuilt local installs
# as the same app instead of asking for Accessibility permission every time.
codesign --force --deep --sign - "$app_path"
codesign --force --sign - \
  --requirements '=designated => identifier "com.novavoice.app"' \
  "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"
codesign --display --requirements - "$app_path"
