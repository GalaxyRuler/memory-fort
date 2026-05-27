# Codex Implementation Brief — Hub Overload Metric Tuning

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Final Phase 3 brief. After Phase 3.2 landed, exactly one fail remains on `/api/graph-health`:

- `graph.hub-overload: 1016` (fail threshold `> 60`)

The metric was designed in Phase 2 from the research doc's generic threshold (`> 60` fail) before we had data on Memory Fort's actual graph shape. With current live numbers:

- 1398 edges across roughly 22 active wiki pages → average inbound per wiki page is ≈65
- The top 5 highest-degree nodes:

| Rank | Node | Degree | Kind |
|---|---|---|---|
| 1 | `wiki/projects/agentmemory.md` | 1016 | project page (by-design anchor) |
| 2 | `wiki/lessons/mcp-plugin-bundled-mcp-json.md` | 157 | lesson |
| 3 | `wiki/projects/memory-system.md` | 52 | project page |
| 4 | `wiki/lessons/cross-platform-payload-field-fallback.md` | 28 | lesson |
| 5 | `wiki/references/karpathy-llm-wiki-pattern.md` | 18 | reference |

The original `> 60` threshold treats the median active wiki page as pathological. That's not a metric — it's a constant. Two fixes:

1. **Exempt project hubs from the calculation.** Project pages are by-design anchors; that's their function in the taxonomy. Including them in `max(degree)` always returns 1016+ regardless of whether anything is actually wrong
2. **Recalibrate the thresholds against the observed distribution.** Average inbound is 65; reasonable thresholds are `warn > 3× average ≈ 200`, `fail > 10× average ≈ 650`. Under the new thresholds + project exemption, the mcp-plugin lesson at 157 sits cleanly in pass, the badge goes green, and the metric still catches genuine runaway hubs

After this lands, the HealthBadge should go green for the first time since Phase 2 surfaced the cohesion metrics.

---

## Scope guard

You will:

- Add a `EXEMPT_HUB_PATTERNS` constant to `src/dashboard/graph-health.ts` listing path patterns whose nodes are excluded from the `hub-overload` `max(degree)` calculation. Initial entry: `wiki/projects/*.md`
- Modify `metricHubOverload` so:
  - `value` is computed against non-exempt nodes only
  - Exempt nodes still appear in `topOffenders` but are tagged with an `exempt: true` flag and a `reason` string so the operator can see them without false-alarm escalation
  - All five `topOffenders` are returned sorted by raw degree descending (exempt and non-exempt mixed), since "the project hub has 1016 edges" is genuinely useful diagnostic data
