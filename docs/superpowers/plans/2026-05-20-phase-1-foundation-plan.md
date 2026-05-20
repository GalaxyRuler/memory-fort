# Phase 1 — Foundation: Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-20-cross-tool-memory-system-design.md` (commit `212fbc3`)
**Date:** 2026-05-20
**Scope:** Storage layout + Claude Code hooks + minimal CLI (`init`, `install`, `stats`). NO MCP. NO embeddings. NO compile/lint/crystallize. NO Codex or Antigravity wiring yet.
**Acceptance (from spec §14 Phase 1):** Hooks fire on Claude Code session activity; raw files appear under `~/.memory/raw/<date>/`; `memory stats` reports counts; `errors.log` exists and is empty after a successful session.

---

## 1. Repository scaffolding

### 1.1 Project root

Location: `C:\CodexProjects\memory-system\` (already initialized as git repo with the spec committed).

Branch: `main` (single-branch flow until plan steps justify branching).

Author identity for commits: `GalaxyRuler <aoa@live.ca>`.

### 1.2 `package.json`

```json
{
  "name": "@galaxyruler/memory-system",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Cross-tool memory system: Claude Code + Codex + Antigravity → unified ~/.memory/ wiki",
  "scripts": {
    "build": "tsdown",
    "test": "vitest run",
    "test:watch": "vitest",
    "memory": "node dist/cli.mjs"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "commander": "^12",
    "gray-matter": "^4",
    "js-yaml": "^4"
  },
  "devDependencies": {
    "typescript": "^5",
    "tsdown": "^0.6",
    "vitest": "^2",
    "@types/node": "^20",
    "@types/js-yaml": "^4"
  }
}
```

**Rationale:** Minimal deps. `gray-matter` for YAML frontmatter read; `js-yaml` for write (gray-matter doesn't expose write cleanly). `commander` for CLI parsing — same library family the existing agentmemory uses, proven on the user's Windows. `tsdown` for the build (matches agentmemory's toolchain per spec §12). No HTTP client, no DB, no daemon library.

### 1.3 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### 1.4 `vitest.config.ts`

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    // Slice 5 lesson: unambiguous totals output
    outputFile: undefined,
  },
});
```

### 1.5 `.gitattributes` — slice 4 lesson applied from day one

```
*.mjs text eol=lf
*.cjs text eol=lf
*.ts  text eol=lf
*.md  text eol=lf
*.json text eol=lf
*.yaml text eol=lf
```

### 1.6 `.gitignore`

```
node_modules/
dist/
*.tsbuildinfo
coverage/

# Memory runtime artifacts that should never be in the source repo
~/.memory/  # symbolic — not actually under repo, but documents intent
.archive/
errors.log
```

### 1.7 `README.md` (stub)

Brief 1-page introduction: what the system does, link to the spec, Phase 1 quickstart (one paragraph).

---

## 2. Storage primitives (`src/storage/`)

These are pure helpers — no I/O orchestration, just the building blocks the rest of the system uses.

### 2.1 `src/storage/paths.ts`

Centralized path resolution. **Every path in the system goes through this module** — no ad-hoc `path.join` calls elsewhere. Mirrors the slice 3 lesson: extract decision logic to a pure function for testability.

**Exports:**
```typescript
export function memoryRoot(): string;                              // resolves ~/.memory/ → absolute
export function schemaPath(): string;                              // ~/.memory/schema.md
export function indexPath(): string;                               // ~/.memory/index.md
export function logPath(): string;                                 // ~/.memory/log.md
export function errorsLogPath(): string;                           // ~/.memory/errors.log
export function configPath(): string;                              // ~/.memory/config.yaml
export function rawDir(date?: Date): string;                       // ~/.memory/raw/<YYYY-MM-DD>/
export function rawSessionFile(tool: ToolName, sessionId: string, date?: Date): string;
export function wikiDir(category?: PageType): string;              // ~/.memory/wiki/<category>/
export function crystalsDir(): string;
export function scriptsDir(): string;                              // ~/.memory/scripts/ (where hook scripts get symlinked)
export type ToolName = "claude-code" | "codex" | "antigravity";
export type PageType = "projects" | "people" | "decisions" | "lessons" | "references" | "tools" | "slots";
```

