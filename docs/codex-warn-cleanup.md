# Codex Implementation Brief — Warn Cleanup (Entropy + Cross-Galaxy)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Phase 3.4. After Phase 3.3 closed the last fail, two warns remain on `/api/graph-health`:

- `graph.edge-type-entropy: 0.62 warn` (pass threshold `≥ 0.80`)
- `graph.cross-galaxy-ratio: 98% warn` (pass threshold `≤ 95%`, fail `> 99%`)

Both have honest fixes — not cosmetic suppression. The entropy warn is real: the classifier's rule 4 has an over-conservative confidence ceiling that leaves obvious-`derived_from` matches as `mentions`. The cross-galaxy warn is an architecture-vs-threshold mismatch: the original generic threshold (`> 95%`) treats Memory Fort's normal consolidation-heavy graph as pathological.

After this lands and the operator re-runs consolidation against the live vault, both metrics should move to pass and the HealthBadge should go fully green for the first time since Phase 2.

---

## Scope guard

You will:

- Drop the confidence ceiling on classifier rule 4 in `src/consolidate/classify-edge-type.ts`. New rule: **all BM25-only matches against `wiki/decisions/*.md` or `wiki/lessons/*.md` classify as `derived_from`** regardless of confidence
- Optionally extend rule 4 to also cover `wiki/references/*.md` targets (BM25-only against references → `derived_from`). The semantic justification: BM25-only = no literal mention = topical evidence = `derived_from`, independent of target subdirectory. **Stop and ask** before doing this if test coverage suggests a regression risk
- Recalibrate cross-galaxy thresholds in `src/dashboard/graph-health.ts`. New thresholds: `warn > 99%`, `fail > 99.5%`. Rationale documented in code comment
- Update `templates/schema.md` if it explicitly names the old classifier rule
- Update `docs/consolidation-thresholds.md` with the new classifier ceiling drop and the cross-galaxy threshold recalibration, plus the expected post-deploy entropy result
- Update tests to cover: BM25-only at confidence 0.95 against a lesson now returns `derived_from` (was `mentions`); cross-galaxy ratio at 98% passes under new thresholds

You will **not**:

- Reclassify lexical or `both`-source matches — those stay `mentions`. Lexical = literal title mention; `both` = title appears AND topical overlap; both are explicit references, not derivations
- Change the cross-galaxy metric semantics — only the thresholds. The detail line with directional breakdown stays
- Touch other metrics, other classifier rules, or the consolidation matcher
- Add new edge types
- Add new wiki page targets to the classifier beyond the optional `wiki/references/*.md` extension

