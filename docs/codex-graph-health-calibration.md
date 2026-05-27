# Codex Implementation Brief — Graph Health Calibration

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Phase 2 of the roadmap shipped the Graph Cohesion Metrics Dashboard (commits `69d2c59` and adjacent). The live VPS now reports 12 metrics. Three of the four "fail" signals turn out to be measurement bugs or threshold mis-calibrations, not real graph pathologies:

1. **Wrong denominator.** Four metrics (`provenance-coverage`, `agent-attribution`, `confidence-coverage`, `duplicate-entities`) compute "% of wiki pages" using the graph feed's 20 nodes as denominator. The actual vault has **165 wiki pages**. `loadGraphFeed` includes all 1097 raw observations regardless of edges, but only includes wiki pages that participate in at least one edge — so 145 isolated wiki pages are invisible to the metrics. Live `agent-attribution` reports `12/20 = 60%` when the real signal is closer to `12/165 = 7%`.

2. **Threshold mis-calibrated for our architecture.** `cross-galaxy-ratio` fails at 97.9%. But the entire consolidation pipeline writes raw-episodic → wiki-semantic edges by design. Cross-galaxy IS the dominant edge pattern in a consolidation-heavy graph. The research-doc thresholds (warn `>70%`, fail `>90%`) assumed a graph where same-galaxy edges are the norm. They aren't for Memory Fort.

3. **Missing metric.** The fact that 145 of 165 wiki pages have zero relations is itself a more interesting signal than the broken denominators are reporting. Worth surfacing as a new 13th metric: **graph-participation rate**.

This brief fixes the three calibration issues so the dashboard tells the truth. After it lands, we re-deploy, re-read `/api/graph-health`, and decide the next Phase 3 brief from honest data.

---

## Scope guard

You will:

- Fix the denominator on `metricDuplicateEntities`, `metricProvenanceCoverage`, `metricConfidenceCoverage`, and `metricAgentAttribution` so they compute against the **full wiki corpus** (`loadSearchCorpus({ vaultRoot, scope: "wiki" })`), not against `feed.nodes.filter(kind === "wiki")` which only contains graph-connected pages
- Re-calibrate `cross-galaxy-ratio` thresholds for Memory Fort's consolidation-heavy graph topology. Two specific changes:
  - Raise thresholds: `warn > 95%`, `fail > 99%`. This reflects that cross-galaxy edges are normal for our architecture
  - Add to the metric's `detail` line: a breakdown by edge direction so the operator can see *which* crossings dominate (e.g., "1241 raw→wiki of 1319 cross-galaxy edges")
- Add a 13th metric `graph.participation-rate` measuring `wiki_pages_with_at_least_one_edge / total_wiki_pages`. Warn `< 50%`, fail `< 25%`. Top offenders: 5 random isolated wiki pages
- Update tests for each touched metric. Add tests for the new metric
- No new dependencies. No changes to `loadGraphFeed` itself — pass the corpus alongside the feed to `computeGraphHealth` instead

You will **not**:

- Change `loadGraphFeed` semantics. The feed remains visualization-focused (only graph-connected nodes). The metrics module gets a separate corpus reference for whole-vault denominators
- Add automatic remediation
- Touch metrics that don't have the denominator bug (`orphan-episodic`, `edge-type-entropy`, `hub-overload`, `temporal-coverage`, `contradiction-coverage`, `project-subgraph-density`, `narrative-thread-coverage`)
- Add new graph-feed fields. Brief A and B already expose everything needed
- Change the `GraphHealthPanel` UI — the new metric appears automatically as a 13th card; existing cards keep their shape

If a metric's correct denominator is ambiguous (e.g., should `duplicate-entities` cluster against the full wiki corpus or only graph-connected pages?), **stop and ask**. The default assumption for this brief: anything measuring "% of wiki pages" uses the full corpus.

---

## Repo orientation

- `src/dashboard/graph-health.ts:64,85,245,279,328,345,374` — the metric functions; line numbers identified by `grep "kind === \"wiki\""` after Phase 2 deploy
- `src/dashboard/loaders.ts:1135` — `loadGraphFeed`. Read-only reference; do not modify
- `src/retrieval/corpus.ts` — `loadSearchCorpus` returns `{ documents }`. The metrics module already imports types from `loaders.ts`; importing the corpus loader is a small addition
- `src/dashboard/server.ts` — the `/api/graph-health` route at the `verifyRunner`-style closure. Pass the corpus into `computeGraphHealth` alongside the feed
- `src/cli/commands/verify/graph-cohesion.ts` — the verify check calls `computeGraphHealth`. Same signature change applies

