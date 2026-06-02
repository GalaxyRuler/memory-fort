# Codex Implementation Brief — Section-Patch Consolidation (Phase 4.29)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> This builds **on top of** 4.28 (synthesis-first compression + bounded consolidation from facts). 4.28 fixed the upstream unit — *what* the LLM consumes. 4.29 fixes the downstream interface — *how* the LLM writes back. Together they close the loop. Do not regress 4.28: facts still come from `~/.memory/facts/`, top-K by importance, `MAX_LLM_CALLS` cap, `.history` archive.

---

## What this is (root cause, settled)

4.28 shipped: consolidation now reads compressed importance-scored facts, bounded, never raw transcripts. Despite that, the live re-run on `wiki/system/memory-system.md` still produced a polluted page — a generic `## Additional Information` appendix with workflow noise ("Target: Codex 5.5", "Subagent A focuses on…"), Phase 3 still asserted as "planned" alongside the new "shipped" prose, and the dashboard described twice. We verified by reading the artifact bytes after the run.

The diagnosis is **not** a fact-quality problem (the facts were clean) and **not** a retrieval problem (the right facts were selected). It is an **edit-interface failure**: Stage B prompts a chat model to emit one coherent updated page, but gives it no constrained edit primitive. "Include new facts" is locally satisfiable by appending. "Replace stale prose" is the riskier operation that small models avoid. The model therefore preserves old text and grows an appendix — exactly the polluted page we observed. InkSync (UIST 2024) describes this same UI-level pathology: chat-shaped outputs leave the system to reconcile changes manually; the remedy is *executable in-document edits*.

The "Phase 3 planned → shipped" miss is the same shape narrower: a chat completion has no mechanical distinction between "add a new claim" and "replace an obsolete claim". FineEdit (EMNLP 2025) reports this exact failure mode — edit outputs targeting wrong locations or preserving content instead of mutating it. EDIT-Bench (2026) measures it: on 40 models, only one exceeds 60% pass@1 (claude-sonnet-4 at 64.81%). Structural reliability is not achievable by picking a better model.

The fix is to remove the unconstrained edit primitive. The LLM never writes the page. The only write op available is `replace_section_body(section_id, paragraphs[])` over a parsed Markdown AST. Free-form rewrite is deleted from the operation set.

### Grounding (verified sources only)

- **InkSync** (Laban et al., UIST 2024, arXiv:2309.15337) — chat-shaped revisions force manual reconciliation; executable in-document edits are the remedy. *Frames the diagnosis.*
- **FineEdit** (arXiv:2502.13358, EMNLP 2025 Findings) — LLM edits target wrong locations and preserve content instead of mutating; multi-turn editing compounds drift. *Frames the failure mode.*
- **EDIT-Bench** (arXiv:2511.04486, leaderboard at waynechi.com/edit-bench) — 40-model evaluation; best score is **64.81% pass@1** (claude-sonnet-4), only one model >60%. *Calibrates expectations: frontier-model swap will not close the gap.*
- **JSON Whisperer** (Duanis et al., arXiv:2510.04717, EMNLP 2025 Industry) — RFC-6902 patch editing of JSON with EASE stable identifiers; 31% token reduction, quality within 5% of full regeneration. *Justifies patch-based editing with stable IDs.*
- **RFC 6902 — JSON Patch** (datatracker.ietf.org/doc/html/rfc6902) — defines `test`, `replace`, `add`, `remove`, `move`, `copy`. We use only `test` and `replace`. *Justifies optimistic-concurrency via `body_hash`.*
- **Aider unified-diffs benchmark** (aider.chat/docs/unified-diffs.html) — GPT-4 Turbo: 20% → 61% on laziness benchmark, 3× fewer lazy placeholders, when emitting machine-applied edits instead of prose. *Justifies "model writes data consumed by a program, not Markdown".*
- **SWE-Edit** (arXiv:2604.26102, April 2026) — Viewer + Editor decomposition: +3.5pp edit success, –17.9% inference cost. The "Viewer" is closer to retrieval than planning, but the load-bearing claim — *decouple high-level reasoning from format-sensitive generation* — is what we apply. *Justifies planner/renderer split.*
- **OpenAI Structured Outputs** (developers.openai.com/api/docs/guides/structured-outputs) — exact JSON-schema adherence; eliminates malformed-output failure class but does not guarantee semantic correctness. *Justifies "use it to make invalid ops impossible, not to ask better."*
- **agentmemory consolidation architecture** (`C:/Users/Admin/.memory/wiki/references/agentmemory-consolidation-architecture.md`) — versioned-lineage (`version`, `parentId`, `supersedes`, `isLatest`) we ported in 4.28; PageIR must extend this, not parallel it.

