# Codex Implementation Brief — Narrative Memory Records (Phase 4.31)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> This brief **retires** the 4.29 section-patch and 4.30 renderer-expansion machinery. It is a deliberate architectural retreat to the pattern that already works in the predecessor `agentmemory` and aligns with 2026 SOTA memory systems. **Lines removed > lines added.**

---

## What this is (root cause, settled empirically 2026-06-01)

After nine phases of synthesis-prompt iteration, an empirical bypass test (`scripts/test-narrative-synthesis.mjs`) ran one direct gpt-4o-mini call on `memory-system.md` + 8 importance-scored facts: 1.66 s, 4,241 chars of valid Markdown, no append-bloat, no "Additional Information." For comparison, the 4.29/4.30 planner+renderer pipeline on the same inputs staged with "render emitted no replacement blocks" and never wrote anything.

The bypass test also revealed the *real* invariant the pattern depends on: **the LLM only writes prose. Code owns every structured field.** When the bypass prompt asked the model to also bump `version` and update `supersedes`, the model ignored both. agentmemory's `consolidate.ts:155-191` works for the same reason — the model only fills `title/content/concepts/strength`; code does `isLatest=false`, `version+1`, `parentId`, `supersedes:[...]`.

memory-system's wiki pages have been treated as **richly-structured Markdown documents to edit in place**. A memory system stores **memory records to supersede whole**. The mismatch is the root cause of every synthesis-prompt failure across 4.22–4.30.

---

## Grounding (verified in source 2026-06-01)

- **agentmemory `src/prompts/compression.ts`** — per-event compression → importance-scored facts. *Already ported as 4.28 (`src/cli/commands/compress.ts`).*
- **agentmemory `src/functions/consolidate.ts:104-194`** — concept-grouped facts → top-K by importance → ONE LLM call with the `CONSOLIDATION_SYSTEM` prompt. Output is a structured `Memory` record. On title match: old `isLatest=false`, new gets `version+1`, `parentId`, `supersedes:[oldId,...]`. *The pattern this brief ports.*
- **agentmemory `src/functions/auto-forget.ts:40-134`** — TTL expiry via `forgetAfter`; contradiction detection sets `older.isLatest=false`. *Maps to Task 5 below.*
- **Bypass test** (committed `scripts/test-narrative-synthesis.mjs`) — verified that one direct LLM call on a real page + real facts produces valid content fast. Found the "code must own structural fields" invariant.

---

## Scope guard

### Task 1 — Knowledge-page format (narrative records)

Knowledge-page types — `projects`, `lessons`, `decisions`, `references`, `tools`, `people`, `prospective` — become **narrative records**: YAML frontmatter + ONE prose body. No `## headings` in the body, no bullet lists, no checklists, no code blocks, no tables. Wikilinks `[[...]]` inline are allowed.

Frontmatter fields (managed by code, NEVER by the LLM):

```yaml
type: projects               # unchanged
title: "memory-system"       # unchanged
created: "2026-05-20"        # unchanged
updated: "2026-06-01"        # code bumps on supersede
version: 7                   # NEW: monotonic; code increments
supersedes: ["v6"]           # NEW: list of prior version markers (history filename)
strength: 9                  # NEW: importance/access score, code decays
last_accessed: "2026-06-01"  # NEW: code bumps on MCP read/search hit
source_facts: ["f_..."]      # NEW: fact IDs that produced the current body
relations: { ... }           # unchanged
tags: [...]                  # unchanged
```

Other page types (`threads`, `procedures`, `index.md`, `log.md`, `schema.md`, `crystals`, dot-directories) keep their current structure. They are not knowledge records.

### Task 2 — Add `synthesizeNarrative()` (the only new code)

New file: `src/compile/synthesize-narrative.ts`. Single export:

