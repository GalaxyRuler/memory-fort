# Memory Fort Audit and Stale-Path Cleanup Plan

Date: 2026-06-02
Repo: `C:\CodexProjects\memory-system`
Vault: `C:\Users\Admin\.memory`
Branch: `main`

This audit executed the meta-prompt in `docs/meta-prompt-fort-audit-and-cleanup.md` as far as local safety and the current runner state allowed. No vault or repo deletions were performed.

## Applied Fixes

| Area | Change | Evidence |
|---|---|---|
| Shared Claude/Codex hook parser | `runHook` now accepts a leading UTF-8 BOM before JSON parsing. | Red: `npm test -- test/hooks/error-handler.test.ts --minWorkers=1 --maxWorkers=2 --reporter=dot` failed on `accepts UTF-8 BOM-prefixed JSON payloads`; green rerun passed 13/13. Installed symlinked hook then wrote `claude-code-audit-probe-claude-code-bom.md` and `codex-audit-probe-codex-bom.md`. |
| Antigravity live hook YAML | Generated hook now writes `cwd` with `JSON.stringify(cwd)` so Windows backslashes are valid YAML. | Red: `npm test -- test/cli/commands/install-antigravity.test.ts --minWorkers=1 --maxWorkers=2 --reporter=dot` failed with `unknown escape sequence (6:10)`; green rerun passed 14/14. Reinstalled plugin with `node dist/cli.mjs install antigravity`; fixed probe parsed `cwd: "C:\\CodexProjects\\memory-system"`. |
| Repo runtime-data guard | `.gitignore` now ignores root-level vault runtime paths: `/raw/`, `/facts/`, `/wiki/`, `/embeddings/`, `/state/`, `/config.yaml`, `/log.md`. | Fresh scan found top-level repo `raw/` exists, untracked and empty. Runtime data belongs in `~/.memory`, not the source checkout. |

## Part A - Functional and Connection Audit