The numbers above are the verified ones. An earlier draft cited EDIT-Bench's best score as 66.67%; the live leaderboard says 64.81%. The argument is unchanged either way (no model is structurally reliable), but the number is corrected here.

---

## The port (TypeScript, adapted to memory-system's repo)

Codebase audit (2026-06-01) found two current Stage B rewrite paths to retire:

- `src/compile/fact-consolidate.ts:53-157` — `runFactConsolidation()` calls `buildSynthesisPrompt()` (`:222-256`) and `chatWithTimeout()` (`:258-273`) with system message `"Return only JSON: {\"body\": string}."`, then emits a single `rewrite_page` op with the whole body replaced. No structured output. No section granularity.
- `src/compile/execute.ts:748-960` — `rewriteExistingKnowledgePageUpdate()` calls `buildKnowledgeNoveltyPrompt()` then a chat returning `{ hasNewFacts, body }`; on positive, emits another `rewrite_page` op with the full body. The `guardRewriteOperation()` at `:1111` checks prose presence and confidence but does not validate semantic content.

Both replace the **entire body string**. There is no PageIR, no claim extraction, no patch operation type, no structured-output support in `LLMProvider` (`src/llm/types.ts:12-18` accepts only `messages`, `maxTokens`, `temperature`, `signal`). 4.29 introduces the missing layer beneath the operation model: a parsed-AST representation, a planner/renderer split, and a restricted patch compiler. The existing `compile-ops` operation pipeline stays — we add `section_patch` as a new op variant and route the new path through it.

### Task 1 — `LLMProvider` structured-output support

Extend `LLMRequest` (in `src/llm/types.ts`) with optional `jsonSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean }`. Implement in `src/llm/openrouter.ts` by passing `response_format: { type: "json_schema", json_schema: {...} }` to the OpenAI SDK. In `src/llm/ollama.ts`, when `jsonSchema` is set, throw `LLMConfigError("structured output not supported for Ollama provider")`. The planner and renderer require schema enforcement; **Ollama is therefore not supported for the 4.29 consolidation path** and we surface that explicitly rather than silently degrading. Document this in `docs/cli.md`.

**Files**: `src/llm/types.ts`, `src/llm/openrouter.ts`, `src/llm/ollama.ts`.

### Task 2 — `PageIR` parser

Create `src/compile/parse-pageir.ts`. Use the `remark` / `remark-gfm` / `unified` ecosystem (add as deps if not present; verify before adding). Walk the AST and emit:

```ts
type PageIR = {
  frontmatter: Record<string, unknown>;
  title: string;
  page_version: number;          // from frontmatter.version, default 1
  sections: Section[];
};
type Section = {
  section_id: string;             // sha1(page_title + heading_path + position_index).slice(0,12)
  heading: string;
  level: 2 | 3;                   // only H2/H3 in the initial release
  position_index: number;         // stable index within page; used in section_id
  body_hash: string;              // sha256 of body_markdown
  body_markdown: string;
  body_blocks: Block[];           // typed AST: paragraph | list | code | table | blockquote
  claims: Claim[];                // only from paragraph blocks (see Task 3)
  has_structured_blocks: boolean; // true if any list/code/table — guards renderer
};
type Claim = { claim_id: string; text: string; offset: [number, number] };
```

Mitigations baked in:

- **Section-ID stability across heading renames (failure mode "high").** `section_id` is **not** content-hashed. It is `sha1(page_title || heading_path || position_index)`. Heading-text rename keeps the same `section_id` as long as the position is preserved; pure position-based fallback handles "## Phase 3" → "## Phase 3 retrieval". On rewrites that change a heading, emit the old → new mapping into `wiki/.history/<page>.section-map.json` for grace-period lookup. **Do not** include heading-text in the ID hash.
- **Multi-level headings.** H2 sections may contain H3 subsections; the parser emits H3s as separate `Section` entries with `level: 3`. Initial release renders H2 sections only — H3-targeted jobs are staged (see Task 6). H4+ inside body is treated as part of `body_markdown` and not split.
- **Dated event sections (`### 2026-05-20: …`).** Position-based IDs survive typo fixes in the heading. Same mechanism as the rename case.