```ts
async function synthesizeNarrative(opts: {
  vaultRoot: string;
  pageRelPath: string;            // e.g. "wiki/projects/memory-system.md"
  facts: ConsolidationFact[];     // top-K by importance, already noise-filtered
  llm: LLMProvider;
  now: Date;
}): Promise<SynthesisResult>;
```

Pipeline (two small LLM calls, both with strict JSON schemas):

1. **Detect** — payload: current frontmatter + current body + facts (compressed, not raw). LLM returns `{ contradicted_claims: string[], net_new_facts: string[] }`. If both empty, return `{ outcome: "unchanged" }` and skip step 2.
2. **Synthesize** — payload: current body + `contradicted_claims` (to drop) + `net_new_facts` (to integrate). LLM returns `{ body: string }`. Schema requires `body` to be a single string; no nested structure.

System prompt for **Synthesize** (verbatim, port of agentmemory `CONSOLIDATION_SYSTEM` adapted to in-place narrative pages):

```
You are a memory consolidation engine. You write ONE narrative paragraph (or a short sequence of paragraphs) that updates the CURRENT BODY by:

1. REMOVING the listed contradicted_claims wherever they appear (do not preserve, paraphrase, or rephrase them).
2. INTEGRATING the listed net_new_facts inline as natural prose.
3. PRESERVING all other substantive content verbatim or paraphrased.

Rules:
- Output ONLY prose. No `## headings`, no `- bullets`, no `[x] checkboxes`, no ``` code fences ```, no tables.
- Wikilinks `[[target]]` inline are allowed.
- Do not add "Additional Information", appendices, changelogs, or commentary.
- Do not write metadata, IDs, dates, version numbers, or workflow content. Code handles those.
```

Code wraps the returned `body` with the existing frontmatter (with `updated`, `version+1`, `supersedes:[prior]`, `last_accessed=now`, `source_facts=[fact_ids]` set deterministically) and writes via the existing atomic-write + `.history` archival path.

### Task 3 — Wire `synthesizeNarrative` into the compile + curate paths

Replace the existing knowledge-page consolidation calls:

- `src/cli/commands/curate.ts` — replace the section-patch path for narrative records.
- `src/compile/fact-consolidate.ts` — for knowledge-page targets, call `synthesizeNarrative` instead of `applyCompileOperations({ rewriteLLM, ... })`.
- `src/compile/execute.ts:748-960` (`rewriteExistingKnowledgePageUpdate`) — for narrative records, delegate to `synthesizeNarrative`; for non-knowledge pages (threads etc.), keep current behavior.

### Task 4 — Retire 4.29 / 4.30 machinery (delete code)

Delete or stub out:

- `src/compile/parse-pageir.ts`
- `src/compile/extract-claims.ts`
- `src/compile/planner.ts`
- `src/compile/renderer.ts`
- `src/compile/patch-compiler.ts`
- `src/compile/validate-patch.ts`
- `scripts/check-prompt-drift.ts` 4.29/4.30-specific assertions (keep generic prompt-drift detection from 4.24)
- The 4.29 `section_patch` op kind in `src/compile/execute.ts` and the `rewrite_page` planner backstop in 4.25 (no longer needed; the model never emits ops for knowledge pages)
- The corresponding test files under `test/compile/`

Keep:
- 4.28 compression layer (`src/facts/`, `src/cli/commands/compress.ts`)
- 4.25 no-append invariant on non-knowledge pages
- `.history/` archival
- `prompt.drift` verify check (4.24)
- `commitVaultChange` and the sync layer

### Task 5 — `last_accessed` tracking + strength decay

- **last_accessed bump** — when MCP `read_page` or `search` returns a knowledge page in its results, `last_accessed` is set to now (atomic-write the frontmatter, leave the body untouched, do NOT bump `version` or archive). Same idea as agentmemory `consolidate.ts:155-163` access counters.
- **Decay job** — new `memory decay [--plan|--apply]` command. For each knowledge record, `strength *= 0.9^periods` where `periods = floor((now - last_accessed_days) / 14)`. Records with `strength < 1.0` and no access in 180+ days get archived to `wiki/.archive/` (not deleted). Mirrors agentmemory `auto-forget.ts:40-134`.

### Task 6 — One-time migration command

New: `memory migrate-to-narrative [--plan|--apply]`. For each existing knowledge page that has `## headings` or list items in the body:

