# Codex Implementation Brief — Auto-Link Degeneracy Guard + Embedding Health (Phase 4.37.1)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> The Phase 4.37 auto-linker (uncommitted) **poisons the graph**. On a live run it linked **498 of 531 orphaned raw files to the same 3 decision pages at cosine 1.000**. Root cause verified by reading the vectors: `embeddings/*.jsonl` contain **degenerate `[1,0,0]` 3-dimensional stub vectors** (real Voyage is 2048-dim) because no `VOYAGE_API_KEY` is set — so every pair scores 1.000 and the linker matched everything to the first few wiki pages. This brief makes the linker **refuse to act on degenerate embeddings**, fall back to lexical matching, and adds a health check so stub embeddings can never silently corrupt retrieval again. **Do not land 4.37 until this is in.**

## Evidence (verified 2026-06-02, by reading bytes)

- `link-raw --apply` wrote `mentions` edges into **498 raw files**, all pointing to exactly `2026-05-20-sidecar-embeddings-no-vector-db`, `2026-05-20-voyage-ai-for-embeddings`, `2026-05-21-sentinel-marker-config-patches`, each at `confidence: 1.0`.
- Embedding vectors on disk: `wiki/decisions/…voyage… = [1,0,0]`, `…sidecar… = [1,0,0]`, a raw sample `= [1,0,0]`. **All `dim=3`, all identical** (`decision1 == decision2 == raw == True`). `cosineSimilarity([1,0,0],[1,0,0]) = 1.0`.
- `src/capture/auto-link.ts` loads `loadEmbeddings(root,"raw")`, finds `rawVector`, computes `cosineSimilarity`, and accepts any score ≥ `auto_link.similarity_threshold` (0.75). With stub vectors everything is 1.0 → accept-all.
- The stub embeddings come from the no-Voyage fallback embedder (`src/retrieval/embedder/`). **Implication beyond this bug: the entire vector-retrieval stream is currently running on `[1,0,0]` stubs** — decorative until real embeddings exist.

(The live garbage was already reverted; the vault is clean. This brief prevents recurrence + fixes the linker.)

## Task 1 — Degeneracy guard in the auto-linker (the core fix)

In `src/capture/auto-link.ts`, before trusting the embedding strategy, detect degenerate embeddings and **refuse to link on them**:

1. **Dimension check:** if the loaded vectors' `dim` is below a sane floor (e.g. `< 16`, or `!= config.embedding.dim`), the embeddings are stubs → do not use the embedding strategy.
2. **Collision check:** if the raw vector is byte-identical to the candidate wiki vectors, or the top-K candidates all score `≥ 0.999`, the signal is degenerate → reject the embedding result for that file.
3. On either condition → **fall back to the title/lexical strategy** (Task 2), or, if that also yields nothing, emit `outcome: "skipped", reason: "degenerate embeddings"` and write **no edge**. Never write a 1.000-everything edge.
4. **Mass-collision backstop (corpus-level):** in `link-raw`, after computing all candidate links, if **> 20% of orphans resolve to the same single target**, abort the whole apply with a loud error (`"refusing to link: N% of orphans map to <page> — embeddings likely degenerate"`). This is the safety net that would have stopped the 498→3 catastrophe.

## Task 2 — Make the lexical (title) fallback real and primary-when-degenerate

The brief required a BM25/title fallback for the no-Voyage case; it did not fire on *degenerate* embeddings (only on absent ones). Fix:

