#!/usr/bin/env bash
# Copies src/chess/ byte-identical into both apps' src/chess/.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/src/chess/"
for app in bluff-frontend bluff-frontend-portrait; do
  dest="$here/../$app/src/chess/"
  if [ ! -d "$here/../$app/src" ]; then
    echo "skip $app (no src/)"
    continue
  fi
  mkdir -p "$dest"
  rsync -a --delete --checksum "$src" "$dest"
  diff -r "$src" "$dest" >/dev/null && echo "synced $app/src/chess"
done