1. Read the page (frontmatter + sectioned body).
2. ONE LLM call with the **Synthesize** prompt (same as Task 2) where `contradicted_claims=[]` and `net_new_facts=` the body itself flattened to bullet points by code (`-` lines stripped, sections concatenated).
3. The model returns a single narrative body.
4. Code wraps with frontmatter (version+1, supersedes:[prior], updated:today, strength:8 default, last_accessed:today, source_facts:[]).
5. Archive prior to `.history/`. Write new file.
6. Print before/after line counts. `--plan` previews without writing.

After migration, all knowledge pages are narrative records. New synthesis calls (Task 2) operate on already-clean format.

### Task 7 — Tests (acceptance = read the bytes, lessons #2/#3)

- **Test 1 — the canonical case.** Restore `wiki/projects/memory-system.md` to the 2026-05-22 baseline; load the existing 8 importance-≥6 facts about memory-system. Run `synthesizeNarrative`. Read the final file bytes. Assert:
  - `Phase 3 — planned` is gone; `Phase 3 retrieval` is described as shipped.
  - The text does NOT contain `## ` (any heading), `- ` at line start, `Additional Information`, `Target: Codex`, `Subagent`, or 7+ hex-char git hashes.
  - Frontmatter `version` is 2 (was 1), `supersedes` contains a `.history/` filename, `updated` is today, `last_accessed` is today, `source_facts` is non-empty.
  - `wiki/.history/wiki/projects/memory-system.md/` contains the prior version.
- **Test 2 — idempotent.** Re-run with the same facts. Assert: detect returns `unchanged`, no write, no `.history` entry, no `version` bump.
- **Test 3 — at scale.** Run synthesis on 20 random knowledge pages (importance-filtered facts from `~/.memory/facts/`). Assert: no run hangs >30 s; no run emits a heading or list in body; all writes have `version` and `supersedes` populated.
- **Test 4 — decay.** Fixture page with `last_accessed` 100 days ago, `strength: 5`. Run decay. Assert `strength ≈ 5 * 0.9^7 ≈ 2.4`. Not archived (still >1.0). Re-run with 200 days: strength drops below 1.0, page moved to `wiki/.archive/`, audit row written.

Lesson #2 is non-negotiable: every assertion reads file bytes after the run. No exit-code, no op-count, no "didn't throw" assertions.

### Task 8 — Docs

- `docs/MEMORY-FORT-SPEC.md`: document narrative-record format, the two-stage synthesis, code-owned frontmatter fields, decay, contradiction.
- `docs/cli.md`: add `memory migrate-to-narrative`, `memory decay`. Mark `memory curate` as superseded.
- `docs/ROADMAP.md`: Phase 4.31 shipped; 4.29 and 4.30 retired with rationale.

---

## You will **not**

