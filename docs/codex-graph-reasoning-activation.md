# Codex Implementation Brief — Activate Graph Reasoning (Phase 4.39)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> A GPT-5.5-Pro graph audit recommended rebuilding the reasoning layer. **Verified against the code: most of the machinery already exists** — `spreadingActivation` (multi-hop, 5 iterations), per-edge-type `edgeWeight()`, `confidence` in metadata scoring, `validTo`/`supersededBy` on edges. The real gaps are narrow: **the edge weights are empty, superseded edges aren't filtered, and graph metrics mix provenance with reasoning edges.** This brief turns on what exists and fills the verified holes — it does NOT rebuild.

## Verified state (read the code, 2026-06-02)

- `src/retrieval/graph.ts`: `spreadingActivation()` does multi-hop activation spreading (decay, inhibition, `maxIterations: 5`), wired into `search.ts:311` behind `spreadingActivationEnabled()`. **Not 1-hop.**
- `edgeWeight(edge, edgeWeights)` (graph.ts:311) keys by `relationType` then `kind` — **but `DEFAULT_EDGE_WEIGHTS = {}` (empty)** → every edge gets the fallback, so `linked` and `caused_by` are weighted equally **in practice**. The mechanism is built and unused.
- `Edge` carries `validFrom`, `validTo`, `supersededBy` (graph.ts:11-13), populated from `valid_to`/`superseded_by` frontmatter — **but traversal never filters on them.**
- `src/retrieval/metadata-score.ts` already uses `getConfidenceScore` + `getValidationState` → **confidence is NOT dead.**
- `EdgeKind = "relation" | "wikilink"`; the 9 relation types live in `relationType`. No `issue`/`incident` node type exists, so `caused_by`/`fixed_by` have no clean domain.

## Task 1 — Populate edge weights (cheap, high-impact; machinery exists)

Fill `DEFAULT_EDGE_WEIGHTS` (graph.ts) so reasoning edges outrank provenance/association. Key by the real `relationType` values + the `wikilink` kind. Suggested (tune later via Task 5 eval):

```ts
const DEFAULT_EDGE_WEIGHTS: Record<string, number> = {
  // reasoning (high)
  uses: 1.0, depends_on: 1.0, caused_by: 0.95, fixed_by: 0.95,
  contradicts: 0.9, supersedes: 0.85,
  // provenance / association (low — recall, not reasoning)
  mentioned_in: 0.35, mentions: 0.35, derived_from: 0.25,
  linked: 0.10, wikilink: 0.10,
};
```

- Only key edge types that **actually exist** today (the 9 + `wikilink`). Do not invent `resolves`/`implements`/etc here — those are Task 4.
- Expose as `config.yaml` `graph.edge_weights` (optional override map; falls back to the default). Read it in the search path and pass to `spreadingActivation({ edgeWeights })`.
- `edgeWeight()` already prefers `relationType` over `kind` — keep that; it means a typed `relation` edge beats a generic `wikilink`.

## Task 2 — Filter superseded / invalidated edges from traversal (cheap; fields exist)

In `spreadingActivation` and `expandGraph`, skip an edge when:
- `edge.supersededBy` is set, OR
- `edge.validTo` is non-null AND `validTo < now` (the "as-of" time; default now).

Add an optional `asOf?: string` traversal option (default = now) so future temporal queries filter by interval. Superseded/expired edges must not contribute activation to current-answer retrieval. Add a test: an edge with `supersededBy` set does not propagate activation; with `asOf` before its `validTo`, it does.

## Task 3 — Split graph metrics: reasoning vs provenance vs association

The graph-health metrics (`edge-type-entropy`, `participation-rate`, `project-subgraph-density`, `orphan-episodic`) currently count **all** edges, so provenance (`derived_from`) and `wikilink` edges dominate and distort. Per the audit:

1. Classify edges into three sets (a shared helper): **reasoning** (`uses, depends_on, caused_by, fixed_by, contradicts, supersedes`), **provenance** (`derived_from, mentioned_in/mentions`), **association** (`linked, wikilink`).
2. Compute the structural metrics (entropy, density, participation, hub) **over the reasoning set only**, and report provenance/association coverage separately as informational.
3. **Reclassify `orphan-episodic`**: the denominator should be **salient recent** raw episodes (importance ≥ threshold, last N days), not all raw. A benign archival raw log with no edges is not a health failure. New metric: `salient-episode-anchor-rate = salient recent raw with ≥1 semantic anchor / salient recent raw`. Keep the old all-raw number as informational only.

This directly addresses the persistent `graph.cohesion` FAILs (which are dominated by all-raw orphan counting) and makes the metrics measure reasoning health, not provenance volume.

## Task 4 — Ontology: add `issue` node type + edge-grammar lint (the genuinely-new part)

