#!/usr/bin/env bash
# Copies src/carrom/ byte-identical into both apps' src/carrom/.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/src/carrom/"
for app in bluff-frontend bluff-frontend-portrait; do
  dest="$here/../$app/src/carrom/"
  if [ ! -d "$here/../$app/src" ]; then
    echo "skip $app (no src/)"
    continue
  fi
  mkdir -p "$dest"
  rsync -a --delete --checksum "$src" "$dest"
  diff -r "$src" "$dest" >/dev/null && echo "synced $app/src/carrom"
done
