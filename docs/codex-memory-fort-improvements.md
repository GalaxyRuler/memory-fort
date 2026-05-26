# Codex Implementation Brief — Memory Fort Architectural Improvements

**Target**: Codex 5.5 (or higher)
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>` · Co-Author: `Claude Opus 4.7 <noreply@anthropic.com>` only when Claude actually pair-implemented
**Branches**: Work directly on the current default branch unless asked to fork. Create one commit per numbered task. Stop and ask if a task's scope creeps beyond what's specified.

---

## Scope Guard — What This Brief Does NOT Cover

You are **not** redesigning the dashboard UI. The classic dashboard at `/memory/` (sidebar, glass panels, cyan/violet/amber palette, entity colors) is the canonical Memory Fort look and is staying. Do **not**:

- Build a new UI shell, sidebar, or routing layer
- Change `src/dashboard-ui/components/AppShell.tsx`, `Sidebar.tsx`, `TopBar.tsx`, or `index.css` design tokens
- Touch `tailwind.config.ts` color tokens (other than adding *new* tokens for surfaced features — never modify existing ones)
- Introduce a new font, layout system, or theme
- Touch `GraphCanvas.tsx` or `GraphPage.tsx` rendering — the 3D graph rendering is intentionally left for a separate visual track

You **are** delivering: contradiction propagation, confidence-aware injection, the Memory Fort rebrand surface area, spreading activation in graph retrieval, cross-agent canonicalization, and a memory pruning strategy. Six numbered tasks below.

Do not commit secrets. `VOYAGE_API_KEY` lives in `/root/memory-system/env/voyage.env` on the VPS only. No OneDrive paths anywhere. Vite/vitest configs are off-limits unless a task explicitly touches them.

---

## Repo Orientation (Verified Before Brief)

- **Retrieval pipeline** (`src/retrieval/`): five-stream RRF fusion in `search.ts` — `bm25`, `vector`, `exact`, `graph` (BFS in `graph.ts:expandGraph`), and `metadata` (`metadata-score.ts:scoreByMetadata` which already factors `confidence × status × recency`).
- **Conflict detection** (`src/curation/checks.ts`): runs `duplicate-title`, `contradiction`, `stale-clone`, `drafts (conf < 0.5)`, `stale (>180d)`, `orphans`, `broken-links`, `broken-relations`. Output surfaces in `/api/conflicts` and `/api/maintenance/scan`. Detection is passive — nothing propagates after a conflict is recorded.
- **Compile pipeline** (`src/compile/`): rebuilds wiki indexes, BM25 cache, vector embeddings, graph adjacency.
- **Hooks** (`src/hooks/`): `session-start.ts` emits `schema.md + index.md + last 20 log lines` to stdout for Claude Code / Codex. `pre-compact.ts` marks compaction boundaries. Antigravity has no hook surface.
- **MCP server** (`src/hooks/mcp-server.ts`): exposes memory tools to AI clients.
- **Vault writers**: claude/codex/gemini all dump raw observations to `wiki/raw/YYYY-MM-DD/*.md`. Each source has its own filename prefix and frontmatter shape conventions. There is no canonicalization step today.
- **Dashboard SPA** (`src/dashboard-ui/`): React 19 + TanStack Router @ basepath `/memory`. Sidebar shows literal title "memory" and `v0.4.0-dev` pill. Browser tab title is "memory".
- **Build/deploy**: `npm run build && npm run memory -- install-vps`. Test runner: `npx vitest run`. Total tests last green: 574.

---

## Task 1 — Memory Fort Rebrand (Trivial, Ship First)

### Why
Name change was decided in product session. Old name "memory" is generic and unbranded; "Memory Fort" is the production identity going forward. This is the smallest task — landing it first proves the deployment loop and gives you a fast win.

### Files to touch
- `src/dashboard-ui/index.html` — `<title>memory</title>` → `<title>Memory Fort</title>`
- `src/dashboard-ui/layouts/Sidebar.tsx` — the literal text `"memory"` rendered as the app brand, plus the version pill `"v0.4.0-dev"` (keep version, just update wording context if needed)
- `src/dashboard-ui/components/TopBar.tsx` — if any "memory" branding appears here
- `src/dashboard-ui/index.css` — meta description / app name comments
- `package.json` — `"description"` field only. **Do not** change `"name": "@galaxyruler/memory-system"` (npm package id stays).
- `README.md` — update product name in the headline; leave package name and install commands as-is.

### Out of scope
- The MCP server name `"memory"` stays (downstream agents have it hardcoded — breaking change risk).
- CLI command `memory ...` stays (muscle memory + scripts).
- Internal module paths and identifiers stay.

### Test plan
- Add/update `test/dashboard-ui/router.test.tsx` (or equivalent) to assert document.title contains `"Memory Fort"`.
- Visual smoke: `npm run dev` or build + deploy and verify sidebar shows "Memory Fort" and browser tab shows "Memory Fort".

### Acceptance
- All existing 574 tests still pass.
- `grep -ri "memory" src/dashboard-ui/` returns zero user-visible brand uses (function names, variable names, comments OK).

---

## Task 2 — Confidence-Aware Injection in Session Start

### Why
`scoreByMetadata` already factors confidence into search ranking. But the SessionStart hook dumps `schema.md + index.md + last 20 log lines` blindly — there's no awareness of which entries are high vs. low confidence. Result: low-confidence drafts get injected with the same authority as audited decisions, reinforcing hallucination.

### Current state (verified)
- `src/hooks/session-start.ts:sessionStartBody` emits three sections without any confidence filtering.
- `src/retrieval/metadata-score.ts:scoreByMetadata` returns per-doc `confidenceFactor` and final score. Reusable.
- Confidence floor for "draft" classification is `0.5` (in `src/curation/checks.ts:checkDrafts`).

### Contract
- Add a new function `confidenceAwareIndex()` in `src/hooks/session-start.ts` (or a new module `src/hooks/session-start-helpers.ts` if it grows):
  - Reads the wiki index.
  - For each entry, looks up the page's frontmatter `confidence`.
  - Splits entries into three buckets: `high (≥0.8)`, `medium (0.5–0.79)`, `low (<0.5)`.
  - Returns a string formatted like:
    ```
    --- High-confidence entries (N) ---
    [list]

    --- Medium-confidence entries (N) ---
    [list]

    --- Low-confidence / drafts (N) ---
    [list — explicitly prefixed with `⚠ DRAFT:` so the receiving LLM downweights them]
    ```
- Replace the current plain `Index` section in `sessionStartBody` with this bucketed version.
- Add an env var override `MEMORY_FORT_INJECTION_CONF_FLOOR` (default `0`) that suppresses entries below the floor entirely. `0` = inject all (current behavior). `0.5` = drop drafts. Document in README under "Environment variables".

### Files to touch
- `src/hooks/session-start.ts`
- New: `src/hooks/session-start-helpers.ts` (if helper grows beyond ~60 lines)
- `test/hooks/session-start.test.ts` (likely exists; add cases)
- `README.md` — env var section

### Test plan
- Unit test: given a fixture index with mixed confidence pages, `confidenceAwareIndex()` outputs three correctly-bucketed sections with `⚠ DRAFT:` prefixes on low-confidence entries.
- Unit test: `MEMORY_FORT_INJECTION_CONF_FLOOR=0.5` drops the low-confidence section entirely.
- Integration test: `sessionStartBody` end-to-end output contains the bucketed format.

### Acceptance
- A SessionStart fired against the current vault visibly buckets pages by confidence in stdout.
- Low-confidence drafts carry the `⚠ DRAFT:` prefix.
- Env-var floor suppression works.
- All existing tests still green.

---

## Task 3 — Contradiction Propagation

### Why
`checks.ts:checkContradictions` flags pairs of pages that contradict (e.g., page A says "use Postgres", page B says "use JSONL"). Today the conflict gets recorded and surfaces in the Conflicts dashboard, but **downstream pages** that referenced the loser of the contradiction are not flagged. So you keep injecting stale-implication memory into agent contexts indefinitely.

### Current state (verified)
- `src/curation/checks.ts` exports a list of conflict records with `pageA`, `pageB`, `reason`.
- Page relations live in frontmatter `relations` field; graph adjacency is built in `src/retrieval/graph.ts`.
- No "marked-for-review" field exists on pages today.

### Contract
- Extend conflict detection: after detecting a `contradiction` between `pageA` and `pageB`, walk the inbound-relation graph from each contradicted page. For every page that references either side of the contradiction (any hop depth up to **2**), record a new conflict record of type `derived-from-contradiction` with:
  - `dependentPath`: the downstream page
  - `via`: the path the dependent took (chain of relation IDs)
  - `rootContradictionId`: pointer to the original conflict record
- Surface this new type in `/api/conflicts` so the dashboard's ConflictsPage can render it.
- Add a maintenance scanner check `checkSupersededDependents()` that flags pages still referencing `superseded` pages — same propagation idea applied to the status field, not to contradictions.

### Files to touch
- `src/curation/checks.ts` — new propagation logic + `checkSupersededDependents`
- `src/dashboard/api.ts` (or wherever `/conflicts` is served) — include new conflict type in response
- `src/dashboard-ui/components/ConflictsPage.tsx` — render the new conflict type with a distinct visual treatment (different icon, "indirect" badge) using existing GlassPanel/Card primitives — **do not** introduce new visual primitives
- Test files for both checks
- `src/storage/paths.ts` or relevant types: extend the conflict record union with `derived-from-contradiction`

### Test plan
- Fixture: page A "use Postgres" (status: superseded), page B "use JSONL" (status: active), pages C/D/E reference A.
- After scan, conflicts should include the A↔B contradiction PLUS three `derived-from-contradiction` records for C, D, E with their relation chains.
- 2-hop test: page F references C but not A directly. F should be flagged (2-hop).
- 3-hop test: page G references F. G should **not** be flagged (max 2 hops).

### Acceptance
- Conflicts page renders both direct contradictions and propagated-flag entries with clear visual distinction.
- Maintenance scan reports superseded dependents.
- No new test failures.

---

## Task 4 — Spreading Activation in Graph Retrieval

### Why
`expandGraph` in `src/retrieval/graph.ts` uses BFS with a hop limit. This finds *reachable* nodes but doesn't model **associative recall**: a human thinking about "React" first surfaces "hooks", then more weakly "state management", then very weakly "that React bug from last month". Spreading activation captures this with decay, and lateral inhibition prevents spurious paths from dominating.

### Current state (verified)
- `src/retrieval/graph.ts:expandGraph(seeds, options)` does BFS, returns flat set of paths.
- The result feeds into the `graph` stream of the RRF fusion in `search.ts`.

### Contract
- Add a new export `spreadingActivation(seeds, options)` in `src/retrieval/graph.ts`:
  - Each seed node starts with activation `1.0`.
  - On each iteration step, every node's activation propagates to its neighbors via `nextActivation += incomingActivation × edgeWeight × decay`, where `decay` defaults to `0.6` per step.
  - **Lateral inhibition**: at each step, after computing raw next-activations, subtract `λ × max(activations of competing siblings)` where `λ` defaults to `0.15`. Competing siblings = nodes sharing a parent in the same step.
  - Iterate until either max-iterations (default `5`) or all activations below epsilon (`0.01`).
  - Return a sorted array `{ path, activation }[]` descending by activation.
- Wire it into `search.ts`: add a sixth RRF stream `graph-spread` alongside the existing `graph` stream. Both should produce ranked results; RRF fuses them.
- Add an env var `MEMORY_FORT_SPREADING_ACTIVATION` (default `true`) to disable for benchmarking.
- Edge weights: derive from `RELATION_COLORS` weights in `src/retrieval/graph.ts` if they exist, or default to `1.0` for all edges if not.

### Files to touch
- `src/retrieval/graph.ts` — add `spreadingActivation` export
- `src/retrieval/search.ts` — add new stream to fusion
- New test: `test/retrieval/spreading-activation.test.ts`
- README — document the algorithm and env var

### Test plan
- Property test: seed=A on a chain A→B→C→D. Expected: `A > B > C > D` ordering, with strict decay.
- Lateral inhibition test: seed=A with two parallel paths A→B→D and A→C→D. D should activate from both but inhibition should suppress B and C relative to each other if they're at the same depth.
- Disconnected component test: nodes not reachable from any seed have activation 0 and don't appear in output.
- Performance: 1000-node graph completes in under 100ms.

### Acceptance
- New stream visible in `/api/search` response under `timings` and `components`.
- Spreading-activation results add measurable lift on the LongMemEval-S report (currently R@5 = 95.2%; even a 0.5% improvement counts as success — the metric isn't degraded).
- Algorithm correctness covered by unit tests.

---

## Task 5 — Cross-Agent Memory Canonicalization

### Why
Claude Code, Codex, and Antigravity write into `wiki/raw/` with **different filename conventions and frontmatter shapes**. The `source` field exists but no normalization happens. A memory written by Codex about "the GraphCanvas resize fix" may not be retrievable when Claude searches for the same topic because frontmatter keys differ.

### Current state (verified)
- `src/retrieval/corpus.ts` recognizes `source` as one of `claude-code | codex | antigravity | manual | crystal | unknown`.
- Different sources produce different frontmatter shapes — observed empirically but not normalized.
- No tests verify cross-agent retrievability today.

### Contract
- Add a canonicalization step in the compile pipeline (`src/compile/`): when ingesting raw observations into the corpus, **normalize** frontmatter into a canonical shape:
  - `source` — already canonical
  - `agent_session_id` — synthesize from filename or existing frontmatter (`session_id`, `sessionId`, etc. — try all known variants)
  - `tool_calls_summary` — extract from raw body if present (lines starting with `Tool:` or `Used tool:`)
  - `topic_tags` — derive from existing tags + filename + first H1 of body
  - `confidence` — default to source-specific baseline if missing: `claude-code → 0.75`, `codex → 0.75`, `antigravity → 0.6` (lower because Antigravity has no Stop hook so reflection quality is lower), `manual → 0.85`, `crystal → 0.9`
- Add a regression test fixture: three raw files (one per agent) about the same topic. After canonicalization, a search for that topic returns all three within the top-5 results.

### Files to touch
- `src/compile/` — new normalizer module
- `src/retrieval/corpus.ts` — accept canonical frontmatter
- New test fixture under `test/fixtures/cross-agent/`
- `test/retrieval/cross-agent.test.ts`

### Test plan
- Three identical-topic raw observations from claude/codex/antigravity. Compile → search → all three appear in top results regardless of which agent's terminology the query uses.
- Confidence defaults applied correctly per source.
- Existing source-specific fields preserved in a `raw_frontmatter` field for debugging.

### Acceptance
- Cross-agent regression test passes.
- No degradation on LongMemEval-S report.
- Existing 574 tests still green.

---

## Task 6 — Memory Pruning at Scale

### Why
At 127 wiki pages and 318 edges, performance is fine. At 10K pages, BM25 cache regeneration starts taking >10s, the embedding store grows to gigabytes, and `/api/graph` payloads become unwieldy. There's no story today for what to prune, archive, or compact.

### Current state (verified)
- `src/curation/checks.ts` has `checkStale (>180d)` and `checkOrphans (no inbound)` — flags only, no action.
- No archival tier exists. The wiki has only one storage class.

### Contract
- Add a CLI command `memory prune` with three subcommands:
  - `memory prune --plan` — dry-run report listing pages that would be pruned, by category (stale, orphan, low-confidence, large-raw). No writes.
  - `memory prune --apply` — moves matching files into `wiki/archive/YYYY-MM-DD/` preserving original relative path. Updates the wiki index to exclude them. Embeddings for archived pages get a `archived: true` flag in the embeddings store rather than being deleted (cheaper to restore).
  - `memory prune --restore <path>` — moves an archived file back into active wiki.
- Add a maintenance scan extension that surfaces "ready to prune" candidates in the dashboard (read-only — actual pruning is CLI-driven only, per existing pattern).
- Define pruning eligibility:
  - Stale + orphan + confidence < 0.5 → prune candidate (all three conditions).
  - Raw observations older than **90 days** AND not referenced by any wiki page → prune candidate.
  - Crystals never get pruned automatically (human-curated insights).

### Files to touch
- New: `src/cli/commands/prune.ts`
- `src/cli/index.ts` — wire command
- `src/curation/checks.ts` — add `checkPruneCandidates`
- `src/retrieval/embeddings-store.ts` — add `archived` flag handling
- README — document the command and policy

### Test plan
- Unit test: `--plan` correctly identifies eligible candidates from a fixture vault.
- Integration test: `--apply` moves files, updates index, marks embeddings archived. `--restore` is the inverse.
- Search regression: archived pages don't appear in search results.
- Crystals are never proposed for pruning even if stale/orphan.

### Acceptance
- All three subcommands work.
- Dashboard maintenance page shows prune candidates count.
- Round-trip test passes (prune → restore → prune).
- All 574+ tests green.

---

## Execution Order

Land in this order. Each is a separate commit. Stop and run tests between every task — don't queue commits.

1. **Task 1 (rebrand)** — proves the deploy loop, gives a fast win
2. **Task 2 (confidence injection)** — small, high impact, no new architecture
3. **Task 3 (contradiction propagation)** — touches conflict pipeline; needs Task 1 deployed first to verify dashboard renders new conflict type correctly
4. **Task 5 (cross-agent canon)** — must land before Task 4 because spreading activation will leverage canonicalized graph edges
5. **Task 4 (spreading activation)** — biggest unknown, save for when context is fresh
6. **Task 6 (pruning)** — last, because it touches the most files and creates new on-disk state

---

## Build / Test / Deploy Commands

```
# Run full test suite
npx vitest run

# Run a single test file
npx vitest run test/retrieval/spreading-activation.test.ts

# Type-check + build everything
npm run build

# Build only the dashboard SPA (regenerates route tree)
npm run build:ui

# Deploy to VPS (only after all green)
npm run memory -- install-vps
```

After each task: `npx vitest run` must be clean. After all six: build, deploy, and smoke-test the dashboard at `https://srv1317946.tail6916d8.ts.net/memory/`.

---

## Verification Checklist

Before declaring done:

- [ ] All six tasks committed individually with clear messages
- [ ] `npx vitest run` clean (≥574 tests, no regressions)
- [ ] LongMemEval-S report shows R@5 ≥ 95.2% (no regression)
- [ ] Dashboard loads at `/memory/` with new "Memory Fort" branding
- [ ] Sample contradiction propagates to dependents and renders in ConflictsPage
- [ ] Sample SessionStart hook output shows confidence buckets
- [ ] `memory prune --plan` produces a sensible report against the live vault
- [ ] Cross-agent regression test passes
- [ ] Spreading-activation stream visible in `/api/search` timings
- [ ] No secrets committed, no OneDrive paths anywhere

If you hit a blocker that requires scope creep, **stop and ask** rather than expanding the brief.
