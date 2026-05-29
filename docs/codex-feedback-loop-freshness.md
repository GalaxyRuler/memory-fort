# Codex Implementation Brief — Feedback-Loop Freshness Fixes (Phase 4.8)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Phase 4.5 built the memory read-back loop (commit-on-write, a session-start "What you should remember" block, search no-rerank default). A **live round-trip test on 2026-05-29** proved the loop is NOT actually closed for freshly-logged observations:

- Logged a uniquely-tagged observation (`ROUNDTRIP-PROBE-7Q4K`) via the `memory` MCP `log_observation`.
- **Write + commit: works** (file on disk, committed). This part is solid — do not touch it.
- **Receive via search: FAILS** — the new observation is not returned even by exact-token BM25; it's absent from the searchable corpus.
- **Receive via session-start: FAILS** — the new observation does not appear in the "What you should remember" block.

Three distinct bugs, all verified in `src/hooks/session-start-helpers.ts` and the search corpus path:

### Bug A — preference-tagged observations never render

`buildRememberBlock` does:
```ts
const preferences = [...wikiPreferences, ...preferenceObservations]
  .sort(compareRememberEntries).slice(0, maxPreferences);
```
With `DEFAULT_MAX_PREFERENCES` small and `compareRememberEntries` sorting by timestamp desc, `wiki/preferences.md` wins all the slots and preference-tagged raw observations are cut. Observed: a `preference`-tagged observation logged this session did not appear anywhere (excluded from "recent" by the `!tags.includes("preference")` filter AND cut from "preferences").

### Bug B — "recent" is not actually most-recent

`recent = recentObservations.sort(compareRememberEntries).slice(0, maxRecent)`, and `compareRememberEntries` sorts by `entry.timestamp` (a per-observation-block timestamp parsed in `parseObservationBlocks`). Manual-MCP observation files whose block timestamp is missing/coarser sort BELOW older files that have finer timestamps, so the **newest** observations get dropped. Observed: `manual-mcp-1780016430503` (newer, non-preference, confidence 1.0) was skipped while two older 05-28 observations were shown.

### Bug C — search corpus excludes un-embedded new files

`loadSearchCorpus` / the search pipeline does not include a just-written observation until embeddings are refreshed (`reindex-embeddings`, which needs `VOYAGE_API_KEY`). Even pure-lexical BM25 missed the exact rare token `ROUNDTRIP-PROBE-7Q4K`, meaning the file isn't in the BM25 corpus either — corpus membership appears gated on having an embedding.

---

## Scope guard

You will:

### Task 1 — Preference-tagged observations always surface

- In `src/hooks/session-start-helpers.ts`, guarantee that preference-tagged raw observations render in the "Preferences / durable directives" section alongside `wiki/preferences.md`. Options (pick the cleanest):
  - give curated preference PAGES and preference-tagged OBSERVATIONS separate budgets (e.g., always include `wiki/preferences.md`, then up to N preference-tagged observations), or
  - raise `maxPreferences` and ensure the sort interleaves pages and observations rather than letting pages monopolize the slice.
- A `preference`-tagged observation logged in the current session MUST appear in the block.

### Task 2 — "Recent" reflects true write-recency

- Fix the recency ordering so the most-recently-written observations always win. The reliable signal is the raw file's date directory (`raw/YYYY-MM-DD/`) plus the observation-block time; when a block lacks a precise time, fall back to the file's mtime (or the date + a monotonic within-file index) — never sort a newer file below an older one.
- Ensure `log_observation` writes a precise `observed_at` (ISO timestamp) per observation block so the timestamp source is consistent across all manual-MCP files. Backfill is NOT required; just make new writes consistent and make the sorter robust to older date-only entries.
- A non-preference observation logged in the current session MUST appear at the top of "recent" (subject to the confidence floor).

### Task 3 — New observations are immediately searchable (at least lexically)

- Ensure a just-written observation is part of the search corpus without requiring an embedding reindex:
  - include all raw/wiki files in the **BM25 / lexical** corpus regardless of whether they have an embedding (lexical search must find a brand-new file by exact token), and
  - treat missing embeddings as "vector stream skips this doc," not "doc excluded from the corpus."
- Optionally trigger an incremental embedding for the new file on write (best-effort, gated on the embedder being configured; never block the write). If the embedder/API key is absent, the file must still be lexically searchable.
- Document the latency expectation: lexical-immediate, vector-after-embed.

### Task 4 — Tests + the round-trip regression

- Unit tests in `test/hooks/session-start.test.ts`:
  - a preference-tagged observation present → appears in the preferences section even with `wiki/preferences.md` present
  - three observations with increasing recency → the newest appears first in "recent"; a date-only older entry does not displace a newer one
