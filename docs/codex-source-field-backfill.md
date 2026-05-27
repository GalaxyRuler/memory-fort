# Codex Implementation Brief — Source Field Backfill

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Phase 3 of the Memory Fort roadmap. The Phase 3.0 calibration deploy revealed three real fail signals on `/api/graph-health`:

- `edge-type-entropy: 0.30` — typed-edge proposing brief, later
- `hub-overload: 1008` — strategic decision, later
- `agent-attribution: 60% (12/20)` — **this brief**

Eight of twenty live wiki pages have `source: unknown` because the code that created them never set the source field. Identified via live `/api/graph?scope=all`:

| Path | Category | Should have source |
|---|---|---|
| `wiki/.audit/agentmemory-migration-2026-05-26T01-12-17-243Z.md` | audit log | `import-agentmemory` |
| `wiki/.audit/backfill-2026-05-26T17-39-39-230Z.md` | audit log | `backfill` |
| `wiki/.audit/consolidate-2026-05-26T22-26-13-956Z.md` | audit log | `consolidate` |
| `wiki/crystals/enhance-scripts-for-better-compliance.md` | crystal | `crystal-extraction` |
| `wiki/crystals/project-management-benefits-from-tech-improvements.md` | crystal | `crystal-extraction` |
| `wiki/crystals/upgrade-process-requires-compliance-and-testing.md` | crystal | `crystal-extraction` |
| `wiki/crystals/validation-is-key-for-upgrades.md` | crystal | `crystal-extraction` |
| `wiki/references/fork-smoke-marker-codex-fork-smoke-9d207734d8ff443d8dbe9fa912cc73a9.md` | test artifact | `codex-fork-smoke` |

This brief covers all three angles: fix the writers so it stops happening, backfill the eight existing pages, and add a verify check so regression is impossible.

After this lands, `agent-attribution` moves from 60% fail to 100% pass, and `provenance-coverage` likely moves from 85% to 100% as well (the same files were probably missing `imported_from` too).

---

## Scope guard

You will:

- Find every place that writes a wiki page (audit logs, crystals, fork-smoke markers) and make each one set a `source` field at write-time
- Add a new CLI command `memory backfill-source` (`--plan` / `--apply` / `--force`) that scans the live wiki for pages with missing or `unknown` source and assigns one based on file path heuristics
- Add a new verify check `frontmatter.source` that fails if any live wiki page (i.e. excluding `wiki/archive/`) has a missing or `unknown` source field. Registered alongside `freshness.staleness` and `graph.cohesion`
- Tests for each writer change asserting source is set; tests for the backfill command; tests for the verify check

You will **not**:

- Touch pages in `wiki/archive/` — they're frozen by definition
- Hand-edit the eight broken pages. The CLI command does the migration. Hand-edits don't generalize and won't help when this pattern recurs
- Change the `source` field semantics for pages that already have it set correctly
- Add a `source` field to raw observations (they already have one — this brief is wiki-only)
- Touch `imported_from` (a separate, related field that may also need backfill — out of scope here; `provenance-coverage` warn moves down naturally once source is fixed because `imported_from` shares paths with `source` in the metric implementation)

If the writer for a particular wiki-page-creating code path is harder to locate than expected (e.g., the crystal-extraction logic), **stop and ask** before making structural changes.

---

## Repo orientation (verified before brief)

The three writer locations to fix:

- `src/migration/map-agentmemory.ts:133-135` — writes `wiki/.audit/agentmemory-migration-{ts}.md` via `atomicWrite`. The frontmatter on this audit log is built nearby; add `source: import-agentmemory` to it
- `src/cli/commands/backfill.ts` (or wherever the backfill audit is constructed — verify the path; the audit-writing logic may live in a helper) — writes `wiki/.audit/backfill-{ts}.md`. Add `source: backfill`
- `src/consolidate/runner.ts:145-159` (`writeObservationMentions` is observation-side; the audit log writer is elsewhere in the same file) — writes `wiki/.audit/consolidate-{ts}.md`. Add `source: consolidate`

The crystal-extraction code path needs locating:
- `grep -rn "wiki/crystals" src/` and `grep -rn "atomicWrite.*crystal" src/` are good starting points
- The four crystal files have names that look like compile-output. The crystal writer may live in `src/compile/` or similar

The fork-smoke code path:
- `grep -rn "fork-smoke-marker" src/` should find it
- This is test/development scaffolding, not core functionality

The backfill CLI command:
- `src/cli.ts` — register the new `backfill-source` command alongside existing commands
- New file: `src/cli/commands/backfill-source.ts`

