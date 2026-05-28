# Codex Implementation Brief — Windows-Safe atomicWrite (Phase 4.3.L)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Live-vault errors log shows recurring `EPERM` failures from the auto-push scheduler:

```
2026-05-27T15:59:23.970Z auto-push schedule failed:
  EPERM: operation not permitted,
  rename 'C:\Users\Admin\.memory\.auto-push-pending.tmp'
       -> 'C:\Users\Admin\.memory\.auto-push-pending'
```

Root cause is a Windows read/rename race in `src/storage/atomic-write.ts`. The write side is already serialized correctly — `writePendingFile()` in `src/sync/auto-push.ts` holds a `.lock` file via `openSync(path, "wx")` to prevent concurrent writers. But **readers race with the rename**: a reader who has `.auto-push-pending` open via `readFile()` blocks the writer's `rename(tmp, canonical)` because Node's default share mode on Windows excludes `FILE_SHARE_DELETE`.

On a machine with one or two MCP server processes the race is theoretical. With ~30 concurrent node processes (operator currently runs Claude Code, Codex, Antigravity, the dashboard, the MCP server instances, etc., each holding the memory-system code in-process and periodically reading `.auto-push-pending`), the race becomes a routine occurrence.

The error is non-fatal — the failed write returns "busy" and the next session's auto-push attempt succeeds — but it pollutes `~/.memory/errors.log` and keeps the dashboard's `error 1d ago` pill red even when the system is otherwise healthy.

Fix: add rename-retry-with-backoff inside `atomicWrite()`. EPERM almost always clears within a few hundred milliseconds because the reader closes the file. Three retries at 50 / 150 / 400 ms backoff resolve the race silently for the common case; if all retries fail, the error propagates as today.

The fix is local to one primitive and benefits every caller — auto-push, audit log, config writes, debug log, proposed-draft writes from Phase 4.3.J. Not just auto-push.

---

## Scope guard

You will:

### Task 1 — Retry-with-backoff in `atomicWrite`

- Modify `src/storage/atomic-write.ts`:
  - Replace the single `await rename(tmp, absolutePath)` call with a retry loop
  - Retry on Windows-specific errno codes: `EPERM`, `EACCES`, `EBUSY` (all three can manifest from the same race). Also retry `ENOENT` — Windows can briefly report ENOENT during a rename if a sync just closed the handle
  - Backoff schedule: 50 ms, 150 ms, 400 ms (three retries, ~600 ms total worst case)
  - On retry exhaustion, throw the original error (existing behavior preserved for genuine permission issues)
  - Retry behavior is platform-conditional: on POSIX, no retry (rename is atomic on POSIX, retrying would mask real bugs). Detect via `process.platform === "win32"`
  - The whole function stays exported with the same signature

- Add export `atomicWriteWithRetry` as the new entry — leave the old `atomicWrite` as a 1-line alias for back-compat. Or just embed the retry inside `atomicWrite` directly and document the change. Pick whichever feels cleaner; the rest of the codebase already calls `atomicWrite`

### Task 2 — Telemetry counter

- When a retry succeeds, increment a process-local counter exported from `atomic-write.ts` (e.g. `atomicWriteRetryStats.success`). When all retries fail, increment `atomicWriteRetryStats.exhausted`
- Surface in `memory verify` under a new check `storage.atomic-write-retries`:
  - `pass` when retry rate is < 1% of total writes (calculated from the counter)
  - `warn` when rate is 1–10%
  - `fail` when rate is ≥ 10% (signals a deeper Windows issue — maybe Defender, OneDrive sync, or a stuck file handle)
  - Counter resets per CLI invocation; for the dashboard, expose via `/api/health` only

### Task 3 — Tests

- Add `test/storage/atomic-write.test.ts`:
  - Mock `fs.rename` to throw `EPERM` once, then succeed → atomicWrite resolves cleanly, retry counter incremented
  - Mock to throw `EPERM` always → atomicWrite throws after three retries, exhaustion counter incremented
  - Mock to throw `EISDIR` (not a race error) → atomicWrite throws immediately without retry
  - On a stub `process.platform = "linux"`, throw `EPERM` once → atomicWrite throws immediately (no retry on POSIX)
- Existing tests that use `atomicWrite` continue passing unchanged

### Task 4 — Docs

