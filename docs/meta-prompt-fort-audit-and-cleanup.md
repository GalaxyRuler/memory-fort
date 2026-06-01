# Meta-Prompt — Memory Fort Full Audit + Stale-Path Cleanup

> Paste this into GPT Pro (to reason + produce a Codex brief) **or** directly into Codex 5.5.
> It produces two deliverables: (A) a functional/connection audit **report**, and (B) a categorized **deletion plan** for stale paths. It does **not** delete anything — deletions are proposed for human review (no permanent deletions without confirmation).

---

You are a senior TypeScript/systems auditor. Audit **Memory Fort** (`@galaxyruler/memory-system`) end-to-end and produce a stale-path cleanup plan. Verify every claim by reading the artifact or running the command — never assert from file names or memory. Read the final bytes/responses, not exit codes or counts.

## Project facts (verify, don't trust)

- **Repo:** `C:\CodexProjects\memory-system` — TypeScript ESM, Node 24, tsdown build, Vitest. Branch `main`.
- **Vault (canonical, separate from repo):** `C:\Users\Admin\.memory` — markdown + git, also an Obsidian vault. Backed up to git remote `vps` (`srv1317946`, read-only hosted dashboard on port 4410).
- **Capture clients:** Claude Code, Codex (desktop+CLI), Antigravity — hooks + MCP server (`log_observation`, `read_page`, `list_pages`, `search`).
- **Pipeline:** capture → `raw/<date>/<tool-session>.md` (in the VAULT, not the repo) → `memory compress` → importance-scored facts in `facts/` → `synthesizeNarrative` (two-stage Detect+Synthesize) → **narrative memory records** in `wiki/` → 6-stream RRF retrieval (BM25 + Voyage embeddings + graph + metadata) → dashboard.
- **Current architecture (4.31+):** knowledge pages are **narrative records** — frontmatter + ONE prose body, no `##` sections / no `-` bullets in body. The LLM writes only prose; **code owns** `version`/`supersedes`/`strength`/`last_accessed`/`source_facts`. Frontmatter-owned, supersede-don't-patch, `.history/` archival.
- **Secrets:** env-var only (`OPENROUTER_API_KEY`, `VOYAGE_API_KEY`) — never in config.yaml/UI/API/logs.

## Known-retired designs (their briefs in `docs/` are now historical — the CODE is gone)
- 4.26 LLM-judged novelty (`codex-novelty-judgment.md`)
- 4.27 two-stage late extract (`codex-two-stage-extract.md`)
- **4.29 section-patch compiler** (`codex-section-patch-consolidation.md`, `gpt-5.5-section-patch-proposal.md`) — PageIR/planner/renderer/patch-compiler, all retired by 4.31
- **4.30 renderer block expansion** (`codex-section-patch-renderer-expansion.md`) — retired by 4.31
- Confirmed already deleted from `src/`: `parse-pageir.ts`, `extract-claims.ts`, `planner.ts`, `renderer.ts`, `patch-compiler.ts`, `validate-patch.ts`.

---

## PART A — Functional + connection audit

Verify each subsystem **works and connects to its neighbors**. For each: state PASS/FAIL/DEGRADED with the exact evidence (command output, file bytes, HTTP response).

1. **Build + suite.** `npm run typecheck`, `npm run build`, `npm run build:ui`, `node scripts/check-prompt-drift.mjs`, `npm test`, `npm run test:ui`. Report file/test counts. Run the full suite **3×** and report any flake (a known class was wall-clock timing + real-`~/.vscode` writes — confirm both stay green).
2. **Capture → raw.** Confirm all 3 clients' hook handlers exist and fire: Claude Code (`~/.memory/claude-code-plugin/`), Codex (`~/.codex/config.toml` blocks), Antigravity (`~/.gemini/antigravity/plugins/memory/hooks/*.mjs`, underscore-named). Trigger each handler with a synthetic payload; assert a `raw/<today>/<tool>-*.md` file is written.
3. **Compress → facts.** `memory compress --plan` (report uncompressed count). Read one `facts/<date>/*.json` and confirm the importance-scored schema `{title, facts[], narrative, concepts[], files[], importance 1-10}`.
4. **Consolidate (narrative records).** Run `synthesizeNarrative` (or `memory curate <page> --refresh --apply`) on a test page. Read the final page **bytes**: assert body has **0** `^##` headings, **0** `^- ` bullets; frontmatter `version` incremented; prior archived under `wiki/.history/`. Confirm stale-claim replacement works (a "planned"→"shipped" style flip integrates, no `Additional Information` appendix, no workflow noise like `Subagent`/`Target: Codex`/git-hashes).
5. **Staged proposals.** Confirm `stageNarrativeReview` emits a `rewrite_page` fenced compile-op (not raw JSON) and that `wiki/compile-proposed/` promotion succeeds against a durable knowledge page (the earlier "knowledge-page update requires narrative synthesis" bug must not recur). Verify promotion commits the `.history` archive (touchedPaths).
6. **Retrieval.** `memory search "<query>"` — assert ≥1 result, report latency and which streams fired (BM25 always; Voyage only if `VOYAGE_API_KEY` set — DEGRADED-without-key is acceptable, state it).
7. **MCP server.** Exercise `log_observation`, `read_page`, `list_pages`, `search`. Confirm `read_page`/`search` bump `last_accessed` without a `version` bump or `.history` write.
8. **Dashboard.** `memory dashboard --no-open` → `/memory/api/status` 200, `capabilities.writable: true`, vault root correct. Confirm self-heal: `rm -rf dist/dashboard-ui && memory dashboard` rebuilds UI and serves 200. Confirm VPS mirror at `:4410` is read-only and returns 200.
9. **Sync.** Confirm `config.yaml` `sync.remote_name: vps`; vault local HEAD == `vps/main`. Confirm `memory verify` git/sync check passes.
10. **Verify suite.** `memory verify --offline --role server --json` — exit 0, list every check status. Confirm only honest warns remain (offline dashboard skip, `graph.narrative-thread-coverage` windowed %, `graph.project-subgraph-density`). The narrative-thread-coverage metric must use the **30-day trailing window** (not all-time denominator).
11. **Decay / lifecycle.** `memory decay --plan` runs; confirm strength-decay + archive logic exists and is bounded.
12. **End-to-end connection trace.** Pick ONE real recent raw session and trace it forward: raw → fact bundle → (if consolidated) the narrative page that absorbed it → retrievable via search. Report any break in the chain.

