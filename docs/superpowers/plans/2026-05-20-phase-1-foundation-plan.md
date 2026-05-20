# Phase 1 — Foundation: Implementation Plan (rev. 2 post-grilling)

**Spec:** `docs/superpowers/specs/2026-05-20-cross-tool-memory-system-design.md` (commits 3c30fe7 → 212fbc3, plus the post-grilling spec updates)
**Date:** 2026-05-20
**Plan revision:** 2 (after grill-me session resolved Q1-Q5)
**Scope:** Storage layout + hooks for Claude Code & Codex + minimal MCP server (3 tools) for all three platforms (Claude Code, Codex, Antigravity) + multi-command CLI including `memory grep` and `memory log` for immediate usefulness + schema.md template.

**What Phase 1 does NOT include** (deferred to later phases):
- Embeddings layer (Phase 3)
- Voyage Rerank, HyDE, graph queries, search MCP tool (Phase 3)
- Compile / lint / crystallize workflows (Phase 2 / 4)
- Migration from agentmemory (Phase 5)
- Scheduled tasks + Obsidian verification + retention (Phase 6)

**Acceptance:** With Phase 1 installed, a real session in any of Claude Code, Codex desktop/CLI, or Antigravity desktop produces raw observation files in `~/.memory/raw/<date>/`. The user can run `memory grep "<pattern>"` and `memory log "<text>"` from any terminal. The schema.md is non-empty and well-formed. `memory stats` reports accurate counts. `errors.log` is empty after a normal session.

---

## 1. Repository scaffolding

### 1.1 Project root

Location: `C:\CodexProjects\memory-system\` (already initialized as git repo with the spec + this plan committed).

Branch: `main`. Author identity for commits: `GalaxyRuler <aoa@live.ca>`.

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
  "bin": { "memory": "dist/cli.mjs" },
  "dependencies": {
    "commander": "^12",
    "gray-matter": "^4",
    "js-yaml": "^4",
    "@modelcontextprotocol/sdk": "^1.29"
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

**Verified May 2026:** `@modelcontextprotocol/sdk` ^1.29 is the current stable line (npm); requires Node 18+; supports stdio transport. v2 is anticipated Q1 2026 but v1.x stays recommended for production through 2026.

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

Configured for slice-5-style unambiguous totals output.

### 1.5 `.gitattributes` (slice 4 lesson, applied from day one)

```
*.mjs text eol=lf
*.cjs text eol=lf
*.ts  text eol=lf
*.md  text eol=lf
*.json text eol=lf
*.yaml text eol=lf
```

### 1.6 `.gitignore`

Excludes `node_modules/`, `dist/`, `*.tsbuildinfo`, `coverage/`.

### 1.7 `README.md` (stub)

Brief one-page introduction + link to spec + Phase 1 quickstart.

---

## 2. Storage primitives (`src/storage/`)

Pure helpers. No I/O orchestration; just building blocks.

### 2.1 `src/storage/paths.ts`

Centralized path resolution. **Every path in the system goes through this module** — no ad-hoc `path.join` calls elsewhere. Mirrors the slice 3 lesson (extract decision logic to pure functions for testability).

**Exports:**
```typescript
export function memoryRoot(): string;          // resolves env MEMORY_ROOT or ~/.memory/
export function schemaPath(): string;
export function indexPath(): string;
export function logPath(): string;
export function errorsLogPath(): string;
export function configPath(): string;
export function rawDir(date?: Date): string;
export function rawSessionFile(tool: ToolName, sessionId: string, date?: Date): string;
export function wikiDir(category?: PageType): string;
export function crystalsDir(): string;
export function scriptsDir(): string;
export function mcpServerPath(): string;       // path to mcp-server.mjs
export type ToolName = "claude-code" | "codex" | "antigravity";
export type PageType = "projects" | "people" | "decisions" | "lessons" | "references" | "tools";
```

**Implementation notes:** `memoryRoot()` reads env `MEMORY_ROOT` first, falls back to `path.join(os.homedir(), ".memory")`. Tests use the env var to redirect to a temp dir. Date formatting always ISO 8601.

### 2.2 `src/storage/atomic-write.ts`

```typescript
export async function atomicWrite(absolutePath: string, content: string): Promise<void>;
export async function atomicAppend(absolutePath: string, content: string): Promise<void>;
```

Write to `<path>.tmp`, fsync, rename — atomic. Append uses `fs.appendFile` (atomic for small writes).

### 2.3 `src/storage/frontmatter.ts`

YAML frontmatter read/write via `gray-matter` (read) + `js-yaml` (write).

```typescript
export interface Frontmatter { /* per spec §4.2 */ }
export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string };
export function serializeFrontmatter(fm: Frontmatter, body: string): string;
export function validateFrontmatter(fm: unknown): { valid: true; fm: Frontmatter } | { valid: false; errors: string[] };
```

Lightweight Phase 1 validation: required fields (`type`, `title`, `created`, `updated`); type is one of known values; dates parse as ISO 8601.

---

## 3. Hook scripts (`src/hooks/`)

Five hook scripts + shared `error-handler` wrapper. Each is a small Node entry point that reads JSON from stdin, appends to a raw session file, exits 0. **No HTTP. No daemon. No retries on failure** — errors go to `errors.log`.

### 3.1 `src/hooks/error-handler.ts` (shared wrapper)

```typescript
export async function runHook(hookName: string, body: (payload: HookPayload) => Promise<void>) {
  try {
    const payload = JSON.parse(await readStdin()) as HookPayload;
    if (isSdkChildContext(payload)) return;
    await body(payload);
  } catch (err) {
    await fs.appendFile(errorsLogPath(), `${new Date().toISOString()} ${hookName} ${(err as Error).message}\n${(err as Error).stack}\n\n`);
  } finally {
    process.exit(0);
  }
}
```

### 3.2 `src/hooks/session-start.ts`

Triggered when session begins. Loads context from existing memory (schema.md + index.md + recent log.md + relevant pages by cwd) and emits to stdout in the format each platform expects.

### 3.3 `src/hooks/prompt-submit.ts`

Triggered on user prompt submission. Appends prompt text to today's `raw/<date>/<tool>-<session>.md` under a `## [HH:MM:SS] Prompt` heading.