- `templates/schema.md`: brief note under the storage section about Windows-safe atomic writes and the retry policy
- `docs/ROADMAP.md`: Phase 4.3.L shipped 2026-05-28 — a small operational-hygiene fix outside the 4.3.A-K feature arc

You will **not**:

- Change the read-side share mode. There's no portable way in Node to open files with `FILE_SHARE_DELETE` without `fs/native` — the retry approach handles the race adequately
- Add a global file-system mutex. Cross-process coordination via `.lock` files already covers the write side; adding more lock state would be over-engineered for this race
- Replace the rename-based atomic write with copy-and-delete. Rename IS the right primitive; we're just hardening it against transient races
- Touch the auto-push scheduler logic. The fix lives one level down at the storage primitive
- Investigate why there are 30+ node processes on the operator's machine. That's an operator-environment question, not a code-fix question
- Change error log format. Errors that exhaust retries still hit `~/.memory/errors.log` with the same shape
- Add a CLI flag to disable retry. Always-on, always-three-retries

If the retry adds measurable latency to small writes (it shouldn't — 99% of writes succeed on the first attempt and pay zero retry cost), **stop and ask** before introducing async batching or write-coalescing. The baseline expectation is invisible retry cost.

---

## Repo orientation

- `src/storage/atomic-write.ts` — the primitive being hardened. Currently 38 lines, will grow by ~30 with the retry loop and counter
- `src/sync/auto-push.ts` — the most active caller. Will benefit automatically without code changes there
- `src/llm/audit.ts` (Phase 4.3.B + 4.3.H) — also uses `atomicWrite` / `atomicAppend` for the audit log. Benefits automatically
- `src/cli/commands/{thread,procedure}.ts` — propose orchestrators write drafts via `atomicWrite`. Benefits automatically
- `src/dashboard/config-patch.ts` (Phase 4.3.C) — PATCH /api/config uses `atomicWrite`. Benefits automatically
- `src/cli/commands/verify/registry.ts` — where the new `storage.atomic-write-retries` check is registered

---

## Acceptance contract

1. `atomicWrite` retries transient `EPERM` / `EACCES` / `EBUSY` / `ENOENT` errors up to three times with 50 / 150 / 400 ms backoff on Windows. POSIX skips retry
2. After retry success, internal counter `atomicWriteRetryStats.success` increments. After retry exhaustion, `atomicWriteRetryStats.exhausted` increments and the error propagates
3. `memory verify` reports `storage.atomic-write-retries` with pass/warn/fail bands tied to retry rate
4. Existing tests pass. New tests cover the four scenarios in Task 3
5. `~/.memory/errors.log` no longer accumulates EPERM rows on a typical workday (operator-verified by observation over 24-48h — not in the test suite)
6. `npm run build` and `npm run build:ui` pass; `git diff --check` clean

---

## Verification commands

Operator runs after the brief lands:

```powershell
cd C:\CodexProjects\memory-system

# 1. Confirm the verify check exists
node dist/cli.mjs verify --role=operator | Select-String "atomic-write-retries"

# 2. Stress-test: trigger many concurrent reads while writing
# (Open multiple Claude/Codex sessions, run normal work for 1h)
# Check errors.log for EPERM rows
Get-Content "$env:USERPROFILE\.memory\errors.log" | Select-String "EPERM" | Measure-Object | % Count
# Should be zero or near-zero after the fix

# 3. Sidebar pill on the dashboard should auto-heal to green within 24h of the last EPERM
```

---

## Commit boundaries

Suggested chunking (4 commits):

- Task 1: `feat: windows-safe atomicWrite with rename retry (Phase 4.3.L Task 1)`
- Task 2: `feat: storage.atomic-write-retries verify check (Phase 4.3.L Task 2)`
- Task 3: `test: atomicWrite retry coverage (Phase 4.3.L Task 3)`
- Task 4: `docs: atomic-write retry policy (Phase 4.3.L Task 4)`

---

## Out-of-scope follow-ups

Tracked separately, do not bundle:

- Killing zombie node processes is an operator-side cleanup. If the operator wants to script it, that's a separate small CLI tool, not part of this brief
- Migrating to a real file-system-level lock library (e.g., `proper-lockfile`) for the lock file itself. The current `openSync(..., "wx")` pattern works; only revisit if cross-platform robustness becomes a real issue
- Replacing the file-based pending-state with an in-memory mailbox / IPC channel. That's an architectural change; this brief is the small surgical fix
