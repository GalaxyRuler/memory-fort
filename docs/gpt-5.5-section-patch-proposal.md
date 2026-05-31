# GPT-5.5 Pro response — Section-Patch Consolidation (2026-06-01)

Response to the diagnostic prompt about Memory Fort's synthesis-prompt failure
(gpt-4o-mini produces bulleted "Additional Information" appendix instead of
integrating new facts and replacing stale prose). Verbatim from GPT-5.5 Pro.

---

## Diagnosis (with sources)

This is not mainly a retrieval or compression failure; it is an **edit-interface failure**. Your Stage B prompt asks a chat model to produce "one coherent updated page," but it does not give the model a constrained edit primitive such as "replace this section body." The model can satisfy "include new facts" while avoiding the riskier operation "delete or mutate existing prose," so the locally safe completion is: keep old text, append a generic "Additional Information" section, and copy salient fact bullets. That is exactly the failure shown in your artifact. **InkSync's** document-editing work describes the same UI-level problem: standard chat interfaces usually return a revised draft or suggestions in plain text, leaving the user/system to compare and integrate changes manually; their remedy is executable in-document edits, not stronger prose instructions.

Small models are especially vulnerable because your prompt bundles several hard tasks into one generation: detect contradictions, choose target locations, preserve page structure, filter workflow noise, rewrite prose, and maintain factual coverage. Editing research shows this is qualitatively harder than generation. **FineEdit** reports that LLM edit outputs can target incorrect locations or misinterpret semantics, and its qualitative examples include models repeating or preserving content rather than applying the intended change; multi-turn editing also compounds deviations across turns. **EDIT-Bench's 2026** real-world code-editing benchmark similarly finds instructed editing remains challenging even for strong models: it evaluates 40 models and reports that only one model scores over 60% pass@1, with performance varying significantly by context and edit category.

The specific "planned → shipped" miss is a **destructive stale-claim replacement** problem. The model must recognize that "Phase 3 planned" is not just incomplete; it is now false under the new evidence. A chat-completion prompt gives no mechanical distinction between "add a new claim" and "replace an obsolete claim." Current agent-memory surveys make the same systems point: robust memory requires explicit retrieve/update/consolidate operations over an external memory state, and memory quality is strongly tied to the control interface exposed to the model, not just the model's raw intelligence.

## Techniques surveyed (with sources)

1. **Structured outputs / function calling / constrained decoding** — useful but insufficient alone. OpenAI Structured Outputs and Claude structured outputs constrain responses to a JSON schema or compiled grammar, which removes malformed-output classes of failure; they do not guarantee that the semantic edit is correct. Use this to make invalid operations impossible, not to "ask better."

2. **Executable edits / diffs / JSON Patch** — strongest fit. **RFC 6902** defines JSON Patch as ordered operations such as `test`, `remove`, `add`, and `replace`; InkSync shows that executable edits improve transparency and verifiability for document editing; **JSON Whisperer** shows patch-based JSON editing can reduce token usage while staying close to full-regeneration quality when stable identifiers and few-shot examples are used. Verdict: **use a restricted patch API over a Markdown AST**, not free-form page replacement.

3. **Diff-first prompting beats prose-only pleading.** **Aider's** production benchmark found that unified diffs improved GPT-4 Turbo's score from 20% to 61% on a "lazy coding" benchmark and reduced lazy placeholder behavior by 3×; the key lesson is that models behave more rigorously when writing data consumed by a program. Verdict: the model should output machine-applied edit objects, never the final page as unconstrained Markdown.

4. **Planner/editor split** — good architecture. **SWE-Edit 2026** reports that decoupling planning from format-sensitive generation improves edit-format reliability and lowers inference cost; it also finds that different edit modes fit different change complexity. Verdict: use a cheap planner to decide facts/sections, then a scoped renderer to rewrite only dirty section bodies.

5. **Few-shot examples** — use as a schema stabilizer, not as the main guardrail. JSON Whisperer reports patch generation benefits from appropriate few-shot examples, and InkSync used examples to define its executable-edit language. Verdict: include 2–3 compact examples inside the planner/renderer prompts, especially the "planned → shipped" stale-claim replacement case, but rely on code invariants for enforcement.

6. **Frontier models** — reduce frequency, do not solve the invariant. GPT-5-class models are marketed for coding and agentic tasks, but real-world editing benchmarks still show substantial failure rates; EDIT-Bench's best reported model reaches 66.67% pass@1, not anything close to structural reliability. Verdict: use GPT-5/Claude Sonnet as escalation on validation failure, not as the core fix.

## Recommended design

Use a **Restricted Section Patch compiler**. The invariant is simple:

