# Codex Implementation Brief — Graph Cohesion Metrics Dashboard

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Phase 2 of the Memory Fort roadmap (see `docs/ROADMAP.md`). The principle is **measure before optimize**. Today we know exactly one health metric — `episodic.relations.coverage` (99% on the live vault) — but the research-backed roadmap names eleven more we don't currently surface: duplicate entity rate, edge-type entropy, cross-galaxy ratio, hub overload, temporal coverage, provenance coverage, confidence coverage, contradiction coverage, project subgraph density, agent attribution, and stale canonical rate.

Without measurement, Phase 3's optimization choices are guesswork. With it, the reddest metric tells us which brief to draft next.

This brief makes all eleven computable-today metrics visible:

1. A new pure-function module computes each metric over the existing corpus + graph feed
2. A new endpoint `/api/graph-health` returns a `GraphHealthReport` with per-metric `{ value, threshold, status, topOffenders }`
3. A new `GraphHealthPanel` on the Overview page renders the metrics as cards sorted worst-first
4. A new verify check `graph.cohesion` aggregates the metrics into a single pass/warn/fail signal and surfaces in `/api/health`

After this lands, every Phase 3 brief starts from a fact ("hub overload is in fail, top hubs are A/B/C") instead of an opinion ("I think hubs might be a problem").

---

## Scope guard

You will:

- Add a pure-function metrics module at `src/dashboard/graph-health.ts` (or `src/retrieval/graph-health.ts` if that placement reads more naturally). Each metric is a separately exported function for testability. The module consumes the already-loaded corpus + graph feed; it does **not** re-read files
- Wire a new `GET /api/graph-health` endpoint into `src/dashboard/server.ts` (the route table around lines 437–443 where `/api/graph` lives is the right neighborhood). Cache the result for 25 seconds, same pattern as `/api/health`
- Add a `GraphHealthPanel` component at `src/dashboard-ui/components/GraphHealthPanel.tsx` and render it on the Overview screen at `src/dashboard-ui/routes/index.tsx` below the existing `<HealthBadge />` at line 109
- Add a hook `src/dashboard-ui/hooks/useGraphHealth.ts` following the existing `useHealth.ts` / `useGraph.ts` pattern (TanStack Query, 25s stale time)
- Add a new verify check `graph.cohesion` at `src/cli/commands/verify/graph-cohesion.ts` that calls the same metrics module (running locally against the vault corpus) and aggregates results
- Register the new check in `src/cli/commands/verify/registry.ts`
- Tests for each metric in isolation (the computation module is pure; tests are easy), one integration test for the endpoint, and one for the verify check

You will **not**:

- Add automatic remediation — pure observability. No auto-merging duplicates, no auto-archiving stale pages, no auto-compaction
- Compute the twelfth metric (narrative thread coverage). That's deferred to Phase 4 when narrative threads exist as a structure. Stub the metric and surface as `{ status: "n/a", detail: "pending narrative threads in Phase 4" }`
- Touch the existing `/api/graph` loader — read from its output, don't modify it
- Add a SQLite index, ledger, or new background job — the metrics compute on-demand off the cached graph feed (which is in-memory anyway)
- Change the `HealthBadge` UI — the new panel sits alongside it
- Add new graph-feed fields. Brief A already exposed `type`, `validFrom`, `validTo`. Brief B already exposed `lifecycle`, `confidenceFull`. Everything the metrics need is there

If a metric requires data that isn't on the current `GraphFeed`, **stop and ask** before extending the feed. Likely candidates that might surface: nothing — but if you find one, raise it.

---

## Repo orientation (verified before brief)

