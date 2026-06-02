# Codex Implementation Brief — cwd-Aware Proactive Memory Injection (Phase 4.36)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> The memory system is capture-heavy, consumption-light. At SessionStart the agent is handed a **map** of memory (the global `index.md`) but not the **territory** — the actual project page and its linked decisions/lessons. So rich memory is only used if the agent proactively queries via MCP, which it often doesn't. This brief makes the relevant project memory get injected **by default**, based on the working directory.

## The gap (verified in source 2026-06-02)

`src/hooks/session-start.ts` `sessionStartBody(payload, deps)`:
- Line 24 literally does **`void payload;`** — it ignores the payload, including `payload.cwd` (which exists on `HookPayload`, `error-handler.ts:13`).
- It injects: `Schema` (schema.md), `Index` (index.md, confidence-aware — a TOC of ALL pages), `Recent log` (last 20 lines), and the preferences block (`whatToRememberBlock`).
- It does **not** inject the page for the project you're actually in. The agent gets "here is a list of everything in memory," not "here is what you know about *this* project."

Live cwd values from captures (note worktree subpaths):
```
C:\CodexProjects\memory-system
C:\CodexProjects\memory-system\.claude\worktrees\charming-swartz-ead30b
C:\CodexProjects\efm-paper
C:\Users\Admin\ClaudeCodeProjects\misc-claude-sessions
```
Project page slugs in `wiki/projects/`: `agentmemory`, `iaqar`, `memory-system`, `veritrace`. (Pages carry **no `repo:` field** today — match must be slug-based, with an optional authoritative override.)

## Task 1 — resolve the current project from cwd

New helper (e.g. `src/hooks/session-start-helpers.ts` or a `resolveProjectForCwd.ts`):

Input: `payload.cwd`, the vault root. Output: the best-matching project page rel-path, or `null`.

Two-tier match, most-specific wins:
1. **Authoritative override (preferred).** If a project page frontmatter has a `repo:` (single path) or `repo_paths:` (list) field, and `cwd` equals or is a subdirectory of that path (normalized: lowercase on Windows, forward-slash, trailing-slash-insensitive), it matches. Longest matching path wins. *(Pages don't have this field yet — support it for when they do; Task 4 documents adding it.)*
2. **Slug-in-path heuristic (fallback).** Split `cwd` into path segments. If any segment exactly equals a `wiki/projects/<slug>.md` slug, match that project. The **deepest** matching segment wins so worktree subpaths (`…/memory-system/.claude/worktrees/x`) still resolve to `memory-system`. Ignore generic segments (`src`, `.claude`, `worktrees`, `node_modules`).

No match (e.g. cwd `efm-paper`, which has no page in this vault, or a random dir) → return `null` → fall back to current behavior. Deterministic, pure string/path ops — **no LLM, no embedding** (hooks must stay sub-second).

## Task 2 — inject the project memory + its 1-hop neighbors

When Task 1 resolves a project, prepend two new sections **before** the global Index (so the most relevant memory is most prominent):

- **`Current project memory`** — the matched project page's **body** (the prose narrative), plus its key frontmatter (status, updated). This is the territory.
- **`Related memory`** — the project's 1-hop neighbors: pages referenced by its `relations` edges + inline `[[wikilinks]]`. For each, inject **title + one-line summary** (from index.md), not the full body. Bound to the top **N = 5** neighbors, ranked by `strength` then recency (`last_accessed`/`updated`). List the rest by title only under "more".

Keep `Schema`, `Index`, `Recent log`, and preferences — but the project memory now leads. If Task 1 returns `null`, output is exactly today's behavior (no regression).

## Task 3 — bound the injection (don't blow the context budget)

- Cap total injected memory at a named constant (e.g. `MAX_INJECTED_CHARS = 8000`). The project body is highest priority; neighbor summaries fill remaining budget; truncate with a clear `…(truncated, use MCP read_page for full)` marker.
- This runs on **every** SessionStart and blocks it — keep it fast: cap project-page scan, read index.md once, no recursive traversal beyond 1 hop.
- Never throw: any resolution/read error falls back to the current schema+index+log output (wrap in the existing try/skip pattern).

## Task 4 — apply to all shared hooks + document

- The Antigravity plugin has its own `session_start` hook (`src/cli/commands/install/antigravity-plugin/hooks/session_start.ts`) — apply the same cwd-aware injection there (or factor the resolver into shared code both import). Codex + Claude Code use `src/hooks/session-start.ts`.
- `schema.md`: document the optional `repo:` / `repo_paths:` frontmatter field on project pages so users can make cwd→project matching authoritative when a dir name differs from the slug.
- `docs/`: note the new SessionStart behavior.

## You will NOT
- Call an LLM or embedding model inside the SessionStart hook — it must stay deterministic and sub-second.
- Inject full bodies of neighbor pages — titles + summaries only (the project body is the only full body).
- Regress the no-match path — unknown cwd must produce exactly today's output.
- Exceed the injection cap — truncate with a marker, never dump unbounded memory into context.
- Inject another project's memory on a partial/ambiguous match — require an exact segment or `repo:` prefix match; when ambiguous, prefer the deepest match, and if still tied, fall back to index-only.

## Stop and ask
1. Two project pages legitimately match the same cwd (nested projects, monorepo) and deepest-segment doesn't disambiguate → confirm tie-break (newest `updated`? both? index-only?).
2. The injection cap forces dropping the project body itself (huge page) → confirm whether to summarize-by-truncation or inject frontmatter + first paragraph only.
3. Antigravity's hook payload doesn't carry `cwd` in the same field → confirm the field name before wiring (check a real Antigravity raw capture's `cwd`).

## Acceptance (read the injected bytes, lessons #2/#3)
- **Match + inject:** run `session-start` with `payload.cwd = C:\CodexProjects\memory-system` → stdout **contains** the `Current project memory` section with the memory-system page body, and a `Related memory` section listing ≥1 linked page (e.g. `[[agentmemory]]`). Assert on the actual stdout text, not exit code.
- **Worktree subpath:** `cwd = C:\CodexProjects\memory-system\.claude\worktrees\x` resolves to the same `memory-system` project.
- **No match:** `cwd = C:\Users\Admin\ClaudeCodeProjects\misc-claude-sessions` → output equals today's (schema + index + log + preferences), no project section.
- **Bounded:** injected memory never exceeds `MAX_INJECTED_CHARS`; oversized project page is truncated with the marker.
- **Fast + safe:** hook returns quickly; any error falls back to current output. Unit tests cover match/worktree/no-match/cap/error for both the shared and Antigravity hooks.
- Full suite + typecheck + build clean.

## Commit boundaries
- Task 1: `feat(hooks): resolve current project from cwd (repo-field then slug-in-path) (Phase 4.36 Task 1)`
- Task 2-3: `feat(hooks): inject current-project memory + 1-hop neighbors at SessionStart, bounded (Phase 4.36 Task 2)`
- Task 4: `feat(hooks): cwd-aware injection for Antigravity hook + schema docs (Phase 4.36 Task 3)`