- Add a section-patch, planner, or renderer back. The whole point of this brief is that they aren't needed.
- Let the LLM write or modify frontmatter. Frontmatter is code-owned. The Synthesize prompt explicitly forbids the model from emitting it.
- Let the LLM choose between "edit" vs "rewrite." There is one operation: write a new narrative body. Code wraps it. Code supersedes.
- Append a dated section, an `## Additional Information` block, or any other structural addition to a knowledge page. Heading/list outputs from the model fail schema validation (the JSON schema requires `body: string` only) and `validate-narrative.ts` rejects any `^#{1,6}` or `^\s*[-*+]\s+` patterns.
- Migrate `threads/`, `procedures/`, `index.md`, `log.md`, `schema.md`, or any dot-directory page. They are not knowledge records.
- Skip the bytes-level acceptance test. Op counts and exit codes are not evidence (lesson #2).

---

## Stop and ask

1. The Detect call returns ≥10 contradicted claims on one synthesis. That looks like over-eager contradiction; pause before applying.
2. A migrated page comes back shorter than 30% of the original. The model may have lost substantive content; stage to `wiki/compile-proposed/` for operator review.
3. Strength decay would archive a page tagged `pinned: true` (new optional frontmatter field for opt-out). Skip and warn instead.
4. The body returned by Synthesize fails to mention any of the page's existing wikilinks. Stage; the model may have dropped relations.

---

## Acceptance contract

1. **`memory-system.md` ends current and clean.** After running `synthesizeNarrative` on the 2026-05-22 baseline with existing facts, the file says Phase 3 is shipped (with the real stack), `updated` is today, `version` is 2, `supersedes` references the prior `.history/` filename, and the body has zero `## headings` and zero `-` list items. **Verified by reading the file bytes.**
2. **Idempotency holds.** A second run with the same facts writes nothing.
3. **At-scale clean.** 20-page random synthesis run produces zero heading/list bodies and zero hangs >30 s.
4. **Decay and access tracking work.** `last_accessed` bumps on MCP retrieval; `memory decay --apply` correctly archives below-threshold pages and adjusts strength.
5. **Code shrunk.** Net deletion from `src/compile/` (4.29 + 4.30 files retired) larger than additions (`synthesize-narrative.ts` + small wiring).
6. **Suite + typecheck + build clean.**

---

## Commit boundaries

- Task 1: `feat: knowledge-page narrative-record schema; frontmatter version/supersedes/strength/last_accessed/source_facts (Phase 4.31 Task 1)`
- Task 2: `feat: synthesizeNarrative — two-stage detect+synthesize, structured JSON, code-owned frontmatter (Phase 4.31 Task 2)`
- Task 3: `refactor: route knowledge-page consolidation through synthesizeNarrative (Phase 4.31 Task 3)`
- Task 4: `refactor: retire 4.29 section-patch + 4.30 renderer expansion (Phase 4.31 Task 4)`
- Task 5: `feat: last_accessed bumping + strength decay job (Phase 4.31 Task 5)`
- Task 6: `feat: memory migrate-to-narrative — one-time flattening of existing knowledge pages (Phase 4.31 Task 6)`
- Tasks 7–8: `test+docs: narrative memory records, bytes-level acceptance (Phase 4.31)`

---

## Engineering-lessons alignment

| Lesson | How 4.31 satisfies it |
|---|---|
| 1. Prior art | Ports agentmemory's `consolidate.ts:104-194` and `auto-forget.ts:40-134` patterns directly. The bypass test that produced this brief is its own form of prior-art check. |
| 2. Read the artifact, not the proxy | Every Test acceptance is on the final file bytes; explicit ban on op-count/exit-code assertions. |
| 3. Verify at scale | Test 3 runs 20 real knowledge pages, not a fixture. |
| 4. Deterministic enforcement over prompting | Strict JSON schema requires `body: string` only — model cannot return arrays/structures. Validator rejects heading/list patterns in `body`. Frontmatter is mechanically code-owned. The "model picks edit vs append" decision is removed entirely from the design — code only knows "replace whole body, supersede old version." |
| 5. Ground in research | agentmemory file:line refs cited; bypass-test result cited as direct evidence; structured-outputs strict-mode lessons from 4.29 carried forward. |
| 6. Source↔deployed drift | The 4.24 `prompt.drift` check still applies (the two short Synthesize/Detect prompts ship as template files and get drift-checked). |
| 7. Right unit, right time | 4.28 fixed the upstream unit (compress at capture). 4.31 fixes the downstream unit (narrative record, not richly-structured wiki page). 4.29/4.30 attempted the right operation on the wrong unit; retired. |