1. Add `issue` to the knowledge page types (bug / blocker / incident / failure / constraint). `wiki/issues/`. This gives `caused_by` and `fixed_by` a real domain.
2. Add **edge domain/range validation** to `memory lint`: reject edges whose endpoints violate a grammar, e.g.:
   - `caused_by`: src ∈ {issue} ; dst ∈ {issue, decision, tool, artifact}
   - `fixed_by`: src ∈ {issue} ; dst ∈ {decision, procedure, tool, lesson?} — note the audit's point that *lessons don't fix bugs*; flag `lesson fixed_by *` and `* fixed_by lesson` as suspect.
   - `learned_from` (new, optional): src ∈ {lesson} ; dst ∈ {issue, decision, procedure}
   Lint surfaces violations as warnings (don't hard-fail existing data; this is advisory).
3. Treat `prospective` as a **status/cognitive_type**, not a node type, going forward (don't migrate existing pages destructively — Stop-and-ask before any migration).

Keep this task additive and non-destructive. No silent rewrites of existing pages.

## Task 5 — Gold-query retrieval eval (makes all of the above measurable)

Add `memory eval-retrieval [--json]`:
1. A checked-in gold set `qa/retrieval-gold.jsonl`: 30-50 real queries, each with `{query, expected_paths[], type: fact|causal|temporal|dependency|provenance}`.
2. Run each query through retrieval; compute **Recall@5, Recall@10, MRR**.
3. **Graph lift**: run with and without the graph-spread stream; report `recall@K(with) - recall@K(without)`. If lift ≤ 0, the graph stream is decorative or harmful — surface that loudly.
4. Report per-query-type breakdown (does the graph help causal/dependency queries specifically?).

This is the **acceptance instrument** for Tasks 1-4: prove edge weights + supersede-filtering improve retrieval, not just that they run.

## You will NOT
- Rebuild `spreadingActivation` — it works; only feed it weights + a supersede filter.
- Invent edge types in Task 1 that don't exist yet (no `resolves`/`implements`/`blocks` until Task 4 adds them deliberately).
- Hard-fail lint on existing edge-grammar violations — advisory warnings only.
- Destructively migrate `prospective`/`reference` pages — Stop-and-ask.
- Claim a reasoning improvement without the Task 5 eval numbers (lesson #2: measure the artifact, not the mechanism).

## Stop and ask
1. Edge-weight values materially change top results on a spot-check in a way that looks worse — pause; the defaults are a starting point, tune via eval.
2. The gold set is hard to build objectively (no ground truth) — confirm the query/expected-path format before hand-labeling 50.
3. Adding `issue` as a node type ripples into compile/consolidate routing — confirm the routing change scope.

## Acceptance
- `DEFAULT_EDGE_WEIGHTS` populated + config-overridable; `spreadingActivation` receives them; a test asserts a `caused_by` neighbor outranks a `linked` neighbor for the same seed.
- Superseded/expired edges excluded from traversal (test: `supersededBy` edge contributes zero activation; `asOf` respects `validTo`).
- Graph metrics split reasoning/provenance/association; `orphan-episodic` reclassified to salient-recent; **`graph.cohesion` no longer FAILs on benign archival raw** (read the verify output).
- `memory eval-retrieval` runs, reports Recall@K + MRR + graph-lift on the gold set. **Graph lift > 0** (if not, report it — don't hide).
- `issue` node type + advisory edge-grammar lint shipped; no destructive migration.
- Full suite + typecheck + build clean.

## Commit boundaries
- Task 1: `feat(graph): populate edge weights (reasoning > provenance > association), config-overridable (Phase 4.39 Task 1)`
- Task 2: `feat(graph): exclude superseded/expired edges from traversal, asOf option (Phase 4.39 Task 2)`
- Task 3: `feat(verify): split graph metrics by edge class; salient-recent orphan rate (Phase 4.39 Task 3)`
- Task 4: `feat: issue node type + advisory edge-grammar lint (Phase 4.39 Task 4)`
- Task 5: `feat: memory eval-retrieval — gold-query Recall@K/MRR/graph-lift (Phase 4.39 Task 5)`

## Grounding
- GPT-5.5-Pro graph audit (the prompt + its response this session) — framework sound; engine-primitiveness claims corrected against code. Weight table + metric critique + gold-query eval taken; "rebuild reasoning layer" rejected as unnecessary.
- Verified code refs: `src/retrieval/graph.ts` (spreadingActivation, edgeWeight, Edge temporal fields), `src/retrieval/metadata-score.ts` (confidence in ranking), `src/retrieval/search.ts:311` (spreading wired in).
- Aligns with 4.37 (auto-linking) which supplies the ingest-time anchoring the audit also wants — these two briefs are complementary, not overlapping.
