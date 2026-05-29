# Codex Implementation Brief — Leak-Surface Hardening (Phase 4.9)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

A fresh-eyes security audit (2026-05-29), verified against the code by a 10-agent workflow, confirmed three real data-leak surfaces. This brief closes all three. (Severity in this single-user, 127.0.0.1 + Tailscale-only deployment is bounded, but each is a genuine gap the spec claims is closed.)

### F-01 — compile secret redaction is incomplete (HIGH)

`redactSecrets()` in `src/compile/execute.ts` (~L319-323) has only two regexes:
1. `/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*\S+/gi` — `KEY=value` assignments
2. `/\b(sk-[A-Za-z0-9_-]{8,})\b/g` — bare `sk-…` tokens

The spec claimed `AIza*`, `ghp_*`, `Bearer`, and PEM are also redacted. They are **not**. A compiled wiki page could therefore embed a Google API key, GitHub PAT, bearer token, or private key pulled from raw observations. Test coverage (`test/compile/execute.test.ts:38-68`) only exercises `OPENROUTER_API_KEY=sk-live-secret`.

### F-09 — `.audit/` operational logs leak into MCP surfaces (HIGH)

`listPages()` in `src/mcp/server.ts` (~L154-204) recursively scans `wikiDir()` and collects every `*.md`, filtering only by extension — it does **not** exclude `wiki/.audit/`. The shared filter `src/retrieval/wiki-paths.ts` (`isWikiDotDirectoryPath`, added in Phase 4.3.Q for graph-health + entity-dedup) exists but is **not imported** in `server.ts`. So `memory` MCP `list_pages` / `search` / `read_page` and any dashboard surface that reuses this path can surface LLM audit logs and propose-run logs as if they were curated memory.

### F-16 — dashboard API leaks absolute filesystem paths (HIGH/MEDIUM)

`PageDetail` (loaders.ts ~L99) and `RawSessionDetail` (~L132) expose a `fullPath: string` computed via `join()` → absolute paths (`C:/Users/Admin/.memory/...`). These are serialized in API responses (`server.ts` ~L593, ~L786, ~L824). Any dashboard client sees the operator's local filesystem layout.

---

## Scope guard

You will:

### Task 1 — Complete compile secret redaction (F-01)

- Extend `redactSecrets()` in `src/compile/execute.ts` to also redact:
  - Google API keys: `AIza[0-9A-Za-z_\-]{35}`
  - GitHub tokens: `gh[posru]_[0-9A-Za-z]{36,}` (covers `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`)
  - Bearer tokens: `Bearer\s+[A-Za-z0-9._\-]+` → `Bearer [REDACTED]`
  - PEM private keys: the `-----BEGIN ... PRIVATE KEY----- ... -----END ... PRIVATE KEY-----` multiline block (use a multiline/`[\s\S]` match)
  - Slack-style `xox[baprs]-…` (cheap to add; common)
- Keep the existing two regexes. Order so the assignment regex runs first.
- **Avoid false positives:** do not redact `max_tokens`, ordinary prose containing the word "secret", or short tokens. Anchor patterns to their real shapes; add a test asserting `max_tokens: 4096` and a sentence like "the API key rotation policy" survive.
- Add golden tests in `test/compile/execute.test.ts` for EACH pattern (AIza, gh*_, Bearer, PEM multiline, xox*) plus the false-positive guard.
- Update `docs/MEMORY-FORT-SPEC.md` §7 redaction line to list the now-implemented patterns (the spec currently says these are a "Phase 4.9 gap" — flip it to implemented).

### Task 2 — Exclude `.audit/` from MCP + all wiki-page surfaces (F-09)

- Import `isWikiDotDirectoryPath` (or the appropriate helper) from `src/retrieval/wiki-paths.ts` into `src/mcp/server.ts` and apply it in `listPages()`, `search` result assembly, and `read_page` (reject/omit any `wiki/.audit/` or `wiki/.<dir>/` path).
- Audit the dashboard loaders (`src/dashboard/loaders.ts`) and retrieval corpus for any other wiki-page enumeration that doesn't already exclude dot-dirs, and route them through the same shared filter. **One shared filter, applied everywhere** — grep for `endsWith(".md")` collection loops and verify each excludes dot-dirs.
- Tests: a fixture vault containing `wiki/.audit/llm-2026-05-29.md` → it does NOT appear in MCP `list_pages`/`search`/`read_page` results, nor in the dashboard wiki list. (Reuse/extend the dot-dir fixture pattern from the Phase 4.3.Q tests.)

### Task 3 — Return vault-relative paths from the dashboard API (F-16)

- Change `PageDetail` / `RawSessionDetail` (and any other API DTO) to expose a **vault-relative** path (e.g. `relPath: "wiki/projects/x.md"`) instead of, or in addition to, an absolute `fullPath`. Default responses must NOT contain absolute filesystem paths.
- If an absolute path is genuinely needed internally, keep it server-side and strip it before `writeJson`. If a debug affordance is wanted, gate absolute paths behind an explicit `?debug=1` + same-origin (optional; relative-by-default is the requirement).
- Update `test/dashboard/server.test.ts` (~L562-614) to assert responses contain relative paths and **no** `C:/`, `/root/`, or home-dir prefixes.

You will **not**:

- Add raw-capture redaction in this brief — raw stays verbatim (documented in spec §20). A raw-redaction opt-in is a separate future item.
- Change the compile append-only / grounding / confidence logic (Phase 4.4/4.6) — only the redaction regex set.
- Re-architect the MCP server or dashboard — just apply the existing shared filter and swap path fields.
- Remove `fullPath` if internal callers depend on it — repoint them to a server-side value; only the API surface must be relative.
- Weaken same-origin or any existing guard.

If completing PEM multiline redaction risks catastrophic backtracking on large bodies, **stop and ask** — use a bounded, non-greedy match or a line-scan rather than a vulnerable regex.

---

## Repo orientation

- `src/compile/execute.ts` ~L319-323 — `redactSecrets()`.
- `src/retrieval/wiki-paths.ts` — `isWikiDotDirectoryPath` shared filter (reuse, don't reimplement).
- `src/mcp/server.ts` ~L154-204 — `listPages()` + search/read handlers.
- `src/dashboard/loaders.ts` ~L97-136 — `PageDetail`/`RawSessionDetail` + `fullPath`.
- `src/dashboard/server.ts` ~L593, 786, 824 — `writeJson` of those DTOs.
- Tests: `test/compile/execute.test.ts`, `test/mcp/server.test.ts`, `test/dashboard/server.test.ts`.

---

## Acceptance contract

1. `redactSecrets` redacts AIza, gh*_, Bearer, PEM, xox*, plus the existing two patterns; `max_tokens` and benign prose survive; golden tests per pattern.
2. `wiki/.audit/*` never appears in MCP `list_pages`/`search`/`read_page` or the dashboard wiki list; one shared filter used everywhere.
3. Dashboard API responses contain vault-relative paths and no absolute filesystem paths by default.
4. Spec §7 redaction line updated to match the implementation.
5. Full suite + `npm run typecheck` green; build + build:ui clean; `git diff --check` clean.

---

## Commit boundaries

- Task 1: `fix: complete compile secret redaction (AIza/gh/Bearer/PEM/xox) (Phase 4.9 Task 1)`
- Task 2: `fix: exclude wiki/.audit from MCP + dashboard wiki surfaces (Phase 4.9 Task 2)`
- Task 3: `fix: dashboard API returns vault-relative paths, not absolute (Phase 4.9 Task 3)`