- A search test asserting a freshly-added raw file (no embedding) is returned by an exact-token lexical query.
- **End-to-end round-trip test** (the one whose absence let this ship): write an observation with a unique token, then assert (a) session-start output contains it and (b) lexical search returns it — within the same test, no reindex step.

### Task 5 — Docs

- `templates/schema.md` + `docs/MEMORY-FORT-SPEC.md` §19: update the feedback-loop description — observations are retrievable immediately (lexical + session-start); vector search follows after embedding. Remove the "loop closed" overstatement; state the freshness guarantees precisely.
- `docs/ROADMAP.md`: Phase 4.8 shipped — feedback-loop freshness.

You will **not**:

- Change the write/commit path (Phase 4.5 Task 1 / 4.3.R/S) — it works.
- Require a reindex or `VOYAGE_API_KEY` for an observation to be retrievable. Lexical + session-start must work key-less.
- Inject the whole raw corpus at session-start — keep the bounded counts; just make selection correct (newest-first, preferences guaranteed).
- Block `log_observation` on embedding/commit — both stay best-effort.
- Lower the confidence floor to paper over the selection bug.

If making new files lexically searchable requires invalidating a corpus cache on every read (perf concern), **stop and ask** — a cheap mtime/size cache key or appending new files to the in-memory corpus is preferred over a full rebuild per query.

---

## Repo orientation

- `src/hooks/session-start-helpers.ts` — `buildRememberBlock` (preferences/recent assembly ~L88-123), `compareRememberEntries` (~L319), `collectRawObservations` + `parseObservationBlocks` (~L229-244), `DEFAULT_MAX_PREFERENCES`/`DEFAULT_MAX_RECENT`.
- `src/mcp/server.ts` — `log_observation` handler; ensure per-block `observed_at`.
- `src/storage/raw-file.ts` (or wherever observation blocks are written) — block format.
- `src/retrieval/corpus.ts` / `loadSearchCorpus` + `src/retrieval/bm25.ts` — corpus membership; ensure un-embedded files are included for lexical.
- `src/retrieval/search.ts` — vector stream should skip embedding-less docs, not drop them from the corpus.
- `test/hooks/session-start.test.ts`, `test/retrieval/*` — test homes.

---

## Acceptance contract

1. Log a uniquely-tokened observation, then **without any reindex**: session-start output contains it, and lexical `memory search "<token>"` returns it.
2. A preference-tagged observation surfaces in the preferences section even alongside `wiki/preferences.md`.
3. The newest non-preference observation appears first under "recent"; no older entry displaces a newer one.
4. Vector search still works once embeddings exist; absent embeddings degrade to lexical, never to "file invisible."
5. The end-to-end round-trip regression test exists and passes.
6. Full suite + `npm run typecheck` green; build + build:ui clean; `git diff --check` clean.

---

## Verification commands (operator + Claude re-runs this exact probe)

```powershell
cd C:\CodexProjects\memory-system
# write a unique marker via CLI (no API key needed)
node dist/cli.mjs log "FRESH-PROBE-XYZ feedback loop freshness check" --tag preference --confidence 1
# session-start must surface it
'{"hook_event_name":"SessionStart","session_id":"t","cwd":"."}' | node dist/hooks/session-start.mjs | Select-String "FRESH-PROBE-XYZ"
# lexical search must find it, no reindex
node dist/cli.mjs search "FRESH-PROBE-XYZ" --no-rerank
```

---

## Commit boundaries

- Task 1: `fix: preference-tagged observations always surface at session-start (Phase 4.8 Task 1)`
- Task 2: `fix: session-start recent-observation ordering is true write-recency (Phase 4.8 Task 2)`
- Task 3: `fix: new observations are lexically searchable without reindex (Phase 4.8 Task 3)`
- Task 4: `test: end-to-end memory round-trip regression (Phase 4.8 Task 4)`
- Task 5: `docs: feedback-loop freshness guarantees (Phase 4.8 Task 5)`

---

## Context

This is the brief that actually makes "use Memory Fort as my memory" true for *fresh* writes. Phase 4.5 closed write+commit and built the session-start block but left three freshness gaps that a same-session round-trip exposes. After this lands, the operator (and Claude) must be able to log an observation and see it come back in the same session, with no reindex and no API key. **Re-run the round-trip probe to verify before claiming the loop is closed.**

There is a leftover test marker in the live vault (`ROUNDTRIP-PROBE-7Q4K`, tagged `preference`) — useful as a verification target now; after 4.8 verification, the operator may delete or retag it.
