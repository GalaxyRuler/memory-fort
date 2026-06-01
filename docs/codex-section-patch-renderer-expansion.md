# Codex Implementation Brief — Section-Patch Renderer Expansion (Phase 4.30)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Resolves both Stop-and-Ask cases from Phase 4.29: structured-block staging and renderer producing forbidden text.

---

## What this is (verified live 2026-06-01)

Phase 4.29 shipped the section-patch pipeline. Two issues surfaced during live testing:

**Issue 1 — Structured blocks stage silently**: `memory-system.md` has a `## Phase status` section containing a checkbox list (`- [x] / - [ ]`). The current renderer is paragraph-only by design (Task 6 / Stop-and-Ask #2 in 4.29). The result is correct-but-limited: the page stages, nothing writes, operator must review manually.

**Issue 2 — Renderer still outputs "Additional Information" text**: On a paragraph-only fixture page, the renderer ran (no 400 anymore after the schema fix), but its output contained the phrase "Additional Information" — caught by the artifact validator and staged instead of writing. The structural schema (no headings, no lists) works, but the renderer's output included the forbidden phrase *inside a paragraph string*. The validator blocked it (correct), but the renderer should not generate it in the first place.

These are two separate improvements needed before the acceptance test can pass.

---

## Issue 1 fix — Structured-block renderer expansion

### Task 1 — List-preserving renderer mode

The renderer currently produces `replacement_paragraphs: string[]` (paragraph text only). Extend the renderer output to support a `replacement_blocks` field:

```ts
type RendererBlock =
  | { type: "paragraph"; text: string }
  | { type: "checklist"; items: { checked: boolean; text: string }[] }
  | { type: "list"; ordered: boolean; items: string[] };

type RendererOutputV2 = {
  section_id: string;
  replacement_blocks: RendererBlock[];
  coverage: { fact_id: string; block_index: number }[];
};
```

Rules:
- The renderer receives the section's current `body_blocks` (from PageIR, Task 2 in 4.29) so it knows existing structure.
- For checklist sections (like `## Phase status`): the renderer receives the current checklist items. It may **check or uncheck existing items** and **add new items** at the end. It may **not** remove existing items (append-only for list items — same invariant as knowledge prose: no deletions). It may **not** reorder items.
- For paragraph sections: behavior unchanged from 4.29 (`replacement_paragraphs`).
- Serializer converts `RendererBlock[]` → Markdown deterministically. Code does the serialization; the LLM never writes Markdown directly.

### Task 2 — Update validator for v2 output

Extend `validate-patch.ts` to validate `replacement_blocks`:
- `paragraph` blocks: same rules as current (no headings, no lists, no forbidden terms, no "Additional Information").
- `checklist` blocks: no new items that match NOISE_PATTERNS; new items must be linked to at least one `fact_id` in coverage; no re-ordering (assert item order matches current except for appended items).

### Task 3 — Update renderer prompt

Add a few-shot example for checklist sections:
```
Current section (checklist):
items: ["[x] Phase 1 shipped", "[ ] Phase 3 — planned"]
New fact: "Phase 3 retrieval shipped (BM25+Voyage+RRF+rerank)"
Valid output:
{
  "section_id": "s_phase_status_...",
  "replacement_blocks": [
    {"type": "checklist", "items": [
      {"checked": true, "text": "Phase 1 shipped"},
      {"checked": true, "text": "Phase 3 retrieval — shipped (BM25+Voyage+RRF+rerank, 2026-05-31)"}
    ]}
  ],
  "coverage": [{"fact_id": "f_phase3_shipped", "block_index": 0}]
}
```

---

## Issue 2 fix — Renderer forbidden-phrase enforcement

### Task 4 — Strengthen renderer prompt + few-shot

The renderer system prompt already says "You do not include an appendix, changelog, or 'Additional Information'." But the model still produces it in paragraph text. Two-part fix:

**Part A — Negative few-shot (the most effective lever, per Aider benchmark findings):** Add an explicit bad-output example to the renderer prompt showing the failure mode and why it is rejected:

```
BAD output (rejected by validator):
{
  "replacement_paragraphs": [
    "Phase 3 retrieval has shipped.",
    "Additional Information: The pipeline executed on 2026-06-01."
  ]
}
Reason: paragraph text contains "Additional Information" — forbidden phrase.

GOOD output:
{
  "replacement_paragraphs": [
    "Phase 3 retrieval shipped on 2026-05-31. The live path combines BM25 lexical search with Voyage embeddings, merges with RRF, and runs a reranker before consolidation. The previous planned-state wording is obsolete."
  ]
}
```

**Part B — `forbidden_terms` enforcement in the validator is already present** (from 4.29 `validate-patch.ts`). Confirm "Additional Information" is in the default `forbidden_terms` list passed to every renderer job, regardless of the planner output. It should be a hardcoded baseline, not relying on the planner to include it.

---

## Tests (acceptance = read the bytes, rule #2)

### Test 1 — Checklist section (the `memory-system.md` case)
Fixture: a copy of `wiki/references/section-patch-fixture.md` extended with a `## Plan` section containing checkboxes. Fact: "Phase 4.29 shipped." Run curate --refresh. Read the final bytes. Assert:
- The `## Plan` section now contains a checked `[x] Phase 4.29 shipped` item.
- No existing checklist items were removed or reordered.
- No "Additional Information" in the output.
- `.history` archive written; `version` incremented.

### Test 2 — Paragraph-only "planned → shipped" (the original acceptance test)
The fixture page at `wiki/references/section-patch-fixture.md` (paragraph-only, Status section says "currently planned"). Fact: "Phase 4.29 section-patch validated 2026-06-01." Run curate --refresh. Read the bytes. Assert:
- "currently planned" is gone from `## Status`.
- "shipped" or "validated" appears in `## Status`.
- No "Additional Information" anywhere.
- `.history` archive written.
- **This is the acceptance gate that was blocked by Issue 2 in 4.29.** Must pass here.

### Test 3 — Validator rejects "Additional Information" in paragraph
Inject a mock renderer that returns `replacement_paragraphs: ["Additional Information: new facts here."]`. Assert the validator throws and stages, the canonical page is unmodified.

---

## You will **not**
- Allow list item deletion or reordering (append-only invariant for list items).
- Let the LLM write Markdown directly — the serializer converts `RendererBlock[]` to Markdown.
- Remove the paragraph-only path — it stays the default for prose sections.
- Weaken the forbidden-phrase validator check.

---

## Acceptance contract
1. `memory-system.md` Phase status checklist can be updated by the pipeline (checked/unchecked/appended) without destroying the list structure.
2. Paragraph-only "planned → shipped" fixture test passes — **read the bytes**, not the op count.
3. "Additional Information" never appears in a successfully written page.
4. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 1: `feat: checklist + list blocks in renderer output (Phase 4.30 Task 1)`
- Task 2: `feat: validator handles v2 replacement_blocks (Phase 4.30 Task 2)`
- Task 3: `feat: renderer prompt checklist few-shot example (Phase 4.30 Task 3)`
- Task 4: `fix: hardcode Additional Information in forbidden_terms baseline; add negative few-shot (Phase 4.30 Task 4)`
- Tests: `test: checklist rendering + planned→shipped paragraph gate (Phase 4.30)`