- `src/dashboard/loaders.ts:179` — `GraphFeed` interface. Nodes carry `path, title, kind, type, cognitiveType, status, source, created, confidence, confidenceFull, lifecycle, tags, description, updated, inboundCount, outboundCount`. Edges carry `fromPath, toPath, kind, relationType, type, validFrom, validTo, supersededBy`.
- `src/dashboard/loaders.ts:1135` — `loadGraphFeed(vaultRoot, scope)` is the canonical loader. **Use `scope: "all"`** when computing metrics — wiki-only scope misses the 1285 consolidation edges from raw observations into the wiki.
- `src/dashboard/server.ts:443` — `/api/graph` route. The new `/api/graph-health` route goes nearby.
- `src/dashboard-ui/routes/index.tsx:109` — `<HealthBadge />` placement on the Overview. The new panel goes below it.
- `src/dashboard-ui/hooks/useHealth.ts` — reference pattern for the new `useGraphHealth.ts` hook.
- `src/cli/commands/verify/registry.ts` — `ALL_CHECKS` array; append `graphCohesionCheck` after `freshnessStaleCheck`.
- `src/cli/commands/verify/freshness.ts` — reference pattern for the new `graph-cohesion.ts` check.
- `src/storage/confidence.ts` (from Brief B) — `getLifecycle()`, `getConfidenceScore()` helpers the metrics will call.

---

## Task 1 — Metrics computation module

### Why
Every metric is a function from corpus + graph to a `{ value, threshold, status, topOffenders }` record. A pure module makes each one independently testable and the orchestration trivial.

### Contract

```ts
// src/dashboard/graph-health.ts

import type { GraphFeed } from "./loaders.js";

export type HealthStatus = "pass" | "warn" | "fail" | "n/a";

export interface MetricResult {
  id: string;                        // e.g., "graph.edge-type-entropy"
  label: string;                     // human-readable
  value: number | string | null;     // the measured number
  unit?: string;                     // "%", "bits", "count", "ratio"
  threshold: { warn?: number; fail?: number; rule?: string };
  status: HealthStatus;
  detail: string;                    // one-line summary of what was measured
  topOffenders: Array<{
    path?: string;                   // node ref
    edge?: { from: string; to: string; type: string };
    pair?: [string, string];         // duplicate-entity candidates
    value?: number | string;
    note?: string;
  }>;
}

export interface GraphHealthReport {
  computedAt: string;                // ISO timestamp
  metrics: MetricResult[];
  overallStatus: HealthStatus;       // worst non-"n/a" across metrics
}

export function computeGraphHealth(feed: GraphFeed): GraphHealthReport;

// Each metric is also exported individually for tests:
export function metricOrphanEpisodic(feed: GraphFeed): MetricResult;
export function metricDuplicateEntities(feed: GraphFeed): MetricResult;
export function metricEdgeTypeEntropy(feed: GraphFeed): MetricResult;
export function metricCrossGalaxyRatio(feed: GraphFeed): MetricResult;
export function metricHubOverload(feed: GraphFeed): MetricResult;
export function metricTemporalCoverage(feed: GraphFeed): MetricResult;
export function metricProvenanceCoverage(feed: GraphFeed): MetricResult;
export function metricConfidenceCoverage(feed: GraphFeed): MetricResult;
export function metricContradictionCoverage(feed: GraphFeed): MetricResult;
export function metricProjectSubgraphDensity(feed: GraphFeed): MetricResult;
export function metricAgentAttribution(feed: GraphFeed): MetricResult;
export function metricNarrativeThreadCoverage(feed: GraphFeed): MetricResult;  // returns n/a
```

### Metric definitions and thresholds

Use these definitions exactly. Thresholds are tunable later — pick the starting points listed below.

