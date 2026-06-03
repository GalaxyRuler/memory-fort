# Codex Implementation Brief — Auto-Linking for Graph Coverage (Phase 4.37)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Closes the graph-coverage gap by making edge creation **automatic and proportional to observation creation** — the consensus approach across 11 surveyed agent-memory systems (Letta, A-MEM, Mem0, Zep/Graphiti, GraphRAG, HippoRAG, LightRAG, Cognee, CraniMem, GAM, MAGMA). Currently: 470/1618 raw orphaned (29%), thread coverage 23%, project density 0.06 — all because edges are created manually via `thread propose`. After this: edges created at capture + compress time; orphan rate target <10%.

---

## Grounding (deep research, 2026-06-02)

Full research report: `docs/fort-audit-and-stale-cleanup-2026-06-02.md` (attached findings section).

Key findings from 11 production systems:

| System | Edge creation | LLM calls/obs | Orphan prevention |
|---|---|---|---|
| **HippoRAG** (NeurIPS 2024) | Auto at index + **embedding synonymy** (cosine >0.8 = edge, zero LLM) | 1-2 + embedding | Strong (synonymy edges) |
| **A-MEM** (arXiv:2502.12110) | Auto at ingest: embed → top-k neighbors → LLM decides links | 3 (~1200 tokens) | Implicit (similarity) |
| **Mem0** | Auto at ingest: 1 LLM call extracts facts + entities | 1 | Implicit (entity boost) |
| **Zep/Graphiti** (arXiv:2501.13956) | Auto at ingest: entity+fact+temporal extraction | 5-6 | Strong (mandatory extraction) |
| **GraphRAG** (Microsoft) | Auto at index: entity+relation extraction → Leiden community detection | 2-3/chunk | Strong (communities) |
| **CraniMem** (ICLR 2026) | Gated: embedding-similarity gate → extract for accepted items only | 1 (gate) + 1-2 | Strong (gating) |
| **MAGMA** | Dual-stream: fast (temporal backbone, every obs) + slow (LLM neighborhood analysis, async) | 1 async | Strong (temporal chain) |

**No system publishes graph coverage metrics.** Memory Fort's 13-metric `graph-health.ts` is ahead of the field. The gap: Memory Fort measures the disease but lacks the treatment.

**Consensus:** auto-extract entities + relations at ingest time. The growing-denominator problem is solved when edge creation is proportional to observation creation.

---

## Post-4.39 alignment (this brief predates Phase 4.39 — honor these)

Phase 4.39 already shipped and changed the ground this brief stands on. Align to it, do not duplicate:
- **Edge type for synonymy links:** type the auto-created raw→wiki edges as **`mentions`** (it already has weight `0.35` in `DEFAULT_EDGE_WEIGHTS`, graph.ts). Do NOT invent a new `similar_to` type unless you also add its weight; prefer reusing `mentions`.
- **The success metric already exists:** 4.39 added **`graph.salient-episode-anchor-rate`** (graph-health.ts:142) — Layer 1 is exactly what moves it. Make THAT metric (not the informational all-raw `orphan-episodic`) the acceptance target.
- **Embeddings interface:** use `loadEmbeddings()` from `src/retrieval/embeddings-store.ts` for the cosine search; do not build a parallel embedding loader.
- **Eval harness exists:** 4.39 shipped `memory eval-retrieval` + `qa/retrieval-gold.jsonl`. After auto-linking, **re-run it** and report whether graph-lift improves (more anchored episodes → more graph signal). This is a second acceptance instrument.

## Architecture: 3-Layer Auto-Linking

### Layer 1 — Embedding Synonymy at Capture Time (zero LLM cost)

**Inspired by:** HippoRAG's synonymy edge mechanism (arXiv:2405.14831).

