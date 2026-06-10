---
type: projects
title: memory-system
created: "2026-01-10"
updated: "2026-06-01"
status: active
cognitive_type: semantic
lifecycle: canonical
relations:
  uses:
    - wiki/tools/voyage.md
  depends_on:
    - wiki/concepts/retrieval-pipeline.md
tags:
  - memory
  - vault
---

The memory-system project is a cross-tool personal memory vault. The tools the
memory-system project uses include Voyage embeddings, BM25 lexical search, and
a typed-graph wiki compiled from raw observations.

Episodic observations about codex sessions are captured into raw session files
and distilled by the compile pipeline. The compile prompt template lives in the
vault prompts directory; its provenance traces to the compile orchestrator and
the dashboard audit. What was learned from the dashboard audit: stale error
logs surfaced as false alarms, and auto-commit needed lock-file hygiene.

Pages superseded by newer knowledge are stamped with valid_until and status
superseded by the approval path. Auto-commit and sync run after captures so the
vault working tree stays clean.