- The LLM never outputs the final page.
- The LLM never has an append operation.
- The only write primitive for knowledge pages is `replace_section_body(section_id, replacement_paragraphs[])`.
- Novel facts must be integrated into an existing section. If no suitable section exists, **code** may create one deterministic controlled section, such as `## Status` or `## Architecture`, based on page type. The model cannot invent `## Additional Information`.

### Page representation

Parse Markdown into a stable `PageIR`:

```json
{
  "frontmatter": {"title": "Memory Fort", "type": "project"},
  "title": "Memory Fort",
  "sections": [
    {
      "section_id": "s_phase_3_retrieval_7f2a",
      "heading": "Phase 3 retrieval",
      "level": 2,
      "body_hash": "sha256:...",
      "body_markdown": "Phase 3 is planned...",
      "claims": [
        {
          "claim_id": "c_phase3_planned_01",
          "text": "Phase 3 is planned.",
          "offset": [0, 19]
        }
      ]
    }
  ]
}
```

Use deterministic sentence segmentation for initial claims. **Do not ask the model to invent claim IDs.** The model can only reference IDs that code created.

### Deterministic pre-filter

Before the LLM sees facts, hard-filter obvious workflow noise:

```python
NOISE_PATTERNS = [
    r"\bTarget:\s*(Codex|Claude|Antigravity)\b",
    r"\bSubagent\s+[A-Z]\b",
    r"\b(git|commit)\s+[0-9a-f]{7,40}\b",
    r"\bworkflow boilerplate\b",
    r"\bprompt\b|\bscratchpad\b|\btool call\b",
]
```

Keep a conservative escape hatch: if a fact matches a noise regex but also has high entity overlap with the target page, mark it `needs_review` instead of dropping it.

### Step table

| Step | Deterministic or LLM | Output |
|---|---|---|
| Parse page to PageIR | deterministic | stable sections, claims, hashes |
| Load top-K facts and hard-filter noise | deterministic | clean fact candidates |
| Plan consolidation | LLM, structured output | section jobs, stale claim IDs, dropped facts |
| Compile patch jobs | deterministic | replace_section_body jobs only |
| Render dirty sections | LLM, structured output | paragraph strings only |
| Validate | deterministic, optional verifier on failure | accept / retry / stage |
| Apply patch and serialize Markdown | deterministic | final page |

### Planner prompt contract

**System prompt:**
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

**Planner output schema** (`PlannerOutput`):
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

**Example planner output for the failure case:**
```json
{
  "section_jobs": [
    {
      "section_id": "s_phase_3_retrieval_7f2a",
      "operation": "replace_section_body",
      "accepted_fact_ids": ["f_phase3_shipped_bm25_voyage_rrf_rerank"],
      "remove_claim_ids": ["c_phase3_planned_01"],
      "required_terms": ["Phase 3", "shipped", "BM25", "Voyage", "RRF", "rerank"],
      "forbidden_terms": ["Phase 3 is planned", "Additional Information", "Target: Codex", "Subagent"],
      "section_claims": [
        {"claim": "Phase 3 retrieval is shipped and live.", "source_fact_ids": ["f_phase3_shipped_bm25_voyage_rrf_rerank"]},
        {"claim": "The retrieval stack combines BM25, Voyage embeddings, RRF fusion, and reranking.", "source_fact_ids": ["f_phase3_shipped_bm25_voyage_rrf_rerank"]}
      ]
    }
  ],
  "dropped_facts": [
    {"fact_id": "f_target_codex_55", "reason": "workflow_noise"},
    {"fact_id": "f_subagent_a_focuses", "reason": "workflow_noise"}
  ],
  "unresolved_conflicts": []
}
```

### Renderer prompt contract

**System prompt:**
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

**Renderer output schema** (`RendererOutput`):
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

**Few-shot example (embedded):**
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

### Code-side merge algorithm

Use RFC 6902 semantics internally, but only allow `test` and `replace`. The LLM should not emit JSON Patch directly; code compiles validated renderer output into a patch.

```python
def consolidate_page(page_path, fact_bundles):
    page_ir = parse_markdown_to_page_ir(page_path)
    facts = select_topk_importance(fact_bundles, min_importance=5, k=8)
    facts = hard_filter_noise(facts, entity=page_ir.title)
    plan = call_planner_structured(page_ir=page_ir, facts=facts)
    validate_plan(plan, page_ir, facts)
    patches = []
    for job in plan.section_jobs:
        section = page_ir.section(job.section_id)
        render = call_renderer_structured(
            section=section, job=job,
            accepted_facts=[facts[fid] for fid in job.accepted_fact_ids],
            remove_claims=[page_ir.claim(cid).text for cid in job.remove_claim_ids],
        )
        validate_render(render, job)
        patches.extend([
            {"op": "test", "path": f"/sections/{section.section_id}/body_hash", "value": section.body_hash},
            {"op": "replace", "path": f"/sections/{section.section_id}/body_blocks",
             "value": [{"type": "paragraph", "text": p} for p in render.replacement_paragraphs]},
        ])
    new_ir = apply_restricted_patch(page_ir, patches)
    new_markdown = serialize_page_ir(new_ir)
    validate_artifact_text(new_markdown, plan)
    archive_history(page_path)
    page_path.write_text(new_markdown)
```