### 3.4 `src/hooks/post-tool-use.ts`

Triggered after each tool call. Appends `## [HH:MM:SS] ToolUse: <tool_name>` block with input + truncated output (8KB cap, matching agentmemory's convention).

### 3.5 `src/hooks/pre-compact.ts`

Triggered before context compaction. Appends a marker that compile passes use as a thread boundary signal.

### 3.6 `src/hooks/session-end.ts`

Triggered on Stop / SessionEnd. Appends a `SessionEnd` marker. Phase 2 will optionally spawn `memory compile` as a detached subprocess.

### 3.7 `src/hooks/util/detect-tool.ts`

```typescript
export function detectTool(payload: HookPayload): ToolName {
  if (process.env.CLAUDECODE === "1") return "claude-code";
  if (process.env.CODEX_AGENT === "1" || process.env.CODEX_HOME) return "codex";
  if (process.env.ANTIGRAVITY_AGENT === "1" || process.env.GEMINI_AGENT === "1") return "antigravity";
  // Payload-based fallback (cwd, parent process)
  return "claude-code";
}
```

**Note:** verifying exact env var names each platform sets is a Phase 1 implementation task — initial best guess shown; verify at implementation time against current docs for each.

---

## 4. MCP server (`src/mcp/`) — Phase 1 minimal (3 tools)

Single stdio MCP server using `@modelcontextprotocol/sdk` ^1.29. Stateless. Each call reads/writes filesystem directly. Dies with host.

### 4.1 `src/mcp/server.ts`

Three tools registered (per spec §6.3 Phase 1 minimal):

```typescript
server.registerTool("memory.log_observation", {
  description: "Append an observation to today's raw session file with optional tags and confidence.",
  inputSchema: { /* { text, tags?, confidence?, source? } */ },
}, async (input) => { /* atomic append to rawSessionFile */ });

server.registerTool("memory.read_page", {
  description: "Read a wiki page by relative path under ~/.memory/wiki/.",
  inputSchema: { /* { path } */ },
}, async (input) => { /* read + parseFrontmatter */ });

server.registerTool("memory.list_pages", {
  description: "List wiki pages, optionally filtered by type/tag/status.",
  inputSchema: { /* { type?, tag?, status? } */ },
}, async (input) => { /* scan wiki/, filter by frontmatter */ });
```

Search / graph / compile tools come in Phase 3 — same file, more `registerTool` calls.

### 4.2 Registration in each platform's MCP config

`memory install <platform>` (§5.2 below) writes the appropriate config:

- **Claude Code:** `~/.claude/.mcp.json` (or project-scoped `.mcp.json`) — adds `"memory": { "command": "node", "args": ["<absolute path to dist/mcp-server.mjs>"] }`
- **Codex (covers desktop + CLI):** `~/.codex/config.toml` — adds `[mcp_servers.memory]` section with `command`, `args`. Verified May 2026 — Codex hooks/MCP config spans CLI, desktop, and IDE extension.
- **Antigravity desktop:** `~/.gemini/antigravity/mcp_config.json` — adds the memory entry. **This is the ONLY ingestion path for Antigravity** (no hooks).

---

## 5. CLI entry (`src/cli.ts`)

Single Node entry. Commander.js. **Phase 1 commands** (all implemented, not stubs):

| Command | Purpose |
|---|---|
| `memory init [--reset]` | Create `~/.memory/` structure + write `schema.md` template + git init + initial commit |
| `memory install <platform>` | Wire hooks (Claude Code, Codex) + MCP (all three) for one platform |
| `memory grep <pattern> [--scope raw\|wiki\|both]` | Tier-1 retrieval via ripgrep wrapper |
| `memory log "<text>" [--tag X --tag Y]` | Manual observation append; bypasses host session entirely |
| `memory stats` | Storage + activity summary |
| `memory doctor` | Verify installs, schema present, recent activity, errors.log size |
| `memory tail-errors` | `tail -f ~/.memory/errors.log` shortcut |

**Phase 1 stubs** (exit 2 with "Phase N" message): `search`, `compile`, `lint`, `crystallize`, `backup`, `page`, `import-from-agentmemory`, `retain`, `schedule`.

### 5.1 `memory init`

Operations:
1. Create `~/.memory/` if absent.
2. Create subdirs: `raw/`, `wiki/{projects,people,decisions,lessons,references,tools}/`, `crystals/`, `embeddings/`, `scripts/`, `.archive/`.
3. **Copy `templates/schema.md` (from the source repo) → `~/.memory/schema.md`**, substituting template variables (`{{user_name}}`, `{{install_date}}`, etc.). See §10 for the schema template content.
4. Write `index.md` stub ("auto-generated by `memory compile`").
5. Write `log.md` with the init event line.
6. Write `config.yaml` with defaults (retention §3.1 + Phase 3 embedding provider placeholder).
7. Create empty `errors.log`.
8. `git init` if `~/.memory/.git/` absent. Add `.gitignore` excluding `raw/`, `errors.log`, `.archive/`, `embeddings/raw.*.jsonl`.
9. Initial commit `chore: memory init`.

### 5.2 `memory install <platform>`

**`claude-code`:**
1. Verify `~/.claude/` exists.
2. Symlink (Windows: junction) `~/.memory/scripts/` → repo's `dist/hooks/`.
3. Write `~/.memory/scripts/manifests/claude-code.hooks.json` (per spec §5.2).
4. Register plugin with Claude Code per current plugin-install protocol (verify against current Claude Code docs at implementation time).
5. Add MCP entry to `~/.claude/.mcp.json` (or instruct user how to add per-project).
6. Log to `~/.memory/log.md`.

**`codex`:** (covers desktop + CLI per shared `~/.codex/config.toml`)
1. Verify `~/.codex/` exists.
2. Write `~/.memory/scripts/manifests/codex.hooks.json` OR (preferred) inline `[hooks]` table in `~/.codex/config.toml`.
3. Add `[mcp_servers.memory]` to `~/.codex/config.toml`.
4. Log.

**`antigravity`:** (MCP only — Antigravity desktop has no hook system)
1. Verify `~/.gemini/antigravity/` exists.
2. Add memory entry to `~/.gemini/antigravity/mcp_config.json`.
3. Log.
4. (No hook scripts registered for Antigravity — there are no Antigravity hooks. Documented in install output.)

### 5.3 `memory grep`

Thin ripgrep wrapper:
```typescript
// Pseudocode
const args = ["--type", "md", "-n", "-C", "2", pattern];
const dirs = scope === "raw" ? [rawDir()] : scope === "wiki" ? [wikiDir()] : [rawDir(), wikiDir()];
const result = spawnSync("rg", [...args, ...dirs], { encoding: "utf-8" });
process.stdout.write(result.stdout);
process.exit(result.status ?? 0);
```

Exit 0 on matches, 1 on no matches, 2 on error.

### 5.4 `memory log`

```typescript
// Pseudocode
const sessionId = "manual-" + Date.now();
const filePath = rawSessionFile("manual", sessionId);
const block = formatObservationBlock(text, tags, new Date());
await ensureSessionFileExists(filePath, { tool: "manual", sessionId, cwd: process.cwd() });
await atomicAppend(filePath, block);
console.log(`Logged to ${filePath}`);
```

The `manual` "tool" is a synthetic source for CLI-driven entries — sits alongside `claude-code`, `codex`, `antigravity` in the type enum.

### 5.5 `memory stats`

Read-only summary (file counts, total bytes per area, last hook fire, install status per platform, errors.log size, git state).

### 5.6 `memory doctor`

Structural checks (no live network probes):
- `~/.memory/` exists with all subdirs
- `schema.md`, `index.md`, `log.md`, `config.yaml` present
- Each installed platform's manifest readable and points at extant script paths
- MCP entry present in each installed platform's config
- `errors.log` < 100 KB (warn if larger)
- Hook activity in last 24h if any session was active

Exit non-zero on any failure. Structured output (one line per check, ✓/✗ prefix).

### 5.7 `memory tail-errors`

`tail -f` equivalent for `~/.memory/errors.log`.

---

## 6. Tests (`test/`)

Bias toward pure-function unit tests (slice 8 lesson). Integration tests use temp dir via `MEMORY_ROOT` env var (hermetic, per `project_agentmemory` lesson).

| File | Coverage |
|---|---|
| `test/paths.test.ts` | `memoryRoot()` env override; `rawSessionFile` formatting; date defaults |
| `test/atomic-write.test.ts` | Survives mid-write interruption; concurrent appends produce N lines, no torn writes |
| `test/frontmatter.test.ts` | Parse/serialize round-trip; validate required fields |
| `test/hooks/error-handler.test.ts` | Throwing body writes to errors.log; exit 0 |
| `test/hooks/prompt-submit.test.ts` | Mock payload → expected raw file content |
| `test/hooks/post-tool-use.test.ts` | Truncation to 8KB; concurrent calls append correctly |
| `test/hooks/session-start.test.ts` | Emits expected context block when memory empty/populated |
| `test/mcp/server.test.ts` | Each of 3 tools handles valid + invalid input |
| `test/mcp/log-observation.test.ts` | Tool writes to expected raw file with frontmatter |
| `test/mcp/read-page.test.ts` | Reads frontmatter + body correctly; 404 on missing |
| `test/mcp/list-pages.test.ts` | Filters by type/tag/status |
| `test/cli-init.test.ts` | Creates layout; copies schema template; idempotent |
| `test/cli-install.test.ts` | Each platform's manifest written; MCP entry added |
| `test/cli-grep.test.ts` | Returns matches; respects scope flag; correct exit codes |
| `test/cli-log.test.ts` | Manual observation appears in today's raw file with `source: manual` |
| `test/cli-stats.test.ts` | Reports correct counts on fixture data |
| `test/cli-doctor.test.ts` | Detects missing schema; detects missing manifest |

**Target:** ~40 tests, all using slice-5 four-category totals output.

---

## 7. Documentation (`docs/`)

- `docs/architecture.md` — user-facing 2-page summary
- `docs/cli.md` — Phase 1 command reference
- `docs/troubleshooting.md` — top failure modes per platform with diagnosis steps
- `docs/install-claude-code.md` / `install-codex.md` / `install-antigravity.md` — platform-specific install walkthroughs

---

## 8. Implementation order (sequence Codex executes)

Each step independently committable. Tests run after each substantive step. Codex commits with conventional prefixes per `feedback_codex_prompts`.

| # | Step | Acceptance |
|---:|---|---|
| 1 | Scaffolding (§1). `npm install` succeeds; `npm run test` reports 0 of 0; `npm run build` succeeds. | Clean repo, build passes |
| 2 | Storage primitives (§2.1-2.3) + tests | All three modules unit-tested |
| 3 | Hook error-handler wrapper (§3.1) + test | Error path verified |
| 4 | Hook scripts (§3.2-3.7) + tests | Mock payloads produce expected raw files |
| 5 | **Schema template authored.** Write `templates/schema.md` per §10 below. ~200 lines, 12 sections. Committed in source repo. | Template file exists; content matches §10 mandates |
| **CHECKPOINT** | **Manual verification gate (user-driven, NOT codex-automated).** Install Phase 1 partial (steps 1-5) on the user's machine. Run a real Claude Code session. Verify a raw session file appears at `~/.memory/raw/<date>/claude-code-<id>.md` with prompt + tool-use blocks. If this fails, debug before proceeding. | Real Claude Code session produces real raw file |
| 6 | CLI: `memory init` (§5.1) + test | Layout + schema.md created; idempotent |
| 7 | CLI: `memory install claude-code` (§5.2) + test | Manifest written; MCP entry added |
| 8 | MCP server: implement 3 tools (§4) + tests | Tools handle valid/invalid input; stateless verified |
| 9 | CLI: `memory install codex` + test | Codex config.toml written; covers both desktop + CLI |
| 10 | CLI: `memory install antigravity` + test | mcp_config.json written; no hooks (correctly) |
| 11 | CLI: `memory grep` (§5.3) + test | ripgrep wrapped; scope flag works |
| 12 | CLI: `memory log` (§5.4) + test | Manual observations land in today's raw file |
| 13 | CLI: `memory stats`, `memory doctor`, `memory tail-errors` (§5.5-5.7) + tests | Accurate state reporting |
| 14 | CLI: stub commands (§5 - Phase 1 stubs list) | Each exits 2 with "Phase N" message |
| 15 | Documentation (§7) | All five .md files committed |
| 16 | End-to-end smoke: real session on Claude Code, Codex desktop, Antigravity. `memory stats` shows all three. | Multi-platform ingestion confirmed |
| 17 | Tag `v0.1.0-phase1` + release note | Tag exists |

**Effort estimate:** 16-20 Codex prompts, with the checkpoint at step 5/6 as a quality gate.

---

## 9. Phase-1 acceptance gate

All must hold:

- [ ] `npm run test` reports `0 failed | N passed | 0 skipped | 0 todo` (N ≥ 40)
- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] `memory init` on fresh machine creates full layout INCLUDING schema.md with 12 sections
- [ ] `memory install claude-code` registers Claude Code plugin + adds MCP entry
- [ ] `memory install codex` writes Codex config.toml entries (hooks + MCP)
- [ ] `memory install antigravity` writes Antigravity MCP entry (no hooks; documented)
- [ ] After installing all three and using each for one real session, `memory stats` reports ≥ 1 raw file per platform
- [ ] `memory grep` returns matches when given a known term from raw or wiki
- [ ] `memory log "<text>"` appends to today's raw file with `source: manual` frontmatter
- [ ] MCP server's 3 tools (log_observation, read_page, list_pages) work when invoked from any of the three platforms
- [ ] `~/.memory/errors.log` is empty (or only known/expected entries) after a normal session
- [ ] All commits authored as `GalaxyRuler <aoa@live.ca>`
- [ ] Tag `v0.1.0-phase1` exists on `main`
- [ ] No file under `C:\Users\Admin\OneDrive\` touched
- [ ] No global config edited beyond what `memory install` does explicitly

---

## 10. `templates/schema.md` content requirements

The Phase 1 work includes authoring the schema template (`templates/schema.md` in the source repo, copied by `memory init` into `~/.memory/schema.md` with variable substitution).

**The template MUST contain these 12 sections (per grilling Q5):**

1. **Identity** — One paragraph identifying whose memory this is (`{{user_name}}`, GitHub handle, install date, primary tools used).
2. **Entity types** — Table copying spec §4.1 (project / person / decision / lesson / reference / tool / crystal), each row with dir path, naming convention, one-line purpose.
3. **Frontmatter contract** — The YAML block from spec §4.2 as a copy-pasteable template.
4. **Naming rules** — Spec §4.3 verbatim.
5. **Edge types** — Table copying spec §7.3 (9 edge types: uses, depends_on, supersedes, contradicts, caused_by, fixed_by, derived_from, mentioned_in, linked). Direction + semantics per row.
6. **Quality standards** — Spec §4.4 (one-sentence summary, session citation, contradictions recorded not deleted, DRAFT for low-confidence).
7. **Privacy filtering rules** — Spec §4.5 (regex patterns for keys/secrets, `[REDACTED]` replacement).
8. **Ingest workflow** — What the LLM does during `memory compile`: extract entities, dedupe against existing wiki, propose edges, append to log.md.
9. **Lint rules** — What `memory lint` checks (orphans, contradictions, stale, broken links, frontmatter validity).
10. **Anti-patterns** — Concrete "do not do this" examples (no person page for one-off mentions; never silently delete contradictions; wait for cross-session signal before creating wiki page from single-session content).
11. **User identity & preferences** — Ported from agentmemory's slice-7 GalaxyRuler personalize plan ("warm proactive senior engineering collaborator, candid about tradeoffs," etc.).
12. **Versioning** — Frontmatter on schema.md itself: `schema_version: 1`, `updated: {{install_date}}`. Future schema changes increment the version; old pages get one-time migration on next compile.

**Length target:** ~200 lines of markdown. This template is content-authoring work (I — Claude — write it), not code work (Codex executes).

Step #5 in §8 is the milestone where this gets written and committed.

---

## 11. Out of scope for this plan

Subsequent phase plans address:

- **Phase 2** — Curation: compile, lint, frontmatter validation, index/log management
- **Phase 3** — Retrieval & full MCP: BM25, voyage-4-large embeddings, Voyage Rerank 2.5, HyDE, MCP search/graph tools, implicit graph extraction
- **Phase 4** — Crystallize, advanced platform-specific features (if any remain after Phase 1 covers shared hooks+MCP plumbing)
- **Phase 5** — Migration from agentmemory
- **Phase 6** — Scheduled tasks (Option A — confirmed in grilling), Obsidian vault verification, retention scheduler, polish

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Claude Code plugin install format changes between writing spec and execution | Verify against current Claude Code docs at implementation time (step #7) |
| Codex hook event names differ between desktop and CLI | Verified May 2026 — they share `~/.codex/config.toml`; one install path covers both |
| Antigravity hook docs unclear | Confirmed via web search May 2026 — Antigravity desktop has NO hook system; MCP-only is correct (not a workaround) |
| `MEMORY_ROOT` env var conflicts | Specific enough, low collision risk |
| Symlink/junction creation fails on Windows due to permissions | Fall back to copy; warn in install output. Junctions don't require admin |
| Hook scripts on Windows CRLF/LF issues | `.gitattributes` from day one + tsdown build artifacts |
| User's `~/.memory/` collides with existing directory | `memory init` refuses to overwrite without `--reset` confirmation |
| Detect-tool heuristic fails for a multi-tool session | Each platform sets distinct env vars; worst case attribution gets wrong filename prefix; fixable manually |
| MCP server fails to register | `memory doctor` catches; install output is verbose; user retries `memory install <platform>` |
| `@modelcontextprotocol/sdk` v2 lands mid-implementation | Stay on ^1.29 (still recommended for production per current docs); upgrade post-Phase 6 |

---

## 13. Implementation handoff

This plan is committable. Each step in §8 maps to a self-contained Codex 5.5 prompt per `feedback_codex_prompts` conventions. The first prompt to hand off (step #1 — scaffolding) follows the routing memory pattern: `cwd: C:\CodexProjects\memory-system`, echoed to user for paste into Codex Desktop.

---

This plan is rev. 2 — incorporates the five grilling-derived plan changes (Q1 multi-platform Phase 1, Q2 grep+log CLI, Q3 minimal MCP + spec language clarification, Q4 single-phase with checkpoint, Q5 explicit schema.md template content).