| Metric id | What it measures | Formula | Warn at | Fail at | Top offenders |
|---|---|---|---|---|---|
| `graph.orphan-episodic` | Raw observations with zero inbound or outbound relation edges | `orphan_episodic / total_episodic` | `> 10%` | `> 25%` | 5 oldest orphan raw observations |
| `graph.duplicate-entities` | Wiki pages whose normalized titles cluster | See "Duplicate detection" below | `≥ 3 pairs` | `≥ 10 pairs` | 5 highest-similarity pairs |
| `graph.edge-type-entropy` | Shannon entropy over edge `type` distribution | `H = -sum(p_i * log2(p_i))` over edges; cap unique types at 9 | `H < 0.8` | `H < 0.4` | Top 3 dominant types with % share |
| `graph.cross-galaxy-ratio` | Edges where source and target `cognitiveType` differ | `cross_edges / total_edges` | `> 70%` | `> 90%` | 5 most-recent cross-galaxy edges |
| `graph.hub-overload` | Max single-node degree (inbound + outbound) | `max(node.inboundCount + node.outboundCount)` | `> 30` | `> 60` | Top 5 highest-degree nodes |
| `graph.temporal-coverage` | Edges with `validFrom` set | `edges_with_validFrom / edges` | `< 60%` | `< 30%` | 5 most-recent edges missing `validFrom` |
| `graph.provenance-coverage` | Pages with `source` or `imported_from` set | `pages_with_source / pages` | `< 80%` | `< 50%` | 5 most-recent pages missing provenance |
| `graph.confidence-coverage` | Pages with `confidence` field set (scalar or vector) | `pages_with_confidence / pages` | `< 70%` | `< 40%` | 5 wiki pages missing confidence |
| `graph.contradiction-coverage` | Pages flagged with `contradicts` edges | Count of distinct `contradicts` edges | `> 5` | `> 20` | 5 most-recent `contradicts` edges |
| `graph.project-subgraph-density` | Per-project intra-edge density | For each `wiki/projects/*.md`, count edges where both endpoints are in that project's transitive neighborhood; report `min` density across projects | `min < 0.10` | `min < 0.03` | 3 lowest-density projects |
| `graph.agent-attribution` | Pages with non-empty `source` field | `pages_with_source / pages` | `< 90%` | `< 70%` | 5 pages without `source` |
| `graph.narrative-thread-coverage` | Episodes assigned to a narrative thread | n/a — stub | n/a | n/a | empty array; `detail: "pending narrative threads in Phase 4"` |

### Duplicate detection (for `graph.duplicate-entities`)

A simple two-pass approach (no embeddings — keep it deterministic):

1. **Normalize** each wiki page title: lowercase, strip punctuation, collapse whitespace, remove a curated stop-word list (`the`, `a`, `memory`, `fort`, `system`)
2. **Bucket** pages by normalized title; any bucket with > 1 page is a candidate cluster
3. **Also** compute Levenshtein distance ≤ 2 between normalized titles in different buckets to catch near-misses
4. Return pairs `[pathA, pathB]` sorted by `1.0 - (levenshtein / max_length)` descending

Tunable later; this catches the common cases (case differences, "Memory Fort" vs "Memory Fort." vs "memory-fort").

### Cross-galaxy edges

Two endpoints are in **different galaxies** when their `cognitiveType` fields differ (e.g., one is `episodic`, the other `semantic`). The `GraphFeed.nodes` already carries `cognitiveType` per Brief A. Look up endpoints by `fromPath`/`toPath`.

### Project subgraph density

For each `wiki/projects/*.md`:
1. BFS 2 hops from the project node; collect the set `S` of reachable wiki pages
2. Count `intra` edges where both endpoints are in `S`
3. `density = intra / max(1, |S| * (|S| - 1))` (directed, no self-loops)
4. Report `min` across all projects as the metric's `value`; surface the 3 lowest in `topOffenders`

### Files

- New: `src/dashboard/graph-health.ts`
- Tests: `test/dashboard/graph-health.test.ts` — at minimum:
  - Each metric returns the right `status` for a synthetic feed that should hit each threshold
  - Each metric handles an empty feed (no pages, no edges) without throwing
  - The `n/a` metric returns the expected stub
  - `computeGraphHealth()` aggregates `overallStatus` correctly (worst of non-n/a)
  - Duplicate detection finds `"Memory Fort"` and `"memory fort"` as a pair
  - Cross-galaxy ratio uses the right `cognitiveType` comparison
  - Project subgraph density works on a fixture with two projects of differing densities

---

## Task 2 — `GET /api/graph-health` endpoint

### Why
The dashboard needs to fetch the report. The CLI verify check uses the same module directly; this endpoint is for the SPA.

### Contract

```
GET /api/graph-health
→ 200 with GraphHealthReport when overallStatus is pass/warn
→ 503 with GraphHealthReport when overallStatus is fail
→ 500 on internal error
```

- Cache the result for **25 seconds** using the same Map-based cache pattern as `/api/health` at `src/dashboard/server.ts` (look for `healthCache` near the `/api/health` route)
- Reads `loadGraphFeed(opts.vaultRoot, "all")` — note **`"all"` scope**, not the default `"wiki"`. We want raw observations in the metrics because most relation edges are raw→wiki
- Surfaces all 12 metrics

