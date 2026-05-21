# Phase 2 — Curation: Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-20-cross-tool-memory-system-design.md`
**Phase 1 tag:** `v0.1.0-phase1` (commit `31321f3`)
**Date:** 2026-05-21
**Scope:** Curation workflows — `memory compile` (raw → wiki), `memory lint` (wiki health checks), `memory page` (pretty-print a wiki page with resolved relations). NO embeddings (Phase 3). NO crystallize (Phase 4). NO scheduling (Phase 6).

**Acceptance:** With Phase 1's accumulated raw observations as input, `memory compile` produces a curated wiki — new pages in `wiki/projects/`, `wiki/lessons/`, etc. with valid frontmatter, plus an updated `index.md` and a fresh `log.md` entry. `memory lint` reports zero structural issues against a known-good fixture and catches injected issues (orphan, broken link, missing required field, contradiction). `memory page <path>` pretty-prints a page with its inbound/outbound relations resolved to titles.

---

## 1. Prompt templates (`templates/prompts/`)

The compile and lint workflows are LLM-orchestrated — the work is done by the agent in the user's current session, NOT by a separate API call. Each workflow has a structured prompt template the CLI emits to stdout (or hands to the agent via a slash-command pattern); the LLM reads the schema, reads the raws, writes the wiki updates.

Prompt templates live in the source repo at `templates/prompts/` and get copied to `~/.memory/prompts/` by `memory init` (extend the existing copy step).

### 1.1 `templates/prompts/compile.md`

Content authoring task. The compile prompt instructs the agent to:

1. Read `~/.memory/schema.md` first (the controlling document — entity types, frontmatter contract, naming rules, quality standards, ingest workflow).
2. Read `~/.memory/index.md` (current wiki catalog).
3. Read last 50 lines of `~/.memory/log.md` (recent activity, see what was already compiled).
4. Read the list of raw files to process (passed via stdin or as a marker file).
5. For each raw file:
   - Extract candidate entities (projects, people, decisions, lessons, references, tools).
   - For each candidate, check if a wiki page already exists.
   - If it exists: open with Read, append a `## [<date>] update` section if material has changed.
   - If not: only create if the cross-session signal threshold is met (per schema §6).
   - Apply privacy filter per schema §7.
6. After all raws: update `index.md` (add new pages, refresh titles).
7. Append a single `## [<timestamp>] compile | N raw → M updates, K new pages` line to `log.md`.

Anti-patterns the prompt must call out (echoing schema §10): no one-off person pages, no silent contradiction deletion, no marketing language, etc.

Output format the prompt requests from the LLM: a structured summary report (counts + page list) that the CLI can print after compile finishes.

**Estimated length:** ~250-300 lines of markdown including instructions, examples, and the structured summary format spec.

### 1.2 `templates/prompts/lint.md`

The lint prompt instructs the agent to:

1. Scan all `wiki/**/*.md` files.
2. For each, check:
   - Frontmatter validity (per the frontmatter contract from schema §3).
   - Required fields present (type, title, created, updated, status).
   - `relations:` keys are known edge types (uses, depends_on, supersedes, contradicts, caused_by, fixed_by, derived_from, mentioned_in, linked).
   - Cross-references resolve (target page exists for each `[[wikilink]]` and each `relations.<key>` entry).
   - Status consistency (no `status: active` page with `updated > 180 days ago`).
   - `confidence < 0.5` flagged as DRAFT.
3. Build a `lint-report.md` with sections:
   - Broken links
   - Orphan pages (no inbound links AND no inbound `relations:` references)
   - Stale pages (active + updated long ago)
   - Contradictions (pages with `relations.contradicts` pointing at extant pages — both directions, unresolved)
   - Frontmatter validation errors
   - Low-confidence drafts
4. Write report to `~/.memory/lint-report.md`.
5. Append summary to `~/.memory/log.md`.

**Estimated length:** ~200-250 lines.

---

## 2. Frontmatter validation strengthening (`src/storage/frontmatter.ts`)

Phase 1's `validateFrontmatter` did lightweight validation (required fields, known type, ISO 8601 dates, known status). Phase 2 extends it to validate:

1. `relations:` keys are restricted to the 9 known edge types from schema §5 (no arbitrary keys).
2. `relations:` values are arrays of strings (page paths).
3. `confidence` if present is a number 0..1.
4. `tags` if present is an array of strings.
5. `schema_version` if present on the schema.md itself matches the source repo's expected version (deferred — log.md migration in Phase 6).

