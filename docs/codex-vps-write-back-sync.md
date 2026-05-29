# Codex Implementation Brief — VPS Dashboard Write-Back Sync (Phase 4.14)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Architectural — read fully. This brief has a **decision point** the operator must confirm before implementation.

---

## What this is

Live diagnosis (2026-05-29): the dashboard "Run compile now → execute" worked (parsed `compile-ops`, produced `opsApplied: 3, opsStaged: 1`) — but the writes are **stranded on the VPS**:

- The bare repo (`/root/memory-system/memory.git`) HEAD does **not** contain the compile's page writes.
- The VPS vault (`/root/memory-system/vault`) is a **detached checkout**: the post-receive hook runs `git --work-tree=<vault> checkout -f`, so the vault directory has **no `.git`**.
- `commitVaultChange` runs `git add/commit` from inside the vault → **fails (no repo)** → best-effort logs and continues → the write lands on disk but is **never committed, never pushed to the bare repo, never synced to the operator's local vault**, and is **overwritten by the next `checkout -f`** (next time local pushes).

**This affects every VPS-side write**, not just compile: the Phase 4.3.J auto-promote scheduler and the dashboard inbox promote/reject (Phase 4.3.J) all write through the hosted dashboard and strand the same way. The operator's canonical vault is **local**; the hosted dashboard is a read-only checkout of it. Today its write-actions silently don't persist.

---

## The decision point (operator must choose)

The current sync model is **single-writer**: local is the sole author; the VPS is a read-only checkout (push-one-way). That avoids merge conflicts. Making the dashboard write back changes this. Two viable directions — **confirm which before implementing**:

**Option A — Make VPS writes commit to the bare repo (bidirectional sync).**
The VPS-side `commitVaultChange` targets the bare repo directly (`git --git-dir=<bare> --work-tree=<vault> add/commit`), and the dashboard pushes nothing extra — the bare repo IS the shared point. The operator's local `memory sync` (pull-rebase) then picks up VPS-authored commits. Enables the "click the button on the hosted dashboard and it reaches my vault" vision. Cost: dual-writer — local and VPS both author commits on `main`; the existing conflict handling (`.sync-state.json`, pull-rebase) must cover VPS-authored history, and a local push that diverged needs a rebase. Append-mostly operations (compile append, promote moves) make real conflicts rare but not impossible.

**Option B — Keep single-writer; make the dashboard's write-actions honest.**
The hosted dashboard does NOT write canonical memory. Its compile/promote/reject actions either (a) are disabled with a clear "run this from the local CLI — the hosted dashboard is read-only" message, or (b) **delegate**: stage the request and have the operator's local machine pick it up and execute (a small queue the local `memory` polls). Simpler sync (no dual-writer) but the button doesn't directly mutate from the hosted UI.

**Recommendation:** **Option A**, scoped carefully — it's what the operator asked for ("click run compile and it actually runs"), and the conflict surface is small for append-mostly writes. But **stop and ask** before building if the dual-writer risk isn't acceptable; Option B (honest read-only dashboard + local CLI for writes) is the safe fallback.

This brief specifies **Option A**. If the operator picks B, a different brief applies.

---

## Scope guard (Option A)

You will:

### Task 1 — VPS-side commit targets the bare repo

- Make `commitVaultChange` (and any VPS-side writer) commit against the bare repo when the vault is a detached checkout. Detect: if `<vault>/.git` is absent but a sibling bare repo + `MEMORY_INSTALL_ROOT` is configured, commit via `git --git-dir=<install_root>/memory.git --work-tree=<vault> add -- <paths>` then `... commit -m <msg>`, updating the bare repo's `main`.
- After committing, the dashboard does not need to push (the bare repo is the remote). But the **checkout must be refreshed** so the working vault matches the new HEAD — re-run the post-receive-style `checkout -f` (or have the commit path update the work-tree consistently). Avoid the next external push clobbering a just-committed VPS change: since the change is now a commit on `main`, `checkout -f` after a local push (which rebases on top) preserves it.
- Local (non-detached) behavior is unchanged — `commitVaultChange` still does in-repo `git add/commit` when `.git` exists.
- Best-effort + log on failure stays (Phase 4.3.R/S contract).

