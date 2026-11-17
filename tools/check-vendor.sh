#!/bin/sh
# check-vendor.sh — compare the copies vendored into this repo with the vendor/herdr-shared
# submodule. Skips when the submodule is not initialized, since a plain clone has no source.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
SHARED=${HERDR_SHARED:-$REPO/vendor/herdr-shared}

if [ ! -f "$SHARED/tools/check-vendor.sh" ]; then
  printf 'check-vendor: no herdr-shared at %s; run git submodule update --init, skipping\n' "$SHARED" >&2
  exit 0
fi

exec sh "$SHARED/tools/check-vendor.sh" "$REPO"
