# Codex handoff — Phase 3 cutover: make the index the default search path

> ⛔ **DEFERRED TO PHASE 5 (decided 2026-07-01 after GPT-5.5 review + Claude code-verification).** The cutover as scoped here (flip the pure-lexical index to default) would **downgrade search quality**: `lexicalSearch` is pure FTS5 bm25, but legacy `runSearch` is a full **hybrid pipeline** — bm25 + graph spreading-activation + metadata scoring + RRF fusion + Voyage rerank + HyDE (see `src/retrieval/search.ts` imports). Flipping the default now drops all those signals. **Phase 5 rebuilds hybrid over the index (vectors + RRF), restoring quality with bounded memory — cut over THEN.** Meanwhile the index stays dormant (flag-OFF). The GPT-review findings below are kept for the Phase-5 cutover.
>
> **Verified UI/product gaps to fix as part of the Phase-5 cutover (GPT-5.5 review, confirmed vs code):**
> - **Frontend doesn't surface the indexing state** — `src/dashboard-ui/components/SearchPage.tsx` empty-state (line ~112) shows "No results for X" whenever `results.length===0`, with NO check for `degraded`/`warnings`/index-status; `degraded`/`warnings` render only as a tiny inline text suffix. The backend ALREADY provides `degraded` + an `index` status object (`server.ts` ~824-861) — this is a pure frontend gap. During cold-index a user sees a false-negative "No results". Fix: distinct empty state ("No indexed results yet — still indexing") + a prominent "indexing, results incomplete" banner while `!index.ready`.
> - **Backend collapses hard index-open failure into `currentState:"building"`** (`server.ts` ~757) — a broken index masquerades as "building forever" with a working-looking search box. Add a distinct `failed`/`repairing` state + a recovery/diagnostic UI (never silent legacy OOM fallback).
> - **Silent ~corpus-size app-data growth** (real vault: 846 MB markdown → 1.42 GB index) conflicts with the "no database / everything is markdown" positioning. Add a diagnostics/status row: index path, size, readiness, skipped-file count, last error; disclose on first index build.
> - **Discoverable rollback**: keep `MEMORY_INDEX_SEARCH=0` but surface a documented legacy opt-out from the degraded UI + README (an env var alone isn't a real rollback for a desktop user).
> - **Result-quality acceptance gate** before default-on: golden expected-hits is too weak — define top-1/top-5 overlap vs legacy on representative queries (or explicitly accept the tradeoff). This is moot until Phase 5 makes the index path hybrid.
> - **Pre-cutover gates**: needle-at-end cold-start UX test (visible incomplete-state, not "No results"), hard-failure UX test, long-session WAL/search/file-churn/shutdown soak.

---

> **(Original brief below — the flag-flip mechanics still apply when Phase 5 cutover happens, but ONLY after the index path is quality-competitive with legacy.)**

> Self-contained brief. **Builds on merged Tasks 1–6** (main `ee2e0f2`). Phase 3 is feature-complete + gate-green on 4 targets + confirmed on the real 846 MB vault (Part B). The index currently ships **flag-OFF** (`MEMORY_INDEX_SEARCH`). This task **flips the default ON** so the index becomes the real `/api/search` path for users — the actual delivery of the OOM fix. **Legacy `loadSearchCorpus`/`runSearch` is KEPT** (reachable via opt-out) and removed in a **separate later task**, not here.

## Goal

`/api/search` uses the SQLite index by default (memory O(top-K), the OOM fix), with a clean explicit opt-out back to legacy. No user config required for the common case; first launch cold-indexes in the background and search stays usable throughout.

## Grounded current state (verified 2026-07-01)

- `electron/main.ts`: forks the index-writer utilityProcess **only when `MEMORY_INDEX_SEARCH === "1"`** (`isIndexWriterEnabled`, ~line 103).
- `src/dashboard/server.ts`: routes `/api/search` → `lexicalSearch` (read-only WAL conn) **only when `MEMORY_INDEX_SEARCH === "1"`**, else legacy `runSearch`. **Crucially, the index route already searches the PARTIAL index while building** — when not `ready` it still returns index results tagged with `warnings: ["indexing"]` (server.ts ~line 853), NOT a fallback to the corpus loader. So cold-start does **not** reintroduce the OOM path.
- `openIndexDb` already **drops + rebuilds** a corrupt/incompatible DB (Task 1) — hard DB failure self-heals into a rebuild (degraded-but-bounded), it must NOT fall back to the OOM legacy loader.
- Part B proved: real 846 MB vault cold-indexes in ~1.5 min, reconcile-owner peak ~228 MB, steady ~93 MB, search returns correct results incl. mid-reconcile.

## What to change

### 1. Flip the default to ON, with an explicit opt-out
- **Default = index ON.** Introduce a single clear predicate (e.g. `isIndexSearchEnabled(env)`), used by BOTH `electron/main.ts` (writer fork) and `server.ts` (routing), that returns **true unless the user explicitly opts out**.
- **Opt-out contract (pick + document ONE, apply consistently):** `MEMORY_INDEX_SEARCH=0` (or `=off`/`=false`) → legacy path + no writer fork. Any other value / unset → index ON. (Prefer keeping the existing env var name and inverting the default over inventing a new var — least surprise. Document it.)
- `electron/main.ts`: fork the index-writer supervisor by default (unless opted out). Keep the fork options + supervisor reuse exactly as Task 5.
- `server.ts`: route `/api/search` → index by default (unless opted out).

### 2. Cold-start + failure behavior (DO NOT reintroduce the OOM path)
- **While building:** keep the existing behavior — search the partial index, return results with the `"indexing"` warning. Do **NOT** fall back to `loadSearchCorpus` during a normal cold-index (that would reload the whole corpus = the OOM regression).
- **Hard index failure** (DB won't open even after the built-in drop+rebuild): return a clear typed error / empty result with a diagnostic, and let the writer's rebuild recover — do **NOT** fall back to the legacy full-corpus loader. (Legacy is for the explicit opt-out only.)
- The index-writer forks + begins reconcile on launch; the debounced timer + `wal_checkpoint(TRUNCATE)` (Task 5) stay.

### 3. Keep legacy reachable (removal is a later task)
- `loadSearchCorpus` / `runSearch` and their imports stay. The opt-out path uses them unchanged. Do NOT delete them or their tests in this task.

### 4. Tests
- `/api/search` with **no env set** → index path (assert `lexicalSearch` used, `loadSearchCorpus` NOT called).
- `MEMORY_INDEX_SEARCH=0` → legacy path (assert `loadSearchCorpus` called; index not used).
- Cold-start: index not `ready` → returns partial index results + `warnings:["indexing"]`, and **`loadSearchCorpus` is NOT called** (proves no OOM-fallback during build).
- Hard index-open failure → no `loadSearchCorpus` fallback (typed error/empty, not corpus reload).
- The golden-query drift harness stays green (expected hits present in both paths; legacy not called in index mode).
- Update `test/dashboard/index-search-route.test.ts` (its current "flag on/off" tests invert: the previously-"on" behavior is now the default; add an explicit opt-out test).

## Verify before handing back
- `npx tsc --noEmit` + `npx tsc -p tsconfig.ui.json --noEmit` — both 0.
- `npm test -- test/dashboard/index-search-route.test.ts test/dashboard/index-golden-drift.test.ts --reporter=dot` green.
- `npm run build` green; `electron-main.mjs` + `index-writer.mjs` self-contained.
- Do NOT run the full vitest suite locally (`server.test.ts` timeout headroom is global now, but still run targeted). Note: if you rebuild/package (electron:rebuild), `npm rebuild better-sqlite3` afterward to restore the system-Node ABI for vitest.

## What NOT to do
- Do NOT remove `loadSearchCorpus`/`runSearch` or the legacy tests (separate later task).
- Do NOT fall back to the legacy full-corpus loader during a normal cold-index or on transient index states (OOM regression) — legacy is opt-out-only.
- Do NOT bump the version or cut a release (the release is the next, separate task).
- Keep the A″ architecture (Task 5) + the partial-index-while-building behavior intact.

## After Codex hands back — Claude's audit
1. Diff review: single opt-out predicate shared by main.ts + server.ts; default is ON; legacy reachable only via opt-out; no legacy fallback on build/transient/hard-failure states.
2. Local: default-on routes to index, `MEMORY_INDEX_SEARCH=0` routes to legacy, cold-start returns partial+warning without calling `loadSearchCorpus`; typechecks + targeted tests green.
3. **Real-vault re-run (Part B style):** package + launch with NO env → confirm the index writer forks by default, cold-indexes the real vault, memory bounded, `/api/search` returns index results by default; `MEMORY_INDEX_SEARCH=0` → legacy path. Record in `docs/release-evidence/`.
4. On green: this unblocks the **combined public release** (RELEASING.md: version bump → 4 installers → 4-target installed re-check → publish → upgrade local binary). Legacy removal is a follow-up after the release proves the index in the wild.

## References
- Plan: `docs/superpowers/plans/2026-06-28-tier2-phase3-lexical-index.md`
- Impl: `electron/main.ts` (`isIndexWriterEnabled`), `src/dashboard/server.ts` (routing), `src/dashboard/index-writer.ts`
- Tests: `test/dashboard/index-search-route.test.ts`, `test/dashboard/index-golden-drift.test.ts`
- Part B evidence (real vault): `docs/release-evidence/phase3-partB-2026-07-01.md`
- Release: `docs/RELEASING.md`