### Files

- Modify: `src/dashboard/server.ts` — add the route near the existing `/api/graph` handler (around line 437)
- Tests: `test/dashboard/server.test.ts` — integration test asserting the route returns 200/503 with the right `overallStatus`, cache returns identical body on second hit within 25s

---

## Task 3 — `GraphHealthPanel` on the Overview

### Why
This is the user-visible payoff. A panel that surfaces the reddest metric first turns "what should we work on next?" into a 10-second read.

### Contract

A new component `GraphHealthPanel.tsx` rendered immediately below `<HealthBadge />` on the Overview at `src/dashboard-ui/routes/index.tsx:109`:

```
┌── Graph Health ────────────────────────────────────────────┐
│  Last computed: 12s ago                            [↻]     │
│                                                            │
│  🔴 Edge type entropy           0.42 bits   (warn < 0.8)   │
│      mentions dominates (94% of 1347 edges)                │
│      ▸ details                                             │
│                                                            │
│  🟡 Hub overload                47 edges    (warn > 30)    │
│      Top hub: wiki/projects/memory-fort.md (47 inbound)    │
│      ▸ details                                             │
│                                                            │
│  ✓  Orphan episodic rate        1%          (warn > 10%)   │
│  ✓  Cross-galaxy ratio          68%         (warn > 70%)   │
│  ✓  Provenance coverage         94%         (warn < 80%)   │
│  …                                                         │
│                                                            │
│  (narrative thread coverage)    n/a — Phase 4              │
└────────────────────────────────────────────────────────────┘
```

**Behavior:**

- Cards sorted by status descending: `fail > warn > pass > n/a`. Within a status, sort by `id` alphabetically for stability
- Each card collapsed by default; clicking `▸ details` expands to show `topOffenders` inline (no navigation, no new page)
- Pure-pass metrics render compactly (single line); warn/fail metrics get the larger card treatment with details
- Refetch button forces a fresh `/api/graph-health` (TanStack Query `refetch()`)
- The panel reuses the existing `<GlassPanel>` shell and the brand styling already on the Overview

**TanStack Query hook:**

```ts
// src/dashboard-ui/hooks/useGraphHealth.ts
export function useGraphHealth() {
  return useQuery({
    queryKey: ["graph-health"],
    queryFn: () => fetch("/api/graph-health").then(r => r.json()),
    staleTime: 25_000,
    refetchInterval: 60_000,  // refresh every minute
  });
}
```

Mirror the structure of `useHealth.ts`.

### Files

- New: `src/dashboard-ui/components/GraphHealthPanel.tsx`
- New: `src/dashboard-ui/hooks/useGraphHealth.ts`
- Modify: `src/dashboard-ui/routes/index.tsx` — add `<GraphHealthPanel />` below `<HealthBadge />`
- Tests: `test/dashboard-ui/components/graph-health-panel.test.tsx` — at minimum:
  - Renders all metric cards from a fixture report
  - Sorts fail > warn > pass > n/a
  - Clicking `▸ details` expands the offender list
  - n/a metric renders compactly with the "Phase 4" detail text

---

## Task 4 — `graph.cohesion` verify check

### Why
The `freshness.staleness` check from Brief B already surfaces in `/api/health` (and therefore the `HealthBadge`). Adding `graph.cohesion` there too means the HealthBadge turns red when any graph metric fails, even without the operator opening the dashboard.

### Contract

```ts
// src/cli/commands/verify/graph-cohesion.ts

export const graphCohesionCheck: CheckDescriptor = {
  id: "graph.cohesion",
  label: "graph cohesion metrics",
  roles: ["operator", "server"],
  run: async (ctx) => {
    const feed = await loadGraphFeed(ctx.vaultRoot, "all");
    const report = computeGraphHealth(feed);

    if (report.overallStatus === "fail") {
      const failingIds = report.metrics
        .filter((m) => m.status === "fail")
        .map((m) => m.id)
        .join(", ");
      return fail(
        "graph.cohesion",
        `graph cohesion: ${failingIds} in fail`,
        "open the dashboard Graph Health panel",
        `${failingIds}`,
      );
    }
    if (report.overallStatus === "warn") {
      const warnIds = report.metrics
        .filter((m) => m.status === "warn")
        .map((m) => m.id);
      return warn(
        "graph.cohesion",
        `graph cohesion: ${warnIds.length} metric${warnIds.length === 1 ? "" : "s"} in warn`,
        warnIds.join(", "),
      );
    }
    return pass("graph.cohesion", "graph cohesion: all metrics passing");
  },
};
```

