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
produce non-zero edge-type entropy. The live vault reclassification is still
pending the operator step (`memory consolidate --apply --force`), so the
previous live `graph.edge-type-entropy` value of `0.30` remains the last
recorded empirical baseline here.
