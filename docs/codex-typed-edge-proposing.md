# Codex Implementation Brief — Typed-Edge Proposing in Consolidation

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Phase 3.2 of the Memory Fort roadmap. The final remaining real fail on `/api/graph-health`:

- `graph.edge-type-entropy: 0.30` (fail threshold `< 0.40`)

Out of 1347 edges in the live graph:

| Type | Count | Share |
|---|---|---|
| `mentions` | 1285 | 95.4% |
| `linked` | 54 | 4.0% |
| `derived_from` | 5 | 0.4% |
| `uses` | 2 | 0.1% |
| `supersedes` | 1 | 0.1% |

`mentions` overwhelmingly dominates because the consolidation pipeline (the source of 1285 of those edges) writes everything as untyped `relations.mentions: [...]` regardless of match shape. Brief A added schema support for typed edges; this brief teaches the consolidator to actually use them.

The consolidation matcher already tracks per-match metadata (the `source: 'lexical' | 'bm25' | 'both'` field on each proposed relation, from the Phase 0 consolidation brief). That metadata is enough to classify each match into a probable edge type **without LLM calls or new external dependencies**. The classification is deterministic, testable with fixtures, and reversible.

After this lands and the operator re-runs consolidation with `--force` against the live vault, `edge-type-entropy` should move from 0.30 fail to pass (target `> 0.80`). The HealthBadge can finally go green once `hub-overload` (the last remaining fail, likely a metric-tuning question) is resolved separately.

---

## Scope guard

You will:

- Add a deterministic classifier function that takes a `ProposedRelation` (the existing shape from `src/consolidate/runner.ts`) and returns an edge type label. Rules below
- Update `runConsolidate` in `src/consolidate/runner.ts` so the classifier output replaces the hardcoded `mentions` key when writing `relations.<type>: [...]` back to the observation's frontmatter
- Preserve all backwards-compat for already-written edges. The classifier only affects new writes (or re-writes via `--force`)
- Add an end-to-end test that goes consolidation-write → corpus-read → metric-compute → API-serialize. This is the missing layer that hid the SearchSource bug in Phase 3.1 (see commit `d741aca`)
- Update `templates/schema.md` to document the classification rules so the next reader knows what triggers what type
- Update `docs/consolidation-thresholds.md` to record the post-classifier entropy result against the live vault

You will **not**:

- Add LLM calls to the classifier — pure heuristic only
- Write edges on wiki pages (consolidation writes only on raw observations; reverse-edge materialization is a separate brief)
- Add new edge types beyond what `templates/schema.md` already documents (`mentions`, `derived_from`, `uses`, `depends_on`, `supersedes`, `contradicts`, `caused_by`, `fixed_by`, `mentioned_in`, `linked`)
- Modify the existing typed-edge schema or parser from Brief A
- Change the consolidation matcher itself (title-index, bm25-augment) — only how its output is classified
- Touch retrieval scoring or graph rendering

If a match's correct edge type is ambiguous from the rules below (e.g., a wiki page in `wiki/decisions/` matched only by BM25), **fall back to `mentions`** rather than guessing. The rules below explicitly list the cases that override; everything else is `mentions`.

---

## Repo orientation (verified before brief)

- `src/consolidate/runner.ts:131-170` — `ProposedRelation` type and `runConsolidate` orchestration. The `source: 'lexical' | 'bm25' | 'both'` field is already present per the Phase 0 consolidation brief
- `src/consolidate/runner.ts:145-159` — `writeObservationMentions()`. This is where the hardcoded `mentions` key currently lives. Rename to `writeObservationRelations()` and have it accept the typed map
- `src/consolidate/title-index.ts` — lexical matcher. Returns `Match[]` with `source: 'lexical'`
- `src/consolidate/bm25-augment.ts` — BM25 matcher. Returns matches with `source: 'bm25'`
- `templates/schema.md:92-108` — canonical edge-type list. Confirms the 10 documented types are available
- `src/storage/frontmatter.ts` — `writeRelations()` from Brief A is already typed-edge-aware. We feed it a `RelationMap` with multiple keys instead of `{ mentions: [...] }`
- `docs/consolidation-thresholds.md` — record the empirical entropy result here once Codex re-runs against the live vault