### Task 3 — Deterministic claim segmentation (AST-only, not regex)

Create `src/compile/extract-claims.ts`. Reject regex sentence-splitting on raw Markdown (it tokenizes inside code fences, YAML arrays, and inline code as claims; this is unmitigated failure mode "Claim segmentation breaks on code fences"). Algorithm:

1. Only paragraph nodes from the remark AST produce claims. Code blocks, lists, tables, blockquotes, HTML blocks, frontmatter — never.
2. Within paragraph text, strip inline-code spans and link URLs before splitting. Wikilinks (`[[…]]`) are kept verbatim but not segmented on the inner text.
3. Sentence split: `Intl.Segmenter('en', { granularity: 'sentence' })` when available, else a guarded regex over the cleaned plaintext.
4. `claim_id = "c_" + sha1(section_id || normalized_text).slice(0,10)`. Code creates all IDs. The LLM never invents one.

Edge cases (from the adversarial review) explicitly handled here: code fences with periods, YAML arrays in inline frontmatter references, embedded wikilinks, inline code with claim-shaped text.

### Task 4 — Hard noise filter

Create `src/compile/filter-noise.ts`. Reuse the 4.28 fact selection (`importance ≥ 4`, top-8 per concept) and additionally drop facts matching workflow-noise patterns **only when entity overlap with the target page title is low**. Patterns (TypeScript regex):

```ts
const NOISE_PATTERNS = [
  /\bTarget:\s*(Codex|Claude|Antigravity)\b/i,
  /\bSubagent\s+[A-Z]\b/,
  /\b(git|commit)\s+[0-9a-f]{7,40}\b/,
  /\bworkflow\s+boilerplate\b/i,
  /\b(prompt|scratchpad|tool\s+call)\b/i,
];
```

Conservative escape hatch: if a fact matches noise **and** entity overlap with the page is ≥ 0.5 (Jaccard over normalized title tokens), mark `needs_review` instead of dropping. Mitigates failure mode "over-filtering noise".

### Task 5 — Planner LLM call (structured output)

Create `src/compile/planner.ts`. Single LLM call per page. Input: `PageIR` + selected facts + top-3 retrieval candidates per fact. Output adheres to `PlannerOutput` (schema embedded verbatim below). System prompt verbatim:

```
You are Memory Fort's consolidation planner.
You do not write Markdown.
You do not rewrite the page.
You choose which existing section bodies must be replaced.
Rules:
1. Use only the supplied section_id, claim_id, and fact_id values.
2. The only operation is replace_section_body.
3. There is no append operation.
4. If a new fact contradicts an old claim, include the old claim_id in remove_claim_ids.
5. Drop workflow/process noise even if it appears in facts.
6. If no existing section can receive a fact, put it in unresolved_conflicts. Do not invent a section title.
7. Return JSON matching PlannerOutput exactly.
```

