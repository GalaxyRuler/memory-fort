#!/usr/bin/env bash
# memory-backup.sh - local tarball backup of /root/memory-system/{memory.git,vault,services,env,install-info.json}
# Rotates: keeps the last 30 daily archives.
set -euo pipefail

INSTALL_ROOT="/root/memory-system"
BACKUP_DIR="${INSTALL_ROOT}/backups"
TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"
ARCHIVE="${BACKUP_DIR}/memory_${TIMESTAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

# Archive the durable parts. Skip logs/ (rebuildable) and backups/ itself (would self-reference).
tar -czf "$ARCHIVE" \
  -C "$INSTALL_ROOT" \
  memory.git vault services env install-info.json 2>/dev/null || true

# Rotate: keep last 30 archives, delete the rest.
ls -t "${BACKUP_DIR}/memory_"*.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm -f

echo "[$(date -Iseconds)] backup complete: ${ARCHIVE} ($(stat -c%s "$ARCHIVE" 2>/dev/null || echo 0) bytes)"