## PART B — Stale-path / dead-artifact cleanup plan

Produce a **categorized deletion plan**. Do **NOT** delete anything — output a table the human approves. For every candidate give: path, category, evidence it's stale, and risk-of-keeping.

Scan for:

1. **Retired-design docs that read as current.** The ~70 `docs/codex-*.md` are mostly historical phase briefs — that is fine as an archive. But flag any that **describe retired architecture as if live** (section-patch 4.29/4.30, novelty 4.26, two-stage 4.27). Recommend: either move all historical briefs to `docs/archive/` (preferred — preserves history, removes confusion) or annotate each retired one with a `> RETIRED by Phase 4.31` banner at the top. Do **not** silently delete design history.
2. **Spec/roadmap drift.** Read `docs/MEMORY-FORT-SPEC.md` and `docs/ROADMAP.md`. They reference section-patch (4.29/4.30). Flag every passage that states a retired design as current; propose the corrected text (narrative-records is the live consolidation design).
3. **Orphaned source/tests.** Find any `src/` or `test/` file that imports a now-deleted module, references `section_patch`/`PageIR`/`replace_section_body`, or is never imported/run. Use the build + a dependency scan; list dead exports.
4. **Stray runtime data in the repo.** There is a `raw/` directory **inside the repo** — raw observations belong in the VAULT (`~/.memory/raw/`), not the source repo. Determine whether repo-`raw/` is test fixtures (keep, document) or stray captured data (propose removal + add to `.gitignore`). Same check for any `wiki/`, `facts/`, `embeddings/`, `log.md`, `state/` accidentally committed to the repo.
5. **Stale wiki content in the vault.** The live page `wiki/projects/memory-system.md` contains stale facts (e.g. "current HEAD at 9b28e78", "165/165 passing") baked into prose from an old compile. Flag stale baked-in metrics/commit-hashes in any knowledge page; recommend they be re-synthesized or relinked (do not hand-delete vault content — route through the narrative pipeline).
6. **Duplicate/oldpath dirs.** Flag `.prev` bundles on the VPS, `*.original.md` backups, abandoned top-level dirs (`qa/`, `vscode-extension/` — confirm each is still wired or dead), and any `dist/` artifacts tracked in git that should be gitignored.
7. **Dead config/flags.** Scan `config.yaml`, `package.json` scripts, and CLI commands for options referencing retired features.

## Rules
- **Verify by reading the artifact or running the command.** No claim from file names alone.
- **No deletions.** Part B is a *plan*; the human deletes. Never `rm` vault content or design-history docs.
- **Don't break the 4.31 invariant** (narrative bodies: no headings/bullets) when fixing any page.
- **Secrets stay env-var-only** — flag any leak into config/logs/docs as a finding.
- **Categorize by confidence:** Safe-to-delete / Archive-don't-delete / Fix-in-place / Needs-human-decision.
- Output Part A as a status table (subsystem · status · evidence) and Part B as a deletion-plan table (path · category · evidence · recommendation). End with the top 5 highest-value cleanups ranked.

Commit author `GalaxyRuler <aoa@live.ca>`, Co-Authored-By Claude Opus 4.8 <noreply@anthropic.com>. Any fixes you *do* make (Part A bugs, spec corrections) go in separate, conventional commits; the deletion plan itself is committed as a doc, executed only after human approval.