**`PlannerOutput` (verbatim):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["section_jobs", "dropped_facts", "unresolved_conflicts"],
  "properties": {
    "section_jobs": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["section_id","operation","accepted_fact_ids","remove_claim_ids","required_terms","forbidden_terms","section_claims"],
        "properties": {
          "section_id": {"type": "string"},
          "operation": {"enum": ["replace_section_body"]},
          "accepted_fact_ids": {"type": "array", "items": {"type": "string"}},
          "remove_claim_ids": {"type": "array", "items": {"type": "string"}},
          "required_terms": {"type": "array", "items": {"type": "string"}},
          "forbidden_terms": {"type": "array", "items": {"type": "string"}},
          "section_claims": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["claim", "source_fact_ids"],
              "properties": {
                "claim": {"type": "string"},
                "source_fact_ids": {"type": "array", "items": {"type": "string"}}
              }
            }
          }
        }
      }
    },
    "dropped_facts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["fact_id", "reason"],
        "properties": {
          "fact_id": {"type": "string"},
          "reason": {"enum": ["workflow_noise","stale","duplicate","low_importance","unsupported"]}
        }
      }
    },
    "unresolved_conflicts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["fact_ids", "reason"],
        "properties": {
          "fact_ids": {"type": "array", "items": {"type": "string"}},
          "reason": {"type": "string"}
        }
      }
    }
  }
}
```

Few-shot examples embedded in the prompt: (a) the verified failure case (Phase 3 planned → shipped with workflow-noise drops), (b) stale-claim removal where `claim_reason` is `status_change`, (c) a multi-page conflict resolved by routing to `unresolved_conflicts`. Mitigations:

- **Bad section localization.** Code computes top-3 retrieval candidates per fact (lexical match on heading + body). Planner is constrained: every `section_jobs[i].section_id` must appear in the top-3 set for at least one of its `accepted_fact_ids`. Code rejects the plan and stages otherwise.
- **Stale-claim removal requires semantic match.** Each `remove_claim_ids[i]` is validated to exist on the target section's claim list; if it does not, the plan is rejected. We accept the adversarial-review point that ID-match alone does not guarantee semantic equivalence and add a `claim_reason` (`status_change | clarification | contradiction | superseded`) as an optional planner field; required when the section_job removes any claim. See Task 8's verifier for the semantic check.
- **Multi-page entity arbitration.** Code passes the candidate-page ranking (exact title match > entity overlap ≥ 0.8 > older `created_at`) to the planner as input; the planner records which page it chose. Ambiguous cases (no clear winner) go to `unresolved_conflicts` rather than being routed.

### Task 6 — Renderer LLM call (structured output)

Create `src/compile/renderer.ts`. One LLM call **per dirty section** (not per page). Input: the chosen `Section`, the `section_job`, full text of accepted facts, full text of claims to remove. System prompt verbatim:

```
You are Memory Fort's section renderer.
You rewrite exactly one existing section body.
You do not write a page.
You do not write headings.
You do not write bullet lists.
You do not include an appendix, changelog, or "Additional Information".
You must remove claims listed in remove_claims.
You must integrate accepted section_claims as prose.
You must preserve still-valid context from current_section when it does not conflict.
Return JSON matching RendererOutput exactly.
```

**`RendererOutput` (verbatim):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["section_id", "replacement_paragraphs", "coverage"],
  "properties": {
    "section_id": {"type": "string"},
    "replacement_paragraphs": {
      "type": "array",
      "minItems": 1,
      "maxItems": 4,
      "items": {"type": "string", "minLength": 80, "maxLength": 900}
    },
    "coverage": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["fact_id", "paragraph_index"],
        "properties": {
          "fact_id": {"type": "string"},
          "paragraph_index": {"type": "integer"}
        }
      }
    }
  }
}
```

Few-shot example (embedded verbatim):

```
Current section: "Phase 3 is planned. It will add retrieval later."
Remove claims: ["Phase 3 is planned."]
Accepted claims: ["Phase 3 retrieval is shipped and live.", "The retrieval stack combines BM25, Voyage embeddings, RRF fusion, and reranking."]
Valid output: {
  "section_id": "s_phase_3",
  "replacement_paragraphs": ["Phase 3 retrieval is now shipped. The live retrieval path combines BM25 lexical search with Voyage embeddings, merges candidates with reciprocal-rank fusion, and runs a reranker before consolidation. The previous plan-only wording is obsolete; remaining work should focus on evaluation, tuning, and operational reliability rather than first implementation."],
  "coverage": [{"fact_id": "f_phase3_shipped", "paragraph_index": 0}]
}
```

Mitigations:

- **Renderer cannot emit lists/tables/code (failure mode "high").** If `section.has_structured_blocks === true`, the section is **not** dispatched to the renderer. The planner is told this section is read-only-for-rewrite via `forbidden_targets`. Any plan that targets it is rejected and the job is staged to `wiki/.staged/<page>.<section_id>.json` for manual review. Initial release scope. A future renderer that can emit block-level Markdown can lift this restriction; this brief does not.
- **Empty section after fact removal.** If `replacement_paragraphs` is empty, validator rejects. If post-validation the section ends up with no claims (all removed, no replacements), planner must instead emit a `delete_section` request — **not implemented in this brief**. Until then, stage and stop-and-ask.
- **Temporal anchoring.** Renderer prompt is told accepted facts carry `observed_at`; encourage phrases like "As of 2026-05-22, Phase 3 shipped" instead of bare assertions. Not enforced (would over-constrain prose), but encouraged in the few-shot example bank.

### Task 7 — Restricted patch compiler