| Subsystem | Status | Evidence |
|---|---|---|
| Runner route for noisy validation | DEGRADED | Homelab integration is registered, but `Resolve-CodexRunnerRoute.ps1 -Class container -Json` returned no selected runner. `vps` and `whiteknight` were unhealthy; local WHITEDRAGON was allowed only for lightweight metadata and small checks. Full local 3x suite was not run. |
| Typecheck | PASS | `npm run typecheck` exited 0 with `tsc --noEmit`. |
| Prompt drift | PASS | `node scripts/check-prompt-drift.mjs` exited 0; `npm run build` also ran the prompt drift check before tsdown. |
| Package build | PASS | `npm run build` exited 0 and rebuilt `dist/cli.mjs`, `dist/dashboard/server.mjs`, hook bundles, and retrieval entries. |
| UI build | PASS | `npm run build:ui` exited 0; Vite transformed 2325 modules and wrote `dist/dashboard-ui`. |
| Focused test slice | PASS | `npm test -- test/compile/synthesize-narrative.test.ts test/compile/execute.test.ts test/dashboard/proposed.test.ts test/mcp/server.test.ts test/cli/commands/decay.test.ts test/cli/commands/migrate-to-narrative.test.ts test/cli/commands/verify/graph-cohesion.test.ts --minWorkers=1 --maxWorkers=2 --reporter=dot` passed 7 files, 67 tests. |
| Full suite 3x and `npm run test:ui` | NOT RUN | The prompt asks for noisy repeated full-suite validation. Homelab had no healthy container runner, and active WHITEDRAGON is allowed only for lightweight/small checks without explicit approval. |
| Capture to raw | PASS with fixed bugs | Claude/Codex config points at `~/.memory/claude-code-plugin/scripts/*.mjs`, which symlinks to the built hooks. Synthetic Claude, Codex, and Antigravity probes wrote raw files under `~/.memory/raw/2026-06-01/`. Two capture bugs were found and fixed as listed above. |
| VS Code and Claude Desktop capture recency | DEGRADED | `node dist/cli.mjs install antigravity` ran operator verify: VS Code extension is installed and Claude Desktop MCP entry exists, but both had warnings for no capture file from the last 24h. |
| Compress to facts | PASS with schema correction | `node dist/cli.mjs compress --plan --max-sessions 5` scanned 1408 raw sessions, planned 5, skipped 1403, failed 0, facts written 0. Source and sampled file show the live schema is `CompressedFactFile {version, sourceRawPath, sessionId, observedAt, compressedAt, facts:[CompressedFact...]}`, not the prompt's claimed top-level fact bundle. |
| Narrative consolidation | PASS | `~/.memory/wiki/projects/memory-system.md` has `version: 3`, `last_accessed: "2026-06-01"`, `source_facts`, body heading count 0, body bullet count 0. Focused `synthesize-narrative` tests passed 4/4. |
| Staged proposals | PASS | `test/dashboard/proposed.test.ts` passed 6/6, including rewrite proposal promotion that commits `.history` archive paths. `~/.memory/wiki/compile-proposed` had no current files during inspection. |
| Retrieval | DEGRADED | Temporary dashboard on `127.0.0.1:4411` returned `/api/status` 200 and CLI search returned 5 results for `memory-system narrative records`. Search was degraded because Voyage was unavailable and because an old malformed synthetic Antigravity raw file from the pre-fix probe remains in the vault. MCP search showed streams including BM25, exact, graph-spread, and metadata. |
| MCP tools | PASS with degraded search | `log_observation` wrote `raw/2026-06-01/codex-mcp-1780353709948.md`; `list_pages(type=projects)` returned 4 project pages; `read_page(projects/memory-system.md)` returned the page; `search(scope=raw,no_rerank=true)` returned 5 results in 2321 ms with Voyage-unavailable warnings. |
| Dashboard local | PASS | Temporary dashboard `/memory/api/status` returned `capabilities.writable: true`, `vaultRoot: C:\Users\Admin\.memory`, and counts `{wikiPages:241, rawObservations:1408, crystals:0}`. |
| Dashboard self-heal by deleting `dist/dashboard-ui` | NOT RUN | The prompt's `rm -rf dist/dashboard-ui` probe is a destructive recursive delete. Per repo rules, it was not run without explicit approval. `npm run build:ui` verified the UI can be built. |
| VPS dashboard mirror | FAIL from this machine | `Invoke-RestMethod http://srv1317946:4410/memory/api/status` failed with connection refused. No SSH or deploy action was attempted. |
| Sync state | DEGRADED | `config.yaml` has `sync.remote_name: vps`; `git rev-parse HEAD` equals `git rev-parse vps/main` at `955da651acd81e6a3d7bbcaee3c086a2f577d621`. Vault working tree has 53 dirty entries, so it is not clean. Operator verify warned `vault working tree has no stale uncommitted changes`. |
| `memory verify --offline --role server --json` | WARN, exit 0 | Server verify reported 13 passed, 0 failed, 2 warnings, exitCode 0. Warnings: offline dashboard skip and graph cohesion (`graph.orphan-episodic`, `graph.edge-type-entropy`, `graph.project-subgraph-density`, `graph.narrative-thread-coverage`). |
| Narrative thread coverage denominator | PASS | Source has `NARRATIVE_THREAD_WINDOW_DAYS = 30`; test `calculates narrative thread coverage over the trailing 30-day raw window` asserts `1/3` and detail text containing `trailing 30-day window`. |
| Decay lifecycle | PASS | `node dist/cli.mjs decay --plan` returned `Decay plan`, `Decayed: 0`, `Archived: 0`. Focused decay test passed 1/1 and source writes `wiki/.audit/decay-<timestamp>.md` on apply when changes exist. |
| End-to-end raw to facts to page trace | DEGRADED | Raw/facts/page chain exists for memory-system work, but the sampled live page contains stale baked metrics and commit hashes. The chain is connected, but the page needs narrative refresh rather than hand editing. |

## Part B - Stale-Path and Dead-Artifact Cleanup Plan

