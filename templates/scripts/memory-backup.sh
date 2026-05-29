#!/usr/bin/env bash
# memory-backup.sh - local tarball backup of /root/memory-system/{memory.git,vault,services,env,install-info.json}
# Rotates: keeps the last 30 daily archives.
set -euo pipefail

INSTALL_ROOT="/root/memory-system"
BACKUP_DIR="${INSTALL_ROOT}/backups"
LOG_DIR="${INSTALL_ROOT}/logs"
LOG_FILE="${LOG_DIR}/backup.log"
TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"
ARCHIVE="${BACKUP_DIR}/memory_${TIMESTAMP}.tar.gz"
TMP_ARCHIVE="${ARCHIVE}.tmp"

mkdir -p "$BACKUP_DIR" "$LOG_DIR"

log() {
  echo "[$(date -Iseconds)] $*"
}

fail() {
  log "backup failed: $*" | tee -a "$LOG_FILE" >&2
  rm -f "$TMP_ARCHIVE"
  exit 1
}

verify_archive() {
  local archive="$1"
  [[ -f "$archive" ]] || fail "archive not found: $archive"
  [[ -s "$archive" ]] || fail "archive is empty: $archive"
  tar -tzf "$archive" >/dev/null 2>>"$LOG_FILE" || fail "archive is not listable: $archive"
}

if [[ "${1:-}" == "--verify" ]]; then
  [[ -n "${2:-}" ]] || fail "usage: memory-backup.sh --verify <archive>"
  verify_archive "$2"
  log "backup verify ok: $2"
  exit 0
fi

# Archive the durable parts. Skip logs/ (rebuildable) and backups/ itself (would self-reference).
if ! tar -czf "$TMP_ARCHIVE" \
  -C "$INSTALL_ROOT" \
  memory.git vault services env install-info.json 2>>"$LOG_FILE"; then
  fail "tar exited non-zero"
fi

verify_archive "$TMP_ARCHIVE"
mv "$TMP_ARCHIVE" "$ARCHIVE"

# Rotate only after the new archive has been verified and moved into place.
ls -t "${BACKUP_DIR}/memory_"*.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm -f

log "backup complete: ${ARCHIVE} ($(stat -c%s "$ARCHIVE") bytes)"
