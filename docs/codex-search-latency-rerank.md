# Codex Prompt — Fix Live-Search Latency (~31s) + Dead Reranker (Memory Fort)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system` (TypeScript ESM, `@galaxyruler/memory-system`)
**Live vault**: `C:\Users\Admin\.memory`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (`main`). Stop and ask if scope creeps past this prompt.

---

## Mission

The embedding-durability fix (`0566984`) is verified and live: redaction no longer invalidates embeddings, `--plan` reports **0 pending / 1755 unchanged**, and vector retrieval contributes to ranking. **But the live search is functionally-correct-yet-broken-in-practice**, and this was hidden because the prior self-audit checked correctness with unit tests, not **latency** against the running server.

Your job: **root-cause and fix two measured problems, then prove the fix by reading the live `/api/search` timings — not by unit tests alone.** A passing test is not proof here; the bug lives in per-request wall-clock behavior. Treat *verify-before-claim* as a hard rule.

---

## Measured evidence (hard data — reproduce it, don't trust it)

Hitting the live dashboard (`GET http://127.0.0.1:4410/memory/api/search?q=<text>&k=8`, reading the JSON `timings` block), two consecutive queries — one cold, one warm — were near-identical:

```
Query 1: corpusMs 3373, refreshMs 26537, embedQueryMs 410, bm25Ms 75, vectorMs 159,
         exactMs 5, graphMs 123, graphSpreadMs 114, metadataMs 2, rrfMs 1,
         rerankMs 0, totalMs 32281   (degraded=false, warnings=0, fusion incl. "vector")
Query 2: corpusMs 3329, refreshMs 25817, embedQueryMs 432, vectorMs 168,
         rerankMs 0, totalMs 31490   (warm — same as cold, so NOT warmup)
```

Two problems, both reproducible:

1. **`refreshMs ~26s per query`** — refresh dominates 83% of a 31s search **even though `memory provider reindex-embeddings --plan` reports 0 pending / 1755 unchanged**. With nothing to embed, refresh should cost ~0. The cost is independent of pending work and identical on a warm query → strong hypothesis: the search path **reloads the full corpus and re-parses the ~65 MB embeddings sidecar(s) and re-hashes all 1755 docs on every request, with no in-process cache.** Confirm or refute by reading the code and measuring.

2. **`rerankMs: 0`** — the Voyage reranker (`rerank-2.5`) **never fires** in this path. Determine why: disabled by config, not wired into `runSearch`, default `noRerank`, a candidate-count threshold, missing-key fallback, or dead code.

**Reproduction note:** the dashboard must run with `VOYAGE_API_KEY` in its **process** environment (the key is set at Windows User scope but long-running processes started earlier don't inherit it). Launch from a shell that injected it, e.g. `$env:VOYAGE_API_KEY = [Environment]::GetEnvironmentVariable("VOYAGE_API_KEY","User")` then `node dist/cli.mjs dashboard --port 4410 --no-open`. Never print or commit the key.

---

## Where to look (verify, don't assume)

- `src/retrieval/search.ts` — `runSearch`: the per-query pipeline, where corpus/embeddings get loaded, refresh is invoked, streams fuse (RRF), and rerank is (or isn't) called. The `timings` block is emitted here.
- `src/retrieval/refresh.ts` — `refreshEmbeddings` / `loadEmbeddings`: the 26s. Is it being called per query? Does it re-parse the sidecar and re-hash every doc each time?
- `src/retrieval/corpus.ts` — `loadSearchCorpus` (`corpusMs ~3.3s`): reloaded per query?
- `src/retrieval/embeddings-store.ts` — sidecar load/parse cost.
- `src/dashboard/server.ts` — `/api/search` handler and process lifetime: the natural place for a process-lived cache.
- The Voyage **reranker** module/client (`rerank-2.5`) — find it; trace why `rerankMs` is 0.
- Config: `~/.memory/config.yaml` embedding/rerank settings and how `runSearch` reads them.

---

## What to do

### Phase 1 — Root-cause (read + measure, cite file:line)
Explain precisely **why `refreshMs ~26s`** with 0 pending, and **why `rerankMs 0`**. Back each with code citations and, ideally, an added temporary measurement. Do not propose a fix until both causes are pinned.

### Phase 2 — Ground (online search, cite)
Search current best practice for: in-process caching of a retrieval corpus + vector index, when/whether to refresh embeddings on the query path vs. background, mtime/hash-based cache invalidation, and reranker integration (candidate cap, when to skip). Distinguish fact from interpretation; note recency.

### Phase 3 — Propose options with trade-offs
For **each** problem give **≥2 viable options** with trade-offs (latency, correctness, memory, complexity, staleness risk). Likely directions to evaluate — don't assume:
- **Refresh:** load corpus + embeddings **once per process** and cache; invalidate on file mtime/size/hash; **skip refresh entirely when nothing is pending** (fast path); or move refresh fully off the request path (background). Keep degraded-mode fast-fail intact.
- **Rerank:** wire/enable the reranker in `runSearch` with a sane candidate cap (e.g. rerank top-N fused), gated to degrade gracefully when the key is absent.
Recommend one per problem and justify.

### Phase 4 — Implement (TDD, stay green)
- Tests first. Keep `npm run typecheck`, `npm run build`, and the suite green at every commit.
- Add a **performance-regression guard**: a test proving that with 0 pending, a second search does **not** re-parse the full sidecar / re-hash the whole corpus (assert via a spy/counter or injected timer), and that rerank is invoked when enabled.
- Do **not** break `0566984` (durability), the write-guard (`a60ebe2`), incremental cost, or degraded-mode fast-fail.

### Phase 5 — Adversarial self-audit (the gate: prove it with LIVE timings)
Before claiming done, **start the dashboard with the key and read the real `/api/search` timings**, cold then warm. Paste the actual `timings` JSON into your report and assert:
- warm-query **`refreshMs` ≈ 0** (and total well under, say, ~3s for a warm query),
- **`rerankMs > 0`** with rerank enabled,
- `degraded=false`, vectors still in fusion, results unchanged in quality.
A green unit test is **not** acceptance — the before/after **live timings** are. If you can't show them, say so and stop.

---

## Constraints
- Secrets env-var only; never print/commit `VOYAGE_API_KEY`; no secret-shaped content in logs.
- No permanent deletions (archive instead). No history rewrites.
- Do **not** run a live full re-embed to "test" (costs money); use fixtures/mocks. Any real Voyage spend → stop and ask.
- Windows / PowerShell 7. No OneDrive paths.

## Stop-and-ask
1. Any real Voyage spend beyond a couple of smoke queries.
2. A fix that ripples beyond the search/refresh/rerank path.
3. Caching introduces a staleness risk you can't cleanly invalidate.

## Output contract
- Root-cause for each problem (file:line + measurement).
- Grounding sources + what you took from each.
- Options + recommendation with trade-offs.
- Diffs/commits + test names (incl. the perf-regression guard).
- **Live before/after `/api/search` timings** (the acceptance evidence).
- Residual risks + an operator runbook to reproduce the timing check.

## Definition of done ("sure this time")
- Warm search **`refreshMs ≈ 0`**, total a few seconds, proven by live timings.
- **Reranker fires** (`rerankMs > 0`) when enabled, degrades cleanly without the key.
- Durability fix, write-guard, incremental cost, degraded fast-fail all intact; suite + typecheck + build green.
- Every claim backed by a live timing read or command output in the report.
