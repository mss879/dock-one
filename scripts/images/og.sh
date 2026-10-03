#!/usr/bin/env bash
# Renders scripts/images/og-card.html (1200×630) with headless Chrome and writes the share images
# Next.js picks up by file convention: src/app/opengraph-image.jpg and src/app/twitter-image.jpg.
# Needs Google Chrome and Python Pillow. Run from the repo root:  bash scripts/images/og.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Headless Chrome on macOS can linger after writing the screenshot: wait for the file, then stop it.
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --no-first-run --no-default-browser-check --window-size=1200,630 --virtual-time-budget=10000 \
  --allow-file-access-from-files --user-data-dir="$TMP/profile" --screenshot="$TMP/card.png" \
  "file://$ROOT/scripts/images/og-card.html" >/dev/null 2>&1 &
CHROME_PID=$!
for _ in $(seq 1 120); do
  [ -s "$TMP/card.png" ] && break
  sleep 0.5
done
sleep 0.5
kill "$CHROME_PID" 2>/dev/null || true
[ -s "$TMP/card.png" ] || { echo "Chrome did not write a screenshot" >&2; exit 1; }

python3 - "$TMP/card.png" "$ROOT/src/app" <<'PY'
import sys
from pathlib import Path
from PIL import Image

src, out = Path(sys.argv[1]), Path(sys.argv[2])
im = Image.open(src).convert("RGB")
assert im.size == (1200, 630), im.size
for name in ("opengraph-image.jpg", "twitter-image.jpg"):
    path = out / name
    im.save(path, "JPEG", quality=88, optimize=True, progressive=True, subsampling=0)
    print(f"{path}  {im.width}x{im.height}  {path.stat().st_size // 1024} KB")
PY
