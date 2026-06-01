# Codex Implementation Brief — Graph Cohesion Metric Fix (Phase 4.33)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> The `graph.cohesion` check fails on `narrative-thread-coverage`. The root cause is a **metric-design bug**, not missing curation: the denominator grows with every capture while the numerator only grows when threads are authored, so coverage decays toward 0 no matter what. This brief fixes the metric to measure something achievable, and adds a stopgap to lift current coverage.

---

## Grounding (verified against live code + vault, 2026-06-02)

`src/dashboard/graph-health.ts` → `metricNarrativeThreadCoverage` (≈line 506):

```ts
const rawNodes = input.feed.nodes.filter((node) => node.kind === "raw");        // ALL raw, all-time
const referencedRawPaths = new Set<string>();                                   // raw/ targets in thread relations
for (const page of threadPages) for (const relations of Object.values(page.relations ?? {}))
  for (const relation of relations) if (relation.target.startsWith("raw/")) referencedRawPaths.add(relation.target);
const coverage = rawNodes.length === 0 ? 100 : (referencedRawPaths.size / rawNodes.length) * 100;
// threshold: pass >= 50%, warn >= 25%, fail < 25%
```

**Live numbers:** 1398 raw observations, 15 thread pages, 347 referenced → **24.8% → fail**.

**Why it can never win:** the denominator is *all raw observations ever captured* (1398 and climbing every session). To reach `pass` (≥50%) a human would have to author threads that reference **699+** individual raw files. Capture adds raw faster than anyone authors threads, so the ratio monotonically decays. It was 25.09% (warn) earlier today; new captures pushed it under 25% (fail) within hours. **This is whack-a-mole by construction.**

Adjacent metric also in warn: `graph.project-subgraph-density` = 0.06 (threshold warn < 0.10, fail < 0.03). Real but lower-priority; Task 3 addresses it lightly.

`memory thread propose` already exists (clusters raw → draft thread pages via LLM; `memory thread promote <slug>` publishes). The numerator *can* be grown programmatically.

---

## Task 1 — Rolling-window denominator for narrative-thread-coverage (the real fix)

Change the metric to measure **"are recent raw observations being woven into threads,"** not "have threads ever referenced half of all history."

In `src/dashboard/graph-health.ts` `metricNarrativeThreadCoverage`:

1. Add a window constant near the other calibration constants:
   ```ts
   // Narrative-thread coverage is measured over a trailing window so the
   // denominator does not grow unbounded with capture. Coverage then reflects
   // recent thread-authoring discipline, not the all-time raw backlog.
   const NARRATIVE_COVERAGE_WINDOW_DAYS = 30;
   ```
2. Restrict **both** numerator and denominator to raw nodes whose observation date is within the window:
   - `rawNodes` → only raw nodes with `observedAt` (or the date embedded in the `raw/YYYY-MM-DD/...` path) within the last `NARRATIVE_COVERAGE_WINDOW_DAYS`.
   - `referencedRawPaths` → only count referenced `raw/` targets that are also in the windowed set.
   - Determine "now" from `input` if it carries a timestamp; otherwise derive the window upper bound from the **max** raw date present (do NOT call `new Date()` inside pure metric code if the module is meant to be deterministic — check how sibling metrics get the clock; reuse that. If none, thread a `now` through `GraphHealthInput`).
3. Keep thresholds (pass ≥50%, warn ≥25%, fail <25%) — they now mean "≥50% of the last 30 days' raw observations are referenced by a thread," which is achievable with regular `thread propose`.
4. Update `detail` to state the window: `` `${referenced}/${windowedRaw} raw observations from last ${WINDOW} days referenced by ${threadPages.length} thread(s) (${coverage}%)` ``.
5. Guard the empty-window case: if `windowedRaw.length === 0`, return `status: "n/a"` with detail "no raw observations in window" (don't divide by zero, don't report 100%/0%).

**Why 30 days:** long enough to smooth bursty capture, short enough that the denominator is bounded and recent. Make it a named constant so it's trivially tunable; do not hard-code 30 in multiple places.

---

## Task 2 — Stopgap: lift current coverage by authoring threads over recent raw

The metric fix makes coverage *winnable*; this task makes it *won now*.

1. Run `memory thread propose` (it clusters recent raw → draft thread pages). Review the drafts in `wiki/threads-proposed/`.
2. Promote the coherent ones with `memory thread promote <slug>` so they reference recent `raw/` observations in their `relations`.
3. Re-run `memory verify --offline --role server --json` and confirm `graph.narrative-thread-coverage` is **pass** (or at least warn, not fail) under the new windowed metric.

Do **not** fabricate threads or stuff raw references to game the number — promote only drafts that are genuinely coherent narratives. If `thread propose` produces too few coherent clusters to clear 50%, that is fine: report the real post-fix value and stop. The metric being *honest and winnable* is the goal, not a green light at any cost.

---

## Task 3 — Sanity-check project-subgraph-density calibration (light)

`graph.project-subgraph-density` = 0.06, warn < 0.10. Read `metricProjectSubgraphDensity` and confirm:
- Whether 0.06 reflects genuinely sparse project↔entity linking (real, leave as warn — it's honest signal), or
- Whether the threshold (0.10) was calibrated against a different vault shape and is now mis-set.

If the former: **leave it warn, do not touch the threshold to force green** (that violates lesson #4/#7 — don't paper over honest signal). If the latter: recalibrate with a one-line comment citing the live distribution, same as the existing `HUB_OVERLOAD` calibration comments. When unsure, leave it and note it in the report.

---

## You will NOT
- Lower the coverage thresholds to force a pass — fix the *denominator*, not the bar.
- Fabricate threads or raw references to inflate the numerator.
- Call `new Date()` / `Date.now()` inside deterministic metric code — thread the clock through input like sibling metrics, or derive from max raw date.
- Touch other graph metrics that are currently passing.
- Claim done on the check status alone — show the before/after coverage numbers and the windowed detail string.

## Stop and ask
1. No existing mechanism passes "now" into `GraphHealthInput` and sibling metrics also use wall-clock — confirm the deterministic-clock approach before adding a parameter that ripples through callers/tests.
2. `thread propose` yields too few coherent clusters to clear warn even after the window fix — report the honest number; do not force it.
3. Density threshold looks mis-calibrated AND fixing it would flip several other vaults — defer, note in report.

## Acceptance (content + numbers, lessons #2/#3/#7)
- `metricNarrativeThreadCoverage` uses a trailing-window denominator; unit test with a synthetic feed proves: raw outside the window is excluded from both numerator and denominator; coverage is computed only over in-window raw; empty window → `n/a`.
- `memory verify --offline --role server` → `graph.narrative-thread-coverage` is **pass or warn**, not fail; `verify` exit code reflects it (0 if no other fail).
- Report states the **before** (24.8%, all-time, fail) and **after** (windowed %, status) numbers explicitly — not just "fixed."
- Full suite + typecheck + build clean. New/updated test for the windowed metric.

## Commit boundaries
- Task 1: `fix(graph-health): window narrative-thread-coverage denominator (Phase 4.33 Task 1)`
- Task 2: `chore(vault): author threads over recent raw to lift coverage (Phase 4.33 Task 2)` — vault commit, separate repo (`C:/Users/Admin/.memory`), push to `vps`
- Task 3 (only if recalibrated): `fix(graph-health): recalibrate project-subgraph-density threshold (Phase 4.33 Task 3)`