### Task 2 — Local sync pulls VPS-authored commits

- Confirm `memory sync` / the auto-push worker pull-rebases so VPS-authored commits on the bare repo land in the local vault. Test the round trip: a VPS-side write → commit on bare → local `memory pull` brings it in.
- Handle divergence: if both local and VPS committed since last sync, pull-rebase replays local on top of VPS (or surfaces a conflict via `.sync-state.json` as today). Add a test for the dual-writer rebase path.

### Task 3 — Verify check for stranded writes

- Add/extend a verify check (e.g. `sync.vps-writeback`) that detects VPS-side uncommitted vault changes (the symptom of this bug): on the server role, if the vault working tree has changes not reflected in the bare repo HEAD, warn. This is the canary that would have caught the silent strand.

### Task 4 — Docs

- `docs/MEMORY-FORT-SPEC.md` §6 (sync) + §17: document the write-back model — VPS-side writes commit to the bare repo; local pulls; the dual-writer reconciliation. Update the topology diagram.
- `docs/sync-workflow.md`: add the write-back direction.
- `docs/ROADMAP.md`: Phase 4.14 shipped.

You will **not**:

- Make the VPS a full second clone with its own remote (keep the bare repo as the single shared point).
- Auto-resolve genuine merge conflicts — surface them (existing conflict mechanism).
- Change the dashboard's same-origin / confirm-dialog gates (Phase 4.13).
- Remove the inbox review gate for low-confidence ops.
- Implement Option B in this brief (separate decision).

If reconciling dual-writer history proves to need real merge logic (not just rebase) for non-append operations, **stop and ask** — we may constrain VPS-side writes to append-only/additive operations (compile append, new proposals) and route destructive ones (reject, merge) to the local CLI only.

---

## Repo orientation

- `src/sync/commit-vault-change.ts` — the commit path; add the bare-repo-target branch.
- `src/sync/auto-push-worker.ts` + `memory sync`/`pull` — the pull-rebase that must pick up VPS commits.
- `/root/memory-system/memory.git/hooks/post-receive` (generated by `src/cli/commands/install-vps.ts`) — the `checkout -f`; ensure consistency with VPS-authored commits.
- `src/cli/commands/verify/` — the new `sync.vps-writeback` check (register in registry + registry.test.ts).
- `src/dashboard/auto-promote-scheduler.ts`, `src/dashboard/proposed.ts`, `src/compile/execute.ts` — the VPS-side writers that currently strand.

---

## Acceptance contract

1. A dashboard write-action (compile execute / inbox promote) on the VPS results in a **commit on the bare repo `main`**, and a subsequent local `memory pull` brings that change into the local vault.
2. The VPS working vault matches the bare repo HEAD after a write (no stranded on-disk-only changes).
3. A local push that diverged from VPS commits rebases cleanly (or surfaces a conflict via `.sync-state.json`); covered by a test.
4. `sync.vps-writeback` warns on stranded VPS changes.
5. Full suite + typecheck green; build + build:ui clean; `git diff --check` clean.

---

## Immediate operator workaround (until this lands)

Run consolidation **locally**, where the vault is a real git repo that commits + pushes forward to the VPS:

```powershell
cd C:\CodexProjects\memory-system
node dist/cli.mjs compile --execute            # consolidates ~101 obs, commits, auto-pushes to VPS
# repeat to work through the backlog; low-confidence drafts land in wiki/compile-proposed/ for review
```

The hosted dashboard "Run compile now" button should be treated as **not yet persistence-safe** until Phase 4.14 (Option A) lands or the operator chooses Option B.

---

## Commit boundaries

- Task 1: `feat: VPS-side vault commits target the bare repo (Phase 4.14 Task 1)`
- Task 2: `feat: local sync pulls VPS-authored commits + dual-writer rebase (Phase 4.14 Task 2)`
- Task 3: `feat: sync.vps-writeback verify check (Phase 4.14 Task 3)`
- Task 4: `docs: VPS write-back sync model (Phase 4.14 Task 4)`