This is the foundation that `memory lint` builds on — lint runs frontmatter validation as one of its passes.

The existing `validateFrontmatter` signature stays the same; the implementation adds the new checks. Existing Phase 1 tests for the basic checks must continue to pass.

---

## 3. `src/cli/commands/compile.ts`

Orchestrator for the compile workflow. NOT the LLM — the LLM is the user's agent in their active session.

```typescript
export interface CompileOptions {
  /** Process raw files since this date (ISO 8601). Default: since last compile per log.md. */
  since?: string;
  /** Limit to a specific scope (project name, tag). */
  scope?: string;
  /** Print the prompt and exit without invoking the LLM (for testing the prompt). */
  printPrompt?: boolean;
  /** For tests — inject a "current-time" date. */
  now?: Date;
}

export interface CompileResult {
  rawFilesProcessed: number;
  promptEmitted: boolean;
  promptBytes: number;
}

/**
 * Phase 2 compile is "emit a prompt to stdout for the active
 * agent to execute." The agent reads the prompt, reads schema +
 * raws + index, writes wiki updates + updated index.md + log.md
 * entry directly via its file-write tools. The CLI orchestrator
 * just builds the prompt with the right context.
 *
 * Phase 6 will add a `--batch` mode that calls a frontier LLM
 * API directly for unattended scheduled compile runs.
 */
export async function runCompile(opts: CompileOptions = {}): Promise<CompileResult>;
```

**What `memory compile` actually does:**

1. Read `~/.memory/schema.md` (the controlling document).
2. Read `~/.memory/index.md`.
3. Read last 50 lines of `~/.memory/log.md`.
4. Enumerate raw files in `~/.memory/raw/<date>/` since the `--since` cutoff (or the date of the last `compile` line in log.md).
5. Read each raw file (concatenated input, truncated per file to ~10KB if very long).
6. Load the compile prompt template from `~/.memory/prompts/compile.md`.
7. Substitute variables: `{{schema_content}}`, `{{index_content}}`, `{{recent_log_lines}}`, `{{raw_files_list}}`, `{{raw_content}}`.
8. Print the fully-substituted prompt to stdout.
9. Exit 0.

The user's agent then sees this on its terminal (when run as `node dist/cli.mjs compile`) and executes the instructions — using its own Read/Write/Edit tools to modify wiki pages.

For `--print-prompt`: same as default but with a header comment explaining "paste this into your agent." (`--print-prompt` and default are similar; the flag exists for clarity in scripted use.)

---

## 4. `src/cli/commands/lint.ts`

Lint has two modes:

**Mode 1 (default): LLM-orchestrated.** Same pattern as compile — emit the lint prompt to stdout. The agent reads it, scans the wiki, writes `lint-report.md`.

**Mode 2 (`--checks-only`): direct programmatic checks.** Frontmatter validation, broken link detection, orphan detection — all pure functions over filesystem reads. No LLM needed. Faster and deterministic; runs in CI without burning tokens.

```typescript
export interface LintOptions {
  /** Run programmatic checks only (no LLM prompt). */
  checksOnly?: boolean;
  /** Limit to a specific scope. */
  scope?: string;
  /** For tests. */
  now?: Date;
}

export interface LintResult {
  mode: "llm" | "checks-only";
  /** When checks-only, the detected issues. */
  issues?: LintIssue[];
  /** When LLM mode, the prompt emitted. */
  promptEmitted?: boolean;
  promptBytes?: number;
}

export interface LintIssue {
  category: "broken-link" | "orphan" | "stale" | "contradiction" | "frontmatter" | "draft";
  page: string;
  message: string;
  suggestion?: string;
}
```

The programmatic checks are exposed as pure functions in `src/curation/checks.ts` (testable in isolation). The LLM mode wraps them with judgment (e.g., "is this contradiction worth flagging or is it intentional?").

`memory lint` (no flags) defaults to LLM mode. `memory lint --checks-only` runs the pure checks.

**Programmatic checks to implement in Phase 2:**

| Check | What it returns |
|---|---|
| Frontmatter validation | One issue per page with invalid frontmatter (missing required, bad type, bad date format) |
| Broken `[[wikilinks]]` | One issue per unresolved inline link |
| Broken `relations:` targets | One issue per `relations.<key>` entry whose page doesn't exist |
| Orphan pages | One issue per page with zero inbound references (links + relations) |
| Stale pages | One issue per `status: active` page with `updated > 180d ago` |
| DRAFT pages | One issue per `confidence < 0.5` page |

