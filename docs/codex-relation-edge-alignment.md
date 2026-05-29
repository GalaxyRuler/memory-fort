# Codex Implementation Brief — Relation-Edge Validation + Grounding Alignment (Phase 4.6)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

A 2026-05-29 external audit surfaced a real inconsistency in how relation edges are represented. **Verified against the code:**

- `src/retrieval/relations.ts` defines a rich `RelationEdge { target, confidence?, valid_from?, valid_to?, superseded_by?, source? }` and `readRelations` parses both **string shorthand** (`"wiki/x.md"`) and **object form** (`{target: "wiki/x.md", confidence: 0.8, ...}`). The type system + parser support objects.
- **But two consumers only handle strings:**
  - `validateFrontmatter` (`src/storage/frontmatter.ts` ~L239-240) requires every `relations.<edge>` entry to be a string — an object entry fails with `relations.<edge> must contain only string page paths`.
  - `groundOperation` in compile-execute (`src/compile/execute.ts` ~L141) does `value.filter(item => typeof item === "string")` — silently **dropping** any object-form relation.

**Severity is Medium, not Critical** (the audit said Critical). Reasons, both verified:
1. `validateFrontmatter` is **lint-only** — it is called solely from `src/curation/checks.ts` (the `memory lint` path), NOT on any write path. Capture, compile, propose, and promote all write via `serializeFrontmatter` without validation. So no write is blocked and no data is lost at write time.
2. **No vault file currently uses the object form** — every relation on disk is a string-path array. The bug is **latent**: nothing is losing data today.

Still worth fixing for forward-compatibility: the moment anything (a future propose pipeline, an operator hand-edit, compile-execute) emits an object-form edge, `memory lint` would falsely flag it and compile-execute would silently strip the metadata. This brief makes the validator and grounding **tolerant of and faithful to** both forms.

> **Design note — chosen direction:** make string-path arrays the canonical shorthand AND accept/preserve `RelationEdge` objects (forward-compatible, breaks nothing). The alternative — declaring strings the *only* legal form and removing the `RelationEdge` object capability — is more destructive (it would require deleting working parser code and narrowing the type) and is **not** what this brief does. If you believe the object form should be removed entirely instead, **stop and ask** before doing so.

---

## Scope guard

You will:

### Task 1 — Validator accepts RelationEdge objects

- In `src/storage/frontmatter.ts`, change the `relations.<edge>` validation (~L237-241) so each array entry may be **either**:
  - a non-empty string (page path), **or**
  - an object with a non-empty string `target` (the `RelationEdge` shape). Optionally validate that, when present, `confidence` is a number in [0,1], `valid_from`/`valid_to` are date-parseable-or-null, and `source` is an object — but be lenient (extra keys via `_extra` are allowed; don't reject unknown keys).
- Reuse the parsing/shape logic from `src/retrieval/relations.ts` (`readRelations` / the `RelationEdge` reader) rather than re-implementing the shape check, so there is one source of truth for "what a valid edge is."
- Keep the existing checks: `relations` must be an object, each key must be a `KNOWN_RELATIONS` edge type, each value must be an array.
- Error messages updated to reflect "string path or relation-edge object."

### Task 2 — Compile-execute grounding preserves objects

- In `src/compile/execute.ts` (`groundOperation`, ~L141), stop discarding object-form entries. For each relation entry:
  - if it's a string → ground as today (`filterWikiReferencesToExisting`)
  - if it's an object with a `target` → ground the `target` against the real corpus; **preserve the other fields** (`confidence`, `valid_from`, etc.) on the kept entry; drop only if the `target` doesn't resolve
- `nextRelations` becomes `Record<string, SerializedRelationEdge[]>` (string | object), not `Record<string, string[]>`. `referencesStripped` still counts dropped entries (string or object).
- The serialized output must round-trip: an object edge in → the same object edge (minus a non-resolving target) out.

### Task 3 — Regression tests (the gap the audit correctly identified)

- `test/storage/frontmatter.test.ts`: add cases asserting `validateFrontmatter` **accepts** a frontmatter whose `relations.mentions` contains an object edge with `target` + `confidence` + `valid_from`, and still **rejects** a genuinely malformed entry (number, or object with no `target`). The existing string-array case must still pass.
- `test/compile/execute.test.ts`: add a case where a compile operation proposes an object-form relation whose target exists → it is preserved with its attributes; and one whose target does not exist → it is stripped and counted. Assert no silent attribute loss for a resolving object edge.
- Confirm `memory lint` (curation/checks.ts) no longer flags object-form relations (add/extend a checks test if one exists).

### Task 4 — Docs

- `templates/schema.md`: in the relations/frontmatter section, document both forms explicitly — string shorthand and the `RelationEdge` object with its optional fields — and state that both are valid on disk.
- `docs/ROADMAP.md`: Phase 4.6 shipped 2026-05-29 — relation-edge validation + grounding alignment.

You will **not**:

- Migrate existing string-path relations to object form. Strings stay strings; this is additive tolerance, not a rewrite.
- Remove the `RelationEdge` object capability or narrow the type.
- Change `readRelations` parsing (it already handles both forms correctly).
- Touch the search/graph read path — it already uses `readRelations` and is unaffected.
- Add object-form relations to any vault file as part of this brief (no data migration).
- Make `validateFrontmatter` a write-path gate. It remains lint-only; this brief only widens what it accepts.

If validating the object shape strictly (rejecting unknown keys) would break the `_extra` passthrough that `readRelations` supports, **stop and ask** — leniency (accept + preserve extras) is the intended behavior.

---

## Repo orientation

- `src/storage/frontmatter.ts` ~L226-244 — the relations validation block.
- `src/retrieval/relations.ts` — `RelationEdge`, `readRelations`, `SerializedRelationEdge` — reuse for the shape check; one source of truth.
- `src/compile/execute.ts` ~L135-150 — `groundOperation` relation filtering.
- `src/curation/checks.ts` ~L102 — the only caller of `validateFrontmatter` (confirms lint-only).
- `test/storage/frontmatter.test.ts`, `test/compile/execute.test.ts` — test homes.

---

## Acceptance contract

1. `validateFrontmatter` accepts both string-path and `RelationEdge`-object entries; still rejects malformed entries (number, object without `target`).
2. Compile-execute grounding preserves a resolving object edge with all its attributes; strips (and counts) a non-resolving one; never silently drops attributes of a kept edge.
3. `memory lint` no longer false-flags object-form relations.
4. Existing string-path behavior unchanged across validator, grounding, search, graph.
5. New regression tests cover both forms in both the validator and execute.
6. Full suite + `npm run typecheck` green; build + build:ui clean; `git diff --check` clean.

---

## Commit boundaries

- Task 1: `fix: validateFrontmatter accepts RelationEdge object entries (Phase 4.6 Task 1)`
- Task 2: `fix: compile-execute grounding preserves object-form relations (Phase 4.6 Task 2)`
- Task 3: `test: relation-edge object form across validator + execute (Phase 4.6 Task 3)`
- Task 4: `docs: relation-edge representation (Phase 4.6 Task 4)`

---

## Context

This is the verified core of the external audit, scoped to its true severity (latent Medium, not Critical). It removes a forward-compatibility trap without forcing any migration. Run the FULL suite — the audit correctly noted the test gap that let validator/parser drift go unnoticed.