---

## Task 1 — Pass corpus into `computeGraphHealth`

### Why
`computeGraphHealth` currently takes only `GraphFeed`. The four broken-denominator metrics need access to the full wiki corpus. Extending the signature is the smallest change that unblocks all four fixes.

### Contract

```ts
// src/dashboard/graph-health.ts

export interface GraphHealthInput {
  feed: GraphFeed;
  wikiPages: ReadonlyArray<{
    relPath: string;
    title: string;
    source?: string;
    confidence?: number | null;
    confidenceFull?: unknown;
    // plus anything else the broken-denominator metrics already read off feed.nodes
  }>;
}

export function computeGraphHealth(input: GraphHealthInput): GraphHealthReport;
```

Update callers:
- `src/dashboard/server.ts` (route handler): load corpus alongside feed, pass both
- `src/cli/commands/verify/graph-cohesion.ts`: same

Use `loadSearchCorpus({ vaultRoot, scope: "wiki" })` as the canonical wiki source. The returned `SearchDocument[]` has all the fields the metrics need.

### Files

- Modify: `src/dashboard/graph-health.ts` (signature change + each affected metric)
- Modify: `src/dashboard/server.ts` (route caller)
- Modify: `src/cli/commands/verify/graph-cohesion.ts` (verify check caller)
- Tests: `test/dashboard/graph-health.test.ts` extended to assert each affected metric reports correctly when `wikiPages` is larger than `feed.nodes` filtered by wiki kind

---

## Task 2 — Fix the four denominator metrics

### Why
Each metric currently computes against the graph feed's small subset. Switch each to use `input.wikiPages` (full corpus) for the denominator while keeping graph-feed logic for the per-page checks that genuinely need graph data.

### Contract per metric

**`metricProvenanceCoverage`** — denominator: `input.wikiPages.length`. Numerator: pages with non-empty `source` or `imported_from`. Top offenders: 5 most-recent pages lacking the field.