---

## Task 1 — Edge-type classifier function

### Why
The classification is small, pure, and benefits from being separable from the orchestration. Easy to test in isolation.

### Contract

```ts
// src/consolidate/classify-edge-type.ts

import type { ProposedRelation } from "./runner.js";

export type EdgeType =
  | "mentions"
  | "derived_from"
  | "uses"
  | "supersedes";
// Future types (contradicts, caused_by, etc.) come from later briefs

export function classifyEdgeType(relation: ProposedRelation): EdgeType {
  // Rules below
}
```

### Classification rules (deterministic, evaluated in order)

The classifier evaluates these rules in sequence and returns the **first matching** rule's type. If none match, fall back to `mentions`.

| Rule | Condition | Returns | Rationale |
|---|---|---|---|
| 1 | Target is in `wiki/tools/*.md` | `uses` | The raw observation uses this tool |
| 2 | Target is in `wiki/crystals/*.md` | `derived_from` | Crystals are distilled insights; raw observations are evidence the insight was derived from |
| 3 | Target path contains `superseded-by` or `deprecated` (case-insensitive substring in the title field) | `supersedes` | The match represents a replacement relationship |
| 4 | `relation.source === "bm25"` AND `relation.confidence < 0.7` AND target is in `wiki/decisions/*.md` or `wiki/lessons/*.md` | `derived_from` | High-recall BM25-only match against a decision/lesson is more likely "evidence for" than "explicit mention" |
| 5 (default) | Anything else | `mentions` | Catch-all for explicit references |

Rule 4 is the high-leverage one. Today every raw observation gets `mentions: [wiki/decisions/foo.md]` even when the matcher only found topical overlap, not a literal title mention. Rule 4 reclassifies those as `derived_from` (the raw observation is evidence the decision was made).

The expected effect on entropy: roughly 30-50% of `bm25`-only matches against decisions/lessons get reclassified as `derived_from`. Out of 1285 consolidation edges, that's hundreds shifting from `mentions` to `derived_from`. Entropy moves from 0.30 to roughly 0.85-1.20 (passing).

### Files

- New: `src/consolidate/classify-edge-type.ts`
- New: `test/consolidate/classify-edge-type.test.ts` — at minimum:
  - Tools target → `uses`
  - Crystals target → `derived_from`
  - Title containing "deprecated" → `supersedes`
  - BM25-only, confidence 0.65, target wiki/decisions/foo.md → `derived_from`
  - BM25-only, confidence 0.85, target wiki/decisions/foo.md → `mentions` (confidence too high for rule 4)
  - Lexical match against any target → `mentions`
  - `both` match (lexical + bm25) against decisions → `mentions`
  - Catch-all unmatched case returns `mentions`

---

## Task 2 — Integrate classifier into the consolidation writer

### Why
The classifier output has to actually be used when writing relations. The runner today builds `{ mentions: [...paths] }` and writes it; the new shape builds `{ mentions: [...], derived_from: [...], uses: [...], supersedes: [...] }` (only including keys that have non-empty arrays).

### Contract

```ts
// src/consolidate/runner.ts

import { classifyEdgeType, type EdgeType } from "./classify-edge-type.js";
import { writeRelations } from "../storage/frontmatter.js"; // from Brief A

async function writeObservationRelations(
  vaultRoot: string,
  observationPath: string,
  proposed: ProposedRelation[],
): Promise<void> {
  // Bucket proposed relations by edge type
  const byType: Record<EdgeType, RelationEdge[]> = {
    mentions: [],
    derived_from: [],
    uses: [],
    supersedes: [],
  };
  for (const relation of proposed) {
    const type = classifyEdgeType(relation);
    byType[type].push({
      target: relation.target,
      confidence: relation.confidence,
      source: { agent: "consolidate", captured_at: new Date().toISOString() },
    });
  }

  // Drop empty buckets so we don't write `mentions: []`
  const relations: RelationMap = {};
  for (const [type, edges] of Object.entries(byType)) {
    if (edges.length > 0) relations[type] = edges;
  }

  // Existing atomic-write logic, but pass the typed RelationMap instead of
  // hardcoded { mentions: paths }
  await writeRelationsToFrontmatter(observationPath, relations);
}
```