When a raw observation is **captured** (PostToolUse/SessionEnd hook, or backfill):
1. Compute the observation's embedding (already done for search via Voyage sidecars, or BM25 tokenization).
2. Cosine-similarity search against all **wiki entity page embeddings** (the existing `embeddings/wiki.embeddings.jsonl`).
3. If similarity > threshold (configurable, start at **0.75**, tune empirically), create a `similar_to` relation edge in the raw observation's frontmatter → the matched wiki page.

**What this fixes:** Every new observation gets at least one edge attempt at capture time. The orphan rate drops because most observations are *about* existing known entities. The denominator and numerator grow at the same rate.

**Cost:** One vector search per observation. Zero LLM calls. If Voyage embeddings are unavailable (key absent), fall back to **BM25 title-match scoring** against wiki page titles — still zero LLM, still effective for exact/near-exact entity mentions.

**Where it runs:** New function in `src/hooks/` or `src/capture/`, called from the PostToolUse/SessionEnd hook *after* the raw file is written (non-blocking — the hook writes the raw file first, then attempts linking; linking failure must not block capture). Also callable as `memory link-raw [--plan|--apply]` for the backfill of existing orphans.

### Layer 2 — Entity+Relation Extraction at Compress Time (piggyback on existing LLM call)

**Inspired by:** A-MEM (arXiv:2502.12110), Mem0's single-call extraction.

When `memory compress` runs on a raw session (the existing LLM call that produces `facts/<date>/<session>.json`):
1. **Extend the compress prompt** to also extract: (a) named entities mentioned (project names, tool names, people, decisions), (b) relation triples as `(subject, predicate, object)` — e.g. `("memory-system", "uses", "voyageai")`, `("iaqar", "tested-with", "vitest")`.
2. Add these to the fact bundle schema: `entities: string[]`, `relations: Array<{subject: string, predicate: string, object: string}>`.
3. **Match extracted entities** against existing wiki page titles/slugs (fuzzy: normalized lowercase + Levenshtein ≤2, or embedding similarity if available). Create typed `mentions` / `uses` / `derived_from` relation edges on the fact bundle.
4. Unmatched entities with ≥3 cross-session occurrences surface in the dashboard as "new entity candidates" (the existing compile 3-session threshold — this is how new wiki pages get proposed).

**What this fixes:** Every compressed fact bundle carries structured relations. Compile/consolidate can propagate these into wiki page frontmatter, improving project subgraph density and narrative thread coverage.

**Cost:** ~0 marginal — the compress LLM call already runs; entity+relation extraction is a prompt extension, not a separate call. A-MEM measured ~1,200 tokens total for their 3-call variant; ours is 1 call, so cheaper. At gpt-4o-mini rates: ~$0.0004/observation (same as current compress cost).

**Schema extension** (backward-compatible — new fields are optional):
```ts
// In CompressedFact (src/facts/store.ts or compress.ts)
interface CompressedFact {
  // ... existing fields (title, facts, narrative, concepts, importance, ...)
  entities?: string[];                    // NEW: named entities extracted
  relations?: Array<{                     // NEW: relation triples extracted
    subject: string;
    predicate: string;
    object: string;
  }>;
}
```

### Layer 3 — Community Detection for Thread Discovery (periodic batch, zero LLM)

**Inspired by:** GraphRAG's Leiden community detection, GAM's semantic boundary consolidation.

New CLI command: `memory discover-threads [--plan|--apply]`. Runs periodically (not at ingest):
1. Build an adjacency graph from all relation edges (wiki→wiki typed edges + fact-bundle relations + Layer 1 synonymy edges).
2. Run **label propagation** (simpler than Leiden, no external dep — implement in ~50 lines of TS) to find clusters of densely-connected entities.
3. Each cluster that doesn't already map to a narrative thread → emit as a thread proposal to `wiki/threads-proposed/`.
4. Surface these in the dashboard as "suggested threads" (new card or addition to the existing thread-propose flow).

**What this fixes:** Replaces the manual `thread propose` workflow (which requires operator to run + review + promote) with automated cluster discovery. Addresses the growing-denominator problem for `narrative-thread-coverage` because new threads are proposed proportionally to new entity clusters.

