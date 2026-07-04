# Phase 5 Task 5a Recall Evidence - Lexical Index vs Legacy

Date: 2026-07-03
Branch: codex/phase5-task5
Mode: lexical index vs legacy, no vector embedding, no 4-target CI

## Inputs

- Vault: `<user-home>/.memory`
- Candidate source: `var/phase5-task5/phase5-task5-candidate-queries-2026-07-03.jsonl`
- Hard-held-out paraphrase source: `var/phase5-task5/phase5-task5-hard-heldout-queries-2026-07-03.jsonl`
- Machine-readable result: `var/phase5-task5/phase5-task5-lexical-vs-legacy-metadata-2026-07-03.json` (local ignored evidence)
- Candidate rows before filtering: 75
- Filtered weak rows, 1-based JSONL lines: 53, 54, 55, 58, 60, 61
- Original evaluated rows after filtering: 69
- Hard-held-out paraphrase rows added: 52
- Total evaluated rows: 121
- Known-target rows, original plus hard-held-out: 104
- Evaluated row mix:
  - known-target: 104
  - ambiguous: 5
  - code-api: 3
  - metadata-path-heavy: 5
  - graph-hyde-favoring: 4

Filtered rows:

| line | id | category | query |
| --- | --- | --- | --- |
| 53 | p5-c4a3ff38d6 | ambiguous | what happened with compile proposal: wiki/projects/alfaraheedi.md |
| 54 | p5-179c29ff63 | code-api | which note mentions code block |
| 55 | p5-69eb1d78cf | metadata-path-heavy | which references note at compile proposed alfaraheedi covers compile proposal: wiki/projects/alfaraheedi.md |
| 58 | p5-2f5ee66aad | code-api | which note mentions code block |
| 60 | p5-589d984d49 | ambiguous | what happened with compile proposal: wiki/projects/galaxyos.md |
| 61 | p5-f23abacf70 | code-api | which note mentions integration() |

## Harness Configuration

Lexical index path:

- Built a fresh SQLite index at `var/phase5-task5/phase5-task5-lexical-index-metadata-2026-07-03.sqlite`.
- Ran `reconcileIndex(indexDb, vaultRoot)` only.
- Used `chunks_fts` FTS5 lexical search.
- Schema change under test:
  - `files` now stores frontmatter status, lifecycle, confidence score, confidence JSON, validation, created, updated, and observed date columns.
  - Reconcile extracts those values with the existing `parseFrontmatter`, confidence score, and validation parsers.
- Ranking fixes kept:
  - OR query terms instead of strict AND matching.
  - Canonical wiki scope rank before proposed/raw/archive paths.
  - Path fallback candidates from indexed document paths.
  - Generic query-term-in-title/path prior, with structural folder nouns excluded.
  - Document-level aggregation to one best chunk per page.
- Metadata scoring added:
  - The doc-level lexical/path candidates are reranked with legacy `scoreByMetadata`.
  - The `SearchDocument` shape is built from stored index metadata.
  - Metadata does not admit metadata-only results; it only reranks candidates already found lexically.
- Overfit removed:
  - `PATH_SEGMENT_INTENTS` remains removed.
  - The path-segment-intent score bonus remains removed.

Legacy path:

- Used the existing legacy `runSearch` path over a preloaded corpus.
- `embedClient.providerName = "lexical"` to disable vector query embedding.
- `refreshEmbeddings = false`
- `noRerank = true`
- `noHyde = true`
- `graphSpread = true`
- `llmProvider = null`

Graph-spread stays out of scope for the index implementation in this task. It remains enabled in the legacy baseline to keep the comparison consistent with the earlier Task 5a lexical-vs-legacy runs; any residual gap after metadata scoring is therefore Phase 6 territory.

Safeguards observed:

- `--prepare-index` was not used.
- Vector backfill was not run.
- 4-target CI was not run.
- Runtime counters: embed calls `0`, Voyage embed calls `0`, Voyage rerank calls `0`.

## Index Build

| metric | value |
| --- | ---: |
| files indexed | 3,592 |
| files tombstoned | 0 |
| chunks indexed | 528,061 |
| files skipped | 11 |
| corpus documents loaded by legacy | 3,458 |
| corpus load errors | 0 |
| legacy corpus wiki/raw/crystals scanned | 258 / 3,200 / 0 |
| index build time | 121,126 ms |
| corpus preload time | 9,346 ms |
| evaluation time | 141,266 ms |

## Results

Combined known-target hit rate, original plus hard-held-out, denominator 104:

| mode | top-1 hits | top-1 rate | top-3 hits | top-3 rate |
| --- | ---: | ---: | ---: | ---: |
| lexical index | 31 / 104 | 0.2981 | 44 / 104 | 0.4231 |
| legacy | 29 / 104 | 0.2788 | 46 / 104 | 0.4423 |

Combined known-target depth:

| mode | top-5 hits | top-5 rate | top-7 hits | top-7 rate | top-10 hits | top-10 rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical index | 46 / 104 | 0.4423 | 48 / 104 | 0.4615 | 49 / 104 | 0.4712 |
| legacy | 51 / 104 | 0.4904 | 53 / 104 | 0.5096 | 59 / 104 | 0.5673 |

Original known-target hit rate, denominator 52:

| mode | top-1 hits | top-1 rate | top-3 hits | top-3 rate |
| --- | ---: | ---: | ---: | ---: |
| lexical index | 20 / 52 | 0.3846 | 29 / 52 | 0.5577 |
| legacy | 15 / 52 | 0.2885 | 29 / 52 | 0.5577 |

Original known-target depth:

| mode | top-5 hits | top-5 rate | top-7 hits | top-7 rate | top-10 hits | top-10 rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical index | 30 / 52 | 0.5769 | 30 / 52 | 0.5769 | 30 / 52 | 0.5769 |
| legacy | 32 / 52 | 0.6154 | 34 / 52 | 0.6538 | 36 / 52 | 0.6923 |

Hard-held-out paraphrase known-target hit rate, denominator 52:

| mode | top-1 hits | top-1 rate | top-3 hits | top-3 rate |
| --- | ---: | ---: | ---: | ---: |
| lexical index | 11 / 52 | 0.2115 | 15 / 52 | 0.2885 |
| legacy | 14 / 52 | 0.2692 | 17 / 52 | 0.3269 |

Hard-held-out paraphrase known-target depth:

| mode | top-5 hits | top-5 rate | top-7 hits | top-7 rate | top-10 hits | top-10 rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical index | 16 / 52 | 0.3077 | 18 / 52 | 0.3462 | 19 / 52 | 0.3654 |
| legacy | 19 / 52 | 0.3654 | 19 / 52 | 0.3654 | 23 / 52 | 0.4423 |

Legacy overlap across all 121 evaluated queries:

| k | total overlap hits | mean overlap count | mean overlap rate |
| --- | ---: | ---: | ---: |
| top 5 | 183 | 1.5124 | 0.3025 |
| top 10 | 346 | 2.8595 | 0.2860 |

Legacy overlap across 104 known-target queries:

| k | total overlap hits | mean overlap count | mean overlap rate |
| --- | ---: | ---: | ---: |
| top 5 | 165 | 1.5865 | 0.3173 |
| top 10 | 308 | 2.9615 | 0.2962 |

Legacy overlap across 52 original known-target queries:

| k | total overlap hits | mean overlap count | mean overlap rate |
| --- | ---: | ---: | ---: |
| top 5 | 108 | 2.0769 | 0.4154 |
| top 10 | 170 | 3.2692 | 0.3269 |

Legacy overlap across 52 hard-held-out known-target queries:

| k | total overlap hits | mean overlap count | mean overlap rate |
| --- | ---: | ---: | ---: |
| top 5 | 57 | 1.0962 | 0.2192 |
| top 10 | 138 | 2.6538 | 0.2654 |

Additional sanity checks:

- Lexical index returned at least one result for all 104 known-target queries.
- Lexical index returned at least one result for all 121 evaluated queries.
- Legacy returned no empty-result rows across the 121 evaluated queries.

## Gate Readout

- Gate A equivalent, known-target lexical-index recall: metadata scoring closes the top-3 gap to near parity on the honest combined set. Lexical is 44/104 top-3 versus legacy 46/104; original rows are tied at 29/52; hard-held-out rows are 15/52 versus legacy 17/52.
- Gate B equivalent, legacy overlap: top-5 mean overlap rate is 0.3025 and top-10 mean overlap rate is 0.2860 across all 121 evaluated queries.
- Gate C equivalent, lexical-vs-hybrid: not exercised. This run intentionally wires no vector/hybrid path.
- Gate D equivalent, local bge-small profile: not exercised. Full-vault vector backfill remains deferred.
- Gate F equivalent, cutover verdict: top-3 is now close to parity with legacy on the hard paraphrase-inclusive lexical gate. Full-depth parity is not complete: top-10 remains 49/104 for lexical versus 59/104 for legacy, and that residual belongs to Phase 6 graph-spread/semantic work rather than this metadata-scoring task.
- Gate G dtype recommendation: no dtype recommendation from this run. Dtype selection still requires the deferred local bge-small vector backfill/evaluation.

## Readout

The index now stores and consumes frontmatter metadata for lexical ranking. The remaining index ranking stack is OR matching, wiki preference, document-level dedup, generic path/title term prior, and `scoreByMetadata` applied to doc-level candidates. The hardcoded folder-intent table remains removed.

The auto held-out paraphrases were replaced for this run with 52 hand-authored hard paraphrases using more novel vocabulary. As expected, both systems are weaker on that slice, but the index is close to legacy there: 15/52 top-3 versus 17/52. Combined original plus hard-held-out top-3 is 44/104 versus legacy 46/104. Top-10 still trails by 10 hits.

Full vector backfill remains deferred, and 4-target CI was not triggered.