If the entropy lift after rule 4 expansion is still under 0.80 in the integration tests (i.e., the fixture data shows the new rule didn't move the needle enough), **stop and ask** before adding further rules. The brief's threshold can be a moving target if needed, but expanding the classifier surface is a deliberate decision.

---

## Repo orientation

- `src/consolidate/classify-edge-type.ts` — rule 4 lives here. The current condition is `relation.source === "bm25" && relation.confidence < 0.7 && (target in decisions or lessons)`
- `src/dashboard/graph-health.ts` — `metricCrossGalaxyRatio` and its threshold constants (added in Phase 3.0)
- `templates/schema.md:228` (approximate) — classifier rules section added in Phase 3.2
- `docs/consolidation-thresholds.md` — has both the Phase 3.2 entropy baseline and the Phase 3.3 hub-overload section. The new content from this brief appends to it
- Test fixtures in `test/consolidate/classify-edge-type.test.ts` will need updates to reflect the dropped ceiling

---

## Task 1 — Drop the confidence ceiling on classifier rule 4

### Why
Rule 4's current `confidence < 0.7` ceiling treats high-confidence BM25-only matches as if they were explicit mentions. They aren't — BM25-only means no literal title match in the raw body, regardless of how strong the topical overlap. The original ceiling was a conservative first iteration; we now have live data showing it's too conservative (entropy capped at 0.62 because most BM25-only matches still classify as `mentions`).

### Contract

```ts
// src/consolidate/classify-edge-type.ts

export function classifyEdgeType(relation: ProposedRelation): EdgeType {
  // Rule 1: wiki/tools/*.md → uses
  if (/^wiki\/tools\/[^/]+\.md$/.test(relation.target)) return "uses";

  // Rule 2: wiki/crystals/*.md → derived_from
  if (/^wiki\/crystals\/[^/]+\.md$/.test(relation.target)) return "derived_from";

  // Rule 3: title contains 'deprecated' or 'superseded-by' → supersedes
  const titleLower = (relation.targetTitle ?? "").toLowerCase();
  if (titleLower.includes("deprecated") || titleLower.includes("superseded-by")) {
    return "supersedes";
  }

  // Rule 4 (revised): ANY BM25-only match against a decision or lesson is
  // semantic evidence ('derived_from'), not literal reference ('mentions').
  // BM25-only means no title appeared verbatim in the raw body, so this can
  // never be a literal mention regardless of confidence. The previous
  // confidence < 0.7 ceiling was over-conservative; dropped in Phase 3.4.
  if (
    relation.source === "bm25" &&
    (/^wiki\/decisions\/[^/]+\.md$/.test(relation.target) ||
      /^wiki\/lessons\/[^/]+\.md$/.test(relation.target))
  ) {
    return "derived_from";
  }

  // Rule 5 (catch-all): mentions
  return "mentions";
}
```

Optional rule extension (Codex's judgment call, with the brief's permission): if test fixtures show the rule-4-ceiling drop alone doesn't lift entropy above 0.80, **stop and ask** before adding `wiki/references/*.md` to the rule 4 target set. The brief permits the extension but doesn't mandate it.

### Files

- Modify: `src/consolidate/classify-edge-type.ts`
- Modify: `test/consolidate/classify-edge-type.test.ts` — update existing tests asserting `<0.7` boundary; add coverage at confidence 0.85, 0.95 (should now return `derived_from`)
- Modify: `test/integration/consolidation-to-metric.test.ts` — verify the integration test's expected `derived_from` count increases under the new rule

---

## Task 2 — Recalibrate cross-galaxy thresholds

### Why
The original thresholds (`warn > 70%`, `fail > 90%`) came from the research doc's generic recommendation and were partially recalibrated in Phase 3.0 to (`warn > 95%`, `fail > 99%`). But for Memory Fort's actual graph shape — consolidation pipeline writing raw-episodic → wiki-semantic edges as the dominant pattern — even the recalibrated thresholds treat the architectural norm as a warn signal.

Looking at the breakdown from live data:

- 1398 total edges
- 1370 cross-galaxy (98%)
- Top crossings: `semantic→core` 935 (agentmemory imports → project hubs), `episodic→procedural` 211, `episodic→core` 106, `episodic→semantic` 48

`semantic→core` dominates because agentmemory imports were classified as `semantic` cognitive type and the project pages are `core`. This is by-design behavior of the cognitive-type inference rules. Treating it as a warn flag has been wrong since Phase 3.0.

The metric still has value: it would correctly fire if 100% of edges crossed galaxies (no intra-wiki relations at all). Raising thresholds to `warn > 99%`, `fail > 99.5%` preserves that signal while accepting the current state as normal.

### Contract

```ts
// src/dashboard/graph-health.ts

// Calibrated against Memory Fort's consolidation-heavy graph shape on
// 2026-05-27: raw-episodic and raw-semantic (agentmemory imports) nodes
// linking to wiki-semantic and wiki-core target pages produce 98% cross-
// galaxy edges as the architectural norm. The thresholds catch genuine
// anomalies (essentially 100% crossings = no intra-wiki structure at all)
// without false-alarming on the consolidation pattern.
const CROSS_GALAXY_WARN = 0.99;  // was 0.95 in Phase 3.0
const CROSS_GALAXY_FAIL = 0.995; // was 0.99 in Phase 3.0
```

The metric's `value`, `detail`, and `topOffenders` shape stay unchanged. Only the two thresholds move.

### Files

- Modify: `src/dashboard/graph-health.ts` — the two threshold constants + code comment
- Modify: `test/dashboard/graph-health.test.ts` — update boundary tests (98% should now pass; add new boundary cases at 99% and 99.5%)

---

## Task 3 — Docs update

### Why
Both changes are policy decisions worth recording in the canonical thresholds doc, so future iterations have the rationale visible.

### Contract

Append a new section to `docs/consolidation-thresholds.md`:

```markdown
## Phase 3.4 — Warn cleanup (2026-05-27)

### Classifier rule 4 ceiling dropped

Rule 4 in `src/consolidate/classify-edge-type.ts` previously required
`relation.confidence < 0.7` for BM25-only matches against decisions or
lessons to classify as `derived_from`. The ceiling is dropped in Phase 3.4
because BM25-only by definition means no literal title match in the raw
body — the relation is topical evidence regardless of confidence strength.

Expected post-deploy effect after operator re-runs consolidation:
- `graph.edge-type-entropy`: 0.62 (warn) → ≥0.80 (pass)
- More raw observations have `relations.derived_from` populated alongside
  `relations.mentions`

### Cross-galaxy ratio thresholds recalibrated

Memory Fort's consolidation pipeline writes raw-episodic and raw-semantic
(agentmemory imports) → wiki-semantic and wiki-core edges as the dominant
pattern. The previous Phase 3.0 thresholds (warn > 95%, fail > 99%) treated
the architectural norm as a warn signal.

New thresholds: warn > 99%, fail > 99.5%. The metric still fires if cross-
galaxy crossings reach essentially 100% (no intra-wiki relations at all)
or for shapes where same-galaxy edges should dominate.

### When to revisit

- If intra-wiki edges become more common (e.g., wikilinks between wiki
  pages get materialized as typed relations), the cross-galaxy ratio will
  drop naturally and these thresholds will still catch outliers
- If a new cognitive-type inference rule shifts the from/to galaxy
  distribution, the directional detail in `topOffenders` will surface it
```

If `templates/schema.md` mentions rule 4's old ceiling, update that too.

### Files

- Modify: `docs/consolidation-thresholds.md`
- Modify (if applicable): `templates/schema.md`

---

## Execution order

1. **Task 1** (classifier rule 4) — affects every future consolidation write
2. **Task 2** (cross-galaxy thresholds) — independent; can land in any order
3. **Task 3** (docs) — pure documentation

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Operator step (post-deploy, not part of any Codex commit)

```
# Re-classify existing consolidation edges with the new rule 4
node dist/cli.mjs consolidate --apply --force

# Commit the vault changes (likely more than 65 files this time since
# rule 4 now matches more cases)
git -C ~/.memory add raw/ wiki/.audit/
git -C ~/.memory commit -m "chore: reclassify with dropped rule 4 ceiling"
git -C ~/.memory push vps main

# Restart dashboard
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify both warns moved to pass
curl -s https://srv1317946.tail6916d8.ts.net/memory/api/graph-health | \
  jq '.overallStatus, (.metrics[] | select(.id|test("entropy|cross-galaxy")) | {id, status, value})'
# Expected: overallStatus pass; both metrics status pass
```

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                  # full suite (853 currently passing)
npx vitest run test/consolidate test/dashboard        # focus
npm run build
npm run build:ui

scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/
ssh root@srv1317946 "systemctl restart memory-dashboard"
```

---

## Acceptance checklist

- [ ] Classifier rule 4 no longer requires `confidence < 0.7`
- [ ] All BM25-only matches against `wiki/decisions/*.md` and `wiki/lessons/*.md` classify as `derived_from`
- [ ] Lexical and `both`-source matches are unchanged (still `mentions` unless covered by rules 1-3)
- [ ] `metricCrossGalaxyRatio` thresholds: warn > 99%, fail > 99.5%
- [ ] On the live VPS after operator re-runs consolidation: `graph.edge-type-entropy` status is `pass` (value ≥ 0.80)
- [ ] On the live VPS: `graph.cross-galaxy-ratio` status is `pass` (current 98% under new warn 99%)
- [ ] `/api/graph-health` overallStatus is `pass`
- [ ] `/api/health?deep=true` overallStatus is `pass`
- [ ] HealthBadge UI shows green
- [ ] `docs/consolidation-thresholds.md` documents both Phase 3.4 changes
- [ ] All 853+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No changes to consolidation matcher, other metrics, or UI components

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

- **Per-relation-type degree breakdown in `topOffenders`** — surface what fraction of a hub's edges are `mentions` vs `derived_from` vs `uses`. Would expose lexical-matcher over-eagerness (the 189-degree mcp-plugin lesson hub at `wiki/lessons/mcp-plugin-bundled-mcp-json.md` is almost certainly all `mentions` from "Claude Code" lexical matches)
- **Lexical matcher tightening** — investigate whether the title-index's match against very common phrases ("Claude Code", "agentmemory") is too aggressive. May warrant per-title stop-word lists or minimum-context requirements
- **Configurable EXEMPT_HUB_PATTERNS** — vault-config override for exemption list. Defer until a second by-design anchor category surfaces
- **New cross-galaxy quality metric** — replace the simple ratio with something architecture-aware. E.g., "cross-galaxy direction diversity": Shannon entropy over (from_galaxy, to_galaxy) tuples. Would catch the case where one direction pattern dominates without depending on a static threshold. Defer until evidence shows the current metric is regularly misleading
- **Phase 4 — richer memory kinds** — prospective memory, event segmentation, narrative threads, procedural extraction. The roadmap-published next phase once Phase 3 closes