| Path | Category | Confidence | Evidence | Recommendation | Risk of Keeping |
|---|---|---|---|---|---|
| `docs/codex-section-patch-consolidation.md` | Archive-don't-delete | High | The live source has no `section_patch` or `PageIR` implementation; roadmap/spec mark section-patch as superseded by Phase 4.31. | Move to `docs/archive/retired/` or add a top banner: `RETIRED by Phase 4.31 narrative memory records`. | Readers may treat retired PageIR/section-patch design as current. |
| `docs/gpt-5.5-section-patch-proposal.md` | Archive-don't-delete | High | Same retired design family as above. | Archive or banner as retired. | Confuses future implementation with obsolete patch compiler architecture. |
| `docs/codex-section-patch-renderer-expansion.md` | Archive-don't-delete | High | Renderer expansion was retired with the section-patch compiler path. | Archive or banner as retired. | Suggests renderer/block expansion still exists. |
| `docs/codex-novelty-judgment.md` | Archive-don't-delete | High | Roadmap says LLM-judged novelty was retired 2026-05-31 and superseded by synthesis-first consolidation. | Archive or banner as retired. | Encourages late raw-window novelty logic that is no longer live. |
| `docs/codex-two-stage-extract.md` | Archive-don't-delete | High | Roadmap says two-stage late fact extraction was retired 2026-05-31. | Archive or banner as retired. | Encourages raw re-extraction during consolidation. |
| `docs/MEMORY-FORT-SPEC.md` | Fix-in-place, minor | Medium | Current section describes the live narrative path correctly, but header still says generated 2026-05-28 and source/test counts are stale. | Update generated date and current source/test counts after a full approved suite. | Low-grade drift undermines confidence in the spec. |
| `docs/ROADMAP.md` | Keep, no deletion | High | Fresh inspection found section-patch is listed as `Superseded 2026-06-01` and narrative records as shipped. | No fix required for section-patch wording. | Low. |
| Root `raw/` directory in repo | Safe-to-delete | High | Exists in the source checkout, is empty, and has 0 tracked files. | Delete the empty local directory when approved. `.gitignore` now prevents future root runtime data from being committed. | Empty now, but invites accidental runtime capture into the repo. |
| Root `/facts/`, `/wiki/`, `/embeddings/`, `/state/`, `/config.yaml`, `/log.md` | Fix-in-place guard complete | High | No tracked root runtime files found except the empty `raw/` dir. | Keep `.gitignore` guard added in this audit. | Without ignore rules, future accidental vault material could be staged. |
| `~/.memory/raw/2026-06-01/antigravity-audit-probe-antigravity.md` | Needs-human-decision | High | Pre-fix synthetic probe has invalid YAML `cwd: "C:\CodexProjects\memory-system"` and causes search corpus warnings. | Since this is audit-generated raw data, either archive/delete it with approval or route through an agreed raw repair policy. Do not silently rewrite real raw history. | Search stays degraded with a corpus warning until repaired or removed. |
| `~/.memory/wiki/projects/memory-system.md` | Fix through narrative pipeline | High | MCP `read_page` returned stale prose: `current HEAD at 9b28e78`, `clean Git status`, and `165/165 passing`, all contradicted by fresh repo/vault evidence. | Run `memory curate projects/memory-system.md --refresh --apply` or targeted narrative refresh after operator approval and LLM availability. | Stale baked metrics mislead future agents. |
| Vault working tree | Needs-human-decision | High | `git status --short` in `~/.memory` shows 53 dirty entries. HEAD equals `vps/main`, but working tree is dirty. | Inspect and commit/sync intended vault mutations separately; do not blanket clean. | Sync/verify remains warn, and live dashboard content can drift from remote. |
| `qa/homelab/README.md` | Keep | High | It documents project-owned Homelab profiles and aligns with `AGENTS.md`. | Keep. | None. |
| `vscode-extension/` | Needs-human-decision | Medium | Directory is tracked, has source and package files. Operator verify says extension installed but no capture in last 24h. | Keep until a VS Code capture investigation proves it is abandoned. | Premature deletion could break VS Code capture support. |
| `dist/` artifacts | Keep ignored | Medium | `dist/` is ignored and rebuilt by `npm run build`; not tracked by `git ls-files`. | Keep ignored. Do not delete as part of cleanup without explicit self-heal approval. | Low. |
| `docs/design/iteration-*/*code.html` and screenshots | Needs-human-decision | Medium | Design artifacts are numerous and historical. No source imports depend on them. | Consider archiving under `docs/archive/design/` if they no longer serve active UI review. | Repo browsing noise and size. |

## Highest-Value Cleanups

1. Refresh `~/.memory/wiki/projects/memory-system.md` through the narrative pipeline to remove stale baked metrics and commit hashes.
2. Resolve the dirty vault working tree before relying on sync status or hosted mirror parity.
3. Archive or clearly banner the five retired design docs for novelty, two-stage extract, and section-patch.
4. Remove or repair the synthetic malformed Antigravity audit raw file after human approval so search stops warning on corpus parse.
5. Approve a container/full-suite route, or explicitly approve a local noisy run, so `npm test` 3x and `npm run test:ui` can be executed without violating Homelab safety policy.
