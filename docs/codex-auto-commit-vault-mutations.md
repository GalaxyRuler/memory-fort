# Codex Implementation Brief — Auto-Commit Vault Mutations (Phase 4.3.R)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The full-system checkup (2026-05-28) found the hosted dashboard was serving a **stale vault**: 4 threads on the VPS vs 14 locally. Root cause traced to a single bug:

**Vault-mutating CLI operations move files in the working tree but never commit them.** `memory thread promote` (and `reject`, and presumably `procedure promote/reject`, `entity merge/reject`) relocate a markdown file from `wiki/<kind>-proposed/` to `wiki/<kind>/` (or remove it) **without a git commit**. The 10 threads promoted during the session were all `??` untracked in the vault git. Since auto-push only pushes *commits*, the promotions never reached the VPS bare repo — and the dashboard (which checks out that repo via a working `post-receive` hook) stayed at the last-committed state.

Contrast: the **capture** path DOES commit (the vault git log shows `chore: auto-capture N raw observation file(s)`). So capture syncs, but operator review-gate actions don't. The sync infrastructure (bare repo + post-receive checkout + auto-push) is sound — it just never sees the promotion changes.

This was confirmed by manually committing + pushing the 10 promotions: the VPS vault jumped to 14 threads and `/api/health` flipped from 503 to 200.

### Why this matters beyond the one-time fix

The whole Phase 4.3.J/4.4 "out of the loop" automation writes vault files:
- `memory thread/procedure promote` — review-gate promotions
- `memory entity merge` (Phase 4.3.N) — relation rewrites + alias map
- auto-promote scheduler (Phase 4.3.J) — high-confidence auto-promotions
- compile-execute (Phase 4.4, queued) — created/appended wiki pages

**None of these sync unless they commit.** Without this fix, every automated or manual vault mutation is invisible to the dashboard and to any other client syncing from the bare repo. The automation is only useful if its output actually propagates.

---

## Scope guard

You will:

### Task 1 — Shared commit helper

