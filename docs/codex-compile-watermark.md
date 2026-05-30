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

This brief specifies **Option A**. If B or C is chosen, a different brief applies.

---

## Scope guard (Option A)

### Task 1 — Per-file consumption watermark
- Extend `state/compile-state.json` with a `consumed` map: `{ "raw/2026-05-30/codex-019e761e….md": { bytes: <offset>, lastObservationAt: <iso> } }`.
- In `runCompile` (`src/cli/commands/compile.ts`), replace the single `sinceDate < mtime` gate with: for each raw file, read only the portion **after** its recorded watermark (by byte offset, or by dropping observations at/under `lastObservationAt`). Files with no recorded watermark are processed from the start (back-compat).
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

### Task 5 — Docs
- `docs/MEMORY-FORT-SPEC.md` (compile section): document watermark-based consumption.
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