1. The title strategy must score **real lexical overlap** — BM25 (or token-Jaccard) of the raw observation's salient text (title + first N KB, entities if available) against each wiki page's **title + aliases + summary**. Not a stub.
2. Strategy selection: `embedding` only when embeddings pass the Task 1 degeneracy guard; otherwise `title`. Record which strategy produced each link in the output (already does: `(${strategy} ${score})`).
3. A title-strategy link must clear its own threshold (e.g. BM25 score normalized ≥ `auto_link.title_threshold`, default tuned so random pages don't match). Better **zero links than false links** — anchoring 0 orphans honestly beats anchoring 498 falsely.

## Task 3 — Embedding health check (no silent degradation)

Add a verify check `retrieval.embedding-health` (or under graph health):
- FAIL if embeddings exist but are degenerate: `dim != config.embedding.dim`, OR a sample of vectors are all-identical, OR all-`[1,0,0]`/all-zero.
- WARN if embeddings are absent entirely (no Voyage key → stub mode) — state clearly that **vector retrieval is inactive** and only BM25+graph are live.
- This surfaces the stub-embedding state on the dashboard so it can't hide. (It has been hiding — the 4.39 eval graph-lift came from BM25+graph, not vectors.)

## Task 4 — Real-embedding regeneration path (document + verify)

- Confirm the command that regenerates embeddings (`memory reindex` / a refresh path) produces **real Voyage 2048-dim vectors when `VOYAGE_API_KEY` is set**, overwriting the `[1,0,0]` stubs. If no such path cleanly exists, add `memory reindex --embeddings`.
- Document in `docs/cli.md`: embeddings are stubs without `VOYAGE_API_KEY`; set the key and regenerate before relying on vector search or embedding-based auto-link.
- Do NOT hardcode or commit any key. Env-var only.

## Task 5 — Re-verify the 4.37 acceptance with the guard (read the artifacts)

After Tasks 1-2, with the **current stub embeddings still in place** (no Voyage key):
- `memory link-raw --plan` must **NOT** mass-collide. Expected: it uses the title strategy and produces **sparse, diverse** matches (or zero) — never 498→same-3 at 1.000. **Read the plan output** and confirm varied targets + varied scores, or an honest zero.
- Unit test: feed the linker **degenerate embeddings** (dim-3, identical) → assert it does **not** use the embedding strategy, does **not** mass-link, and either title-matches or skips. Feed it **real diverse embeddings** → assert it links by embedding with varied scores.
- Unit test the mass-collision backstop: a corpus where embeddings force all-same-target → `--apply` aborts with the loud error, writes nothing.
- Re-run `memory eval-retrieval --gold qa/retrieval-gold.jsonl --k 5,10` → graph-lift must not regress.

## You will NOT
- Accept embedding matches when embeddings are degenerate (dim wrong / identical / 1.000-everywhere).
- Write `mentions` edges that mass-collide on one target. The corpus backstop must abort.
- Claim orphan-rate / salient-episode-anchor improvement without **reading that the new edges are semantically real** (diverse targets, varied scores) — a green metric built on 1.000 stub matches is a lie (the exact failure this brief exists to prevent).
- Commit or hardcode `VOYAGE_API_KEY`. Env-var only.
- Land the rest of 4.37 (Layer 2 compress entity-extraction, Layer 3 community detection) without this guard — Layer 1 is the poison vector.

## Stop and ask
1. No clean embedding-regeneration command exists and adding `--embeddings` ripples into the reindex pipeline — confirm scope.
2. With stub embeddings, the honest result is **zero auto-links** (titles don't lexically match raw sessions well) — confirm that "0 honest anchors" is acceptable until real Voyage embeddings exist, vs. waiting to enable auto-link until then.
3. The mass-collision threshold (20%) trips on a legitimately hub-heavy small vault — confirm the threshold or make it config.

## Acceptance
- `link-raw --plan` on the live vault (stub embeddings): **no mass-collision**, diverse-or-zero matches, read and confirmed.
- Degeneracy-guard + mass-collision unit tests pass; `retrieval.embedding-health` FAILs on the current stub `[1,0,0]` embeddings (proving it detects them).
- `eval-retrieval` graph-lift not regressed.
- Full suite + typecheck + build clean.
- 4.37 (all layers) becomes landable only after this; commit them together or this first.

## Commit boundaries
- Task 1: `fix(auto-link): degeneracy guard + corpus mass-collision backstop (Phase 4.37.1 Task 1)`
- Task 2: `fix(auto-link): real BM25/title fallback when embeddings degenerate/absent (Phase 4.37.1 Task 2)`
- Task 3: `feat(verify): retrieval.embedding-health detects stub/degenerate embeddings (Phase 4.37.1 Task 3)`
- Task 4: `feat: regenerate real Voyage embeddings; docs on stub mode (Phase 4.37.1 Task 4)`
- Task 5: `test: auto-link degeneracy + mass-collision + plan-on-stub (Phase 4.37.1 Task 5)`

## Grounding
- Verified by reading `embeddings/wiki.embeddings.jsonl` + `raw.embeddings.jsonl` (all `[1,0,0]` dim-3) and the 498 written edges (all → same 3 decisions @ 1.000). Catastrophe reverted before any commit.
- `src/capture/auto-link.ts` (loadEmbeddings + cosineSimilarity + threshold), `src/retrieval/embedder/` (no-Voyage stub fallback), `src/storage/config.ts:40` (`auto_link` config).
- This is the verify-before-claim catch of the session: Codex reported "matched 525/531" as success; reading the actual edges + vectors exposed that the matches were stub-driven garbage.