- Add a `commitVaultChange(opts: { paths: string[]; message: string; memoryRoot?: string })` helper (likely in `src/sync/` alongside the auto-push code, or `src/storage/`):
  - `git add` the specified paths, then `git commit` with the message, in the vault repo (`~/.memory` or `MEMORY_ROOT`)
  - Author: the vault's existing capture commits use a consistent identity — reuse it (find how `chore: auto-capture` commits set author; match it)
  - No-op safely if there's nothing to commit (e.g., the file was already committed) — check `git status --porcelain` for the paths first
  - Must not fail the parent operation if the commit fails — log to `~/.memory/errors.log` and return a result flag, mirroring the auto-push error-tolerance pattern. A failed commit should not lose the file move
  - Use the same git invocation approach the existing sync code uses (don't introduce a new git library)

### Task 2 — Wire it into every vault-mutating operation

- `src/cli/commands/thread.ts` — `promote` and `reject` call `commitVaultChange` after the file move:
  - promote → `commit: "promote thread: <slug>"` (paths: the moved file's old + new location)
  - reject → `commit: "reject thread: <slug>"`
- `src/cli/commands/procedure.ts` — same for procedure promote/reject
- `src/cli/commands/entity.ts` (Phase 4.3.N) — `merge` commits the rewritten relation files + the alias map (`commit: "merge entity: <canonical> <- <aliases>"`); `reject` commits the dropped proposal
- Phase 4.3.J auto-promote scheduler — when it auto-promotes, it commits (reuse the same helper the CLI promote uses, so there's one code path)
- The propose `--apply` writers (thread/procedure) that write drafts into `*-proposed/` — these should ALSO commit, so proposed drafts sync to the dashboard inbox on other clients. `commit: "propose N thread drafts for review"`
- After the mutating commit, the existing auto-push schedule picks it up — do NOT add a separate push per operation; let the debounced auto-push handle propagation (avoid push-per-keystroke)

### Task 3 — Backfill guard / sweep (safety net)

- Add a verify check `sync.uncommitted-vault` that reports when the vault working tree has uncommitted changes older than ~10 minutes (i.e., a mutation that should have committed but didn't):
  - `pass` when the working tree is clean or changes are very recent (mid-operation)
  - `warn` when there are uncommitted changes older than 10 min (something bypassed the commit helper)
- This catches any mutation path that forgets to commit, so the staleness bug can't silently return. It's the canary for "a write didn't sync"

### Task 4 — Docs

- `templates/schema.md`: document that all vault mutations commit (so they sync), and the capture/promote/merge commit message conventions
- `docs/ROADMAP.md`: Phase 4.3.R shipped 2026-05-28 — fixes the dashboard-staleness root cause

You will **not**:

- Push per operation. Commit per operation; let the debounced auto-push (Phase 4.3.L worker) propagate. Pushing on every promote would hammer the remote
- Change the bare-repo / post-receive / auto-push infrastructure. It works correctly; the gap was purely the missing commits
- Auto-commit unrelated dirty state (e.g., a half-edited config.yaml). `commitVaultChange` commits ONLY the explicit paths passed by the operation, never `git add -A`
- Block the operation on commit failure. The file move/rewrite is the primary effect; the commit is best-effort-with-logging (but the sweep check in Task 3 surfaces failures)
- Introduce a git library dependency. Use the same child-process git approach the existing sync code uses
- Commit secrets. The vault shouldn't contain secrets (Phase 4.3.M), but `commitVaultChange` commits only the operation's specific markdown paths regardless

If wiring auto-commit into the auto-promote scheduler reveals that the scheduler runs in the dashboard process on the VPS (writing to the VPS working tree, not the local vault), **stop and ask** — there's a subtlety about which vault the scheduler mutates and whether the VPS working tree commits back to its own bare repo. The local-CLI paths (promote/merge from the operator's machine) are the primary fix; the VPS-scheduler path may need separate handling.

---

## Repo orientation

- `src/sync/auto-push.ts` + `auto-push-worker.ts` (Phase 4.3.L) — existing commit/push machinery; the capture-commit identity and git invocation pattern to reuse
- the capture path that writes `chore: auto-capture` commits — find it (likely `src/hooks/` or `src/sync/`) and reuse its commit approach
- `src/cli/commands/thread.ts`, `procedure.ts`, `entity.ts` — the mutating operations to wire
- `src/dashboard/auto-promote-scheduler.ts` (Phase 4.3.J) — the auto-promote path
- `src/cli/commands/verify/registry.ts` — register the new `sync.uncommitted-vault` check (remember to add it to `test/cli/commands/verify/registry.test.ts` EXPECTED_ROLES — this was missed in Phase 4.3.L)

---

## Acceptance contract

1. `memory thread promote <slug>` leaves the vault git working tree clean (the moved file is committed) with message `promote thread: <slug>`
2. Same for thread reject, procedure promote/reject, entity merge/reject, and propose `--apply`
3. The auto-promote scheduler commits its promotions
4. After any mutation, the existing auto-push syncs the commit to the VPS bare repo and the dashboard reflects it (no manual `git push` needed)
5. `commitVaultChange` is a no-op when there's nothing to commit and logs-without-throwing on failure
6. New verify check `sync.uncommitted-vault` warns on stale uncommitted changes; registered in both the registry AND `registry.test.ts`
7. Full test suite passes (run the FULL suite, including `registry.test.ts` — don't repeat the 4.3.L miss); `npm run typecheck` clean; build + build:ui clean; `git diff --check` clean

---

## Verification commands

```powershell
cd C:\CodexProjects\memory-system
# Promote a draft, confirm the vault is committed (not left ?? untracked)
node dist/cli.mjs thread promote <some-slug>
Push-Location $env:USERPROFILE\.memory; git status --porcelain wiki/threads/; Pop-Location
# Should be empty (committed). Then auto-push syncs it; dashboard reflects it.
node dist/cli.mjs verify --role=operator | Select-String "uncommitted-vault"
```

---

## Commit boundaries

- Task 1: `feat: commitVaultChange helper for syncing vault mutations (Phase 4.3.R Task 1)`
- Task 2: `feat: auto-commit thread/procedure/entity promote+reject+propose (Phase 4.3.R Task 2)`
- Task 3: `feat: sync.uncommitted-vault verify check (Phase 4.3.R Task 3)`
- Task 4: `docs: vault mutations auto-commit (Phase 4.3.R Task 4)`

---

## Sequencing

- **This should land before Phase 4.4** (compile-execute) and before the operator relies on the Phase 4.3.J auto-promote scheduler — otherwise their output won't sync to the dashboard
- Independent of 4.3.P / 4.3.Q (both shipped)

---

## Out-of-scope follow-ups

- The VPS-scheduler-writes-to-VPS-working-tree subtlety (if the auto-promote scheduler runs on the VPS, does it commit back to the VPS bare repo?) — flagged in the scope guard; may need a dedicated brief once the local-CLI commit path is solid
- `.audit/` log rotation
- `/api/health` readiness-vs-data-quality split (the 503-on-data-quality design issue — now dormant since nothing fails, but still latent)
