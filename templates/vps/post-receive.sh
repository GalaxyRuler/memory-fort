#!/usr/bin/env bash
# Installed by `memory sync-bootstrap`. Checks out pushed commits into <vault>.
# Atomic-enough: uses `git --work-tree=<vault> checkout -f` which is a single git operation.
# For dashboard reads, brief inconsistency during checkout is acceptable.

set -euo pipefail

INSTALL_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VAULT="${INSTALL_ROOT}/vault"
LOG_DIR="${INSTALL_ROOT}/logs"
LOG="${LOG_DIR}/checkout.log"

mkdir -p "$VAULT" "$LOG_DIR"

while read oldrev newrev refname; do
  branch="${refname#refs/heads/}"
  if [ "$branch" != "main" ]; then
    echo "[$(date -Iseconds)] skipping non-main branch: $branch" >> "$LOG"
    continue
  fi

  echo "[$(date -Iseconds)] checkout $newrev -> $VAULT (branch=$branch)" >> "$LOG"

  GIT_DIR="$INSTALL_ROOT/memory.git" \
  GIT_WORK_TREE="$VAULT" \
  git checkout -f "$newrev" 2>&1 | sed "s/^/[$(date -Iseconds)] /" >> "$LOG"

  echo "[$(date -Iseconds)] checkout complete: $newrev" >> "$LOG"
done
