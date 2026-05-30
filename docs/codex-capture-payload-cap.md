# Codex Implementation Brief — Capture: Cap Tool-Input Payloads (middle-out) + Retroactive Raw Compaction (Phase 4.21)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is (root cause, verified live 2026-05-31)

The compile pain (huge prompts, slow drains, byte-cap tuning) traces to oversized raw files, and the oversize traces to **asymmetric truncation in capture**. In `formatToolUseBlock` (`src/hooks/raw-file.ts:46`):

```ts
const max = input.maxOutputBytes ?? 8192;
const inJson = safeJsonStringify(input.toolInput);    // INPUT: NOT capped
const truncatedOutput = truncate(outString, max);     // OUTPUT: capped at 8 KB
```

Tool **output** is capped at 8 KB; tool **input** is written in full. Tools whose input is the payload — `apply_patch` (entire diff/file), `Write`, large `Bash` heredocs — store 20–30 KB each, uncapped.

Measured on one live session file (`raw/2026-05-27/codex-019e5a9c….md`, 23.7 MB, 6,990 observations):
- **0% content duplication** — every observation is unique (this is *not* a dup bug).
- **1,386 observations exceed 8 KB**, accounting for **~49% (11.5 MB)** of the file — all driven by uncapped inputs.
- This one session spans 6 day-files totalling **68.6 MB (37% of the 184 MB raw vault)**.

Capping input the way output already is roughly **halves** these files and bounds every observation to a predictable size, which is what makes compile tractable instead of perpetually byte-cap-tuned.

---

## Grounding (researched 2026-05-31)

- **Use middle-out (head+tail), not head-only.** Head-only truncation is "the worst of both worlds" for structured payloads — it can leave invalid JSON and discards the tail, where results/errors live. Middle-truncation preserving the start and end gives better signal at the same budget.
- **Heavier alternative — spill-to-file + reference.** The cleanest pattern is "return the real result, or a structured reference to it" — store the full payload in a side file and keep a short preview + back-reference in the observation. This is an open ask in agent harnesses generally. It's more than we need for *memory* (the raw obs feeds the LLM compiler, not byte-exact reproduction), so this brief uses middle-out truncation and notes spill-to-file as a future option.

Sources: [BerriAI/litellm — middle-truncation for log payloads](https://github.com/BerriAI/litellm/pull/14637), [openai/codex #14206 — auto-spill large tool outputs to files](https://github.com/openai/codex/issues/14206), [bugsnag-ruby #290 — preserve field types when truncating](https://github.com/bugsnag/bugsnag-ruby/pull/290), [Arize — context management in agent harnesses](https://arize.com/blog/context-management-in-agent-harnesses/).

---

## Scope guard

### Task 1 — Cap tool input (the bug)
- In `formatToolUseBlock` (`src/hooks/raw-file.ts`), truncate `inJson` with a configurable `maxInputBytes` (default 8192, matching output). Add the param to the input object and thread it from `post-tool-use.ts` (config-overridable, see Task 4).
- Every captured tool observation is now bounded to ≈ `maxInputBytes + maxOutputBytes + small overhead`.

### Task 2 — Middle-out truncation helper
- Add `truncateMiddle(text: string, maxBytes: number): string` that keeps a head and tail slice with a `… [N bytes elided] …` marker between (e.g. head ~40% / tail ~60% of budget; snap to UTF-8 boundaries like the existing `truncate`).
- Use `truncateMiddle` for the **input** (so the JSON's opening structure *and* its tail are kept).
- **Also switch the output truncation to `truncateMiddle`** — the existing head-only `truncate` discards the end of tool output, where the result/error usually is. Keep `truncate` for any non-payload callers; update the tests that assert the old head-only marker.

### Task 3 — Retroactive raw compaction (shrink the existing 184 MB)
- The cap only helps *future* captures. Add `memory compact-raw [--plan|--apply] [--max-input-bytes <n>] [--max-output-bytes <n>]`:
  - Walks `raw/`, re-renders each `ToolUse` observation whose input/output exceeds the cap using `truncateMiddle`, leaving everything else byte-identical.
  - **Archive-first** (per the no-hard-delete rule): copy the original file under `raw/.compact-archive/<date>/…` (or honor the existing archive convention) before rewriting. `--plan` reports bytes that would be reclaimed per file + total; `--apply` performs it.
  - Idempotent: re-running on an already-compacted file is a no-op.
  - **Critical**: compaction must NOT change observation boundaries or count (only shrink within-observation payload), so Phase 4.19 watermarks stay valid. If a compacted file's byte length drops below a recorded watermark, the watermark is clamped to the new EOF (the truncation guard 4.19 added handles shorter files — verify it does).
- Commit the rewritten vault changes via the normal `commitVaultChange` path so they sync.

### Task 4 — Config
- Add `capture.max_input_bytes` and `capture.max_output_bytes` to `config.yaml` (defaults 8192). `post-tool-use.ts` reads them. Document that lowering them shrinks the vault at the cost of payload detail.

### Task 5 — Tests
- `formatToolUseBlock`: a 30 KB input → truncated to ~`maxInputBytes` via middle-out (head + tail both present, marker in the middle).
- `truncateMiddle`: head+tail preserved, UTF-8 boundary safe, no-op under budget.
- `compact-raw --apply`: an oversized fixture file shrinks; observation count unchanged; re-run is a no-op; original archived.
- Watermark-safety: a compacted file whose length dropped below a stored watermark → watermark clamped, next compile doesn't error.

### Task 6 — Docs
- `docs/MEMORY-FORT-SPEC.md` (capture): document input/output caps + middle-out + `compact-raw`.
- `docs/cli.md`: add `compact-raw`.
- `docs/ROADMAP.md`: Phase 4.21 shipped.

You will **not**:
- Change observation boundaries, count, or ordering (4.19 watermarks depend on them).
- Hard-delete any raw file (archive-first).
- Implement spill-to-file/side-references in this brief (noted as a future option).
- Change the compile/executor logic (this is upstream, in capture + a maintenance command).

If middle-out truncation of a JSON input produces text that looks like a broken code fence inside the ```json block (e.g. an unbalanced backtick in the elided middle), **stop and ask** — the marker must not break the surrounding markdown fence; sanitize the marker or escape as needed.

---

## Acceptance contract
1. A new `apply_patch` with a 30 KB input is captured at ≈ 8 KB (head+tail), not 30 KB.
2. `compact-raw --plan` on the live vault reports multi-MB reclaimable; `--apply` shrinks the `019e5a9c` day-files by ~half, archives originals, preserves observation counts.
3. After compaction, `compile --execute` still runs (watermarks valid, no errors).
4. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 2: `feat: truncateMiddle head+tail payload truncation (Phase 4.21 Task 2)`
- Task 1: `fix: cap tool-input payloads in capture (Phase 4.21 Task 1)`
- Task 3: `feat: memory compact-raw shrinks oversized raw observations (Phase 4.21 Task 3)`
- Task 4-6: `config+test+docs: capture payload caps + compaction (Phase 4.21)`
