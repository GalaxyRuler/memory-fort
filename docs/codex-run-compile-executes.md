# Codex Implementation Brief — "Run compile now" Executes (Phase 4.13)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The dashboard "Run compile now" button (`/memory/compile`) currently POSTs `/api/compile/run` in **artifact mode** — it assembles a consolidation *prompt*, discards it, bumps the last-compile timestamp, and reports "completed." It does **not** consolidate anything: no wiki pages are created or updated. Observed live (2026-05-29): the operator clicked it, saw "completed," and nothing actually happened — `compile.execute-health` reported "no executed compile run recorded," and the wiki was unchanged. This is a false-success UX trap.

The operator wants the button to **actually run the compile** — i.e., execute mode: send the prompt to the configured LLM, parse `compile-ops`, ground + redact, and apply append-only operations (high-confidence directly; low-confidence staged to `wiki/compile-proposed/` for inbox review).

The backend already supports this — `POST /api/compile/run` accepts an `{ execute?: boolean }` body (Phase 4.4). This brief makes the button send `execute: true`, confirms intent (it mutates memory), and surfaces a real result.

---

## Scope guard

You will:

### Task 1 — Button runs execute mode with confirmation

- On `/memory/compile` (`src/dashboard-ui/components/CompilePage.tsx`), change the primary "Run compile now" action to POST `/api/compile/run` with `{ execute: true }`.
- Add a **confirmation dialog** before the POST (it writes to canonical memory). Copy along the lines of:
  > **Run compile?** This sends recent raw observations to the LLM and updates your wiki: high-confidence changes are written directly; low-confidence ones go to the Inbox for review. This modifies canonical memory.
  > [Run compile] [Cancel]
- While running, disable the button and show an in-progress state ("Consolidating…"). The endpoint already guards concurrency (409 → show "a compile is already running").
- If `MEMORY_LLM_DISABLED=true` or no LLM provider is configured, the button should be disabled with a tooltip explaining why (don't POST and fail opaquely).

### Task 2 — Surface a real result summary

- `POST /api/compile/run` (`src/dashboard/server.ts`) must return a structured summary when `execute: true`. If it doesn't already, extend it to include: `rawIncluded`, `rawSkipped`, `rawRemaining` (total un-compiled minus included), `opsApplied`, `opsStaged`, `referencesStripped`, and `error?`.
- After the run, the CompilePage shows the result inline, e.g.:
  > Consolidated **101** observations → **3** pages created, **5** sections appended, **2** staged for review. **1,038 observations remaining** — run again to continue.
- If `opsStaged > 0`, show a link to `/memory/inbox` ("Review N staged changes →").
- If `rawRemaining > 0`, make it obvious the backlog needs more passes (the per-run byte cap limits each pass to ~100 observations).

### Task 3 — Keep artifact mode available (secondary)

- Don't delete artifact mode — keep a secondary, clearly-labeled affordance ("Generate prompt only (don't execute)") for operators who want to drive compile manually in their own agent. The **primary** button executes; artifact mode is the opt-out, not the default.
- Artifact mode, when used, should make the prompt retrievable (write it to a file or return it in the response) rather than discarding it — a small fix so it's not wasteful. If that's more than a trivial change, **stop and ask**; the primary execute path is the priority.

### Task 4 — Scheduler note (no behavior change)

- Confirm the scheduled-compile path (`auto-promote-scheduler.ts`) and its `compile.execute` config flag are consistent: the scheduler runs execute mode only when `compile.execute: true` (Phase 4.4/4.10). This brief is about the **manual button**; do not change the scheduler defaults. Just verify the button and scheduler share the same execute code path (no duplicated compile logic).

### Task 5 — Tests + docs

- UI test: clicking "Run compile now" → confirm dialog → POST carries `{ execute: true }`; the result summary renders; staged>0 shows the inbox link; 409 shows the already-running message; LLM-disabled disables the button.
- Server test: `POST /api/compile/run {execute:true}` returns the structured summary fields; same-origin still enforced.
- `docs/MEMORY-FORT-SPEC.md` (dashboard section) + `templates/schema.md`: document that the dashboard compile button executes (writes memory) with a confirm + result summary, and that artifact mode is the secondary opt-out.
- `docs/ROADMAP.md`: Phase 4.13 shipped.

You will **not**:

- Auto-run compile without the confirmation dialog. It mutates canonical memory; the operator confirms each manual run.
- Change the scheduler defaults (`compile.scheduled` stays false, `compile.execute` stays false — opt-in).
- Remove the inbox review gate for low-confidence ops (Phase 4.4) — those still stage, never auto-apply.
- Duplicate compile/execute logic — the button and scheduler call the same `runCompile({ execute: true })` path.
- Loosen the same-origin guard or the concurrency (409) guard.
- Auto-loop the backlog in this brief (one pass per click). A "run until caught up" loop can be a later follow-up; surfacing `rawRemaining` is enough for now.

If the byte-cap-per-pass makes a single click feel unsatisfying (1,038 remaining after one run), **stop and ask** before adding an auto-loop — surfacing the remaining count + "run again" is the intended v1; an auto-catch-up loop is a deliberate separate decision (it could be a long LLM run + cost).

---

## Repo orientation

- `src/dashboard-ui/components/CompilePage.tsx` — the button + result UI.
- `src/dashboard/server.ts` — `POST /api/compile/run` handler (the `{execute}` body + summary).
- `src/compile/execute.ts` (Phase 4.4) — the execute engine + its result shape; reuse for the summary fields.
- `src/cli/commands/compile.ts` — `runCompile`; ensure the button path and CLI/scheduler share it.
- `src/dashboard/auto-promote-scheduler.ts` — scheduled compile (verify shared path, no change).
- Tests: `test/dashboard-ui/components/compile-page.test.tsx`, `test/dashboard/server.test.ts`.

---

## Acceptance contract

1. Clicking "Run compile now" → confirm dialog → executes a real consolidation; wiki pages are created/appended (high-confidence) and/or staged to the inbox (low-confidence).
2. The page shows a result summary with raw included/skipped/remaining + ops applied/staged, and an inbox link when staged>0.
3. Concurrency (409) and LLM-disabled states are handled in the UI (no opaque failures).
4. Artifact mode remains available as a clearly-labeled secondary option.
5. Button and scheduler share one compile-execute code path.
6. Full suite + `npm run typecheck` green; build + build:ui clean; `git diff --check` clean.

---

## Commit boundaries

- Task 1: `feat: Run-compile-now button executes (with confirm) (Phase 4.13 Task 1)`
- Task 2: `feat: compile-run returns + surfaces a result summary (Phase 4.13 Task 2)`
- Task 3: `feat: keep artifact mode as a secondary opt-out (Phase 4.13 Task 3)`
- Task 5: `test+docs: dashboard compile executes (Phase 4.13)`

---

## Deploy note

After this lands: rebuild + redeploy the dashboard bundle + UI to the VPS (the operator's button runs on the hosted dashboard). The endpoint uses the dashboard's env `OPENROUTER_API_KEY`, so execute works server-side without the operator's local key.
