# Phase 3 checkpoint - 2026-05-23

## Verdict

Ready for `v0.3.0-phase3` tag: the full Phase 3 path works end to end across local git, VPS sync, dashboard search, CLI search, MCP search, Voyage rerank, and lexical fallback.

## Baseline state

- Wiki pages: 13
- Raw observations: 42 local raw files; 41 raw markdown files observed on the VPS before checkpoint cleanup
- Embeddings sidecar size: 1.4 MB under `/root/memory-system/vault/embeddings`
- Storage on VPS: 14-15 MB for `/root/memory-system/vault`
- Recent live repo commits:
  - `8508bb5` chore: remove .gitattributes from gitignore (F20)
  - `2af0252` chore: hygiene cleanup - un-track claude-code-plugin/, gitignore embeddings/, add .gitattributes, fix config.yaml line 19
  - `e989ecb` chore: auto-capture 2 raw observation file(s)
  - `951350b` chore: auto-capture 1 raw observation file(s)
  - `fca9e62` chore: auto-capture 1 raw observation file(s)

Local stats reported `raw/` at 42 files and 13.1 MB, `wiki/` at 13 files and 29.3 KB, and the local embeddings store empty. The VPS owns the live embedding sidecars: 15 wiki records and 41 raw records, 56 total. Live repo drift was present at checkpoint start (`log.md` plus raw files), then committed during the sync dogfood run; the final live drift count was 0.

## Sync propagation latency

Local commit -> visible on dashboard: **5.48 seconds total**, with the marker found on the first 2-second poll after the push.

The prompt's first marker path created `wiki/checkpoint-marker-20260523214503.md`, which the dashboard indexed as a root-level category rather than under `lessons`; that verified sync but not the intended category poll. A second marker at `wiki/lessons/checkpoint-marker-20260523215012.md` produced the clean propagation measurement above. Both markers were removed and pushed.

## CLI search

Query: `voyage embeddings`, scope: wiki, k=3

- Latency: 1013 ms from the dashboard timing, 1421.9201 ms wall clock including CLI startup and network
- Top result: `wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md` score=0.86328125
- Degraded: `False`

## Dashboard via Tailscale

All routes 200:

- `/`: 200
- `/wiki/`: 200
- `/wiki/projects/memory-system`: 200
- `/api/status`: 200

## MCP search

Tool: `mcp__plugin_memory_memory__search`

- Returns: 3 results
- Top result: `wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md` (rerank score 0.86328125)
- Timing: 547 ms total, 253 ms rerank

The direct stdin/stdout MCP smoke returned a text content block with structured JSON, including the Voyage decision page, `wiki/tools/voyageai.md`, and the sidecar embeddings decision as the top three.

## Voyage fallback

When `VOYAGE_API_KEY` is empty:

- `degraded: True`
- Result count: 3
- Warning: `query embedding failed: voyage unavailable`

After restoring the key:

- `degraded: False`

This confirms the dashboard stays up and returns lexical/RRF results when Voyage is unavailable, then resumes full rerank behavior after the service restarts with the key restored.

## Cost audit

- Embeddings to date: 56 sidecar records, roughly 15 wiki pages plus 41 raw sessions
- Reranks: about 30 passages per search candidate set
- Estimated total Voyage spend so far: under $0.10
- Yearly projection at moderate use: under $10-25

The current API responses do not expose enough usage data for exact spend reconciliation, so this estimate uses observed sidecar counts, raw truncation limits, and rerank candidate counts. The important operational finding is that raw embedding refresh now completes without the earlier token-cap failure mode.

## Open follow-ups

- F21 - search-quality thresholds configurability (filed in Slice 21; deferred to Phase 4 polish)

## Ready for v0.3.0-phase3 tag?

Yes. The checkpoint exercised the real paths that matter: local live repo commits sync to the VPS, dashboard browse/search responds over Tailscale, CLI and MCP both reach the same `/api/search` backend, Voyage-powered ranking works, and a missing Voyage key degrades instead of crashing. The only checkpoint caveat was operational rather than architectural: existing raw/log drift can pause sync until committed, which is expected behavior for the live repo and ended cleanly after dogfooding.
