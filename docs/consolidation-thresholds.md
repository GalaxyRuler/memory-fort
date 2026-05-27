# Consolidation Thresholds

Date: 2026-05-27

This document records the initial live-vault tuning for `memory consolidate`.
The command is intentionally local and deterministic: no LLM calls, embedding
calls, or remote APIs are used.

## Chosen Defaults

- Title and alias matches: confidence `1.0`
- Partial title-prefix matches: confidence `0.85`
- BM25 threshold: `200`
- BM25 confidence range: `0.5` to `0.8`
- Runner minimum confidence: `0.6`
- Maximum links per observation: `5`
- Consolidation target set: `wiki/**` excluding `wiki/.audit/**`

## Live Vault Data

The live plan was run with:

```sh
node dist/cli.mjs consolidate --plan
```

Baseline before tuning:

- BM25 threshold: `5.0`
- Scanned observations: `1094`
- Observations with proposed links: `1094` (`100%`)
- Typical output: `5` links per observation
- Sample issue: audit logs and broad project decisions appeared in the top
  BM25 suggestions.

After tuning:

- BM25 threshold: `200`
- Scanned observations: `1095`
- Observations with proposed links: `1083` (`98.9%`)
- Proposed edges: `1283`
- Average proposed links per linked observation: `1.18`

The linked-observation rate is still above the 60-90% planning expectation, but
the excess is now driven primarily by lexical matches such as imported
agentmemory observations mentioning `agentmemory`, plus high-recall partial
title prefixes. Raising the BM25 threshold further does not materially reduce
coverage once BM25 is no longer the dominant source. Changing that behavior
would mean altering the title/alias matcher contract rather than tuning BM25.

## Rationale

Threshold `5.0` was appropriate for tiny fixtures but too permissive for the
live vault. Many raw observations are long enough that unrelated wiki pages
share enough common terms to clear a low BM25 threshold.

Threshold `200` keeps BM25 as a high-signal augmentation while avoiding the
"five links for every observation" behavior seen at `5.0`. Audit pages are
excluded because they are operational records, not semantic wiki targets.

The warning threshold in `memory verify` is intentionally separate: it warns
when fewer than `30%` of episodic observations have at least one relation, which
corresponds to an orphan rate above `70%`.

## Typed Edge Proposing

The typed-edge classifier keeps the matcher thresholds above unchanged, but
routes proposed matches into more specific relation buckets before writing raw
observation frontmatter:

- `wiki/tools/*.md` targets write as `uses`.
- `wiki/crystals/*.md` targets write as `derived_from`.
- Titles containing `deprecated` or `superseded-by` write as `supersedes`.
- BM25-only matches with confidence `< 0.7` against `wiki/decisions/*.md` or
  `wiki/lessons/*.md` write as `derived_from`.
- Everything else writes as `mentions`.

Fixture verification now covers consolidation-write -> corpus-read ->
graph-feed -> graph-health and confirms mixed `uses` plus `derived_from` edges
produce non-zero edge-type entropy.

### Live vault baseline (2026-05-27)

After the operator ran `memory consolidate --apply --force` against
`~/.memory/` and the resulting vault delta was pushed to the VPS and the
dashboard restarted:

- `graph.edge-type-entropy`: **0.30 (fail) → 0.62 (warn)**
- 1398 edges across 5 edge types
- 65 raw observations had at least one match reclassified from `mentions` to
  `derived_from` (rule 4 — BM25-only matches against decisions/lessons)
- Remaining matches kept `mentions` (rule 5 catch-all) and produced
  byte-identical output, so atomic writes skipped them

The remaining gap from 0.62 to the pass threshold (0.80) reflects that
lexical and `both`-source matches still dominate, and rule 4's confidence
ceiling (0.7) was deliberately conservative to avoid false `derived_from`
classifications. Tightening rule 4 or adding rules that target `wiki/projects/`
or `wiki/references/` are candidates for a future iteration if the warn becomes
load-bearing for the HealthBadge.

## Hub Overload Thresholds (Phase 3.3)

The `graph.hub-overload` metric in `src/dashboard/graph-health.ts` measures
the maximum inbound + outbound degree across non-exempt wiki nodes.

### Exempt patterns

- `wiki/projects/*.md` - project pages are by-design anchors; high inbound on
  them is expected. They appear in `topOffenders` with `exempt: true`, a
  `reason`, and a note so the operator can see their degree without
  false-alarm escalation.

### Thresholds

- `warn > 200` (3x the average inbound per active wiki page)
- `fail > 650` (10x the average inbound per active wiki page)

Calibrated against live vault distribution on 2026-05-27: 1398 edges across
~22 active wiki pages. Average inbound is approximately 65.

### When to revisit

- If the wiki grows 10x, the graph average may shrink and these thresholds may
  become too loose. Recalibrate against the new average.
- If a new wiki category, such as `wiki/personas/`, emerges as a by-design
  anchor, add it to `EXEMPT_HUB_PATTERNS`. Stop and ask before doing so; do not
  expand the exemption list to chase green badges.

## Phase 3.4 - Warn cleanup (2026-05-27)

### Classifier rule 4 ceiling dropped

Rule 4 in `src/consolidate/classify-edge-type.ts` previously required
`relation.confidence < 0.7` for BM25-only matches against decisions or lessons
to classify as `derived_from`. The ceiling is dropped in Phase 3.4 because
BM25-only by definition means no literal title match in the raw body. The
relation is topical evidence regardless of confidence strength.

Expected post-deploy effect after the operator re-runs consolidation:

- `graph.edge-type-entropy`: 0.62 (warn) -> >=0.80 (pass)
- More raw observations have `relations.derived_from` populated alongside
  `relations.mentions`

### Cross-galaxy ratio thresholds recalibrated

Memory Fort's consolidation pipeline writes raw-episodic and raw-semantic
(agentmemory imports) -> wiki-semantic and wiki-core edges as the dominant
pattern. The previous Phase 3.0 thresholds (warn > 95%, fail > 99%) treated the
architectural norm as a warn signal.

New thresholds: warn > 99%, fail > 99.5%. The metric still fires if
cross-galaxy crossings reach essentially 100% (no intra-wiki relations at all)
or for shapes where same-galaxy edges should dominate.

### When to revisit

- If intra-wiki edges become more common, such as wikilinks between wiki pages
  getting materialized as typed relations, the cross-galaxy ratio will drop
  naturally and these thresholds will still catch outliers.
- If a new cognitive-type inference rule shifts the from/to galaxy
  distribution, the directional detail in `topOffenders` will surface it.
