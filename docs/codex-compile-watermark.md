# Codex Implementation Brief — Compile Idempotency: Per-File Consumption Watermark (Phase 4.19)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Architectural — read fully. Contains a **decision point** for the operator before implementation.

---

## What this is (root cause, verified live 2026-05-30)

`memory compile` re-derives the same pages (iaqar, veritrace, …) on **every single run**, because its "what's new since last compile" window is **mtime-based** and a long-running agent session writes one **continuously-growing raw file**.

Verified evidence:
- One active Codex session (`019e761e…`) has a **3.6 MB raw file with 2,881 observations** in `raw/2026-05-30/`, still being appended to (mtime stays "now"). A same-day split sibling sits in `raw/2026-05-29/` (different content — per-day-per-session files, which is fine).
- Compile's cutoff = "max compile timestamp in `log.md`" (correct, it advances). But the active session file's mtime is **always newer than any cutoff**, so it is **re-included on every run**.
- That file is full of repeated iaqar/veritrace/homelab mentions → the LLM regenerates the same pages each run.
- The Phase-4.18 converter then turned each regenerated `write_page` into an append and **dumped the whole regenerated body (intro + the model's own `## date update` headings) into the page**, producing duplicated/nested/out-of-order content. (That direct-apply path was reverted 2026-05-30 — converted ops now stage rather than corrupt, but they still pile up as redundant inbox proposals.)

**The core defect:** mtime-based windowing cannot express "I have already consolidated observations 1–2400 of this file; only process 2401+." An actively-growing file is perpetually "new."

---

## The decision point (operator chooses the approach)

**Option A — Per-file consumption watermark (recommended).**
Persist, per raw file, how far compile has already consumed it (byte offset or last-observation timestamp), in `state/compile-state.json`. Each run processes only the **unconsumed tail** of each file. Correct and complete; handles growing files, mid-file resumes, and never re-derives consolidated content. More state to manage.

**Option B — Exclude still-active sessions.**
Skip raw files whose mtime is within the last N minutes (e.g. 30) — i.e. only compile sessions that have gone quiet. Simple; one predicate. Downside: a session that never goes quiet for long is never compiled, and a file compiled once at "quiet" then resumed is re-included whole.

**Option C — Observation-level content dedup.**
Hash each observation; skip ones already folded into a wiki page. Robust against any windowing bug, but the heaviest to build and reason about.

**Recommendation: Option A** (watermark) — it's the one that actually matches the data model (append-only growing files). **Confirm before building.** If the operator prefers the smallest change that stops the pain today, Option B is a defensible interim.

**Operator decision (2026-05-30): Option A.**

### Grounding in established practice (researched 2026-05-30)

This is the standard **high-water-mark incremental extraction** pattern (Kafka consumer offsets, incremental ETL, Flink/Spark Structured Streaming checkpointing). The literature dictates several specifics this brief must follow — they are not optional:

1. **Prefer a monotonic byte offset over a timestamp.** HWM requires a "reliable monotonic tracking column." A raw file is append-only, so its **byte length only grows** — byte offset is the clean monotonic tracker. Last-observation-timestamp is a fallback only; timestamps risk clock-skew/ordering bugs. → **Byte offset is primary.**
2. **"Exactly-once is a myth" — design at-least-once + idempotent load.** The robust pattern is *watermark to bound the work cheaply* **+** *idempotent loading to make re-reads safe*. So Options A and C are **complementary, not alternatives**: the watermark (Task 1/2) is the cheap window; the converter's content-dedup / skip-if-redundant (Task 3) is the idempotent-load safety net that makes a re-read or a late write harmless. Both ship together.
3. **Provide a reset/backfill escape hatch.** A documented pitfall: "if your watermark has moved past affected data and you have no way to reset it, you're stuck doing a full re-extract." → compile must support **ignoring/resetting the watermark** (see Task 6). `--since <date>` already bypasses the log cutoff; it must also bypass the watermark, and add an explicit `--reset-watermark` to clear recorded offsets.

Sources: [oneuptime — incremental extraction](https://oneuptime.com/blog/post/2026-01-30-data-pipeline-incremental-extraction/view), [Skyvia — incremental load strategy](https://skyvia.com/blog/incremental-load-strategy-for-data-warehouses/), [DZone — exactly-once myth vs reality](https://dzone.com/articles/exactly-once-processing), [Matillion — high-water-mark loading](https://docs.matillion.com/metl/docs/2506598/).

This brief specifies **Option A**. If B or C is chosen, a different brief applies.

---

## Scope guard (Option A)

### Task 1 — Per-file consumption watermark (byte-offset primary)
- Extend `state/compile-state.json` with a `consumed` map: `{ "raw/2026-05-30/codex-019e761e….md": { bytes: <offset>, lastObservationAt: <iso> } }`.
- **Byte offset is the authoritative watermark** (append-only file → monotonic). `lastObservationAt` is stored for diagnostics/fallback only; do not gate on it when a byte offset exists.
- In `runCompile` (`src/cli/commands/compile.ts`), replace the single `sinceDate < mtime` gate with: for each raw file, read only the bytes **after** its recorded offset. Files with no recorded watermark are processed from the start (back-compat with the existing log-cutoff for the first run).
- Guard against truncation/rotation: if a file's current size is **smaller** than the recorded offset (file was rewritten/rotated), treat the watermark as invalid and reprocess from 0 (the Task 3 dedup keeps that safe).
- A file with no unconsumed tail is skipped with reason `"already consumed to watermark"`.

### Task 2 — Advance the watermark only on `--execute` that applied/staged
- After a successful `--execute` run, update each included file's watermark to its end-of-file offset / latest observation timestamp **actually included** in this pass (respect the byte caps — if a file was truncated by the total-cap, only advance to what was included, so the rest is picked up next run).
- Artifact mode (no `--execute`) and `--plan` do **not** advance the watermark (they don't consolidate).
- Persist atomically (existing `atomicWrite`).

### Task 3 — Converter: append only genuinely-new prose (fixes the duplication)
- `convertExistingWriteToAppend` must NOT dump the full regenerated body. Before appending, **strip any content already present in the target page** (compare normalized lines/paragraphs), and **never wrap content that itself contains `## <date> update` headings** — append only the net-new prose under a single dated heading. If nothing is net-new, **skip** the op with outcome `"skipped: no new content"`.
- Re-enable direct apply for converted ops **only** once this dedup is in place (so applying can't reintroduce the duplication that was reverted).

### Task 4 — Tests
- Growing-file test: a raw file compiled to watermark, then appended to, then re-compiled → only the new tail is processed; pages are not re-derived from old content.
- Watermark-not-advanced-on-artifact test.
- Converter dedup test: `write_page` whose body is already present in the target → `skipped: no new content`, page byte-identical.
- Truncated-by-cap test: watermark advances only to the included portion.

### Task 6 — Reset / backfill escape hatch (named pitfall)
- The documented HWM failure mode is "watermark moved past data you need to reprocess, no way to reset → stuck doing a full re-extract." Prevent it:
  - `--since <date>` must **bypass** the watermark entirely (process by date cutoff, ignore recorded offsets) — so the operator can always force a re-scan of a window.
  - Add `memory compile --reset-watermark [<path-glob>]` that clears recorded offsets (all files, or matching a glob), so the next run reprocesses from scratch. Pairs with Task 3 dedup so a full reprocess doesn't duplicate content.
- Log clearly when a run is watermark-bypassed vs watermark-gated, so it's never ambiguous which mode produced an outcome.

### Task 5 — Docs
- `docs/MEMORY-FORT-SPEC.md` (compile section): document watermark-based consumption + the "watermark bounds the work, content-dedup makes it idempotent" pairing + the reset hatch.
- `docs/ROADMAP.md`: Phase 4.19 shipped.

You will **not**:
- Change the capture hooks or the per-day-per-session file layout (that's correct).
- Change the compile byte caps.
- Re-enable direct-apply of converted ops before the Task 3 dedup exists.
- Touch the cutoff/log parsing beyond adding the watermark gate.

If the watermark-vs-byte-cap interaction gets subtle (a file partially included one run, more the next), **stop and ask** — correctness of "advance only to what was included" is the crux; get it reviewed before finalizing.

---

## Acceptance contract
1. Running `memory compile --execute` twice with **no new observations** → second run reports `0 operations` (nothing re-derived).
2. Appending new observations to an active session file, then compiling → only the new tail is consolidated.
3. Converter appends only net-new prose; a fully-redundant regenerated page → `skipped: no new content`, page unchanged.
4. `iaqar.md` / `veritrace.md` stop accumulating duplicate dated sections.
5. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 1: `feat: per-file consumption watermark in compile-state (Phase 4.19 Task 1)`
- Task 2: `feat: advance watermark only on executed compile (Phase 4.19 Task 2)`
- Task 3: `fix: converter appends only net-new prose; skip redundant (Phase 4.19 Task 3)`
- Task 4-5: `test+docs: compile idempotency via watermark (Phase 4.19)`