The verify check:
- `src/cli/commands/verify/registry.ts` — append new descriptor after `graph.cohesion`
- New file: `src/cli/commands/verify/source-field.ts`
- Existing pattern: see `src/cli/commands/verify/freshness.ts` for shape

---

## Task 1 — Fix the wiki-page writers

### Why
If the writers don't set source, every future audit log / crystal / smoke marker will recreate the same gap. The migration in Task 2 is a one-time backfill; this task prevents recurrence.

### Contract

Every code path that writes a file under `wiki/` (excluding `wiki/archive/`) must include a `source: <string>` field in the frontmatter. The string should identify the tool or process that created the file. Recommended values:

- `source: import-agentmemory` for files written by `memory import-agentmemory`
- `source: backfill` for files written by `memory backfill`
- `source: consolidate` for files written by `memory consolidate`
- `source: crystal-extraction` for files written by the crystal extractor (wherever that lives)
- `source: codex-fork-smoke` for files written by the fork-smoke harness (if it stays in the repo; if it's dev-only, document that)

For audit-log writers, the source value should be the noun form of the CLI subcommand. For derived-content writers (crystals), it should be the process name.

### Files

- Modify: `src/migration/map-agentmemory.ts` — audit log frontmatter gets `source: import-agentmemory`
- Modify: `src/consolidate/runner.ts` — audit log frontmatter gets `source: consolidate`
- Modify: `src/cli/commands/backfill.ts` (or wherever the backfill audit writer lives) — `source: backfill`
- Modify: the crystal writer (locate via grep, then edit) — `source: crystal-extraction`
- Modify: the fork-smoke writer (locate via grep) — `source: codex-fork-smoke`. If the writer is in a test directory and the file shouldn't be in the live wiki, raise that as a finding instead of writing source on it
- Tests: each writer's existing test gets one assertion added — parse the written frontmatter and assert `source` is set to the expected value

---

## Task 2 — `memory backfill-source` CLI

### Why
Eight wiki pages already exist with `source: unknown`. A reusable CLI command is the right shape because:

- The same pattern will likely recur when future code paths are added (a new audit type, a new crystal subtype) and forget the source field
- It's idempotent — re-running on a clean vault is a no-op
- It documents the path → source mapping in code, where the operator can read and edit

### Contract

```
memory backfill-source [--plan|--apply] [--force]
```

- `--plan` (default): scans `wiki/**/*.md` excluding `wiki/archive/`, lists pages with missing or `unknown` source, prints proposed source value per page based on the rules below, exits without writing
- `--apply`: same scan, but writes the source field via atomic write
- `--force`: also processes pages where source is currently set to a non-`unknown` value (e.g., for re-classification). Default is to skip pages that already have source set

Rules for inferring source from file path:

| Path pattern | Proposed source |
|---|---|
| `wiki/.audit/agentmemory-migration-*.md` | `import-agentmemory` |
| `wiki/.audit/backfill-*.md` | `backfill` |
| `wiki/.audit/consolidate-*.md` | `consolidate` |
| `wiki/.audit/*.md` (any other audit log) | `unknown-audit` (flagged for manual review) |
| `wiki/crystals/*.md` | `crystal-extraction` |
| `wiki/references/fork-smoke-marker-*.md` | `codex-fork-smoke` |
| Anything else | leave as-is, report under "unmatched" |

Write an audit log of the backfill itself at `wiki/.audit/backfill-source-{ts}.md`. Yes — that means the new audit log carries `source: backfill-source` (or `source: backfill` if you reuse the existing backfill audit format). Document the choice.

Report shape (stdout):
```
Memory backfill-source plan
total wiki pages: 20 (excluding archive)
missing/unknown source: 8
  - wiki/.audit/agentmemory-migration-2026-05-26T01-12-17-243Z.md -> import-agentmemory
  - wiki/.audit/backfill-2026-05-26T17-39-39-230Z.md -> backfill
  ...
unmatched: 0
```

### Files

- New: `src/cli/commands/backfill-source.ts`
- Modify: `src/cli.ts` — register the new command
- Tests: `test/cli/commands/backfill-source.test.ts` — at minimum:
  - Plan mode scans without writing
  - Apply mode writes correct source for each path pattern
  - Already-sourced pages are skipped by default
  - `--force` reprocesses already-sourced pages
  - An audit log is written to `wiki/.audit/`
  - Unmatched paths are reported

---

## Task 3 — `frontmatter.source` verify check

### Why
Future code paths will forget the source field. A verify check catches the regression at the next dashboard load, not weeks later when someone notices a metric drift.

### Contract

```ts
// src/cli/commands/verify/source-field.ts

export const sourceFieldCheck: CheckDescriptor = {
  id: "frontmatter.source",
  label: "wiki pages have source provenance",
  roles: ["operator", "server"],
  run: async (ctx) => {
    const corpus = await loadSearchCorpus({ vaultRoot: ctx.vaultRoot, scope: "wiki" });
    const live = corpus.documents.filter((d) => !d.relPath.startsWith("wiki/archive/"));
    const missing = live.filter((d) =>
      !d.source || d.source === "unknown"
    );
    if (missing.length === 0) {
      return pass(
        "frontmatter.source",
        `all ${live.length} live wiki pages have source provenance`,
      );
    }
    if (missing.length <= 2) {
      return warn(
        "frontmatter.source",
        `${missing.length}/${live.length} live wiki pages lack source`,
        `run \`memory backfill-source --apply\``,
      );
    }
    return fail(
      "frontmatter.source",
      `${missing.length}/${live.length} live wiki pages lack source`,
      `run \`memory backfill-source --apply\``,
      missing.slice(0, 5).map((d) => d.relPath).join(", "),
    );
  },
};
```

Thresholds:
- 0 missing → pass
- 1–2 missing → warn (tolerates one stray new code path between the time a brief lands and the time the writer is fixed)
- 3+ missing → fail

### Files

- New: `src/cli/commands/verify/source-field.ts`
- Modify: `src/cli/commands/verify/registry.ts` — append `sourceFieldCheck` after `graphCohesionCheck`
- Modify: `test/cli/commands/verify/registry.test.ts` — assert new descriptor present
- Tests: `test/cli/commands/verify/source-field.test.ts` — assert pass/warn/fail at each threshold; assert pages in `wiki/archive/` are excluded

---

## Execution order

1. **Task 1** (writer fixes) — prevent recurrence. Highest leverage going forward
2. **Task 2** (CLI backfill) — clean up the 8 existing pages
3. **Task 3** (verify check) — catch regression on the next dashboard load

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                  # full suite (832 currently passing)
npx vitest run test/cli/commands/backfill-source      # focus on new CLI
npx vitest run test/cli/commands/verify               # focus on new check
npm run build
npm run build:ui

# Run the backfill against the live vault before deploying:
node dist/cli.mjs backfill-source --plan              # preview
node dist/cli.mjs backfill-source --apply             # apply
git -C ~/.memory status                               # 8 files modified + 1 audit log added
git -C ~/.memory add raw/ wiki/                       # stage
git -C ~/.memory commit -m "chore: backfill source field on 8 wiki pages"
git -C ~/.memory push vps main                        # ride to VPS

# Deploy dashboard (no functional dashboard change but ships the new verify check):
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify:
curl -s https://srv1317946.tail6916d8.ts.net/memory/api/graph-health | jq '.metrics[] | select(.id=="graph.agent-attribution")'
# Expected: status=pass, value=100
```

