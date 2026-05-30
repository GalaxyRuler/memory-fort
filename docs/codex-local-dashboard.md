# Codex Implementation Brief — Local Dashboard (writes persist; VPS read-only) (Phase 4.15)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The operator's canonical vault is **local** (`~/.memory`) because capture (Claude Code / Codex / Antigravity hooks + the MCP server) runs locally and must write instantly and offline. The **hosted VPS dashboard is a one-way read mirror** (detached `git --work-tree checkout -f`, no `.git`), so its write-actions strand: `commitVaultChange` can't commit, nothing syncs back, the change is overwritten on the next checkout. (Diagnosed live 2026-05-29: a dashboard compile-execute wrote pages that never reached the bare repo or local vault.)

**Decision (operator, 2026-05-29): go local.** Run the dashboard on the operator's machine against the real local vault, where writes commit (local `.git`) and the existing auto-push syncs them forward to the VPS bare repo (which the hosted read-view then reflects). The hosted VPS dashboard becomes explicitly **read-only for writes** — its write buttons disable with a clear notice — so it can never strand a write again.

This brief: (1) add a `memory dashboard` command to serve the dashboard locally, and (2) gate write-actions on whether the serving instance can actually persist (committable git vault), disabling them on the read-only mirror.

---

## Scope guard

You will:

### Task 1 — `memory dashboard` command

- Add `memory dashboard [--port <n>] [--host <h>] [--no-open]` in `src/cli.ts` + `src/cli/commands/`.
- It starts the dashboard HTTP server against the **local vault** (`MEMORY_ROOT` or `~/.memory`), reusing the existing `createServer` from `src/dashboard/server.ts` — do NOT fork a second server implementation.
- Bind `127.0.0.1` by default (`--host` to override); default port 4410, and if it's in use, either fail with a clear message or pick the next free port and report it.
- Serve the built SPA from `dist/dashboard-ui`; if that's missing, error with "run `npm run build:ui` first".
- Pick up env keys from the local shell (`VOYAGE_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_HOST`) — so local search + `compile --execute` work using the operator's keys.
- Print the URL (`http://127.0.0.1:<port>/memory/`); open the browser unless `--no-open`.
- Clean shutdown on Ctrl+C / SIGINT.

### Task 2 — Gate write-actions on "can this instance persist?"

- The dashboard must determine whether its vault is a **committable git working tree** — i.e. `<vault>/.git` exists (local) vs a detached checkout (VPS, no `.git`). Expose this as a capability: extend `GET /api/status` (or add `GET /api/capabilities`) to return `{ writable: boolean, reason?: string }`.
  - `writable: true` when the vault has its own `.git` and commits succeed (local).
  - `writable: false` with `reason: "read-only mirror — run \`memory dashboard\` on your machine to make changes"` when it's a detached checkout (VPS).
- The UI reads this capability and, when `writable: false`:
  - **Disables** the write-actions: compile **execute** ("Run compile now"), inbox **promote/reject**, and settings **PATCH /api/config** — with a visible banner/tooltip explaining it's a read-only mirror.
  - The artifact-mode "Generate prompt only" and all read/browse/search remain enabled (they don't write).
- Server-side defense-in-depth: the write endpoints (`POST /api/compile/run {execute:true}`, `POST /api/proposed/{promote,reject}`, `PATCH /api/config`) should **refuse with a clear 4xx** when the vault isn't committable, rather than writing a stranded change. (Keep them working when writable.)
- Do not key this purely off `MEMORY_ROLE` — the committable-git-tree check is the real signal (it directly reflects "will this persist"). Role can be a secondary hint.

### Task 3 — Confirm local write path persists

- With the local dashboard: compile execute, inbox promote/reject, and config edits write to `~/.memory`, commit via `commitVaultChange`, and the existing debounced auto-push propagates to the VPS bare repo (→ the hosted read-view updates via post-receive). No new sync code — just verify the local path works end-to-end and add a test.
- The auto-promote **scheduler** that currently runs inside the hosted dashboard (Phase 4.3.J) would strand on the VPS too — when `writable: false`, the scheduler must **not** run compile/auto-promote on the VPS (it would strand). Gate the scheduler on the same writable check, or document that scheduling is a local-dashboard feature. **Stop and ask** if gating the scheduler is more than a small change.

### Task 4 — Docs

- `docs/MEMORY-FORT-SPEC.md` §11 (dashboard) + §17 (deployment): document the model — **local dashboard = canonical writes; hosted VPS dashboard = read-only mirror + backup.** Update the topology note.
- `docs/cli.md`: add the `memory dashboard` command.
- A short "Running the dashboard" doc or README section: `npm run build:ui` then `memory dashboard`.
- `docs/ROADMAP.md`: Phase 4.15 shipped.

You will **not**:

- Add bidirectional VPS→local sync (that was Option A, explicitly not chosen).
- Move the canonical vault to the VPS (capture is local; out of scope).
- Fork a second dashboard server — reuse `createServer`.
- Remove the hosted VPS dashboard — it stays as the read-only remote view + backup.
- Change capture, hooks, or the MCP server.
- Auto-run anything destructive; the write gates + confirm dialogs (Phase 4.13) stay.

If the SPA can't easily read a capability flag before rendering the write buttons (timing), **stop and ask** — a simple `useCapabilities()` query gating button `disabled` state is the intended approach, not a rearchitecture.

---

## Repo orientation

- `src/dashboard/server.ts` — `createServer`; add the `writable` capability + endpoint guards.
- `src/cli.ts` + `src/cli/commands/` — the new `dashboard` command (this session it was started manually via `createServer({ vaultRoot, dashboardDistRoot })`).
- `src/sync/commit-vault-change.ts` — the committable-tree detection (a `.git` check) can live here or in a `src/storage/` helper, shared with the capability check.
- `src/dashboard-ui/components/CompilePage.tsx`, `InboxPage.tsx`, `SettingsPage.tsx` — gate write buttons on the capability.
- `src/dashboard-ui/hooks/` — a `useCapabilities()` / extend `useStatus()`.
- `src/dashboard/auto-promote-scheduler.ts` — gate on writable.
- Tests: `test/dashboard/server.test.ts`, the UI component tests, a CLI test for `dashboard`.

---

## Acceptance contract

1. `memory dashboard` starts the dashboard against `~/.memory` on `127.0.0.1`, serves the SPA, uses local env keys, prints + opens the URL.
2. On the **local** instance: compile execute, inbox promote/reject, and config edits write to the local vault, commit, and auto-push to the VPS; verified by a round-trip.
3. On a **detached-checkout (VPS)** instance: `writable: false`; write buttons are disabled with a clear notice; write endpoints refuse with a 4xx instead of stranding; the scheduler does not run compile there.
4. Read/browse/search/artifact-mode work on both.
5. Full suite + typecheck green; build + build:ui clean; `git diff --check` clean.

---

## Commit boundaries

- Task 1: `feat: memory dashboard command serves the dashboard locally (Phase 4.15 Task 1)`
- Task 2: `feat: gate write-actions on committable-vault capability (Phase 4.15 Task 2)`
- Task 3: `fix: scheduler runs only where the vault persists; local write round-trip test (Phase 4.15 Task 3)`
- Task 4: `docs: local dashboard writes, hosted is read-only (Phase 4.15 Task 4)`

---

## Deploy note

After this lands: rebuild + redeploy the dashboard bundle + UI to the VPS so the **hosted** dashboard shows the read-only notice and disables write buttons (closing the stranded-write trap). Locally, the operator runs `npm run build:ui` once, then `memory dashboard` whenever they want to do memory work — buttons there persist.
