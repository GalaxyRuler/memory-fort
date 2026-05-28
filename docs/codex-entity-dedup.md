# Codex Implementation Brief — Entity Deduplication Pass (Phase 4.3.N)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The full-system checkup (2026-05-28) found `graph.duplicate-entities` is the **only failing health check** — 33 duplicate wiki-entity candidate pairs in a vault with only ~31 canonical wiki pages. That's a duplicate rate above 100% of the page count, which means the entity layer has significant name-variant drift (e.g., `Lisan Studio` vs `lisan-studio` vs `LisanStudio`, `agentmemory` vs `Agent Memory` vs `agent-memory`, `Voyage AI` vs `Voyage` vs `voyageai`).

The check currently only *detects and reports* duplicates. There's no tooling to *resolve* them — the operator has no way to merge `Lisan Studio` and `lisan-studio` into one canonical entity. This brief adds the resolution path: a detection-to-review-to-merge workflow that mirrors the propose/promote gating already proven in Phase 4.3.D/E/J.

After this lands: the operator runs `memory entity dedup --plan` to see proposed merges, reviews them (CLI or dashboard), and applies the keepers. The `graph.duplicate-entities` check drops to pass, and the cognitive graph stops fragmenting the same real-world entity across multiple nodes.

---

## Scope guard

You will:

### Task 1 — Duplicate-pair detection module

- Add `src/consolidate/entity-dedup.ts` with a pure function `findDuplicateEntityPairs(entities): DuplicatePair[]`:
  - Reuse whatever entity extraction the existing `graph.duplicate-entities` health check already uses (find it in `src/cli/commands/verify/` and `src/retrieval/graph.ts` or wherever entities are enumerated — do NOT build a second entity source)
  - A pair is a candidate when their normalized forms match. Normalization: lowercase, strip non-alphanumerics, collapse whitespace/hyphens (`Lisan Studio` → `lisanstudio`, `lisan-studio` → `lisanstudio`). Also flag high Jaccard/Levenshtein similarity (≥ 0.85) for near-misses that don't normalize identically
  - Each `DuplicatePair` carries: the two entity names, their normalized form, the match reason (`exact-normalized` | `high-similarity`), the count of observations/pages referencing each, and a suggested canonical form (prefer the variant appearing in a canonical wiki page title; else the most frequent; else the kebab-case form)
- Test: known variant sets collapse correctly; `max_tokens`-style false-friends (two genuinely different entities) do NOT merge; the canonical-form heuristic picks the wiki-titled variant when one exists

### Task 2 — Merge primitive

