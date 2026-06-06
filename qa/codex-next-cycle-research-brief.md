# CODEX BRIEF — Next Development Cycle: Deep Research Prompt Generator

**Branch:** `feat/next-cycle-research` off `main` (`2a67f57`). No merge.  
**Output:** one file — `docs/next-cycle-gpt-prompt.md` — containing a ready-to-paste prompt for GPT-5.5 Pro.  
**Do not implement any features.** Research + synthesis only.

---

## What Codex must do

### Step 1 — Full codebase audit (read-only)

Read and internalize the following. Build a structured mental model before writing anything.

**Package identity**
- `package.json`: name, version, description, bin aliases, scripts, dependencies
- `README.md`: why/quickstart/architecture/supported tools/comparison table/roadmap sections

**CLI surface** (`src/cli.ts` + `src/cli/commands/`)
- List every registered command with its description and key options
- Note which commands are stubs vs fully implemented
- Note which are hidden/dev-only

**Install integrations** (`src/cli/commands/install/`)
- One file per tool: `claude-code.ts`, `codex.ts`, `antigravity.ts`, `hermes.ts`, `pi.ts`, `openclaw.ts`, `claude-desktop.ts`, `vscode.ts`
- For each: what gets installed (hooks, MCP entry, sentinel block, JSON patch), what gets wired, what uninstall does

**Capture pipeline** (`src/capture/`, `src/hooks/`)
- Hook scripts: `prompt-submit`, `post-tool-use`, `pre-compact`, `session-end`, `session-start`
- What each captures, where it writes, payload shape
- `auto-link.ts` — what it does post-capture

**Sniffer / backfill system** (`src/sniffers/`, `src/cli/commands/backfill.ts`, `src/cli/commands/backfill-source.ts`)
- What sniffers exist (`claude-code.ts`, `claude-desktop.ts`)
- How `runSniffer` works, what `runBackfill` produces
- What sources are missing (no Codex sniffer? no Hermes sniffer?)

**Retrieval stack** (`src/retrieval/`)
- Files: `bm25.ts`, `exact.ts`, `graph.ts`, `metadata-score.ts`, `corpus.ts`, `embeddings-store.ts`, `rrf.ts`, `rerank.ts`, `hyde.ts`, `search.ts`, `refresh.ts`, `rebless.ts`, `voyage-client.ts`
- Understand the full pipeline: corpus → BM25 + exact + graph + metadata → RRF → rerank (Voyage) → HyDE expansion
- Note what's in `voyage-client.ts` — Voyage 4 large, rerank-2.5

**Storage layer** (`src/storage/`)
- `paths.ts` — vault layout, env vars
- `config.ts` — what config keys exist, defaults
- `frontmatter.ts` — parse/serialize
- `atomic-write.ts` — write durability

**Curation** (`src/compile/`, `src/cli/commands/compile.ts`, `src/cli/commands/lint.ts`)
- How `memory compile` works: raw → facts → synthesize → wiki page narrative records
- Confidence tiers, novelty judgment, contradiction detection
- `memory lint` checks: frontmatter, broken links, relations, orphans, stale, drafts

**Dashboard** (`src/dashboard/`, `src/dashboard-ui/`)
- Server endpoints: what `/api/*` routes exist
- React SPA routes: overview, search, wiki browse, raw browse, sessions, graph, audit, settings, crystals
- Galactic 3D graph: `three.js`, force/clustered/constellation/orbital/timeline modes
- What's missing or placeholder in the UI

**Verify + health** (`src/cli/commands/verify.ts`, `src/cli/commands/verify-schedule.ts`)
- What `memory verify` checks (hook paths, capture watchdog, dashboard health, graph participation, orphan rate)
- What roles exist

**Sync** (`src/sync/`, `src/cli/commands/pull.ts`, `src/cli/commands/push.ts`)
- Current sync model — git-based push/pull
- What `auto-commit-raws.ts` and `auto-push-worker.ts` do

**Templates** (`templates/`)
- `config.yaml` — all knobs
- `schema.md` — 12 sections, what they control
- `prompts/compile.md`, `prompts/lint.md` — LLM prompt templates
- `prompts/hyde.md` — HyDE expansion prompt

