#!/bin/sh
# check-vendor.sh — fail when a vendored copy differs from its herdr-shared source. Skipped
# when herdr-shared is not checked out (`HERDR_SHARED` names another location).
set -u

SHARED=${HERDR_SHARED:-$HOME/git-repo/herdr-shared}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

if [ ! -d "$SHARED" ]; then
  printf 'check-vendor: %s not found; vendored copies not checked\n' "$SHARED"
  exit 0
fi

status=0
count=0
while read -r src dst; do
  [ -n "$src" ] || continue
  source_file="$SHARED/$src"
  vendored="$ROOT/$dst"
  count=$((count + 1))
  if [ ! -f "$source_file" ]; then
    printf 'check-vendor: missing source %s\n' "$source_file" >&2
    status=1
    continue
  fi
  if [ ! -f "$vendored" ]; then
    printf 'check-vendor: missing vendored copy %s\n' "$dst" >&2
    status=1
    continue
  fi
  if ! cmp -s "$source_file" "$vendored"; then
    printf 'check-vendor: %s differs from herdr-shared %s\n' "$dst" "$src" >&2
    status=1
  fi
  source_exec=0
  vendored_exec=0
  [ -x "$source_file" ] && source_exec=1
  [ -x "$vendored" ] && vendored_exec=1
  if [ "$source_exec" -ne "$vendored_exec" ]; then
    printf 'check-vendor: %s exec bit differs from herdr-shared %s\n' "$dst" "$src" >&2
    status=1
  fi
done <<'EOF'
bin/cca mods/claude-accounts/cca
bin/usage-tap.sh mods/claude-accounts/usage-tap.sh
bin/usage-api.mjs mods/claude-accounts/usage-api.mjs
bin/codex-usage.mjs mods/claude-accounts/codex-usage.mjs
bin/models.mjs mods/claude-accounts/models.mjs
bin/scan.sh mods/pulse/scan.sh
EOF

if [ "$status" -eq 0 ]; then
  printf 'check-vendor: %d vendored files match herdr-shared\n' "$count"
fi
exit "$status"