---

## 5. `src/cli/commands/page.ts`

Reads a wiki page, parses frontmatter, resolves `relations:` and `[[wikilinks]]` to their target titles, prints a formatted view.

```typescript
export interface PageOptions {
  path: string;  // relative under wiki/ or absolute
}

export interface PageResult {
  frontmatter: Frontmatter;
  body: string;
  outboundRelations: Array<{ type: string; target: string; targetTitle: string | null }>;
  inboundRelations: Array<{ from: string; type: string }>;
  outboundLinks: Array<{ target: string; targetTitle: string | null }>;
}
```

Output format:

```
# <title> (wiki/projects/agentmemory.md)

Type:       projects
Status:     active
Updated:    2026-05-21
Tags:       windows, stability
Confidence: 0.9

Outbound relations:
  uses → typescript ("TypeScript")
  depends_on → iii-engine ("iii-engine")
  fixed_by → lessons/windows-stale-ports ("Windows stale ports")

Inbound references (computed by scanning all wiki pages):
  ← projects/lisan-studio (uses)
  ← decisions/2026-05-20-relocate-agentmemory (mentioned_in)

---

<body content with [[wikilinks]] preserved>
```

This is a programmatic command (no LLM). It scans `wiki/**/*.md` to build the inbound-reference index, then renders.

---

## 6. CLI wiring (src/cli.ts)

Replace stub registrations with real handlers for `compile`, `lint`, `page`:

```typescript
program
  .command("compile")
  .description("Distill raw observations into curated wiki pages (emits prompt for current agent)")
  .option("--since <date>", "Process raw files newer than this ISO date (default: since last compile)")
  .option("--scope <name>", "Limit to a specific scope")
  .option("--print-prompt", "Print prompt with explanatory header (same content)")
  .action(async (opts) => { ... });

program
  .command("lint")
  .description("Check wiki for contradictions, orphans, broken links, stale claims, frontmatter errors")
  .option("--checks-only", "Run programmatic checks; skip LLM judgment pass")
  .option("--scope <name>", "Limit to a specific scope")
  .action(async (opts) => { ... });

program
  .command("page <path>")
  .description("Pretty-print a wiki page with resolved relations and inbound references")
  .action(async (path) => { ... });
```

---

## 7. Tests

| File | Coverage |
|---|---|
| `test/storage/frontmatter-phase2.test.ts` | Extended validateFrontmatter — relations keys/values, confidence range, tags type |
| `test/curation/checks.test.ts` | Each programmatic check in isolation: 1-2 fixture cases per check |
| `test/cli/commands/compile.test.ts` | Builds prompt with substituted variables; respects --since; lists correct raw files |
| `test/cli/commands/lint.test.ts` | Default mode emits prompt; --checks-only mode returns LintIssue[] |
| `test/cli/commands/page.test.ts` | Resolves relations to titles; computes inbound references; handles missing pages gracefully |
| `test/cli/commands/init-prompts.test.ts` | `memory init` now copies prompts/ into ~/.memory/ alongside schema.md |

Total target: ~30 new tests, bringing total to ~210 (178 + ~30).

---

## 8. Docs updates

- Update `docs/cli.md` to move `compile`, `lint`, `page` from the stubs section to the implemented section.
- Add a new `docs/curation-workflow.md` — explains the compile + lint loop, when to run each, what the LLM is responsible for vs what the CLI does.
- Update `docs/architecture.md` if the LLM-orchestration model needs more explanation than it currently has.
- Move resolved follow-ups (none new expected for Phase 2 if everything goes clean) but capture any discovered.

---

## 9. Implementation order

