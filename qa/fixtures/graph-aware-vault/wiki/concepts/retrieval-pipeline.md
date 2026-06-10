---
type: references
title: retrieval-pipeline
created: "2026-02-01"
updated: "2026-05-20"
status: active
cognitive_type: semantic
lifecycle: canonical
relations:
  uses:
    - wiki/tools/voyage.md
  linked:
    - wiki/projects/memory-system.md
tags:
  - retrieval
  - search
---

The retrieval pipeline fuses vector embeddings, BM25 lexical scoring, and graph
spreading activation. How BM25 relates to the search pipeline: BM25 supplies
the lexical signal that is fused with vector similarity via reciprocal rank
fusion before reranking.

Concepts linked to graph traversal: spreading activation expands candidate
pages along typed relations (uses, depends_on, derived_from), which is what is
derived from the retrieval pipeline work.

Embedding refresh keeps the sidecar store in sync with page content hashes.
When a claim contradicts or disputes existing claims, the dispatch classifier
stages a dispute proposal instead of overwriting the page.