**Cost:** Zero LLM calls. Label propagation is O(E) where E = edge count (~2000 currently). Runs in milliseconds. Trigger: scheduled (daily/weekly via `memory schedule`), or on-demand, or when `verify` detects orphan rate > warn threshold.

---

## Task breakdown

### Task 1 — Layer 1: Embedding synonymy at capture + backfill command

New files:
- `src/capture/auto-link.ts` — `autoLinkRawToWiki(rawPath, opts)`: reads the raw observation, computes/retrieves its embedding, cosine-searches wiki page embeddings, writes `similar_to` relation edges into the raw file's frontmatter if similarity > threshold. Returns `{ linked: string[], skipped: boolean }`.
- `src/cli/commands/link-raw.ts` — `memory link-raw [--plan|--apply] [--threshold <n>]`: batch-links all orphaned raw observations (those with no relation edges). `--plan` reports how many would link and to which wiki pages.

Modified files:
- `src/hooks/post-tool-use.ts` (or the capture-write path) — after writing the raw file, call `autoLinkRawToWiki` non-blocking. On error, log to `errors.log`, never block capture.
- BM25 fallback when Voyage unavailable: score raw-title + first 200 chars against wiki page titles. If best score > threshold, link.

Configuration:
- `config.yaml`: `auto_link.similarity_threshold: 0.75` (tunable).
- `config.yaml`: `auto_link.enabled: true` (opt-out for users who don't want auto-edges).

### Task 2 — Layer 2: Entity+relation extraction at compress time

Modified files:
- `src/facts/compress.ts` (or wherever the compress prompt is built) — extend the LLM prompt to also extract `entities[]` and `relations[]`. The prompt addition should be ~3-4 lines of instruction + a schema example. Do NOT add a second LLM call — piggyback on the existing one.
- `src/facts/store.ts` — extend `CompressedFact` type with optional `entities?: string[]` and `relations?: Array<{subject, predicate, object}>`. Backward-compatible: existing fact files without these fields still parse.
- `src/compile/synthesize-narrative.ts` (or the consolidation path) — when building a wiki page, propagate unique relations from its source facts into the page's frontmatter `relations` map. New relation types from extraction (`mentions`, `tested-with`, etc.) should be added alongside existing ones (`uses`, `derived_from`, `supersedes`).

### Task 3 — Layer 3: Community detection for thread discovery

New files:
- `src/graph/community-detection.ts` — label propagation over the wiki+fact relation graph. Input: adjacency list built from wiki page relations + fact bundle relations + Layer 1 synonymy edges. Output: clusters (sets of entity slugs).
- `src/cli/commands/discover-threads.ts` — `memory discover-threads [--plan|--apply]`. `--plan` lists discovered clusters + which would become new thread proposals. `--apply` writes proposals to `wiki/threads-proposed/`.

Modified files:
- Dashboard: surface "suggested threads" count on the graph-health card or a new "Thread Discovery" card.

### Task 4 — Backfill the existing 470 orphans + re-measure

1. Run `memory link-raw --apply` on the full vault to link existing orphaned raw observations.
2. Run `memory compress --drain --apply` (if any remain uncompressed) to generate entity+relation-enriched fact bundles.
3. Run `memory discover-threads --plan` to see what clusters emerge.
4. Re-run `memory verify` and the graph-health API. Report before/after for all 4 graph metrics.

### Task 5 — Tests (lesson #2/#3)

- **Unit: auto-link** — fixture raw observation + fixture wiki embeddings → correct `similar_to` edge written when above threshold, no edge when below, no crash when embeddings unavailable.
- **Unit: entity extraction** — fixture compress output includes `entities` + `relations` fields; backward-compat: old fact files without these fields still load.
- **Unit: community detection** — fixture adjacency list → expected clusters; singleton handling; empty graph → no proposals.
- **Integration: orphan rate** — after `link-raw --apply` on a test vault with known orphans, `graph.orphan-episodic` metric improves. Read the metric value, not just the exit code.
- **Integration: thread coverage** — after `discover-threads --apply` + promote on a test vault, `graph.narrative-thread-coverage` improves.
- Full suite + typecheck + build clean.

---

## You will NOT
- Add >1 LLM call per observation. Layer 1 = embedding only. Layer 2 = piggyback on existing compress call. Layer 3 = algorithmic only.
- Block capture on a linking failure. `autoLinkRawToWiki` errors → log, skip, move on. Capture is sacred.
- Adopt Graphiti's 5-6 call pipeline. Too expensive for this vault.
- Remove or weaken existing graph-health metrics. They're ahead of the field — preserve and satisfy them.
- Create `similar_to` edges to non-wiki paths (e.g. raw→raw). Only raw→wiki or fact→wiki.
- Auto-promote discovered threads. `discover-threads --apply` writes **proposals** — operator reviews + promotes.

## Stop and ask
1. Voyage embedding sidecar format doesn't support per-raw-file lookups (only bulk wiki + bulk raw JSONL) — confirm whether individual raw embedding retrieval is feasible before building Layer 1, or scope Layer 1 to BM25-title-match only.
2. The compress prompt is already near the context window on large sessions — confirm the entity/relation extraction addition fits without truncation.
3. Label propagation on a disconnected graph with many singletons produces N singleton clusters — confirm this is handled (filter out singletons, don't propose singleton threads).
4. `auto_link.enabled` default = true — confirm this is the right default vs opt-in.

## Acceptance
- **Orphan rate**: `graph.orphan-episodic` drops from 29% to **<15%** after `link-raw --apply` on the existing vault. Read the metric value.
- **Thread coverage**: `graph.narrative-thread-coverage` rises from 23% to **>30%** after `discover-threads --apply` + promote coherent clusters. Read the metric value.
- **Project density**: `graph.project-subgraph-density` rises from 0.06 to **>0.10** (the warn threshold) after Layer 2 relations propagate. Read the metric value.
- **No capture regression**: hook fires, raw file written, auto-link runs non-blocking. A linking error must not prevent capture.
- **Cost**: no additional LLM calls beyond the existing compress pipeline.
- Full suite + typecheck + build clean.

## Commit boundaries
- Task 1: `feat: embedding-synonymy auto-link at capture + link-raw backfill command (Phase 4.37 Task 1)`
- Task 2: `feat: entity+relation extraction piggybacked on compress (Phase 4.37 Task 2)`
- Task 3: `feat: community-detection thread discovery (Phase 4.37 Task 3)`
- Task 4: `chore(vault): backfill orphan links + re-measure graph metrics (Phase 4.37 Task 4)` — vault commit
- Task 5: `test: auto-link, entity extraction, community detection, graph metric integration (Phase 4.37 Task 5)`

## Research sources (verified via web search 2026-06-02)
- HippoRAG (NeurIPS 2024, arXiv:2405.14831) — synonymy edges via embedding cosine similarity
- A-MEM (arXiv:2502.12110) — 3-call self-organizing memory with auto-linking
- Mem0 — single-call entity extraction, moved away from full graph to entity-boosted vectors
- Zep/Graphiti (arXiv:2501.13956) — 5-6 call temporal KG with mandatory entity+fact extraction
- GraphRAG (Microsoft) — Leiden community detection over entity-relation graphs
- CraniMem (ICLR 2026, arXiv:2603.15642) — gated ingest with bounded buffer + utility pruning
- GAM (arXiv:2604.12285) — hierarchical dual-layer with semantic-boundary consolidation
- MAGMA (arXiv:2601.03236) — dual-stream fast (temporal) + slow (LLM neighborhood) linking
- LightRAG (EMNLP 2025) — lightweight incremental entity-relation extraction
