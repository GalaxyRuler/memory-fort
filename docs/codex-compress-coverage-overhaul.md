# Codex Implementation Brief — Compress Coverage Overhaul (Phase 4.38)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> **The foundation is broken.** `memory compress` truncates every session to the first **4,000 bytes, head-only**, before the LLM sees it. Average session = **182 KB**, so compress sees **2.1%** and discards the rest — including every decision, procedure, and outcome that occurs after the opening. This was verified three ways (code, audit logs, empirical diff). Every one of the 698 existing fact bundles was built from session openings only. This brief fixes it: larger windows, map-reduce for oversized sessions, a `type` field, and a full re-compress.

---

## Evidence (verified 2026-06-02, three independent ways)

**1. Code.** `src/facts/compress.ts:23` `const DEFAULT_MAX_INPUT_BYTES = 4_000;`. Line 53 wraps input in `truncateUtf8(redactSecrets(rawText), 4000)`. `truncateUtf8` (line 166) = `buffer.subarray(0, maxBytes)` — **head-only hard cut**. The CLI (`compress.ts:76`) passes no override.

**2. Audit logs.** 462 historical `session-compress` calls: median input **1,211 tokens**, **max ever 2,282**. 4KB ≈ 1,000-1,300 tokens. No compress call ever saw a full large session.

**3. Empirical diff.** Real 743 KB session (`codex-019e7f47…`), same prompt, 4KB vs 64KB:
- **4KB → 3 facts**, all one opening topic (WebView2 init, its fix, testing).
- **64KB → recovered 5 facts the 4KB lost**, including a **procedure** ("Test-Driven Development"), a **procedure** ("Systematic Debugging Process"), and a **decision** ("Homelab Runner Integration"). The 4KB pass lost every procedure and decision in the session.