- Recalibrate thresholds: `warn > 200`, `fail > 650`. Document the rationale in code comments and in the thresholds doc
- Update `templates/schema.md` graph cohesion section if it explicitly names the old thresholds
- Update `docs/consolidation-thresholds.md` (or `docs/graph-health-thresholds.md` if that's where Phase 2 / 3.0 thresholds live) with the new values and rationale

You will **not**:

- Change any other metric's thresholds
- Add new metrics
- Remove `hub-overload` (the metric is meaningful with the exemption + recalibration)
- Touch the consolidation matcher or the typed-edge classifier
- Make the exempt pattern list configurable via vault config — keep it a constant for now. Configurability is a future-work item
- Touch the SPA UI — `GraphHealthPanel` automatically renders the new `exempt` tag if the metric result includes it; if a UI tweak is needed to visually distinguish exempt entries, do it minimally inline (a small "(exempt)" suffix on the offender row)

If new live data shows that another category (e.g., lessons) also has by-design hub behavior, **stop and ask** before adding it to `EXEMPT_HUB_PATTERNS`. Don't expand the exemption list to chase green; the data-driven thresholds should handle moderate variation.

---

## Repo orientation (verified before brief)

- `src/dashboard/graph-health.ts` — contains `metricHubOverload` from Phase 2 (line ~280 area in the post-Phase 3.0 layout; verify by `grep -n metricHubOverload`)
- `src/dashboard-ui/components/GraphHealthPanel.tsx` — renders `topOffenders`. The component is already generic enough to handle additional fields on each offender entry; an `exempt` tag may render automatically as `note: "(exempt)"` if the existing render path uses `note` for free-form display
- `docs/consolidation-thresholds.md` — has the Phase 0–3.2 thresholds documented; add a new section for graph-health thresholds OR confirm a sibling doc exists
- Live data for threshold validation: `curl https://srv1317946.tail6916d8.ts.net/memory/api/graph-health` shows the current 5 highest-degree nodes

---

## Task 1 — Exempt project hubs + recalibrate thresholds

### Why
Both changes belong in the same commit because they're coupled: exemption alone (max becomes 157) still triggers the old `> 60` fail threshold; recalibration alone (max stays 1016) still triggers the new `> 650` fail threshold. Together they yield the honest signal.

### Contract

```ts
// src/dashboard/graph-health.ts

// Path patterns whose nodes are by-design anchors. Excluded from the
// hub-overload max(degree) calculation because high inbound on these is
// expected behavior, not a pathology. Surfaced in topOffenders with
// exempt: true so the operator still sees them.
const EXEMPT_HUB_PATTERNS = [
  /^wiki\/projects\/[^/]+\.md$/,
];

// Calibrated against live vault distribution: 1398 edges across ~22 active
// wiki pages → average inbound ≈65. Warn at 3× average, fail at 10× average.
const HUB_OVERLOAD_WARN = 200;
const HUB_OVERLOAD_FAIL = 650;

function isExemptHub(path: string): boolean {
  return EXEMPT_HUB_PATTERNS.some((pattern) => pattern.test(path));
}

export function metricHubOverload(input: GraphHealthInput): MetricResult {
  const allNodes = input.feed.nodes.map((node) => ({
    path: node.path,
    degree: node.inboundCount + node.outboundCount,
    exempt: isExemptHub(node.path),
  }));

  const nonExempt = allNodes.filter((n) => !n.exempt);
  const maxDegree = nonExempt.length === 0
    ? 0
    : Math.max(...nonExempt.map((n) => n.degree));

  const status: HealthStatus =
    maxDegree > HUB_OVERLOAD_FAIL ? "fail" :
    maxDegree > HUB_OVERLOAD_WARN ? "warn" :
    "pass";

  // topOffenders includes ALL high-degree nodes (exempt and non-exempt)
  // sorted by raw degree, so the operator sees the full picture
  const topOffenders = [...allNodes]
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 5)
    .map((n) => ({
      path: n.path,
      value: n.degree,
      note: n.exempt ? "exempt (project hub — by-design anchor)" : undefined,
    }));

  return {
    id: "graph.hub-overload",
    label: "hub overload (non-project nodes)",
    value: maxDegree,
    unit: "count",
    threshold: { warn: HUB_OVERLOAD_WARN, fail: HUB_OVERLOAD_FAIL },
    status,
    detail: `highest non-exempt single-node degree is ${maxDegree}`,
    topOffenders,
  };
}
```

### Threshold rationale (record in code comment)

```ts
// HUB_OVERLOAD_WARN/FAIL calibrated against live vault distribution as of
// Phase 3.3 (2026-05-27): 1398 edges / ~22 active wiki pages → avg inbound 65.
// Warn at 3× avg, fail at 10× avg. These can be revisited if the graph shape
// changes substantially (e.g., 10× more wiki pages would shrink the average).
```

### Expected post-deploy effect on the live vault

Before:
- value 1016 (agentmemory.md), status fail
- topOffenders: 5 entries, all treated equally

After:
- value 157 (mcp-plugin lesson), status pass (under warn 200)
- topOffenders: 5 entries, agentmemory.md marked exempt with note
- `graph.cohesion` aggregator no longer reports fail
- HealthBadge goes green

### Files

- Modify: `src/dashboard/graph-health.ts` — `metricHubOverload` + the two constants + the helper
- Modify: `test/dashboard/graph-health.test.ts` — at minimum:
  - Exempt project hub doesn't affect `value` but appears in `topOffenders` with `note`
  - Non-exempt node at 199 → pass; at 250 → warn; at 700 → fail
  - All-exempt feed returns value 0, status pass
  - Empty feed returns value 0, status pass

---

## Task 2 — Threshold doc update

### Why
The new thresholds and the project-hub exemption are policy decisions that should live in the canonical thresholds doc, not just in code comments.

### Contract

Append a new section to `docs/consolidation-thresholds.md`:

```markdown
## Hub Overload Thresholds (Phase 3.3)

The `graph.hub-overload` metric in `src/dashboard/graph-health.ts` measures
the maximum inbound + outbound degree across **non-exempt** wiki nodes.

### Exempt patterns

- `wiki/projects/*.md` — project pages are by-design anchors; high inbound on
  them is expected. They appear in `topOffenders` with `exempt: true` and a
  note so the operator can see their degree without false-alarm escalation.

### Thresholds

- `warn > 200` (3× the average inbound per active wiki page)
- `fail > 650` (10× the average inbound per active wiki page)

Calibrated against live vault distribution on 2026-05-27: 1398 edges across
~22 active wiki pages. Average inbound ≈65.

### When to revisit

- If the wiki grows 10× (graph average shrinks), the thresholds may be too
  loose. Recalibrate against new average.
- If a new wiki category (e.g., `wiki/personas/`) emerges as a by-design anchor,
  add it to `EXEMPT_HUB_PATTERNS`. Stop and ask before doing so; do not expand
  the exemption list to chase green badges.
```

If `templates/schema.md` references the old thresholds anywhere, update there too.

### Files

- Modify: `docs/consolidation-thresholds.md`
- Modify (if needed): `templates/schema.md`

---

## Task 3 — Wire `note` field through the dashboard panel

### Why
The metric now returns `topOffenders[].note` for exempt entries. The `GraphHealthPanel` component renders offenders, so it needs to surface the note inline (e.g., `"wiki/projects/agentmemory.md — 1016 (exempt: project hub)"`). Otherwise the exempt status is invisible in the UI.

### Contract

Locate the offender-rendering code in `src/dashboard-ui/components/GraphHealthPanel.tsx`. If the existing render path already supports a `note` or `reason` field on offender entries, no change is needed beyond verifying. If it doesn't, add a small render hint: `{offender.note && <span className="text-text-muted">({offender.note})</span>}` next to the path/value.

Keep the change minimal — this is observability, not a UI redesign.

### Files

- Modify: `src/dashboard-ui/components/GraphHealthPanel.tsx` (only if the note field isn't already surfaced)
- Tests: `test/dashboard-ui/components/graph-health-panel.test.tsx` — assert that an offender with a `note` field renders the note text

---

## Execution order

1. **Task 1** (metric + thresholds) — substantive change; foundation
2. **Task 2** (docs) — pure documentation
3. **Task 3** (UI surface) — small, polish

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                    # full suite (848 currently passing)
npx vitest run test/dashboard/graph-health              # focus
npx vitest run test/dashboard-ui/components             # UI focus
npm run build
npm run build:ui

scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify the badge goes green:
curl -s https://srv1317946.tail6916d8.ts.net/memory/api/graph-health | \
  jq '{overallStatus, hub: (.metrics[] | select(.id=="graph.hub-overload") | {status, value})}'
curl -s 'https://srv1317946.tail6916d8.ts.net/memory/api/health?deep=true' | \
  jq '{overallStatus, cohesion: (.checks[] | select(.id=="graph.cohesion") | {status, label})}'
```

Expected:
- `/api/graph-health` overallStatus: `warn` (two warns remain: `edge-type-entropy` 0.62 and `cross-galaxy-ratio` 98%)
- `/api/health?deep=true` overallStatus: `pass` if `graph.cohesion` only escalates on fail
- HealthBadge: green for the first time since Phase 2

---

## Acceptance checklist

- [ ] `EXEMPT_HUB_PATTERNS` is a module-level constant in `graph-health.ts`
- [ ] `wiki/projects/*.md` is the only initial exempt pattern
- [ ] `metricHubOverload` computes `value` against non-exempt nodes
- [ ] `topOffenders` includes exempt entries with a `note` field explaining the exemption
- [ ] Thresholds: `warn > 200`, `fail > 650`
- [ ] On the live VPS after deploy: `graph.hub-overload` status is `pass` (value 157 < 200)
- [ ] On the live VPS: `graph.cohesion` verify check no longer reports `graph.hub-overload` in its failing list
- [ ] On the live VPS: HealthBadge goes green (or warn, depending on how `graph.cohesion` aggregates)
- [ ] `docs/consolidation-thresholds.md` documents the new thresholds and rationale
- [ ] `GraphHealthPanel` surfaces the `note` field for exempt offenders
- [ ] All 848+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No changes to other metrics' thresholds or exemption logic
- [ ] No changes to consolidation, classifier, or matchers

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

- **Configurable exemption list** — `EXEMPT_HUB_PATTERNS` becomes a vault-config value so operators can extend it without code changes. Defer until a second by-design anchor category surfaces
- **Per-relation-type degree breakdown** — surface in `topOffenders` how many of a node's edges are `mentions` vs `derived_from` vs `uses`. Would expose the "mcp-plugin lesson is 157 inbound because lexical matcher catches 'Claude Code'" pattern. Real signal for a future tuning pass on the lexical title-index
- **Lexical matcher tightening** — separate brief: investigate whether the lexical title-index's match against `wiki/lessons/mcp-plugin-bundled-mcp-json.md` is too aggressive ("Claude Code" is a very common phrase). May warrant per-title stop-word lists or minimum-context requirements
- **Edge-type-entropy push to pass** — `0.62 warn` could move to pass by tightening rule 4's confidence ceiling (currently `< 0.7`; bumping to `< 0.85` would reclassify more matches as `derived_from`). Defer until evidence shows the warn is load-bearing
- **Cross-galaxy ratio recalibration** — `98% warn` is the architectural reality given our consolidation-heavy graph. The metric is essentially fixed-at-warn for our shape. Consider raising thresholds further or replacing with a different cross-galaxy quality signal