**Implementation notes:**
- `memoryRoot()` reads env var `MEMORY_ROOT` first, falls back to `path.join(os.homedir(), ".memory")`. Tests use the env var to redirect to a temp dir.
- All returned paths are absolute and use forward-slash internally (Node.js path module handles cross-platform translation; we standardize internally).
- Date formatting always ISO 8601 (`YYYY-MM-DD`), never locale-dependent.

### 2.2 `src/storage/atomic-write.ts`

All file writes go through atomic rename to prevent torn writes.

**Exports:**
```typescript
export async function atomicWrite(absolutePath: string, content: string): Promise<void>;
export async function atomicAppend(absolutePath: string, content: string): Promise<void>;
```

**Implementation:**
- `atomicWrite`: write to `<path>.tmp`, fsync, rename to `<path>`. Replaces existing file atomically.
- `atomicAppend`: simpler — `fs.appendFile` (Node's append is atomic for small writes; for >4KB chunks we still use append because torn-append is rarer than torn-overwrite and the consequence is benign for log-style files).
- Both ensure parent dir exists via `fs.mkdir` with `recursive: true`.

### 2.3 `src/storage/frontmatter.ts`

YAML frontmatter read/write. Wraps `gray-matter` for read and `js-yaml` for write.

**Exports:**
```typescript
export interface Frontmatter {
  type: PageType | "crystal" | "raw-session";
  title: string;
  created: string;   // ISO 8601 date
  updated: string;
  status?: "active" | "archived" | "superseded";
  confidence?: number;
  source?: ToolName | "manual" | "crystal";
  session?: string;
  relations?: Record<string, string[]>;
  tags?: string[];
  [key: string]: unknown;
}

export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string };
export function serializeFrontmatter(fm: Frontmatter, body: string): string;
export function validateFrontmatter(fm: unknown): { valid: true; fm: Frontmatter } | { valid: false; errors: string[] };
```

**Validation** in Phase 1 is lightweight: required fields (`type`, `title`, `created`, `updated`), type is one of known values, dates parse as ISO 8601. Stricter relation-graph validation arrives in Phase 2 with the lint workflow.

---

## 3. Hook scripts (`src/hooks/`)

Five hook scripts plus the shared `error-handler` wrapper. Each is a small Node entry point that reads JSON from stdin (the platform's hook payload), appends to a raw session file, and exits 0. **No HTTP. No daemon. No retries on failure** — errors go to `errors.log`.

### 3.1 `src/hooks/error-handler.ts` — shared wrapper

```typescript
export async function runHook(hookName: string, body: (payload: HookPayload) => Promise<void>) {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw) as HookPayload;
    // Skip if this hook is being fired from an SDK-child process (avoid loops)
    if (isSdkChildContext(payload)) return;
    await body(payload);
  } catch (err) {
    await fs.appendFile(
      errorsLogPath(),
      `${new Date().toISOString()} ${hookName} ${(err as Error).message}\n${(err as Error).stack}\n\n`
    );
  } finally {
    process.exit(0);  // never break the host session
  }
}
```

**Design choice:** every hook's `main()` is a one-liner — `runHook("session-start", async (payload) => { ... })`. The error-handler wraps all the policy. Single point of failure-handling, hard to forget.

### 3.2 `src/hooks/session-start.ts`

Triggered when a session begins. Loads context from existing memory and emits it (via stdout per the Claude Code hook protocol) to inject into the agent's initial context.

**Phase 1 minimal version:**
- Read `~/.memory/schema.md` if present (~5KB)
- Read `~/.memory/index.md` if present (catalog of curated pages)
- Read last 20 lines of `~/.memory/log.md` for recent timeline
- Emit a single context block to stdout in the format Claude Code expects (TBD by reading agentmemory's existing hook output format)
- No file writes

### 3.3 `src/hooks/prompt-submit.ts`

Triggered when user submits a prompt.

```typescript
runHook("prompt-submit", async (payload) => {
  const sessionId = payload.session_id ?? "unknown";
  const tool = detectTool(payload);  // "claude-code" | "codex" | "antigravity"
  const filePath = rawSessionFile(tool, sessionId);
  await ensureSessionFileExists(filePath, { tool, sessionId, cwd: payload.cwd });
  await atomicAppend(filePath, formatPromptBlock(payload.prompt, new Date()));
});
```

`ensureSessionFileExists` writes the frontmatter header if file doesn't yet exist. `formatPromptBlock` produces:

```markdown
## [HH:MM:SS] Prompt
<user prompt verbatim, fenced if it contains backticks>
```

### 3.4 `src/hooks/post-tool-use.ts`

Triggered after each tool call.

```typescript
runHook("post-tool-use", async (payload) => {
  const sessionId = payload.session_id ?? "unknown";
  const tool = detectTool(payload);
  const filePath = rawSessionFile(tool, sessionId);
  const block = formatToolUseBlock(
    payload.tool_name,
    payload.tool_input,
    truncate(payload.tool_output, 8000),  // matches agentmemory's existing truncation
    new Date()
  );
  await atomicAppend(filePath, block);
});
```

`formatToolUseBlock` produces:

```markdown
## [HH:MM:SS] ToolUse: <tool_name>

**Input:**
```json
<tool_input as JSON, truncated>
```

**Output:**
```
<tool_output truncated to 8KB>
```

### 3.5 `src/hooks/pre-compact.ts`

Triggered before Claude Code compacts a session.

```typescript
runHook("pre-compact", async (payload) => {
  const filePath = rawSessionFile(detectTool(payload), payload.session_id ?? "unknown");
  await atomicAppend(filePath, `\n---\n## [HH:MM:SS] CompactionMarker\n\n`);
});
```

The marker is used in Phase 2 by the compile workflow to identify thread boundaries.

### 3.6 `src/hooks/session-end.ts`

Triggered on Stop / SessionEnd.

```typescript
runHook("session-end", async (payload) => {
  const filePath = rawSessionFile(detectTool(payload), payload.session_id ?? "unknown");
  await atomicAppend(filePath, `\n---\n## [HH:MM:SS] SessionEnd\n\n`);
  // Phase 2: optionally spawn `memory compile --since <session-start>` as detached subprocess
});
```

### 3.7 `src/hooks/util/detect-tool.ts`

Reads env vars to identify which platform fired the hook:

```typescript
export function detectTool(payload: HookPayload): ToolName {
  if (process.env.CLAUDECODE === "1") return "claude-code";
  if (process.env.CODEX_AGENT === "1") return "codex";
  if (process.env.ANTIGRAVITY_AGENT === "1") return "antigravity";
  // Fallback: inspect payload for tool-specific fingerprints
  if (payload.cwd?.includes("\\Anthropic\\Claude")) return "claude-code";
  return "claude-code";  // safest default for Phase 1 which only ships Claude Code wiring
}
```

---

## 4. CLI entry (`src/cli.ts`)

Single Node entry. Commander.js for subcommand parsing. **Phase 1 commands:** `init`, `install`, `stats`, `doctor`, `tail-errors`. Other commands (`search`, `compile`, `lint`, `crystallize`, `import-from-agentmemory`) get stubs that exit 2 with "not yet implemented" — that way the CLI shape is set and later phases just fill them in.

### 4.1 Command: `memory init`

```bash
memory init                 # idempotent; safe to re-run
memory init --reset         # blows away ~/.memory/ first (destructive, confirms)
```

**Operations:**
1. Create `~/.memory/` if absent.
2. Create subdirectories: `raw/`, `wiki/{projects,people,decisions,lessons,references,tools}/`, `crystals/`, `embeddings/`, `scripts/`, `.archive/`.
3. Write `schema.md` template (~50-line starting schema per spec §4) — only if file doesn't exist.
4. Write `index.md` stub (one-line "auto-generated by memory compile").
5. Write `log.md` with the init event.
6. Write `config.yaml` with defaults (per spec §3.1 retention block + embedding provider placeholder for Phase 3).
7. Create empty `errors.log`.
8. `git init` inside `~/.memory/` if not already a repo. Add `.gitignore` excluding `raw/` (per locked decision §2), `errors.log`, `.archive/`, `embeddings/raw.*.jsonl`.
9. Initial commit `chore: memory init`.

**Output:** human-readable success message with the path of each created directory. Exit 0.

### 4.2 Command: `memory install <platform>`

```bash
memory install claude-code
memory install codex          # Phase 4
memory install antigravity    # Phase 4
```

**Phase 1 — Claude Code only.**

Operations for `claude-code`:
1. Verify `~/.claude/` exists (Claude Code config dir).
2. Symlink (Windows: junction) `~/.memory/scripts/` → `<repo>/dist/hooks/` so the hook scripts are accessible from a stable location.
3. Build the platform manifest file (the JSON shown in spec §5.2) and write to `~/.memory/scripts/manifests/claude-code.hooks.json`.
4. Register the plugin with Claude Code: either copy/link the manifest into `~/.claude/plugins/memory/` per Claude Code's plugin convention, OR provide the user a one-liner instruction if the plugin install requires the CLI command (`/plugin install ...`).
5. Verify by re-reading the registered plugin manifest and confirming the hooks match what we wrote.
6. Write a `~/.memory/log.md` entry recording the install.

**Output:** confirmation of each step + a "next: restart Claude Code or open a new session" hint.

### 4.3 Command: `memory stats`

Read-only summary of the current memory state.

**Output (verbatim format example):**
```
Memory at C:\Users\Admin\.memory\

Storage:
  raw/      42 files     1.2 MB  (12 sessions across 3 days)
  wiki/      0 files       0 B   (no curated pages yet — run `memory compile` in Phase 2)
  crystals/  0 files       0 B
  embeddings/ 0 records    0 B   (Phase 3)

Activity:
  Last hook fire:    2026-05-20 14:23:15  (post-tool-use, session abc-123)
  Last compile:      never
  Last crystallize:  never

Hooks installed: claude-code ✓   codex ✗   antigravity ✗

errors.log:     0 bytes (clean)

Git:
  Branch: main    Commits: 14    Last: chore: memory init
```

### 4.4 Command: `memory doctor`

Lightweight verification — Phase 1 version only checks structural things, no live network probes:
- `~/.memory/` exists and has all expected subdirs
- `schema.md`, `index.md`, `log.md`, `config.yaml` all present
- For each "installed" platform, the manifest is readable AND points at script paths that exist
- `errors.log` size: if > 100KB, warn (likely something is failing silently)
- Recent hook activity (any session file in `raw/` from last 24h) — if zero AND a session was supposedly active, warn

Exit non-zero if any check fails. Output structured: one line per check, `✓` or `✗` prefix.

### 4.5 Command: `memory tail-errors`

```typescript
// Phase 1: equivalent of `tail -f ~/.memory/errors.log`
// Implementation: read file, watch for changes via fs.watchFile, stream new lines to stdout
```

### 4.6 Stub commands (exit 2)

`search`, `compile`, `lint`, `crystallize`, `backup`, `page`, `import-from-agentmemory`, `retain` — each prints `<cmd> is implemented in Phase <N>` and exits 2. This locks the CLI surface from Phase 1; later phases just fill in implementations.

---

## 5. Tests (`test/`)

Bias toward pure-function unit tests (slice 8 lesson). Integration tests use a temp dir via the `MEMORY_ROOT` env var.

### 5.1 Test file inventory

| File | Coverage |
|---|---|
| `test/paths.test.ts` | `memoryRoot()` respects env var; `rawSessionFile` formats correctly; date defaults to today |
| `test/atomic-write.test.ts` | `atomicWrite` survives mid-write interruption (use process.kill + retry); `atomicAppend` is concurrent-safe (5 parallel appends produce 5 lines, no torn writes) |
| `test/frontmatter.test.ts` | Parse/serialize round-trip preserves content + frontmatter; validateFrontmatter catches missing required fields |
| `test/hooks/error-handler.test.ts` | Throwing body writes to errors.log; exit code still 0; subsequent hooks unaffected |
| `test/hooks/prompt-submit.test.ts` | Given mock payload, produces expected raw session file with frontmatter + prompt block |
| `test/hooks/post-tool-use.test.ts` | Tool input/output get truncated to 8KB; multiple tool calls append correctly |
| `test/hooks/session-start.test.ts` | Emits expected context structure when memory is empty / populated |
| `test/cli-init.test.ts` | `memory init` creates all expected directories and files; idempotent on second run |
| `test/cli-install.test.ts` | `memory install claude-code` writes correct manifest; manifest points at extant script paths |
| `test/cli-stats.test.ts` | Stats output reports correct counts; behaves sanely on empty memory |

**Test counts target:** ~30 tests; all using slice-5 format reporter so totals are unambiguous.

### 5.2 Hermetic test pattern (project_agentmemory lesson)

Tests redirect `~/.memory/` via `MEMORY_ROOT=$TMPDIR/memory-test-<random>` env var. Each test gets its own temp dir; teardown removes it. No tests touch the user's real `~/.memory/`.

### 5.3 No daemon-up test

Phase 1 has no daemon to start. All tests are pure-function or filesystem-only. This is by design — slice 8/9 lesson: integration tests that need live daemons are the source of friction.

---

## 6. Documentation (`docs/`)

### 6.1 `docs/architecture.md`

User-facing 2-page summary: what the system is, how the directory is laid out, where hooks fire from, where errors go. Not the spec — the spec is the design document. Architecture.md is the operator's reference.

### 6.2 `docs/cli.md`

One-page reference for the CLI subcommands available in Phase 1. Each subcommand: synopsis, options, exit codes, example output.

### 6.3 `docs/troubleshooting.md`

Top 5 likely failure modes Phase 1 might hit, with diagnosis steps:
1. Hooks not firing → check `tail-errors`, check Claude Code plugin install, check env vars
2. Wrong tool detected → set `CLAUDECODE=1` / `CODEX_AGENT=1` / `ANTIGRAVITY_AGENT=1` explicitly
3. `~/.memory/` missing after install → re-run `memory init`
4. Permission errors on Windows → check `~/.memory/` isn't under OneDrive (per `feedback_onedrive_exclusion`)
5. Errors.log filling up → see specific errors; fix root cause

---

## 7. Implementation order (sequence Codex executes)

Each step is independently committable. Tests run after each substantive step. **Codex commits with `feat:`, `test:`, `chore:`, `docs:` prefixes per session conventions.**

| # | Step | Acceptance |
|---:|---|---|
| 1 | Scaffolding (§1): package.json, tsconfig, vitest.config, .gitattributes, .gitignore, README stub. `npm install` succeeds. | `npm run test` passes (zero tests, zero failures); `npm run build` succeeds with empty src/. |
| 2 | Storage primitives (§2.1-2.3) + tests for each. | `paths.test.ts`, `atomic-write.test.ts`, `frontmatter.test.ts` all pass. |
| 3 | Hook error handler (§3.1) + test. | `error-handler.test.ts` passes; error path verified to write `errors.log` and exit 0. |
| 4 | Hook scripts (§3.2-3.7) + tests for each, except session-end stays trivial in Phase 1. | All hook tests pass; sample payloads produce expected raw session files. |
| 5 | CLI: init subcommand (§4.1) + test. | `memory init` creates expected layout; idempotent re-run. |
| 6 | CLI: install subcommand for claude-code (§4.2) + test. | Manifest written; symlink/junction created on Windows. |
| 7 | CLI: stats, doctor, tail-errors (§4.3-4.5) + tests. | Stats reports correctly on a populated test fixture. |
| 8 | CLI: stub commands (§4.6) — minimal exit-2 stubs. | Each stub exits with code 2 and a helpful message. |
| 9 | Documentation (§6). | All three .md files present with content. |
| 10 | End-to-end smoke test: `memory init` → fake a Claude Code hook invocation → `memory stats` shows the activity. | Manual run produces expected output. |
| 11 | Tag `v0.1.0-phase1` and write a brief release note. | Tag exists; v0.1.0-phase1 release note describes what's shipped. |

---

## 8. Phase-1 acceptance gate

Before declaring Phase 1 done, all of these must hold:

- [ ] `npm run test` reports `0 failed | N passed | 0 skipped | 0 todo` (N ≥ 30)
- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] `memory init` on a fresh machine creates the full directory structure
- [ ] `memory install claude-code` registers the plugin; no manual file copying required
- [ ] After installing and using Claude Code for one real session, `memory stats` reports ≥ 1 raw session file with non-zero bytes
- [ ] `~/.memory/errors.log` is empty after a normal session (or contains only well-understood entries)
- [ ] All commits authored as `GalaxyRuler <aoa@live.ca>`
- [ ] Tag `v0.1.0-phase1` exists on `main`
- [ ] No file under `C:\Users\Admin\OneDrive\` is touched (per `feedback_onedrive_exclusion`)
- [ ] No global config edited (no `~/.codex/config.toml`, no `~/.claude/.mcp.json` mutations in Phase 1 — that's Phase 3)

---

## 9. Estimated effort

If executed in single-direction passes by Codex via the existing prompt pattern: **~8-12 prompts**, roughly one per step in §7.

If executed manually: a focused day's work.

---

## 10. Out of scope for this plan

To be addressed in subsequent phase plans:

- **Phase 2 plan** — curation: compile, lint, frontmatter validation, index/log management
- **Phase 3 plan** — retrieval: BM25, voyage-4-large embeddings, Voyage Rerank 2.5, HyDE, MCP server with 12 tools, graph operations, implicit graph extraction
- **Phase 4 plan** — Codex hooks manifest + MCP registration; Antigravity hooks manifest + MCP registration; crystallize
- **Phase 5 plan** — migration from agentmemory
- **Phase 6 plan** — polish, Obsidian verification, retention scheduling, `.gitattributes`

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Claude Code's plugin install format changes between when this spec was written and when Phase 1 is executed | Verify against current Claude Code docs at implementation time; the install step is small and self-contained |
| `MEMORY_ROOT` env var conflicts with something else | Use `AGENTMEMORY_HOME_OVERRIDE` instead? No — `MEMORY_ROOT` is generic enough and not in conflict |
| Symlink/junction creation fails on Windows due to permissions | Fall back to copy + manual reinstall on script changes; warn in install output |
| Hook scripts on Windows have CRLF/LF issues | `.gitattributes` from §1.5 + we don't author the scripts as text-on-disk; they're built artifacts under `dist/` per tsdown |
| User's `~/.memory/` collides with something they already have | `memory init` refuses to overwrite without `--reset` confirmation |
| The detect-tool heuristic fails for a multi-tool session | Worst case: tool name is "claude-code" instead of "codex"; raw file goes into the wrong filename prefix. Fixable manually. Phase 4 adds richer detection. |

---

## 12. Open implementation questions (deferred to Phase 1 execution)

- **Exact format of `session-start.ts` output** — what does Claude Code expect from a SessionStart hook? Verify against agentmemory's existing session-start.mjs at implementation time and mirror.
- **Where Claude Code registers plugins** — `~/.claude/plugins/<name>/plugin.json`? `~/.claude/.claude.json`? Look at existing agentmemory plugin install path.
- **Whether Windows junctions vs symlinks matter** — both should work for Node.js script execution. Pick junction since it doesn't require admin.

These are too small for the design doc; they get resolved in execution.

---

This plan is committable as-is. Next step in the brainstorming → planning → implementation flow: hand off step §7 #1 (scaffolding) to Codex as a self-contained prompt per `feedback_codex_prompts.md` conventions.
