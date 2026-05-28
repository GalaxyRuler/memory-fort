# Codex Implementation Brief — Scheduled Compile Cadence (Phase 4.3.O)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The full-system checkup (2026-05-28) found the consolidation pipeline is starving:

- `compile` last ran **2026-05-22** — 6 days stale
- **1,173 raw observations** have accumulated since
- Only **2 project wiki pages** exist despite ~10 active projects the operator works on daily (Lisan Studio, iAqar, VeriTrace, legal-ai, Homelab, Discord bot, personal website, agentmemory, Memory Fort itself…)

Capture is healthy (22 Codex captures today, 1,173 raw observations total). Consolidation is the bottleneck: raw observations only become curated wiki pages when `memory compile` runs, and nothing runs it automatically. The operator has to remember to invoke it, and hasn't in 6 days — so the curated knowledge layer is badly behind the raw layer.

Phase 4.3.J already built a scheduler (`src/dashboard/auto-promote-scheduler.ts`) for the propose pipelines. This brief extends that same scheduler to run `compile` on a cadence, closing the consolidation gap without the operator having to remember.

After this lands: compile runs on a configurable cadence (default daily), raw observations roll into wiki pages automatically, and the project-page count reflects actual project activity. The operator's "out of the loop" experience from Phase 4.3.J now covers consolidation too.

---

## Scope guard

You will:

### Task 1 — Extend the scheduler config

- Add a `compile` block to the `~/.memory/config.yaml` schema in `src/storage/config.ts`, alongside the `auto_promote` block from Phase 4.3.J:
  ```yaml
  compile:
    scheduled: true          # default true (consolidation should not starve)
    cadence: "daily"         # daily | weekly | manual
  ```
- Default `scheduled: true`, `cadence: daily`. Consolidation starving is the failure mode we're fixing, so the safe default is on

### Task 2 — Wire compile into the existing scheduler

- Extend `src/dashboard/auto-promote-scheduler.ts` (Phase 4.3.J) — do NOT build a second scheduler:
  - On dashboard startup, read the `compile` config block
  - If `scheduled: true`, register a timer per cadence that runs the existing compile entry point (find it — likely `src/compile/` or a `runCompile` function behind `memory compile`)
  - Errors log to `~/.memory/errors.log` without crashing the dashboard (same pattern as the auto-promote scheduler)
  - Clean shutdown on SIGTERM
- If compile and auto-promote are both scheduled, sequence them: compile first (produces wiki pages), then auto-promote propose (which clusters over the freshly compiled state). Don't run them concurrently — they both write to the vault

### Task 3 — Surface compile freshness

- The `compile.recent` verify check already exists and reports the last-compile date. Confirm it stays accurate after scheduled runs
- Add the compile cadence + last-run to the dashboard — the overview "Compilation Phase" route (`/memory/compile`) likely already shows compile state; add a line showing the configured cadence and next scheduled run
- Settings page (Phase 4.3.C/J): add a "Compile" card with a scheduled toggle + cadence picker, mirroring the auto-promote card. Writes via PATCH `/api/config`; extend the safelist to allow `compile.scheduled` and `compile.cadence`

### Task 4 — Manual trigger from the dashboard

- Add a "Run compile now" button on `/memory/compile` that POSTs to a new `POST /api/compile/run` endpoint (same-origin gated). Lets the operator force a consolidation without the CLI
- The endpoint runs compile and returns a summary (`N raw → M updates, K new pages`). Guard against concurrent runs — if a compile is already in progress, return 409

### Task 5 — Docs

- `templates/schema.md`: document the `compile` config block + the scheduler behavior
- `docs/ROADMAP.md`: Phase 4.3.O shipped 2026-05-28 — closes the consolidation cadence gap

You will **not**:

- Rewrite the compile logic itself. This brief is about *scheduling* an existing operation, not changing what compile does
- Run compile concurrently with auto-promote or another compile. Serialize vault-writing operations
- Auto-delete raw observations after compile. Retention/pruning is a separate concern (the config has a `retention` block, but that's not this brief)
- Build a second scheduler. Extend `auto-promote-scheduler.ts` — rename it to something neutral like `vault-scheduler.ts` if the auto-promote-specific name no longer fits, but keep it one scheduler
- Change compile's output format or the wiki page schema
- Make the default cadence weekly. Daily is the safe default — 6 days of starvation is exactly what we're fixing

If extending the scheduler reveals that compile is long-running (minutes) and would block the dashboard event loop, **stop and ask** — we may need to run it in the detached-worker pattern that auto-push uses (`src/sync/auto-push-worker.ts`) rather than inline.

---

## Repo orientation

- `src/dashboard/auto-promote-scheduler.ts` (Phase 4.3.J) — the scheduler to extend
- `src/compile/` — compile logic. Find the entry point (`runCompile` or similar) the CLI `memory compile` calls
- `src/cli/commands/` — the `compile` command; reuse its entry function, don't duplicate
- `src/storage/config.ts` — config schema; add the `compile` block
- `src/cli/commands/verify/` — the `compile.recent` check to keep accurate
- `src/dashboard/server.ts` — add `POST /api/compile/run`; same-origin pattern from Phase 4.3.C
- `src/dashboard-ui/routes/compile.tsx` (or `CompilePage.tsx`) — the "Run compile now" button + cadence display
- `src/dashboard/config-patch.ts` — safelist; add `compile.scheduled`, `compile.cadence`
- `src/sync/auto-push-worker.ts` — the detached-worker pattern, if compile turns out to need it

---

## Acceptance contract

1. With `compile.scheduled: true, cadence: daily`, the dashboard scheduler runs compile once per 24h, logging the summary
2. Compile and auto-promote, when both scheduled, run sequentially (compile first), never concurrently
3. `memory verify` `compile.recent` reflects the scheduled runs and stops going stale
4. Settings page has a Compile card (scheduled toggle + cadence); `/memory/compile` shows cadence + last run + a "Run compile now" button
5. `POST /api/compile/run` is same-origin gated, returns a run summary, and 409s on concurrent runs
6. After a compile run against the current vault, the project-page count rises to reflect actual project activity (the operator will eyeball this)
7. Full test suite passes (baseline 1039). New tests cover the scheduler extension, the config safelist, and the run endpoint's concurrency guard
8. `npm run build`, `npm run build:ui`, `tsc --noEmit`, `git diff --check` clean

---

## Verification commands

```powershell
cd C:\CodexProjects\memory-system
node dist/cli.mjs compile                       # manual run, confirm it still works
# Enable scheduling via Settings UI or config.yaml, restart dashboard
# Check /memory/compile shows cadence + next run
node dist/cli.mjs verify --role=operator | Select-String "compile"
```

---

## Commit boundaries

- Task 1: `feat: compile cadence config block (Phase 4.3.O Task 1)`
- Task 2: `feat: scheduled compile in vault scheduler (Phase 4.3.O Task 2)`
- Task 3: `feat: compile cadence surface in settings + compile page (Phase 4.3.O Task 3)`
- Task 4: `feat: POST /api/compile/run manual trigger (Phase 4.3.O Task 4)`
- Task 5: `docs: scheduled compile cadence (Phase 4.3.O Task 5)`

---

## Out-of-scope follow-ups

- Retention/pruning of old raw observations after compile (the `retention` config block exists but is separate)
- Incremental compile (only process raw since last run) as a performance optimization — only if full compile proves too slow
- Why procedures never extract (separate clustering-threshold investigation from the checkup)