**`metricAgentAttribution`** — denominator: `input.wikiPages.length`. Numerator: pages with non-empty `source`. (Yes, this overlaps with provenance-coverage; that's a separate question for a later brief. For now, fix both to use the correct denominator.)

**`metricConfidenceCoverage`** — denominator: `input.wikiPages.length`. Numerator: pages with `confidence` or `confidenceFull` set (scalar or vector).

**`metricDuplicateEntities`** — input: titles from `input.wikiPages` (all 165), not just graph-connected ones. The Levenshtein + bucket detection runs against the wider set. Expected outcome: probably more candidate pairs surface, which is correct.

### Files

- Modify: `src/dashboard/graph-health.ts`
- Tests: each fixed metric gets one new test case asserting the denominator is `wikiPages.length`, not `feed.nodes.filter(wiki).length`

---

## Task 3 — Re-calibrate `cross-galaxy-ratio`

### Why
Our consolidation pipeline writes raw-episodic → wiki-semantic edges. By design. The original thresholds (warn `>70%`, fail `>90%`) treat that as pathological when it's the architecture.

### Contract

`metricCrossGalaxyRatio`:
- Thresholds: `warn > 95%`, `fail > 99%`
- `detail` line includes the top crossing direction: e.g., `"97.9% (1319/1347); top crossings: semantic→core 935, episodic→procedural 211"`
- Compute the breakdown by counting edges grouped by `(sourceCognitiveType, targetCognitiveType)` tuples, surface the top 3 in the detail
- `topOffenders` continues to return 5 most-recent cross-galaxy edges

### Files

- Modify: `src/dashboard/graph-health.ts` (`metricCrossGalaxyRatio` function + its threshold constants)
- Tests: `test/dashboard/graph-health.test.ts` — assert new thresholds, assert breakdown appears in `detail`

---

## Task 4 — Add `graph.participation-rate` metric

### Why
The most interesting signal from today's investigation: **only 20 of 165 wiki pages participate in the graph at all** (12% participation rate). The other 145 wiki pages are floating — they exist as content but have zero typed relations, so they can't be discovered via graph traversal, spreading activation, or any of the 6 retrieval streams that use edges.

This is a real Phase 3 candidate: graph participation drives retrieval recall. The metric makes it measurable.

### Contract

```ts
export function metricGraphParticipationRate(input: GraphHealthInput): MetricResult;
```

- `value`: `participating_wiki_pages / total_wiki_pages * 100` (percentage)
- `participating` = wiki pages that appear as either `fromPath` or `toPath` on at least one edge in `feed.edges`
- Threshold: `warn < 50%`, `fail < 25%`
- `detail`: e.g., `"20/165 wiki pages participate in at least one edge (12%)"`
- `topOffenders`: 5 random non-participating wiki pages (random sample so re-runs show different ones over time)

Add the metric to:
- `metricResultIndex` (or wherever the metric registry lives)
- `computeGraphHealth`'s ordered metric list
- The `narrative-thread-coverage` stub stays — it's already the 13th. The new metric makes 14 total. Update any "12 metrics" wording in code comments and labels to match the new count

### Files

- Modify: `src/dashboard/graph-health.ts` — add the new metric function and register it
- Tests: `test/dashboard/graph-health.test.ts` — at minimum:
  - Empty feed + non-empty corpus: returns `0%`, status `fail`
  - All wiki pages participating: returns `100%`, status `pass`
  - 12% participation: returns `12`, status `fail`
  - Top offenders are non-participating wiki pages only

---

## Execution order

1. **Task 1** (signature change) — foundation; everything else depends on it
2. **Task 2** (denominator fixes) — small mechanical sweep using the new signature
3. **Task 3** (cross-galaxy recalibration) — independent; can land in any order after Task 1
4. **Task 4** (new metric) — independent; can land in any order

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                  # full suite (830 currently passing)
npx vitest run test/dashboard/graph-health            # focus
npm run build
npm run build:ui

scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify the dashboard now reports honest data:
curl -s https://srv1317946.tail6916d8.ts.net/memory/api/graph-health | jq '.metrics[] | {id, status, value}'

# Expected after deploy:
# - provenance-coverage, agent-attribution, confidence-coverage drop to true %s over 165 wiki pages
# - cross-galaxy-ratio stays at ~98% but moves to warn (or pass if we exceeded fail threshold change)
# - graph.participation-rate appears as a new metric with ~12% and status fail
# - edge-type-entropy stays fail at 0.30 (this one was always real)
# - hub-overload stays fail at 1008 (this one was always real)
```

---

## Acceptance checklist

- [ ] `computeGraphHealth` accepts `{ feed, wikiPages }` input
- [ ] `provenance-coverage` denominator is `wikiPages.length` (will be ~165 on live vault)
- [ ] `agent-attribution` denominator is `wikiPages.length`
- [ ] `confidence-coverage` denominator is `wikiPages.length`
- [ ] `duplicate-entities` clusters across the full wiki corpus
- [ ] `cross-galaxy-ratio` warn threshold raised to 95%, fail to 99%
- [ ] `cross-galaxy-ratio` detail line includes top 3 crossing directions
- [ ] New `graph.participation-rate` metric exposed; threshold warn `<50%`, fail `<25%`
- [ ] `/api/graph-health` returns 14 metrics (was 13: 12 + n/a thread coverage)
- [ ] `GraphHealthPanel` automatically renders the new metric card (no UI changes needed)
- [ ] `graph.cohesion` verify check picks up the new metric automatically
- [ ] All 830+ tests still green; new tests added per task
- [ ] No changes to `loadGraphFeed`
- [ ] No new dependencies, no secrets, no OneDrive paths

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

After this lands and the dashboard tells the truth, the natural next briefs (which one comes first will be decided by the actual data):

1. **Typed-edge proposing in consolidation** — addresses the still-fail `edge-type-entropy` 0.30. The consolidation matcher classifies each match into a probable relation type (`derived_from` for raw→wiki provenance, `mentions` for genuine cross-references)
2. **Graph compaction for the agentmemory hub** — `wiki/projects/agentmemory.md` has 1008 inbound edges. Either compact (intermediate node) or exempt project hubs from the metric
3. **Source field backfill** — if `provenance-coverage` and `agent-attribution` still show low after honest measurement, sweep the wiki to fill missing `source` fields
4. **Make 145 isolated wiki pages graph-participating** — depending on how Task 4's metric reads, the right move may be to surface inbound `mentioned_in` edges that the consolidation pipeline implicitly creates but never materializes in frontmatter