**Validation rules:**
```python
def validate_render(render, job):
    text = "\n\n".join(render.replacement_paragraphs)
    reject_if("## " in text or "# " in text)
    reject_if(re.search(r"(?m)^\s*([-*+]|\d+\.)\s+", text))
    reject_if("Additional Information" in text)
    reject_if(any(term in text for term in job.forbidden_terms))
    reject_if(any(re.search(pat, text) for pat in NOISE_PATTERNS))
    for term in job.required_terms:
        reject_if(term.lower() not in text.lower())
    for removed_claim in job.remove_claim_ids:
        old = lookup_claim_text(removed_claim)
        reject_if(normalize(old) in normalize(text))
```

The important part: even a bad renderer cannot append a section, because the serializer only receives paragraph blocks replacing an existing section body. A bullet dump can still be attempted inside a replacement paragraph, but validator rejection makes it non-writeable.

## Adversarial review of own proposal

**Failure 1 — semantic false pass.** Required-term checks can prove that "BM25," "Voyage," "RRF," and "rerank" appear, but cannot prove the page says the right thing. A model could write "Phase 3 may ship with BM25..." and pass term coverage. **Mitigation:** cheap verifier for high-risk status transitions: input old claim + new fact + rendered paragraph; output `{obsolete_removed: bool, new_fact_asserted: bool, contradiction_remaining: bool}`. Verifier may block or stage, never rewrite.

**Failure 2 — bad section localization.** If the planner maps the shipped retrieval fact to the wrong section, the renderer faithfully rewrites the wrong place. **Mitigation:** deterministic retrieval over section headings/body plus a planner constraint — `section_id` must be among top-3 code-retrieved candidates for at least one accepted fact. If the planner chooses outside that set, stage for review.

**Failure 3 — over-filtering noise.** Regexes for "Target: Codex 5.5" and git hashes are correct for the current bug, not universally. **Safe rule:** "hard drop only when pattern matches AND entity overlap is low"; otherwise mark `needs_review`.

**At N≈200 page updates:** expect retry cascades on pages with messy structure or no good target section. Cap each page at one planner call, one renderer call per dirty section, and one retry with a stronger model. If still fails validation, write a `.staged/<page>.json` review packet instead of writing Markdown.

**Cost estimate (8k in / 2k out per two-section update):**
- GPT-5-mini ≈ $0.015/page
- GPT-5.5 ≈ $0.10/page
- Claude Sonnet 4.6 ≈ $0.054/page

**Frontier escalation** improves prose + contradiction handling, but should not be trusted to enforce structure. Structure is enforced by the operation set + PageIR patch compiler + artifact-level validation.

## Implementation brief (≤300 words)

Add a section-patch consolidation path and retire full-page rewrite for knowledge pages.

**Files to touch:** current Stage B consolidator, current Stage B prompt file, plus new `page_ir.py`, `restricted_patch.py`, `prompts/consolidation_planner.py`, `prompts/section_renderer.py`, and `tests/test_stage_b_artifact.py`.

**Contracts:** parse each Markdown page into PageIR with frontmatter, stable section IDs, body hashes, and sentence-level claim IDs. Load top-K facts as today, then hard-filter workflow noise. Planner LLM returns structured PlannerOutput: `section_jobs[]`, `dropped_facts[]`, `unresolved_conflicts[]`. Only allowed operation is `replace_section_body`. Renderer LLM receives exactly one section job and returns `replacement_paragraphs[]`, no headings or bullets. Code validates schema, section IDs, body hashes, required terms, forbidden terms, removed stale claims, and noise regexes. Code compiles renderer output into restricted JSON Patch with only `test` and `replace`, applies to PageIR, serializes Markdown, archives `.history`, then writes.

**Acceptance test:** fixture current page says "Phase 3 — planned" and fact JSON says "Phase 3 retrieval shipped; BM25+Voyage+RRF+rerank live," plus noise facts "Target: Codex 5.5," "Subagent A," and a git hash. Run consolidation, then **read the final Markdown file bytes**. Assert the artifact prose states Phase 3 retrieval is shipped and includes BM25, Voyage, RRF, and rerank. Assert it no longer asserts Phase 3 is planned and does not contain "Additional Information," "Target: Codex," "Subagent," or the git hash. **Do not accept the test based only on exit code, patch count, or section count.**