- Add a merge operation that, given a canonical name and a list of alias names, rewrites references:
  - Update `relations.*` entries across raw observations and wiki pages that point at an alias to point at the canonical entity instead
  - Record the alias → canonical mapping in a persistent `wiki/.entity-aliases.json` (or similar) so future captures normalize automatically and the merge is auditable/reversible
  - Use the existing `atomicWrite` primitive (now Windows-safe per Phase 4.3.L) for all file rewrites
  - **Never delete content** — merging rewrites references and records aliases; it does not delete observations or pages. (Per the operator's hard rule: no permanent deletions.)
- Test: a merge rewrites all alias references to canonical, writes the alias map, and is idempotent (running twice is a no-op)

### Task 3 — Review-gated CLI

- Add `memory entity dedup` subcommand mirroring `memory thread propose`:
  - `--plan` — print proposed merges (canonical ← [aliases], reference counts, match reason) without writing
  - `--apply` — write proposed merges to a review file `wiki/entity-merges-proposed.json` (NOT applied to the graph yet — review gate)
  - `memory entity merge <canonical>` — apply a single reviewed merge
  - `memory entity reject <canonical>` — drop a proposed merge
  - `memory entity aliases` — list the current alias map
- The two-stage gate matters here: an incorrect merge corrupts the graph, so the operator validates before the rewrite happens. Same philosophy as the propose pipelines

### Task 4 — Dashboard surface (optional-but-preferred)

- If it fits cleanly, add proposed entity-merges to the existing `/memory/inbox` page from Phase 4.3.J as a third section ("Entity merges awaiting review") with the same Approve/Reject one-click pattern and the `/api/proposed/*` endpoint family extended to cover entity merges
- If the inbox integration is more than ~1 hour of work, **stop and ask** — ship Tasks 1-3 + 5 first and split the dashboard surface into a follow-up. CLI-only is an acceptable v1

### Task 5 — Docs

- `templates/schema.md`: document the entity alias map, the normalization rules, and the dedup workflow
- `docs/ROADMAP.md`: Phase 4.3.N shipped 2026-05-28 — resolves the duplicate-entities health failure

You will **not**:

- Auto-merge without review. Detection is automatic; merging is operator-gated
- Delete any observation or wiki page. Merging only rewrites references + records aliases
- Change the `graph.duplicate-entities` detection thresholds. The check is correct; this brief gives the operator a way to act on it
- Build a fuzzy-matching ML model. Normalization + Jaccard/Levenshtein is the matcher
- Touch the propose/promote pipelines for threads/procedures. Entity dedup is a parallel workflow, not a modification of those
- Merge entities across cognitive types if that's semantically meaningful in the graph — **stop and ask** if a proposed merge would collapse two different-typed nodes

---

## Repo orientation

- `src/cli/commands/verify/` — find the existing `graph.duplicate-entities` check; it already enumerates the duplicate pairs. Reuse its entity source
- `src/retrieval/graph.ts` — graph/entity model. The merge primitive rewrites relations here
- `src/consolidate/thread-cluster.ts` / `procedure-detect.ts` — the propose-pipeline pattern to mirror for the CLI shape
- `src/cli/commands/thread.ts` — the propose/promote/reject orchestrator shape to copy for `memory entity`
- `src/storage/atomic-write.ts` — Windows-safe write primitive (Phase 4.3.L) for all rewrites
- `src/dashboard/proposed.ts` + `src/dashboard-ui/components/InboxPage.tsx` (Phase 4.3.J) — if doing Task 4

---

## Acceptance contract

1. `memory entity dedup --plan` lists the 33 (or current count) duplicate pairs with canonical suggestions and reference counts
2. `memory entity merge <canonical>` rewrites all alias references to canonical, records the alias map, deletes nothing, and is idempotent
3. After the operator merges the real duplicates, `memory verify` shows `graph.duplicate-entities` as **pass**
4. The alias map persists and future captures normalize against it
5. Full test suite passes (baseline 1039). New tests cover detection, the false-friend guard, the merge primitive, and idempotency
6. `npm run build`, `tsc --noEmit`, `git diff --check` clean

---

## Verification commands

```powershell
cd C:\CodexProjects\memory-system
node dist/cli.mjs entity dedup --plan          # see proposed merges
node dist/cli.mjs entity dedup --apply         # write to review file
node dist/cli.mjs entity merge lisan-studio    # apply one reviewed merge
node dist/cli.mjs verify --role=operator | Select-String "duplicate-entities"   # should now pass
```

---

## Commit boundaries

- Task 1: `feat: duplicate-entity pair detection (Phase 4.3.N Task 1)`
- Task 2: `feat: entity merge primitive with alias map (Phase 4.3.N Task 2)`
- Task 3: `feat: memory entity dedup/merge/reject CLI (Phase 4.3.N Task 3)`
- Task 4: `feat: entity merges in dashboard inbox (Phase 4.3.N Task 4)` — only if in scope
- Task 5: `docs: entity dedup workflow (Phase 4.3.N Task 5)`

---

## Out-of-scope follow-ups

- Automatic normalization at capture time (so duplicates never form) — a nice future addition, but this brief handles the existing backlog first
- Entity-type reconciliation — separate concern
