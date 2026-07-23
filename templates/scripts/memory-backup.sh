#!/usr/bin/env bash
# memory-backup.sh - verified Memory Fort backup to a separately mounted target.
# The backup CLI owns archive creation, hashing, extraction verification, and restore drills.
set -euo pipefail

INSTALL_ROOT="${MEMORY_INSTALL_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${MEMORY_BACKUP_DIR:-}"
NODE_BIN="${MEMORY_NODE_PATH:-node}"
CLI_PATH="${INSTALL_ROOT}/dist/cli.mjs"
LOG_DIR="${INSTALL_ROOT}/logs"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -Iseconds)] $*"
}

fail() {
  log "backup failed: $*" >&2
  exit 1
}

[[ -f "$CLI_PATH" ]] || fail "Memory Fort CLI not found: $CLI_PATH"
command -v "$NODE_BIN" >/dev/null 2>&1 || fail "Node executable not found: $NODE_BIN"

if [[ "${1:-}" == "--verify" ]]; then
  [[ -n "${2:-}" ]] || fail "usage: memory-backup.sh --verify <archive>"
  "$NODE_BIN" "$CLI_PATH" backup verify "$2"
  exit 0
fi

if [[ "${1:-}" == "--drill" ]]; then
  [[ -n "${2:-}" ]] || fail "usage: memory-backup.sh --drill <archive>"
  "$NODE_BIN" "$CLI_PATH" backup drill "$2"
  exit 0
fi

[[ $# -eq 0 ]] || fail "usage: memory-backup.sh [--verify <archive> | --drill <archive>]"
[[ -n "$BACKUP_DIR" ]] || fail "MEMORY_BACKUP_DIR must name a pre-mounted backup target outside $INSTALL_ROOT"
[[ -d "$BACKUP_DIR" ]] || fail "backup target is not mounted or is not a directory: $BACKUP_DIR"
[[ -d "${INSTALL_ROOT}/vault" ]] || fail "vault directory not found: ${INSTALL_ROOT}/vault"
[[ -d "${INSTALL_ROOT}/memory.git" ]] || fail "bare repository not found: ${INSTALL_ROOT}/memory.git"

install_real="$(realpath -e "$INSTALL_ROOT")"
backup_real="$(realpath -e "$BACKUP_DIR")"
case "${backup_real}/" in
  "${install_real}/"*) fail "backup target must be outside the Memory Fort install root" ;;
esac

source_device="$(stat -c '%d' "$INSTALL_ROOT")"
target_device="$(stat -c '%d' "$BACKUP_DIR")"
[[ "$source_device" != "$target_device" ]] || fail \
  "backup target is on the same filesystem device as the source; mount separate backup storage at MEMORY_BACKUP_DIR"

if ! "$NODE_BIN" "$CLI_PATH" backup create \
  --vault "${INSTALL_ROOT}/vault" \
  --repository "${INSTALL_ROOT}/memory.git" \
  --target "$BACKUP_DIR"; then
  fail "verified backup creation failed"
fi

# Rotate only after the new archive has been verified and moved into place.
mapfile -t expired_archives < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'memory-fort-*.tar.gz' -printf '%T@ %p\n' \
    | sort -rn \
    | tail -n +31 \
    | cut -d' ' -f2-
)
for archive in "${expired_archives[@]}"; do
  rm -f -- "$archive"
done

log "backup complete; retained the newest 30 verified archives in $BACKUP_DIR"