**Tests** (`test/`)
- Scan directories: which subsystems have coverage, which don't
- Note any `TODO`, `skip`, `xit`, or `fixme` markers

**Known roadmap** (from `README.md` Roadmap section + `docs/ROADMAP.md` if present)
- What's listed as planned
- What's deferred to v1.1

**Competitive context** (from `README.md` comparison table)
- mem0, Zep/Graphiti, Letta, Cognee, LangMem, OMEGA
- Where memory-fort is strong vs weak on each dimension

**Open gaps** — while reading, note:
- Commands that are stubs with no implementation
- Sniffers that don't exist yet (Codex, Hermes, Pi, OpenClaw, Antigravity sniffers)
- Features mentioned in code comments as TODO
- Things the comparison table shows competitors have that memory-fort lacks
- UX flows that feel incomplete (onboarding, first-run, compile workflow)
- Any `FIXME`, `TODO`, `@deprecated`, or `throw new Error("not implemented")` in src/

---

### Step 2 — Synthesize findings into a structured state-of-the-project summary

Before writing the GPT prompt, produce an internal summary (as a comment block at the top of the output file, prefixed with `<!--` and `-->`) covering:

```
CURRENT STATE SUMMARY (internal, not part of GPT prompt)
- Version: 0.1.2
- Commands implemented (list)
- Commands stubbed (list)
- Sniffers implemented vs missing
- Retrieval stack completeness
- Dashboard completeness
- Test coverage gaps
- Known technical debt (top 5)
- Competitive gaps (top 5)
- Roadmap items already queued
```

---

### Step 3 — Write the GPT-5.5 Pro prompt

Write it as a self-contained, detailed prompt that GPT-5.5 Pro can execute with no prior context about memory-fort.

The prompt must instruct GPT-5.5 Pro to:

1. **Understand the project** from the embedded context you provide (paste the key facts from your audit — don't make GPT guess)

2. **Research externally** across these dimensions:
   - Agent memory landscape 2026: what are the real pain points users are reporting with mem0, Zep, Letta, LangMem? (Reddit, HN, GitHub issues, Discord)
   - MCP ecosystem: what tools are gaining adoption? what do users want from MCP memory servers?
   - Local-first AI tooling trends: what's the appetite for offline/private memory vs cloud?
   - Multi-agent memory: how are people sharing memory across agents in 2026? What patterns are emerging?
   - Embedding models: is Voyage still the best local-friendly option? What's changed?
   - Knowledge graph patterns: what graph schemas are working for agent memory?
   - OpenCode, Cursor, Windsurf, Zed — do they have memory hooks? Is there a gap memory-fort could fill?

3. **Evaluate memory-fort's position** against research findings — where is it uniquely strong, where does it lag, where is the market moving?

4. **Propose a v1.1 development cycle plan** with:
   - **Theme** (one sentence: what is v1.1 *about*?)
   - **Must-have features** (≤5, each with: problem it solves, estimated effort S/M/L, why now)
   - **Should-have features** (≤5, same format)
   - **Deferred** (what to explicitly NOT do in v1.1, and why)
   - **Technical debt to pay first** (top 3 things that will block everything else if not fixed)
   - **Success metrics** (how do we know v1.1 shipped well?)
   - **Risks** (top 3 things that could derail the cycle)

5. **Output format**: structured markdown with clear sections. No fluff. Cite sources inline where researched claims are made.

**The GPT prompt must embed** (not reference — actually paste in):
- The full list of current commands with implementation status
- The full list of supported tools and their integration type
- The comparison table from the README
- The current roadmap items
- The top 5 technical debt items you found
- The top 5 competitive gaps you found

The goal: GPT-5.5 Pro should be able to produce a complete, actionable v1.1 plan without asking any follow-up questions.

---

### Output

Write to: `docs/next-cycle-gpt-prompt.md`

Structure:
```
<!-- INTERNAL AUDIT SUMMARY
... your state-of-project notes ...
-->

# Prompt for GPT-5.5 Pro: memory-fort v1.1 Development Cycle Planning

[the full self-contained prompt, ready to paste]
```

Commit: `research: generate GPT-5.5 Pro prompt for v1.1 cycle planning`  
Push to `origin feat/next-cycle-research`. Do NOT merge.

Gates: file exists, >300 lines, both sections present (internal summary + GPT prompt).