The function previously called `writeObservationMentions()` becomes `writeObservationRelations()`. Old call sites get renamed. Behavior is byte-identical for inputs where every relation classifies as `mentions` (the test suite's fixtures).

### Idempotency

The existing idempotency rule (skip observations that already have `relations.*`) must still hold. When `--force` is set, the writer overwrites the existing typed-edge map — this is the path the operator uses to reclassify the live vault's 1285 existing `mentions` edges after deploy.

### Files

- Modify: `src/consolidate/runner.ts` — rename + restructure the writer
- Modify: `test/consolidate/runner.test.ts` (or wherever the existing tests live) — update fixtures that asserted `relations.mentions` to assert the appropriate typed key when applicable
- New test cases for typed-edge writing in the same file: assert mixed-type output writes correct YAML, assert byte-identical output when all matches classify as `mentions`

---

## Task 3 — End-to-end integration test

### Why
The Phase 3.1 SearchSource bug hid because no test exercised the consolidation-write → corpus-read → metric-compute path together. This task adds that integration so future per-layer type drift surfaces at test time, not at deploy time.

### Contract

A new test file at `test/integration/consolidation-to-metric.test.ts`:

1. Set up a tempdir vault with 1 raw observation and 2 wiki pages (one in `wiki/tools/`, one in `wiki/decisions/`)
2. Run `runConsolidate({ apply: true, vaultRoot: tempdir, ... })`
3. Read the raw observation back via `loadSearchCorpus`
4. Build the graph feed via `loadGraphFeed`
5. Compute graph health via `computeGraphHealth`
6. Assert:
   - The raw observation has `relations.uses: [wiki/tools/X.md]` and `relations.derived_from: [wiki/decisions/Y.md]` (under the rules)
   - The graph feed surfaces both edges with the correct `type` field
   - The `graph.edge-type-entropy` metric returns `> 0` (i.e., diversity present)
   - The `frontmatter.source` verify check still passes on the new audit log

This test is the load-bearing one. If any future change to the corpus loader, graph feed, or metric module silently filters one of these edges, this test fails.

### Files

- New: `test/integration/consolidation-to-metric.test.ts`
- Modify: `vitest.config.ts` only if the new test directory needs explicit inclusion (it shouldn't if the glob picks up `test/**/*.test.ts`)

---

## Task 4 — Schema doc + thresholds doc update

### Why
The classification rules are policy. They belong in the schema documentation so future operators (and future-Codex-on-a-fresh-context) can see the rules in canonical form.

### Contract

Append a section to `templates/schema.md`:

```markdown
## Consolidation edge-type classification

The `memory consolidate` pipeline assigns each proposed match an edge type
based on these rules (evaluated in order; first match wins):

1. Target in `wiki/tools/*.md` → `uses`
2. Target in `wiki/crystals/*.md` → `derived_from`
3. Title contains "deprecated" or "superseded-by" → `supersedes`
4. BM25-only match with confidence < 0.7 against a decision or lesson →
   `derived_from`
5. Catch-all → `mentions`

Lexical matches (where the raw observation body literally contains the wiki
page's title) always go to `mentions` unless overridden by rules 1-3, because
a literal mention is a stronger semantic signal than a topical match.
```

Update `docs/consolidation-thresholds.md` after Codex runs the live re-classification (see "Operator step" below) with the empirical entropy result: e.g., "After typed-edge proposing brief, edge-type-entropy on live vault moved from 0.30 to 0.91 (pass) across 1347 edges."

### Files

- Modify: `templates/schema.md`
- Modify: `docs/consolidation-thresholds.md`

---

## Execution order

1. **Task 1** (classifier) — pure function, low risk, foundation
2. **Task 2** (writer integration) — substantive but bounded
3. **Task 3** (integration test) — adds the missing safety net
4. **Task 4** (docs) — pure documentation, can land alongside Task 3

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Operator step (post-deploy, not part of any Codex commit)

After Codex pushes the four commits and the dashboard is deployed:

```
# Re-classify the existing 1285 consolidation edges against the new classifier
node dist/cli.mjs consolidate --apply --force

# Commit the vault changes
git -C ~/.memory status                               # ~1000 raw files modified
git -C ~/.memory add raw/ wiki/.audit/
git -C ~/.memory commit -m "chore: reclassify consolidation edges with typed classifier"
git -C ~/.memory push vps main

# Restart dashboard so the metrics re-compute
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify
curl -s https://srv1317946.tail6916d8.ts.net/memory/api/graph-health | \
  jq '.metrics[] | select(.id=="graph.edge-type-entropy")'
# Expected: status=pass, value > 0.80
```

This is the operator's responsibility (Claude Opus, in our session structure), not Codex's. The brief delivers the code; the live re-classification is a separate, reviewable operation.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                  # full suite (839 currently passing)
npx vitest run test/consolidate test/integration      # focus
npm run build
npm run build:ui

# Deploy dashboard (no functional change but ships the new classifier
# and the integration test infrastructure):
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
ssh root@srv1317946 "systemctl restart memory-dashboard"
```

---

## Acceptance checklist

- [ ] `classifyEdgeType()` is a pure function returning one of `mentions`, `derived_from`, `uses`, `supersedes`
- [ ] Tools-target matches return `uses`
- [ ] Crystals-target matches return `derived_from`
- [ ] BM25-only matches with confidence < 0.7 against decisions/lessons return `derived_from`
- [ ] Lexical matches always return `mentions` unless overridden by rules 1-3
- [ ] Default fallback is `mentions`
- [ ] `runConsolidate` writes typed `relations.<type>: [...]` arrays instead of hardcoded `relations.mentions: [...]`
- [ ] When all proposed relations classify as `mentions`, the output is byte-identical to today's behavior (no regression in existing fixtures)
- [ ] `--force` overwrites existing typed-edge maps (operator step uses this)
- [ ] Integration test exercises consolidation-write → corpus-read → graph-feed → metric path end-to-end
- [ ] `templates/schema.md` documents the classification rules
- [ ] All 839+ tests still green; new tests added per task
- [ ] No new dependencies, no LLM calls, no secrets, no OneDrive paths
- [ ] No changes to wiki pages' frontmatter
- [ ] No changes to the title-index or bm25-augment matchers

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

- **Reverse-edge materialization** — write `derived_from` arrays on wiki pages pointing at the raw observations that contributed to them. Today reverse counts are computed on-the-fly; making them persistent would help offline tooling and search recall. Touches user-curated content, so user approval per write is appropriate
- **`contradicts` proposing** — detect when a raw observation directly contradicts a wiki page's claim (e.g., decision says "use X", observation says "X failed, switching to Y"). Requires semantic analysis beyond the current title + BM25 signals
- **`caused_by` / `fixed_by`** — bug → fix edges from raw observations that resolve previously-recorded errors. Would need an error/fix detection pass on raw observations
- **`depends_on`** — repo/codebase dependency edges. Out of scope until code-memory ingestion exists as a distinct memory kind (Phase 4)
- **Hub-overload remediation** — the last remaining fail on `/api/graph-health`. Strategic decision: exempt project pages from the metric, or compact the `wiki/projects/agentmemory.md` 1008-edge hub. Likely a small metric-tuning brief rather than a code change