**Session size distribution (1,619 raw):** <32KB: 1,102 · 32-128KB: 300 · 128-512KB: 151 · **>512KB: 66** (exceed gpt-4o-mini's 128K-token context → require chunking).

---

## Task 1 — Replace head-truncation with windowed + map-reduce compression

In `src/facts/compress.ts`:

1. **Remove the head-only 4KB cut as the primary path.** Raise the default and make it config-driven:
   - `config.yaml`: `compress.max_input_bytes: 48000` (default; ~13K tokens, fits one call for ~86% of sessions). Read in `compress.ts` via config, not a hardcoded const.
   - `compress.chunk_threshold_bytes: 48000` — sessions larger than this go to map-reduce.
   - `compress.max_chunks: 8` — hard bound on chunks per session (cost cap).

2. **Single-call path (session ≤ threshold):** compress the whole session text (after `redactSecrets`). No truncation.

3. **Map-reduce path (session > threshold):**
   - Split the session into chunks of `chunk_threshold_bytes`, splitting on observation boundaries (`## [timestamp]` markers) where possible, not mid-line.
   - If chunk count > `max_chunks`: **sample** `max_chunks` chunks spread across the session — always include the **first** and **last** chunk, plus evenly-spaced interior chunks. (Decisions cluster at the end; openings carry intent.) **Log** what was sampled vs skipped — never silently drop (lesson #6).
   - Compress each chunk → partial fact bundles. **`redactSecrets` runs on every chunk** (not just once).
   - **Reduce/merge:** dedup partial facts by normalized-title similarity; merge `facts[]` arrays and `concepts[]`; keep the max `importance`; union `files[]`. This can be a deterministic code merge, OR one final cheap LLM "merge these partial fact lists, dedup" call (prefer deterministic merge to bound cost — only use an LLM merge if dedup quality demands it; Stop-and-ask).

4. **Context-window safety:** never send more than a model-safe token budget in one call (configurable `compress.max_call_tokens`, default ~100K to stay under gpt-4o-mini's 128K). Chunk sizes must respect this.

## Task 2 — Add a `type` field to facts (preserve decision/procedure/lesson)

The fact schema has no type, so decisions/procedures are flattened to generic facts and the type must be re-guessed at consolidate time. Fix at the source:

1. Extend `CompressedFact` (`src/facts/store.ts`) with `type?: "project" | "decision" | "procedure" | "lesson" | "reference" | "tool" | "people" | "fact"` (optional, backward-compatible).
2. Extend the compress prompt: each fact bundle gets a `type` classifying it. Add 1-2 lines of instruction + the enum. A "Systematic Debugging Process" bundle → `procedure`; a "Chose Voyage over OpenAI embeddings" bundle → `decision`.
3. In consolidation (`src/compile/`), use the fact `type` to route to the correct wiki directory (`wiki/decisions/`, `wiki/procedures/`, etc.) instead of inferring it. The PageType routing already exists (`execute.ts:104-111`); feed it from the fact type.

## Task 3 — Re-compress everything (the 698 are all openings-only)

The watermark (`compress.ts:58-60`) skips when `compressed[rawPath].bytes === info.size`. To force a full re-compress under the new logic:

1. Add a `compressVersion` (or `schemaVersion`) to the watermark record. Bump it to `2` for this phase.
2. The skip check becomes: skip only if `bytes === size` **AND** `compressVersion === current`. A version mismatch forces re-compress. This auto-re-does all 698 existing bundles from full raw, no manual reset.
3. `facts/<date>/<slug>.json` overwrites deterministically (already does) — re-compress replaces cleanly; archive prior to `facts/.history/` if you want rollback (optional).
4. Re-compress runs via the existing bounded `memory compress --drain --apply` (the fairness/per-pass bound already prevents a runaway; it'll churn through 1,619 over multiple passes).

## Task 4 — Cost + safety guards

- **Per-session cost is now variable.** Log per-session input tokens; surface a `compress.cost` summary in the command output (total tokens, est. cost).
- **No silent truncation:** if a session is sampled (chunks skipped due to `max_chunks`), the fact bundle records `sampledChunks: n, totalChunks: m` so coverage is honest. The dashboard/verify can surface "N sessions sampled, not fully compressed."
- **Secrets:** `redactSecrets` must run on every chunk before it leaves the process. Verify with a test (a secret planted at byte 60,000 of a session must be redacted in its chunk).
- Config defaults must be safe: a fresh `memory init` writes the new `compress.*` keys.

## Task 5 — Tests (read the fact bytes, lesson #2/#3)

1. **The regression that started this (THE acceptance gate):** re-compress the real session `raw/2026-05-31/codex-019e7f47-78c5-7cd1-9e07-f75bee00a752.md` (743 KB). **Read the resulting `facts/.../….json` bytes.** Assert the fact bundle now contains the procedures and decision that 4KB lost — specifically facts whose titles/narratives mention **"Test-Driven Development"**, **"Systematic Debugging"**, and **"Homelab Runner"** (or equivalents). The 4KB output had none of these. Assert on the file content, not the fact count.
2. **Type preservation:** a fixture session containing a clear decision and a clear procedure → fact bundle has one fact with `type: "decision"` and one with `type: "procedure"`.
3. **Map-reduce coverage:** a synthetic 600 KB session with a unique marker string planted near the END → after compress, a fact references that end-of-session content (proves the tail is reached, not just the head).
4. **max_chunks sampling:** a 2 MB session with `max_chunks: 4` → exactly 4 chunks compressed, first+last always included, `sampledChunks/totalChunks` recorded, a log line emitted. No silent drop.
5. **Secret redaction at depth:** secret planted at byte 60,000 → redacted in output.
6. **Re-compress trigger:** existing fact bundle with old `compressVersion` → re-compressed; with current version + same bytes → skipped.
7. **At scale:** re-compress 20 real large sessions; assert avg facts/session increases materially vs the 4KB baseline and that `type` is populated. Read a sample of bundles.
8. Full suite + typecheck + build clean.

---

## You will NOT
- Keep head-only truncation as the primary path. Large sessions must be chunked, not cut.
- Silently drop content. Sampling (when `max_chunks` is hit) must be logged + recorded in the bundle (`sampledChunks/totalChunks`).
- Skip `redactSecrets` on any chunk. Every chunk is redacted before leaving the process.
- Send more than `max_call_tokens` to a single LLM call (context-window blowout).
- Claim done on fact count or exit code. Acceptance = reading the re-compressed fact bundle bytes and confirming the previously-lost procedures/decisions appear (lesson #2).
- Add a second LLM call for the reduce step unless deterministic merge proves insufficient (cost). If you must, Stop-and-ask.

## Stop and ask
1. Deterministic title-similarity merge produces poor dedup (same fact split across chunks not merging) → confirm before adding an LLM reduce call (+cost).
2. The 14 MB outlier session would need ~220 chunks even capped — confirm `max_chunks: 8` sampling is acceptable coverage for such giants, or whether they should be flagged for a different handling (e.g. compact-raw first).
3. Raising `max_input_bytes` to 48000 pushes monthly cost from ~$0.86 to ~$3-4 — confirm the budget (you indicated $4-10/mo is acceptable).
4. `type` classification disagrees with the existing wiki dir of a page being updated → confirm precedence (existing page type wins vs fact type).

## Cost (grounded in the empirical token counts)
- 4KB now: 1,098 in tok/session → $0.86/mo.
- 48KB window: ~13K in tok/session → **~$3-4/mo** ongoing.
- **One-time re-compress** of 1,619 sessions at the larger window: ~1,619 × ~13K in + ~600 out tok ≈ **~$4-5 one-time** (giants chunked/sampled, bounded).
- The 66 giant sessions, capped at `max_chunks: 8`, stay bounded (no 220-chunk runaway).

## Commit boundaries
- Task 1: `feat(compress): windowed + map-reduce compression, replace 4KB head-truncation (Phase 4.38 Task 1)`
- Task 2: `feat(compress): type field on facts; route decisions/procedures from compress (Phase 4.38 Task 2)`
- Task 3: `feat(compress): compressVersion watermark forces re-compress (Phase 4.38 Task 3)`
- Task 4: `feat(compress): cost logging + honest sampling record + per-chunk redaction (Phase 4.38 Task 4)`
- Task 5: `test: compress coverage — recover lost procedures/decisions, map-reduce, redaction (Phase 4.38 Task 5)`
- Re-compress run: `chore(vault): re-compress 1619 sessions from full raw under windowed compress (Phase 4.38)` — vault commit after verification

## Engineering-lesson alignment
- **#2 read the artifact:** acceptance = reading re-compressed fact bytes, confirming lost procedures/decisions reappear.
- **#3 verify at scale:** 20-session re-compress, not one fixture.
- **#6 no silent caps:** sampling is logged + recorded; cost surfaced.
- **#7 no success on partial evidence:** the claim that drove this brief was verified 3 ways before drafting; the fix is verified by the 64KB empirical recovery, not assumed.