Register in `src/cli/commands/verify/registry.ts` after `freshnessStaleCheck`.

### Files

- New: `src/cli/commands/verify/graph-cohesion.ts`
- Modify: `src/cli/commands/verify/registry.ts` — append to `ALL_CHECKS`
- Modify: `test/cli/commands/verify/registry.test.ts` — assert new descriptor present
- Tests: `test/cli/commands/verify/graph-cohesion.test.ts` — assert pass/warn/fail aggregation given mocked fixtures of `computeGraphHealth()`

---

## Execution order

1. **Task 1** (metrics module) — foundation; pure functions; everything else depends on it
2. **Task 2** (endpoint) — small wiring task
3. **Task 4** (verify check) — small, leverages Task 1 directly. Doing this before Task 3 means the HealthBadge gains the signal even before the dashboard panel exists
4. **Task 3** (UI panel) — user-visible payoff. Last because it consumes Tasks 1+2

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit (the suite has known parallelism flakes in `test/eval/longmemeval-integration.test.ts` and `test/cli/commands/install-vscode.test.ts` — unrelated to this brief).

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                # full suite (806 currently passing)
npx vitest run test/dashboard/graph-health          # metrics focus
npx vitest run test/cli/commands/verify             # verify focus
npx vitest run test/dashboard-ui                    # UI focus
npm run build
npm run build:ui

# Deploy:
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify live:
curl -s https://srv1317946.tail6916d8.ts.net/memory/api/graph-health | jq '.overallStatus, (.metrics[] | {id, status, value})'
# Expected: overallStatus pass/warn/fail; 12 metrics including narrative-thread-coverage = n/a
```

---

## Acceptance checklist

- [ ] `computeGraphHealth()` returns a `GraphHealthReport` with exactly 12 metrics
- [ ] 11 metrics return real values; `graph.narrative-thread-coverage` returns `status: "n/a"` with the Phase 4 detail
- [ ] Each metric handles an empty feed without throwing
- [ ] Each metric's `topOffenders` array has at most 5 entries
- [ ] `overallStatus` is the worst non-"n/a" status across metrics
- [ ] `GET /api/graph-health` returns 200 (pass/warn) or 503 (fail) with the report body
- [ ] Endpoint caches for 25s (second request within window returns identical body, no re-computation)
- [ ] `useGraphHealth()` hook polls every 60s, stale time 25s
- [ ] `GraphHealthPanel` renders on the Overview below `<HealthBadge />`
- [ ] Cards sorted fail > warn > pass > n/a; ties broken by `id` alphabetically
- [ ] `▸ details` toggle reveals `topOffenders` inline (no navigation)
- [ ] `graph.cohesion` verify check runs in both operator and server roles
- [ ] `graph.cohesion` failing surfaces in `/api/health?deep=true` and turns HealthBadge red
- [ ] All 806+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No changes to `loadGraphFeed()` or the `/api/graph` route
- [ ] No automatic remediation logic anywhere

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

Belong in separate briefs (and most map directly to Phase 3 in the roadmap):

1. **Click-through detail pages** — today `topOffenders` renders inline. A richer "drill down" page per metric (showing all offenders, not just top 5, with sort/filter) is the natural next UX move once the panel is in daily use
2. **Trend lines** — chart each metric over time. Requires a persisted history file or table. Worth doing once the metrics have settled
3. **Tuneable thresholds via config** — today the `warn`/`fail` thresholds are constants in the metrics module. A `graph-health-config.yaml` in the vault that overrides them is a small future-work item
4. **Metric-specific remediation briefs** — Phase 3 of the roadmap. Each metric in fail → one targeted brief (entity registry, typed-edge proposing, graph compaction, etc.). The roadmap maps which metric → which brief
5. **Narrative thread coverage** — once threads exist as a structure (Phase 4), implement the stub metric