| # | Step | Acceptance |
|---:|---|---|
| 1 | **Schema-update step.** Update schema.md template if needed to clarify Phase 2's expected wiki growth pattern. Probably no changes needed — schema is forward-compatible. | Schema unchanged or one small clarification |
| 2 | Frontmatter validation strengthening (§2). Update `validateFrontmatter` to check relations / confidence / tags. Existing tests still pass; new tests cover new validations. | All Phase 1 + new validations |
| 3 | **Prompt templates** (§1) — I (Claude) author `templates/prompts/compile.md` and `templates/prompts/lint.md` directly. Content authoring, not code. | Both templates exist with the structure described in §1.1, §1.2 |
| 4 | Programmatic check functions (§4 Mode 2). Pure functions in `src/curation/checks.ts` + tests. | All 6 checks return correct issues against fixtures |
| 5 | `memory init` extended to copy `templates/prompts/` into `~/.memory/prompts/` (alongside schema.md). | After re-init, `~/.memory/prompts/compile.md` and `lint.md` exist |
| 6 | `memory compile` CLI subcommand (§3) — builds the prompt and prints to stdout. | `memory compile` outputs the substituted prompt; agent can execute |
| 7 | `memory lint` CLI subcommand (§4) — default LLM mode + `--checks-only` mode. | Both modes work as described |
| 8 | `memory page` CLI subcommand (§5). | Pretty-prints with resolved relations |
| 9 | Documentation updates (§8) | All docs updated; new curation-workflow.md added |
| 10 | **CHECKPOINT — real compile run.** Run `memory compile` from a real Claude Code session (or paste-into-agent pattern); inspect the resulting wiki updates. If the prompt produces garbage wiki pages, tune the template and retry. | Real raw observations → at least one new curated wiki page; index.md updated; log.md entry appended |
| 11 | Tag `v0.2.0-phase2` + release note | Tag exists |

**Effort estimate:** 8-12 Codex prompts (Claude does steps #1, #3, #9 directly).

---

## 10. Phase 2 acceptance gate

- [ ] `npm run test`: `0 failed | <total> passed | 0 skipped | 0 todo` with total ≥ 200
- [ ] `npm run build`: zero errors
- [ ] `memory compile` produces a syntactically correct prompt (passes a "prompt smoke test" that inspects the structure)
- [ ] `memory compile` run end-to-end via a real Claude Code session against Phase 1's raw data produces ≥ 1 new wiki page with valid frontmatter
- [ ] `memory lint --checks-only` against a known-good fixture wiki reports 0 issues
- [ ] `memory lint --checks-only` against a fixture wiki with injected issues (1 broken link, 1 orphan, 1 stale, 1 bad frontmatter) reports exactly those 4 issues, no false positives
- [ ] `memory page <path>` resolves outbound relations and computes inbound references correctly
- [ ] `errors.log` clean after Phase 2 work
- [ ] Tag `v0.2.0-phase2` exists on main
- [ ] All commits authored as `GalaxyRuler <aoa@live.ca>`
- [ ] No OneDrive paths touched

---

## 11. Out of scope for Phase 2

- Embedding-based retrieval (Phase 3)
- Voyage Rerank / HyDE (Phase 3)
- Graph query MCP tools (Phase 3)
- Crystallize workflow (Phase 4)
- Migration from agentmemory (Phase 5)
- Scheduled-task compile / lint (Phase 6)
- Implicit graph extraction during compile (Phase 6 opt-in)
- Auto-detecting "should compile" based on raw/ size

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The compile prompt template produces low-quality wiki pages (LLM-dependent) | The CHECKPOINT step #10 verifies real output. If quality is bad, iterate on the template. The prompt is markdown — easy to revise without code changes. |
| LLM ignores parts of the prompt (e.g., skips the privacy filter step) | The schema.md is also injected into the prompt; the LLM has the rules. Mitigate by making the prompt explicit and short. |
| Compile creates duplicate pages on re-run (idempotency) | Prompt explicitly says "check if page exists; update if so". Plus lint will catch orphans/duplicates after the fact. |
| Lint's `--checks-only` mode produces false positives on edge cases | Test against fixture wikis with known-good and known-bad cases. |
| `memory page` is slow on large wikis because it scans all pages to compute inbound refs | At Phase 2 scale (~100 pages) it's fine. Phase 3+ can add an index if needed. |
| The wiki page format the LLM produces doesn't match the schema's expectations | The schema.md is the controlling doc — the LLM reads it before writing. Validation runs after compile via lint. |

---

## 13. Implementation handoff

Each step in §9 maps to a Codex prompt per `feedback_codex_prompts` conventions. Steps #1, #3, #9 are content authoring (Claude direct). Steps #2, #4-8, #10 are Codex implementation work.

The plan ships as committed before any Codex prompts go out (so all references are stable).

---

This plan picks up where Phase 1 (`v0.1.0-phase1`) ended. Branch stays `main`; no need to fork.
