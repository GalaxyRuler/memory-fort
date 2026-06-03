# Codex Implementation Brief — Embedding Write-Guard + No-Clobber (Phase 4.40)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> `memory provider reindex-embeddings --apply` **destroyed real embeddings and reported success.** Sequence, verified: (1) a first run embedded all raw into real 2048-dim Voyage vectors (confirmed by reading: `dim=2048`, distinct, ~$9 charged). (2) A second `--apply` run immediately after reported `Documents: 1696, Embedded: 1696, Errors: 0` — but **overwrote every vector with degenerate `[1,0,0]` dim-3 stubs**. Both corpora are now stubs again. The reindex writes degenerate vectors in some failure mode (rate-limit and/or env-propagation), reports `Errors: 0`, and **clobbers the existing real embeddings**. This must never happen — it costs real money and silently breaks vector retrieval.

## Evidence (verified 2026-06-03, reading bytes)

- After run 1: `embeddings/raw.embeddings.jsonl` = 1649 vectors, all `dim=2048`, distinct (`first3=[0.046,0.007,-0.025]`). Real.
- After run 2 (`reindex-embeddings --apply`, output `Embedded: 1696, Errors: 0, cost $9.17`): `wiki = {3: 46}`, `raw = {3: 1650}` — **all `[1,0,0]` dim-3 stubs**.
- `provider test-embedder` WITH key → `Dim: 2048, OK`. WITHOUT key → `Status: ERROR, VOYAGE_API_KEY not set`. So the embedder *can* fail correctly — but the reindex batch path produced stubs while reporting success.
- `src/retrieval/embedder/voyage.ts` catch blocks `throw normalizeVoyageError` (don't stub). So the degenerate `[1,0,0]` comes from somewhere else in the reindex/factory path (a fallback embedder, an empty-response default, or `fallbackDim`). **Find it.**

## Task 1 — Find the dim-3 stub source

Trace where a `[1,0,0]` dim-3 vector originates when `reindex-embeddings --apply` runs and the real provider is unavailable/rate-limited. Candidates: a stub/test/fallback embedder in `src/retrieval/embedder/factory.ts`, an empty-vector default, `fallbackDim`, or a degraded path that returns a placeholder instead of throwing. Report the exact file:line. (This `[1,0,0]` stub is also what auto-link's degeneracy guard had to defend against — it should not exist as a real-write path at all.)

## Task 2 — Write-time dimension guard (the core fix)

Before `saveEmbeddings` writes ANY vector:
- Assert every vector's `dim === config.embedding.dim` (2048 for voyage-4-large). A vector whose dim ≠ configured dim is degenerate → **never write it**.
- If any batch yields degenerate/zero/`[1,0,0]` vectors → **fail the whole reindex loudly** with a clear error (`"refusing to write degenerate embeddings (dim N, expected M) — provider likely unavailable/rate-limited; existing embeddings preserved"`). Exit non-zero. Do NOT report `Embedded: N, Errors: 0`.

## Task 3 — No-clobber on failure (preserve real embeddings)

The reindex must **never overwrite existing good embeddings with worse ones**:
- Write to a temp file and atomically swap **only after** the full run validated (all vectors real dim). On any failure, leave the existing `*.embeddings.jsonl` untouched.
- If existing embeddings are real (2048) and the new run would produce stubs, abort and keep the real ones.
- Consider a `.prev` backup before swap so an accidental clobber is recoverable.

## Task 4 — Rate-limit backoff + honest reporting

- On Voyage `429` (`VoyageRateLimitedError`), **back off and retry** (exponential, a few attempts) — do NOT fall back to a stub vector. If retries exhaust, fail that batch and the run (Task 2/3 keep existing embeddings).
- Reindex output must report **real** counts: `Embedded` = vectors that passed the dim guard; `Failed` = batches that errored. `Errors: 0` while writing stubs is the exact lie that caused this.
- Surface actual vs estimated cost only for successfully embedded docs.

## Task 5 — Tests + recovery

1. **Unit:** a mock embedder returning dim-3 vectors → `saveEmbeddings`/reindex **throws**, writes nothing, leaves existing file intact.
2. **Unit:** mock 429 → backoff/retry invoked; on exhaustion, run fails, existing embeddings preserved.
3. **Unit:** real-dim vectors → written normally.
4. **Integration:** existing real `*.jsonl` + a forced-degenerate run → file still contains the real vectors afterward (no clobber).
5. After the fix, document the safe re-embed: `reindex-embeddings --apply` with `VOYAGE_API_KEY` set either succeeds with real 2048-dim or fails loudly without destroying existing data.

## You will NOT
- Write any vector whose dim ≠ `config.embedding.dim`.
- Report `Errors: 0` when degenerate vectors were produced.
- Overwrite existing real embeddings on a failed/degraded run.
- Fall back to stub/placeholder vectors on rate-limit or missing key — fail loudly.
- Re-run a live `reindex-embeddings --apply` against the real vault as part of testing (costs money + the bug is live) — use mocks. Operator runs the real re-embed after the guard lands.

## Stop and ask
1. The dim-3 stub turns out to be an intentional offline/test embedder used elsewhere (e.g. for unit tests without a key) — confirm before removing; it must still never be used by `reindex --apply` against the real provider.
2. `config.embedding.dim` isn't reliably set — confirm the source of truth for expected dim (provider/model default vs config).

## Acceptance
- Forcing a degenerate/rate-limited reindex **fails loudly and preserves existing embeddings** (integration test reads the file before/after).
- `reindex-embeddings --apply` with a valid key produces all `dim=2048` or fails — never a mix, never stubs.
- `retrieval.embedding-health` stays the end-state safety net; this brief adds the **write-time** guard so health never has stubs to find.
- Full suite + typecheck + build clean.
- Only after this lands: operator runs ONE real `reindex-embeddings --apply` to regenerate real embeddings (the prior $9 result was clobbered).

## Commit boundaries
- Task 1-2: `fix(embeddings): write-time dim guard — refuse degenerate vectors, fail loudly (Phase 4.40)`
- Task 3: `fix(embeddings): atomic no-clobber — preserve existing on failed reindex (Phase 4.40)`
- Task 4: `fix(embeddings): 429 backoff+retry, honest embedded/failed counts (Phase 4.40)`
- Task 5: `test: embedding write-guard + no-clobber + rate-limit (Phase 4.40)`

## Grounding
- Verified by reading `embeddings/*.jsonl` before (1649×2048 real) and after (`{3: …}` all stubs) the second reindex, whose output claimed `Embedded: 1696, Errors: 0`. `provider test-embedder` confirms the embedder errors correctly without a key, so the stub is a reindex/factory-path failure mode. `voyage.ts` catch blocks throw (not the source).
- Real embeddings cost (~$9) was spent then destroyed by the clobber — this guard ensures the next spend is not wasted.
