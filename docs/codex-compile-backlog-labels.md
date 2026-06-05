# Codex Prompt — Honest Compile Backlog Labels + True-Pending Counter

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Live vault**: `C:\Users\Admin\.memory`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (`main`, HEAD `50fbbda`).

---

## Mission

Compile output is **technically correct but reads as a giant backlog**. The current run says:

```
Consolidated 40 observations -> 0 applied, 0 staged for review, 0 rejected.
1,426 observations remaining - run again to continue. 2 pages unchanged. 603 sessions scanned.
```

and `log.md` says:

```
## [2026-06-04T13:14:23.358Z] compile | scheduled prompt: 40 raw included, 1742 skipped
```

Both make it sound like ~1.7k sessions are lurking unprocessed. Reality, per code:

- **1,742 "skipped" = watermark-exhausted** raw files — already drained in prior compile passes, **no new bytes**. Not owed work. (`src/compile/state.ts` `CompileConsumedWatermark.bytes`; aggregated by `src/dashboard/auto-promote-scheduler.ts:141` and CLI cli.ts ~line 555/591.)
- **1,426 "observations remaining" = didn't fit this batch** (batch cap = 40 in scheduled compile). Not failed, not stuck — just queued for the next pass.
- **The real "owed work" count is missing**: number of raw files where `currentBytes > watermark.bytes`, i.e. files with a fresh tail since the last compile read them. That's the only number that actually demands `run again to continue`.

Fix: relabel the user-facing strings AND add a computed "true pending tails" metric to both the CLI summary and the dashboard. No behavioral change. **Honesty, not function.**

---

## Verified context (confirm by reading)

- **Skip aggregation**: `auto-promote-scheduler.ts:141` log-line; `src/dashboard/server.ts:1033` (`rawIncluded`); `src/dashboard-ui/components/CompilePage.tsx:29,38` user-facing strings; `src/cli.ts:555,591` CLI summary.
- **Watermark shape**: `src/compile/state.ts:6` `CompileConsumedWatermark { bytes }`.
- **The CLI message "1,426 observations remaining - run again to continue"** — find where this string is generated. Likely `src/compile/execute.ts` or the CLI's `compile --execute` summary. Cite file:line.
- **Pages unchanged / sessions scanned** — same code path. Decide whether each label needs a clarifier too.

---

## Phase 1 — Audit (cite file:line, no fixes yet)