Create `src/compile/patch-compiler.ts`. Compile each validated renderer output into RFC-6902 ops with **only** `test` and `replace`. No `add`. No `remove`. No `move`/`copy`. Apply against the parsed `PageIR`:

```ts
type SectionPatch =
  | { op: "test"; path: `/sections/${string}/body_hash`; value: string }
  | { op: "replace"; path: `/sections/${string}/body_blocks`; value: Block[] };
```

The compiler:

1. Adds a `test` op against the current `body_hash` (optimistic concurrency — if the page changed underneath us between PageIR parse and patch apply, the patch aborts).
2. Adds a `replace` op against `body_blocks` constructed from `replacement_paragraphs[]` (each becomes `{ type: "paragraph", text }`).
3. Wraps the patch list into a new `CompileOperation` variant `section_patch` in `src/compile/execute.ts`. The existing `rewrite_page`, `write_page`, `append_page` handlers remain for non-knowledge pages and for `.history` archival writes; the knowledge-page consolidation path emits only `section_patch`.

### Task 8 — Artifact validator (deterministic + optional verifier)

Create `src/compile/validate-patch.ts`. Run **after** renderer output, **before** the patch compiles to a `section_patch` op. Rules — the *operation set itself* is structural enforcement, the validator is belt:

```ts
function validateRender(render, job, section) {
  const text = render.replacement_paragraphs.join("\n\n");
  rejectIf(/^#{1,6}\s/m.test(text), "render emitted heading");
  rejectIf(/^\s*([-*+]|\d+\.)\s+/m.test(text), "render emitted list");
  rejectIf(/```/.test(text), "render emitted code fence");
  rejectIf(/Additional Information/i.test(text));
  rejectIf(job.forbidden_terms.some(t => text.includes(t)));
  rejectIf(NOISE_PATTERNS.some(p => p.test(text)));
  for (const t of job.required_terms) rejectIf(!text.toLowerCase().includes(t.toLowerCase()));
  for (const cid of job.remove_claim_ids) {
    const old = section.claims.find(c => c.claim_id === cid)?.text;
    rejectIf(old && normalize(text).includes(normalize(old)), "stale claim still present");
  }
}
```

**Semantic verifier for status transitions (Failure 1 mitigation, adversarial review).** When a `section_job` has both `remove_claim_ids` and `accepted_fact_ids`, run a cheap LLM verifier: input `{ old_claim_text, new_fact_text, rendered_paragraph }`; output `{ obsolete_removed: bool, new_fact_asserted: bool, contradiction_remaining: bool }`. If `contradiction_remaining === true` or `obsolete_removed === false`, fail validation. Verifier may block or stage; it does **not** rewrite.

**Required/forbidden term semantic-collision risk** (adversarial review): `required_terms` of `["BM25", "shipped"]` can both appear in "Phase 3 may ship with BM25" — passing term coverage while semantically wrong. The verifier above is the safety net; do not rely on term coverage alone.

**Wikilink-drift check (drift lesson #6).** Before applying any patch that changes a section's body, compute the set of inbound `[[wikilinks]]` to this page (cheap grep over `wiki/`). If a heading was renamed and an inbound wikilink targets the old anchor, emit a WARNING and include the affected inbound pages in `unresolved_conflicts` for the operator to resolve. Do not auto-rewrite the inbound pages.

**Drift check on the prompts (lesson #6).** Renderer/planner system prompts and few-shot blocks live in `src/compile/prompts/`. Add a build-time check (`scripts/check-prompt-drift.ts`) that re-reads the prompt files and asserts that the shipped operator names (`replace_section_body`), forbidden phrases (`Additional Information`), and schema field names match the TypeScript types. Fail the build if drift is detected. This is the analog of agentmemory's prompt-template loader check.

### Task 9 — Wire it in, retire the dead-ends

Modify `src/compile/fact-consolidate.ts` and `src/compile/execute.ts:748-960`:

- Replace `buildSynthesisPrompt()` + `chatWithTimeout()` + `parseSynthesisBody()` in `fact-consolidate.ts` with a call to the planner → renderer → patch-compiler pipeline. Output is `CompileOperation[]` of `section_patch` ops, not `rewrite_page`.
- Replace `rewriteExistingKnowledgePageUpdate()` and `buildKnowledgeNoveltyPrompt()` in `execute.ts` similarly. The novelty-detection LLM call (`:836-868`) is deleted — its job is folded into the planner.
- Keep `guardRewriteOperation()` for the non-knowledge-page paths and as a final-gate consistency check.
- Wire `version`/`supersedes`/`parentId` from 4.28's versioned-lineage into PageIR frontmatter. On patch apply: `page_version += 1`, write the prior file to `wiki/.history/` (already built), record `supersedes` on the new file. **Mitigates the "Interaction with .history versioning" failure mode** — the patch's `test` op guards against dueling edits within a run; the version bump prevents silent supersession loss across runs.

### Task 10 — Tests (read the artifact, at scale)

Create `tests/compile/section-patch-consolidation.test.ts`.

**Test 1 — verified failure case (the page that triggered this brief).** Fixture: a copy of the real polluted `wiki/system/memory-system.md` plus the actual fact files under `~/.memory/facts/` that the live run used. Run the new consolidation pipeline. Then **read the final Markdown bytes**. Assert:

- File **contains** prose stating Phase 3 retrieval is shipped, and contains the strings `BM25`, `Voyage`, `RRF`, `rerank`.
- File **does not contain** `Phase 3 is planned`, `Additional Information`, `Target: Codex`, `Subagent`, or any 7-40 char hex git hash.
- The dashboard is described exactly once (no duplication).
- Frontmatter `version` is incremented; `wiki/.history/` contains the prior file; `supersedes` points to it.

**Test 2 — at-scale verification (lesson #3).** Run the full vault consolidation (~200 knowledge pages) end-to-end on a snapshot. Assert: no run hangs >2 min per page; total `LLM` calls ≤ `MAX_LLM_CALLS × pages_dirty`; no `.staged/` writes for clean pages; exit clean. Lesson-#3 compliance: scale is where section drift and claim segmentation failures surface; the test must run at vault-real size, not a hand-picked fixture.

**Test 3 — idempotence.** Re-run consolidation with no new facts. Assert: zero `section_patch` ops emitted; zero `.history` writes; page bytes unchanged.

**Test 4 — staged-job path.** A page with a section containing a code fence and a list. Planner targets it. Assert: no renderer call is made for that section, a `.staged/<page>.<section_id>.json` review packet is written, the rest of the page consolidates normally.

**Test 5 — `test` op failure.** Page is mutated between PageIR parse and patch apply. Assert: patch aborts with `body_hash` mismatch; no partial write; clear error.

**Lesson #2 explicit compliance.** Every assertion above is on file bytes after the run, not on exit code, op count, or section count. Do **not** add an assertion of the form `expect(result.opsApplied).toBeGreaterThan(0)` — that is the proxy lesson #2 forbids.

### Task 11 — Docs

- `docs/MEMORY-FORT-SPEC.md`: add the Stage B' section-patch pipeline (PageIR → planner → renderer → restricted patch). Diagram the operation set. Cite this as the downstream complement to 4.28's upstream compression.
- `docs/cli.md`: note the Ollama incompatibility for the consolidation path.
- `docs/ROADMAP.md`: Phase 4.29 shipped.

---

## Acceptance contract

1. **Content-based, read the artifact.** The polluted `memory-system.md` becomes a clean, current page — Phase 3 stated as shipped with the real stack, no `Additional Information`, no workflow noise, dashboard described once. Verified by reading the file bytes, not by exit code or op count (lesson #2).
2. **At scale.** The full ≈200-page vault consolidation completes bounded, with no per-page hangs and no regressions on already-good pages. Lesson #3.
3. **Structural invariants enforced by code, not by prompt.** The renderer cannot emit a heading, list, code fence, or appendix — not because we asked, because the operation set has no primitive for it and the validator rejects (lesson #4).
4. **Idempotent.** Re-running on the same inputs writes nothing.
5. **Versioned.** Every successful patch bumps `version`, writes `supersedes`, archives prior to `.history`. No regressions to 4.28.
6. **Full suite + typecheck + build clean.**

---

## Commit boundaries

- Task 1: `feat: add structured-output (json_schema) support to LLMProvider (Phase 4.29 Task 1)`
- Task 2: `feat: PageIR parser — remark-AST sections, body_hash, position-based section_id (Phase 4.29 Task 2)`
- Task 3: `feat: AST-only claim segmentation, code-deterministic claim_ids (Phase 4.29 Task 3)`
- Task 4: `feat: noise filter with entity-overlap escape hatch (Phase 4.29 Task 4)`
- Task 5: `feat: consolidation planner with structured output (Phase 4.29 Task 5)`
- Task 6: `feat: section renderer with structured output (Phase 4.29 Task 6)`
- Task 7: `feat: restricted RFC-6902 patch compiler (test/replace only) (Phase 4.29 Task 7)`
- Task 8: `feat: artifact validator + semantic verifier + wikilink drift check (Phase 4.29 Task 8)`
- Task 9: `refactor: route knowledge-page consolidation through section_patch; retire rewrite_page novelty path (Phase 4.29 Task 9)`
- Task 10: `test: section-patch consolidation, verified failure case + at-scale (Phase 4.29 Task 10)`
- Task 11: `docs: section-patch consolidation pipeline (Phase 4.29 Task 11)`

---

## You will **not**

- Emit `rewrite_page` for knowledge pages. The only write op for them is `section_patch`.
- Add an `append_section_body` or `add_section` op. None exists. Code may create one deterministic controlled section by page type (`## Status`, `## Architecture`) — the LLM cannot.
- Let the LLM invent a `section_id`, `claim_id`, or `fact_id`. All IDs come from code.
- Let the renderer emit headings, lists, tables, code fences, blockquotes, or the literal string `Additional Information`. The validator rejects all six.
- Write to `wiki/.history/` directly from the new path. The existing archival hook in 4.28 handles it; do not parallel-implement.
- Accept a test that asserts on exit code, op count, section count, or "no exception thrown". The acceptance gate is the final Markdown bytes (lesson #2).
- Run consolidation through the planner/renderer with Ollama. Surface `LLMConfigError`, do not silently downgrade.
- Regress 4.28: facts still come from `~/.memory/facts/`, importance-filtered, top-K per concept, capped by `MAX_LLM_CALLS`.

---

## Stop and ask

Stop the implementation and ask if any of these arise:

1. **Section ends up empty after fact removal** with no replacement paragraphs. The current scope does not include `delete_section`; need product call.
2. **A page's target section contains structured blocks** (list, table, code fence) and there is no other suitable section. Initial release stages this; need decision on whether to expand renderer or to expand staging UX.
3. **Multi-page entity arbitration produces a tie** (two pages with equal title-match and entity-overlap scores). Routing rule needs to be defined before shipping.
4. **`remark` / `remark-gfm` adds >10 MB to the dependency tree** or pulls a peer-dep conflict. Need to evaluate `markdown-it` AST as alternative.
5. **Inbound wikilink drift** — a heading rename breaks N inbound links across the vault. Auto-fix is out of scope; need to decide whether to block the patch or stage with a warning.
6. **Semantic verifier rejection rate exceeds 30%** on the at-scale test. Means the planner/renderer prompts are mis-specified; do not paper over with retries.
7. **The 4.28 fact layer is missing facts the test expects.** Means we are testing the wrong layer; re-run compression first, do not weaken the test.
8. **Build-time prompt-drift check trips on its first run.** Means the schemas and prompts are out of sync as written; fix before committing Task 5/6, do not silence the check.

---

## Engineering-lesson alignment (explicit)

| Lesson | How 4.29 satisfies it |
|---|---|
| 1. Prior art | Grounded in InkSync, FineEdit, EDIT-Bench, JSON Whisperer, RFC 6902, Aider, SWE-Edit, OpenAI Structured Outputs, and extends — not replaces — agentmemory's versioned-lineage already ported in 4.28. |
| 2. Read the artifact, not the proxy | Acceptance gate is final Markdown bytes; explicit ban on exit-code/op-count assertions. |
| 3. Verify at scale | Test 2 runs the full ≈200-page vault, not a fixture. |
| 4. Deterministic enforcement over prompting | The operation set has no append primitive. The validator rejects headings/lists/forbidden terms. Prompt rules are belt; the op set is suspenders. |
| 5. Ground in research | Sources block at the top of this brief lists verified citations only; the EDIT-Bench number was corrected from 66.67% to 64.81% before drafting. |
| 6. Drift checks | Build-time `check-prompt-drift.ts` cross-validates prompt text against TypeScript schema names; inbound-wikilink check guards against silent reference rot. |
| 7. Right unit, right time | 4.28 fixed the upstream unit (compress at capture); 4.29 fixes the downstream interface (section-patch at write). Together they close the synthesis-early / write-narrowly loop. |