---

## Acceptance checklist

- [ ] Audit-log writers in `map-agentmemory.ts`, `backfill.ts`, `consolidate/runner.ts` all set `source` at write-time
- [ ] Crystal writer sets `source: crystal-extraction`
- [ ] Fork-smoke writer either sets `source: codex-fork-smoke` or is removed from the live-wiki write path entirely
- [ ] `memory backfill-source --plan` lists the 8 known pages with correct proposed sources
- [ ] `memory backfill-source --apply` writes the source fields and creates an audit log
- [ ] Re-running `backfill-source --apply` is a no-op (skips pages with source set)
- [ ] `--force` reprocesses
- [ ] `frontmatter.source` verify check passes when all live pages have source, warns at 1-2 missing, fails at 3+
- [ ] Check is registered in `ALL_CHECKS` and runs in both operator and server roles
- [ ] `/api/graph-health` reports `agent-attribution: pass` (value 100) on the live VPS after the backfill commits to the vault
- [ ] All 832+ tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No changes to `wiki/archive/` pages

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

- **`imported_from` backfill** — separate field with similar gap; same pattern would apply. Deferred until evidence shows `provenance-coverage` doesn't move to pass automatically once `source` is fixed
- **Typed-edge proposing in consolidation** — addresses the still-fail `edge-type-entropy: 0.30`. Highest-leverage remaining Phase 3 brief
- **Hub overload strategic decision** — what to do about `wiki/projects/agentmemory.md` accumulating 1008 inbound edges
- **`memory backfill-*` umbrella** — if more single-field backfills accumulate (`imported_from`, `confidence`, `lifecycle`), consolidate into one `memory backfill --field source` CLI surface
