# Codex Implementation Brief — Fix commitVaultChange on File Moves (Phase 4.3.S)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Phase 4.3.R added `commitVaultChange` and wired it into promote/reject/merge so vault mutations commit and sync. **Live verification (2026-05-28) shows it fails on exactly the case it was built for: promoting a draft.**

Reproduction: created a proposed thread draft, ran `memory thread promote <slug>`. The file moved from `wiki/threads-proposed/` to `wiki/threads/`, but the commit failed. errors.log:

```
[2026-05-28T23:16:24Z] commit-vault-change failed | promote thread: sync-test-throwaway |
  git add failed: fatal: pathspec 'wiki/threads-proposed/sync-test-throwaway.md' did not match any files
```

### Root cause

`src/sync/commit-vault-change.ts` runs `git add -- <paths>` (line ~38) where `paths` for a promote includes **both** the old (`threads-proposed/x.md`) and new (`threads/x.md`) locations. By the time the commit runs, promote has already moved the file:

- the **new** path exists on disk ✓
- the **old** path no longer exists in the working tree, and if the draft was never committed as a proposal it isn't in the index either → `git add -- <oldpath>` errors with `pathspec did not match any files`

`git add` with multiple pathspecs **fails entirely if any one pathspec matches nothing** — so the whole add aborts, no commit happens, and the file is left untracked. The promote's file move succeeds but never syncs. **The sync bug 4.3.R was meant to fix is still present.** (It now fails gracefully with a log line instead of silently doing nothing, but the outcome — untracked file, no sync — is the same.)

This affects every mutating op that moves a file: thread promote/reject, procedure promote/reject, entity merge (relation-rewrite is in-place so less affected, but reject moves/removes).

---

## Scope guard

You will:

### Task 1 — Make the staging resilient to moved/absent paths

- In `src/sync/commit-vault-change.ts`, before `git add`, **filter the path list** to those git can actually stage:
  - keep a path if it **exists on disk** (a created/modified file — the move destination), OR
  - keep a path if it is **tracked in the index** (`git ls-files --error-unmatch` succeeds, OR appears in `git status --porcelain`) — this covers a tracked-then-deleted source so its deletion gets staged
  - drop a path that is **neither** on disk nor tracked (the untracked-then-moved-away source — nothing for git to do)
- Stage the filtered set with `git add -A -- <filtered>` so deletions of tracked sources are staged alongside additions of new destinations. `-A` ensures a moved tracked file's deletion is recorded
- If the filtered set is empty, return `no-changes` (don't attempt a commit)
- Preserve the existing best-effort contract: any git failure logs to `~/.memory/errors.log` and returns a failure result without throwing — the file move must never be lost

### Task 2 — Regression tests (the case that was missed)

- Add to `test/sync/commit-vault-change.test.ts`:
  - **The exact failing case**: an untracked file at `old/path` is moved to `new/path` (old deleted from disk, never tracked), then `commitVaultChange({ paths: [oldPath, newPath] })` — assert it commits `newPath` cleanly, does NOT error on the absent `oldPath`, and leaves a clean working tree for those paths
  - **Tracked-source move**: a committed file moved to a new path — assert the commit stages both the deletion of the old and the addition of the new
  - **Nothing to commit**: all paths absent/untracked → `no-changes`, no commit
- Add an integration assertion in `test/cli/commands/thread.test.ts` (or wherever promote is tested): after `runThreadPromote`, the vault working tree is clean for the promoted file (it was committed). Use a temp git repo fixture. **This is the assertion whose absence let the bug ship** — make it explicit

### Task 3 — Re-verify the whole mutation matrix

- Confirm (via tests) that thread promote, thread reject, procedure promote, procedure reject, and entity merge all leave a clean committed working tree after the operation. Each moves or removes files; each must commit successfully

### Task 4 — Docs

- `docs/ROADMAP.md`: Phase 4.3.S shipped 2026-05-28 — fixes commitVaultChange on file moves (4.3.R follow-up)
- No schema change needed

You will **not**:

- Change the promote/reject/merge call sites' path arguments. They correctly pass [oldPath, newPath]; the fix is in `commitVaultChange` handling that input robustly
- Push per operation. Commit only; auto-push propagates (unchanged from 4.3.R)
- Throw on git failure. Best-effort + log, as 4.3.R established
- Use `git mv`. The operations already move files on disk via fs; `commitVaultChange` just needs to stage the result correctly
- Stage paths outside the explicitly-passed set (no `git add -A` without a `-- <paths>` pathspec restriction — never stage the whole tree)

If filtering reveals that a promote sometimes passes ONLY an untracked source and a destination that's somehow also absent (shouldn't happen, but defensively), `no-changes` is the correct safe result — **stop and ask** if you find a call site passing paths that don't reflect the actual on-disk move.

---

## Repo orientation

- `src/sync/commit-vault-change.ts` — the fix target. `uniqueNormalizedPaths` (line ~64) normalizes paths; add the existence/tracked filter after it, before `git add`
- `src/cli/commands/thread.ts` / `procedure.ts` / `entity.ts` — call sites passing [oldPath, newPath]; unchanged
- `test/sync/commit-vault-change.test.ts` — extend with the move cases
- `test/cli/commands/thread.test.ts` — add the post-promote-clean-tree assertion

---

## Acceptance contract

1. `memory thread promote <slug>` on a draft (tracked OR untracked proposal) leaves the vault working tree clean for that file — it is committed
2. Same for thread reject, procedure promote/reject, entity merge
3. `commitVaultChange` no longer errors when a passed path is an absent/untracked moved-away source; it stages what git can act on and commits
4. Regression tests cover the untracked-source-move case and the tracked-source-move case
5. The post-promote clean-tree assertion exists in the thread test
6. Full suite passes (run ALL of it); `npm run typecheck` clean; build + build:ui clean; `git diff --check` clean

---

## Verification commands

```powershell
cd C:\CodexProjects\memory-system
# Create a throwaway proposed draft and promote it
"---`ntype: threads`ntitle: Tmp`ncognitive_type: episodic`nsource: auto-thread-propose`nlifecycle: proposed`nstatus: active`ncreated: 2026-05-28`nupdated: 2026-05-28`ntags: [thread-draft]`nrelations:`n  mentions: []`n---`n# Tmp" | Set-Content "$env:USERPROFILE\.memory\wiki\threads-proposed\tmp-move-test.md"
node dist/cli.mjs thread promote tmp-move-test
Push-Location "$env:USERPROFILE\.memory"; git status --porcelain wiki/threads/tmp-move-test.md; git log --oneline -1; Pop-Location
# status line should be EMPTY (committed); log should show "promote thread: tmp-move-test"
node dist/cli.mjs thread reject tmp-move-test  # clean up (also exercises reject-commit)
```

---

## Commit boundaries

- Task 1: `fix: commitVaultChange stages moved/absent paths without aborting (Phase 4.3.S Task 1)`
- Task 2-3: `test: vault auto-commit covers file moves across all mutations (Phase 4.3.S Task 2)`
- Task 4: `docs: commitVaultChange move fix (Phase 4.3.S Task 4)`

---

## Context: why this matters now

This blocks the value of 4.3.J auto-promote and 4.4 compile-execute — both produce vault mutations that must sync. Until commitVaultChange handles moves, those features write files that stay untracked and never reach the dashboard. **Land this before relying on either.** The operator is currently kept in sync only by manual `git push` from the session.
