# Codex Implementation Brief — Compile Fairness: No-Starvation Scheduling + Backlog Drain (Phase 4.20)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Depends on Phase 4.19 (per-file consumption watermark) being shipped. This builds on the `consumed` map.

---

## What this is (verified live 2026-05-30, after 4.19 shipped)

Phase 4.19 stopped compile from *reprocessing* consumed content and from *corrupting* pages — both confirmed. But verification surfaced a second, independent defect: **compile starves large/late files and can't drain the backlog.**

Evidence from running `compile --execute` repeatedly on the live vault:
- Caps are `DEFAULT_PER_FILE_MAX_BYTES = 10_000`, `DEFAULT_TOTAL_MAX_BYTES = 200_000`.
- The vault has **1,259 raw files** including one **3.96 MB active session**.
- That 3.96 MB session appears **0 times** in the rendered prompt and has **no watermark** — it is **never included**. Files earlier in iteration order fill the 200 KB total budget before compile reaches it, on *every* run. It is permanently starved: never consolidated, never watermarked.
- Across 4 runs the "included" count *rose* (22 → 60) and "applied" trended to 0 — the watermark frees small files and packs in more, but the big file never progresses.

**This is classic scheduling starvation** (a low-priority/late item denied the resource indefinitely because a fixed-order queue is always exhausted first). The established fixes are **round-robin** (every item gets a fixed quantum per cycle → no starvation) and **aging** (raise the priority of long-waiting items). See sources below.

---

## Grounding (researched 2026-05-30)

- **Round-robin eliminates starvation**: "each process is given quanta for execution… no process can be starved by another for more than one time slice." Applied here: give each raw file with an unconsumed tail a per-file byte slice per run, cycling until the total budget — so every eligible file makes progress each run.
- **Aging prevents indefinite waiting**: "gradually increasing the priority of processes that wait a long time." Applied here: order files by **least-recently-consumed** (never-consumed and oldest-watermark first), so a file that's been waiting is served before freshly-consumed ones.

Sources: [GeeksforGeeks — Starvation and Aging](https://www.geeksforgeeks.org/starvation-and-aging-in-operating-systems/), [Fiveable — CPU scheduling algorithms](https://fiveable.me/lists/cpu-scheduling-algorithms), [Redwood — job scheduling strategies](https://www.redwood.com/article/job-scheduling-algorithms/).

---

## Scope guard

### Task 1 — Least-recently-consumed ordering (aging)
- In `runCompile` (`src/cli/commands/compile.ts`), before applying the byte budget, **sort the eligible raw files by consumption age**: files with **no watermark** first (never consumed), then by **oldest `lastObservationAt`/watermark ascending**. This ages starved files to the front so they can't be perpetually skipped.
- Eligibility is unchanged: file passes the `--since`/watermark gate and has an unconsumed tail.

### Task 2 — Round-robin slice allocation (no starvation)
- Replace "include whole files in order until total cap" with a **round-robin pass**: iterate the aging-ordered eligible files, taking up to `perFileMaxBytes` of each file's **unconsumed tail** per cycle, accumulating toward `totalMaxBytes`. Cycle until the total budget is exhausted or no file has remaining tail.
- The guarantee to preserve: **every eligible file contributes at least its first slice before any file contributes a second** — so a 3.96 MB file always advances each run instead of being starved by smaller earlier files.
- Watermarks (Task 2 of 4.19) advance per file for exactly the bytes included this run (respect the partial-inclusion rule already there).

### Task 3 — Backlog drain mode
- Add `memory compile --execute --drain [--max-passes <n>]`: loop compile passes until `rawFilesIncluded === 0` (backlog empty) or `--max-passes` (default e.g. 50) is hit. Each pass advances watermarks; the loop terminates because the watermark monotonically consumes the backlog.
- Print a per-pass progress line (`pass k: included X, applied Y, Z bytes remaining across N files`) and a final summary. Honor a hard safety cap so a runaway can't loop forever.
- `--drain` without `--execute` is an error (draining only makes sense when consolidating).

### Task 4 — Cap defaults (tuning, conservative)
- Do **not** silently balloon the caps (LLM token cost per pass scales with included bytes). Keep `perFileMaxBytes`/`totalMaxBytes` operator-overridable as today. Optionally raise `DEFAULT_TOTAL_MAX_BYTES` modestly (e.g. 200 KB → 400 KB) **only if** the change is called out in the summary and docs — but fairness (Tasks 1–2) is the real fix, not bigger caps. If unsure, leave defaults and rely on `--drain`. **Stop and ask** before changing a default.

### Task 5 — Tests
- **Starvation test**: a fixture with one large file + many small files, total tail >> total cap. Assert the large file's watermark **advances on every pass** (never starved), and that `--drain` eventually consumes it to EOF.
- **Fairness test**: in a single pass, every eligible file's watermark advanced by ≥1 slice (round-robin), not just the first few.
- **Drain termination test**: `--drain` on a finite backlog terminates with `included === 0` and does not exceed `--max-passes`.
- **No-regression**: 4.19 idempotency (run twice on a fully-consumed vault → 0 ops) still holds.

### Task 6 — Docs
- `docs/MEMORY-FORT-SPEC.md` (compile): document round-robin + aging fairness and `--drain`.
- `docs/cli.md`: add `--drain`/`--max-passes`.
- `docs/ROADMAP.md`: Phase 4.20 shipped.

You will **not**:
- Change the 4.19 watermark format or the converter dedup.
- Remove the byte caps (they bound per-pass LLM cost).
- Auto-run `--drain` from the scheduler/dashboard without explicit invocation (it's a deliberate catch-up, and large drains cost LLM tokens).
- Change the corruption-safety behavior (converted writes still dedup/stage).

If round-robin slicing at the observation boundary is tricky (a 10 KB slice must not cut an observation in half mid-record), **stop and ask** — slices should snap to observation (`## [timestamp]`) boundaries so the LLM never sees a truncated record; the watermark then records the byte offset of the last *whole* observation included.

---

## Acceptance contract
1. With a 3.96 MB file present, a single `compile --execute` pass **includes a slice of it** and **advances its watermark** (no longer starved).
2. `compile --execute --drain` consumes the entire backlog to EOF across bounded passes and terminates.
3. After a full drain, `compile --execute` twice → 0 operations (4.19 idempotency preserved).
4. Slices never split an observation mid-record.
5. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 1: `feat: least-recently-consumed ordering for compile fairness (Phase 4.20 Task 1)`
- Task 2: `feat: round-robin slice allocation prevents file starvation (Phase 4.20 Task 2)`
- Task 3: `feat: compile --drain works through the backlog (Phase 4.20 Task 3)`
- Task 5-6: `test+docs: compile fairness + drain (Phase 4.20)`