1. List every place each number is computed and rendered (CLI, log.md, dashboard API, dashboard UI).
2. For each label currently in user-visible output (`skipped`, `observations remaining`, `pages unchanged`, `sessions scanned`, `consolidated`), state in one line what it really counts.
3. Find whether a `pendingTails` (raw files with `currentBytes > watermark.bytes`) signal already exists somewhere (verify it doesn't, then add).

Output as a table: `label | source file:line | actual meaning | misleading?`.

---

## Phase 2 — Implement (TDD, stay green)

### A. Compute the true-pending metric

Add a function (in `src/compile/state.ts` or `src/compile/select.ts` — wherever the watermark map is read) that returns:

```ts
interface CompilePendingSummary {
  // raw files with fresh tail (currentBytes > watermark.bytes); true "owed work"
  filesWithPendingTail: number;
  // total bytes in those tails (informational)
  pendingTailBytes: number;
  // total raw files known to the vault
  totalRawFiles: number;
  // raw files fully drained (watermark exhausted, no new bytes)
  filesFullyDrained: number;
  // raw files never seen by compile (totally new)
  filesUnseen: number;
}
```

This is a pure function over the watermark map + a directory scan of `raw/`. Reuse the runtime cache pattern from `src/dashboard/loaders.ts` (`SearchRuntimeCache`, mtime-keyed) so the dashboard hit doesn't restat the whole `raw/` tree on every request.

### B. CLI summary relabel

Replace the misleading lines in `src/cli.ts` (`compile --execute` block) with:

```
Consolidated 40 observations -> 0 applied, 0 staged, 0 rejected.
Pending tails: <filesWithPendingTail> raw files have fresh content since the last compile read them.
Already-drained: <filesFullyDrained> raw files have no new bytes since the last pass.
Future batches: <filesUnseen + queued-but-batched> raw files queued for upcoming runs (batch cap N).
603 sessions scanned. 2 pages unchanged.
```

Wording must say **"pending tails"** (real work owed) vs **"already-drained"** (done) vs **"future batches"** (not in this batch, not stuck).

### C. log.md template relabel

`src/dashboard/auto-promote-scheduler.ts:141` — replace:

```
compile | scheduled prompt: 40 raw included, 1742 skipped
```

with:

```
compile | scheduled prompt: 40 raw included, 1742 already-drained, <N> pending tails
```

Where `<N>` is the new metric. Preserves the historical line shape (still grep-able) but explicit.

### D. Dashboard UI relabel

`src/dashboard-ui/components/CompilePage.tsx:29,38` — replace the sentences with the same triple: `consolidated / pending-tails / already-drained`. Surface `filesWithPendingTail` as the **headline** number on the Compile page (it's the only one a user can act on).

### E. Dashboard API

Expose `CompilePendingSummary` on `/api/compile` (or wherever the existing compile state is served — `src/dashboard/server.ts:1033` shows `rawIncluded`). Same runtime-cache invalidation as raw-capture events from `50fbbda`.

### Tests

- Unit: `CompilePendingSummary` over a fixture vault — 3 files (one pending-tail, one drained, one unseen) → returns `{1, X, 3, 1, 1}`.
- Unit: CLI summary string under each combo of (pending, drained, unseen) is honest. Don't accept any test that asserts the OLD misleading text.
- Integration: `/api/compile` returns the new fields, no regressions in `rawIncluded`/`rawSkipped` consumers.
- Don't regress: `50fbbda` timeline lanes, `5b1aa08` search perf cache, `a41759c` auto-heal, `0566984` durability.

Keep `npm run typecheck`, `npm run build`, the suite green at every commit.

---

## Phase 3 — Adversarial self-audit (the gate)

Before claiming done:

1. **Live CLI**: run `memory compile --execute --plan` (no spend, plan-only); paste the new CLI summary. The three numbers must reconcile: `pending-tails + already-drained + unseen = totalRawFiles`. Show the arithmetic.
2. **Live dashboard**: `GET /api/compile` — paste JSON. The new fields must exist and match the CLI numbers.
3. **Live log.md**: after a real compile run, paste the new log line.
4. **Cache**: hit `/api/compile` twice; second call must not restat the whole `raw/` tree. Show with a counter or timing.
5. **Perf**: warm `/api/search` refreshMs:0, rerankMs>0 unchanged.
6. **No behavior change**: same 0 applied / 0 staged / 0 rejected when nothing genuine to consolidate. Only labels move.

A green unit test isn't acceptance. Paste real outputs.

---

## Constraints

- Secrets env-var only; no key in logs.
- No permanent deletions.
- Windows + PowerShell 7. No OneDrive paths.
- Preserve all prior wins: durability, perf, auto-heal, supervisor, write-guard, auto-link tuning, reasoning-edge activation, timeline lanes.

## Stop-and-ask

1. `pendingTails` metric already exists somewhere I missed — point to it; do not duplicate.
2. The current digest-cap (≈40) makes "future batches" misleading too because it's bounded — clarify the wording.
3. CLI summary uses `pagesCompiled` semantics that I'd have to refactor more broadly — stop, propose separately.

## Output contract

- Phase 1 audit table.
- Diffs/commits + test names.
- **Phase 3 live evidence**: real CLI summary, real `/api/compile` JSON, real `log.md` line, arithmetic showing reconciliation, perf delta.
- Residual risks + a one-line operator note ("the only number that means 'run me again' is now `pending tails`").

## Definition of done

- CLI and dashboard surface a `pending tails` number that a user can act on, distinct from "already-drained" and "future batches."
- log.md line is grep-compatible but explicit.
- All prior gains intact; suite + typecheck + build green.
- Every claim above backed by a live command output.
