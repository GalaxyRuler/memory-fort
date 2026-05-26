# Codex Implementation Brief — Client Reach + agentmemory Migration

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Two related gaps in Memory Fort's completeness:

1. **Client reach** — every AI surface the user works in (Codex CLI, Antigravity workspace, Antigravity IDE, VS Code with native MCP, plus the already-supported Claude Code and Claude Desktop) needs a working install command. Missing/incomplete clients aren't reading from or writing to Memory Fort, which means the unified-memory promise leaks.

2. **Data migration** — the legacy `agentmemory` project at `C:\CodexProjects\agentmemory` still owns all historical observations (`data/state_store.db/`, `data/stream_store/` — a custom binary KV store with ~thousands of entries). The user has decided agentmemory is going away. All of its content needs to be migrated into the Memory Fort vault before that retirement.

Both tasks land in this single brief because they share the same prerequisite (Memory Fort being the canonical memory layer) and the same verification path (doctor + dashboard count checks).

---

## Scope guard

You will:

- **Task A — Clients**
  - Audit existing install commands; verify each still works end-to-end
  - Add a `vscode` client installer (`src/cli/commands/install/vscode.ts`)
  - Investigate whether **Antigravity IDE** uses a different MCP config location than the Antigravity workspace; add a separate installer if so, otherwise extend the existing one
  - Add a unified `memory connect --all` command that runs every available installer in sequence
  - Extend `memory doctor` to report connection status for each client (✓ installed and config valid, ⚠ installed but stale, ✗ not installed)

- **Task B — Migration**
  - Add `memory import-agentmemory` CLI command with `--plan` (dry-run) and `--apply` modes
  - Read agentmemory's binary KV store using a small embedded reader (the format is custom — see investigation below)
  - Map every entry to a Memory Fort wiki page with full metadata preservation
  - Dedupe against existing Memory Fort pages by content-hash + title
  - Write a migration audit log to `wiki/.audit/agentmemory-migration-{timestamp}.md`

You will **not**:

- Modify any code inside `C:\CodexProjects\agentmemory` (it's retiring; treat it as read-only)
- Touch the Memory Fort dashboard, search pipeline, conflict detection, or pruning code
- Change the existing install commands' config schemas (additive only)
- Auto-delete agentmemory data after migration — leave the source intact for user-driven cleanup
- Introduce new dependencies for the migration; use existing `node:fs` / `node:crypto` / `zod` if needed

If the migration uncovers a data shape you can't faithfully map (e.g., agentmemory's 4-tier consolidation snapshots), **stop and ask** rather than dropping data.

---

## Repo orientation (verified before brief)

### Existing client installers
`src/cli/commands/install/`:
- `antigravity.ts` — writes to `~/.gemini/antigravity/mcp_config.json` (Antigravity workspace)
- `claude-code.ts` — creates the Claude Code plugin manifest + hooks.json + plugin .mcp.json
- `claude-desktop.ts` — writes to Claude Desktop's mcp.json
- `codex.ts` — writes a block into `~/.codex/config.toml` and registers the MCP server

Each has a test under `test/cli/commands/install-*.test.ts`. `memory doctor` in `src/cli/commands/doctor.ts` already cross-checks claude-code; extend the pattern.

### agentmemory data layout (verified)

Path: `C:\CodexProjects\agentmemory\data\`

- `state_store.db/` — directory (not a SQLite file). Contains URL-encoded binary KV entries:
  - `mem%3Amemories.bin` (decoded: `mem:memories`) — primary memory registry
  - `mem%3Aobs%3A<uuid>.bin` (`mem:obs:<uuid>`) — individual observations
  - `mem%3Aaccess.bin`, `mem%3Aaudit.bin`, `mem%3Ahealth.bin`, `mem%3Aindex%3Abm25.bin`, `mem%3Ainsights.bin`, `mem%3Ametrics.bin` — auxiliary stores
- `stream_store/` — append-only streams with URL-encoded keys (`stream%3Amem-live%3A<uuid>.bin`)

The encoding format is implemented in `agentmemory/src/state/kv.ts`, `schema.ts`, `index-persistence.ts`. The exact binary format must be decoded by reading the agentmemory source as reference; do not import its compiled output.

Key insight: filename encoding is **percent-encoding** (`%3A` = `:`, `%2F` = `/`). Decode filename → store key, then decode the file's binary contents.

---

## Task A — Client reach

### A1. Audit existing installers

Run each install command against a clean fixture environment and verify:
- Config file is created/merged correctly
- MCP server entry points to the right script
- Server is reachable (smoke-test invokes the MCP server's stdio handshake)

Update tests where the smoke test reveals gaps. No commit until all four existing installers are confirmed green.

### A2. VS Code installer

VS Code added native MCP support in late 2025 / early 2026. Configuration locations:

- **Global** (per-user): `%APPDATA%\Code\User\settings.json` on Windows, with key `"chat.mcp.servers"` or the dedicated `"mcp.servers"` map (verify against current VS Code docs)
- **Workspace-scoped**: `.vscode/mcp.json` in the project root

The installer:
- Defaults to global settings (per-user reach)
- Accepts `--workspace <path>` to install workspace-scoped instead
- Adds an entry named `memory` pointing at the installed MCP server (`node ${install-dir}/dist/hooks/mcp-server.mjs`)
- Preserves existing entries; replaces the `memory` entry on re-install
- Falls back gracefully if VS Code isn't installed (print a clear message, exit 0)

**Files**:
- New: `src/cli/commands/install/vscode.ts`
- New: `test/cli/commands/install-vscode.test.ts` — covers create-when-absent, merge-preserving-others, replace-on-reinstall, workspace flag, fallback path

### A3. Antigravity IDE — investigation + installer

The existing `antigravity.ts` targets the **Antigravity workspace** (`~/.gemini/antigravity/`). The **Antigravity IDE** is Google's separate IDE product; it may use a different MCP config path (likely under the IDE's own settings, not the workspace's). 

Investigate:
1. Where the Antigravity IDE stores its config (likely `%APPDATA%\Antigravity\` or `~/.antigravity-ide/` on Windows — verify)
2. Whether MCP server registration uses the same JSON shape as the workspace or a different one
3. Whether one config can cover both surfaces or they must be separate

Outcome (one of):
- **If shared config**: extend `antigravity.ts` with a `--surface ide|workspace|both` flag (default `both`)
- **If separate config**: add a new `src/cli/commands/install/antigravity-ide.ts`

**Files**:
- Either: modify `antigravity.ts` + its tests
- Or: new `antigravity-ide.ts` + `test/cli/commands/install-antigravity-ide.test.ts`

### A4. `memory connect --all` command

A single command that runs every available installer non-interactively.

- `memory connect` → runs all six (claude-code, claude-desktop, codex, antigravity workspace, antigravity IDE, VS Code) and reports a summary table:
  ```
  ✓ claude-code        installed (manifest fresh)
  ✓ claude-desktop     installed
  ✓ codex              installed
  ✓ antigravity        installed
  ✗ antigravity-ide    not installed: IDE not found on disk
  ✓ vscode             installed (global settings)
  ```
- `memory connect <client>` → runs only one
- `memory connect --workspace <path>` → propagates `--workspace` to clients that support it (VS Code)
- Exits non-zero only if every installer fails; partial failures print warnings but return 0 (user-friendly)

**Files**:
- New: `src/cli/commands/connect.ts`
- Register in `src/cli.ts`
- New: `test/cli/commands/connect.test.ts`

### A5. Doctor — connection reporting

Extend `src/cli/commands/doctor.ts` so the report includes a `clients:` section listing each client and its install status. Use the same logic as `connect` but read-only.

**Files**:
- Modify `src/cli/commands/doctor.ts`
- Update `test/cli/commands/doctor.test.ts`

---

## Task B — agentmemory migration

### B1. Binary KV reader

Build a small reader that opens agentmemory's `state_store.db/` directory and yields `(key, value)` pairs.

- Decode filenames from percent-encoding to get the real key
- Read each `.bin` file and parse the value. The exact serialization is implemented in `agentmemory/src/state/kv.ts`; **read that source code** to learn the format, then re-implement the decoder in Memory Fort. Do not import the agentmemory package.
- If you discover the format is a known wire format (CBOR, MessagePack, JSON-LD, raw JSON, Buffer-encoded JSON), use the equivalent standard decoder.

**Files**:
- New: `src/migration/agentmemory-kv-reader.ts`
- New: `test/migration/agentmemory-kv-reader.test.ts` — uses fixtures copied from a small subset of the real store (3–5 files anonymized)

### B2. Memory mapping

For each entry in the agentmemory store, map to a Memory Fort wiki page:

| agentmemory key prefix | Memory Fort destination | Notes |
|---|---|---|
| `mem:memories` (registry) | scan to discover all memory IDs and their categories | This is the index |
| `mem:obs:<uuid>` | `wiki/raw/{YYYY-MM-DD}/{source}-{id}.md` | Raw observations |
| Consolidated entries (look for `mem:consolidated:*` or similar) | `wiki/{category}/{slug}.md` | Decisions, lessons, references, tools |
| Crystals (`mem:crystals:*` or in `mem:insights`) | `wiki/crystals/{slug}.md` | Distilled insights |
| Procedural (`mem:routines:*` or similar) | `wiki/lessons/{slug}.md` | Workflows as lessons |

Frontmatter to preserve:
- `type`, `title`, `created`, `updated`, `status`, `confidence`, `tags`, `relations`, `source`
- New optional field: `imported_from: agentmemory` with the original key
- Set `cognitive_type` based on the inference rules from the galactic-graph brief (if that brief lands first) — otherwise default `semantic`

### B3. Deduplication

Before writing a target file:

1. Compute SHA-256 hash of normalized body (lowercase, whitespace-collapsed)
2. Check Memory Fort's existing pages for a matching hash OR matching title
3. On match:
   - If existing page is **newer or equal mtime**: skip with `[dedup-skipped]` log entry
   - If existing page is **older**: write the incoming version with `.imported` suffix, leave both for user triage (don't auto-overwrite)
4. On no match: write the file as new

### B4. CLI command

```
memory import-agentmemory --from C:/CodexProjects/agentmemory/data --plan
memory import-agentmemory --from C:/CodexProjects/agentmemory/data --apply
```

- `--plan` writes nothing; emits a report listing what would be imported, skipped (dedup), or flagged (conflict). Counts per destination category.
- `--apply` performs the migration. Always emits the same plan report PLUS an audit log written to `wiki/.audit/agentmemory-migration-{ISO-timestamp}.md` recording every file written, skipped, or conflicted.
- Idempotent: running `--apply` twice should write nothing on the second run (full dedup hit).

**Files**:
- New: `src/cli/commands/import-agentmemory.ts`
- New: `src/migration/map-agentmemory.ts` — pure mapping logic (testable)
- Register in `src/cli.ts`
- New: `test/cli/commands/import-agentmemory.test.ts`
- New: `test/migration/map-agentmemory.test.ts`

### B5. Verification

After `--apply` completes:

- Run `memory compile` to re-index BM25/embeddings/graph
- Dashboard `/api/status` counts should reflect new pages
- `memory search` should find imported content
- All 595+ tests still green
- No regressions in conflict detection (imported pages may legitimately surface as duplicates of pre-existing Memory Fort pages — that's the expected dedup-flagging behavior)

---

## Execution order

1. **A1 audit** — confirm existing installers still work (lowest risk, builds confidence)
2. **A2 VS Code** — biggest gap in client reach
3. **A3 Antigravity IDE** — investigation outcome dictates whether 1 file or 2
4. **A4 connect command** — wires everything up
5. **A5 doctor reporting** — surfaces install state in `memory doctor`
6. **B1 KV reader** — foundation for migration
7. **B2 mapping + B3 dedup + B4 CLI** — single feature
8. **B5 verification** — run migration on the real data, confirm dashboard reflects it

Each numbered group lands as one commit. Run `npx vitest run` between every commit.

---

## Build / test / deploy

```
npx vitest run                                # full suite
npx vitest run test/cli/commands/install-     # client installers
npx vitest run test/migration                 # migration only
npm run build                                 # everything
npm run build:ui                              # SPA + route tree
npm run memory -- install-vps                 # ship
```

Then trigger the real migration:

```
memory import-agentmemory --from C:/CodexProjects/agentmemory/data --plan
# review the plan, then:
memory import-agentmemory --from C:/CodexProjects/agentmemory/data --apply
memory compile
```

---

## Acceptance checklist

- [ ] All four existing installers (claude-code, claude-desktop, codex, antigravity workspace) audited and confirmed green
- [ ] `install/vscode.ts` lands with tests covering global + workspace modes
- [ ] Antigravity IDE situation resolved (either extended workspace installer OR new IDE installer)
- [ ] `memory connect --all` works and reports per-client status
- [ ] `memory doctor` includes a `clients:` block with status per client
- [ ] `memory import-agentmemory --plan` produces a meaningful report against the real agentmemory data
- [ ] `memory import-agentmemory --apply` populates wiki pages with preserved frontmatter
- [ ] Dedupe correctly skips duplicate imports on second run
- [ ] Audit log written to `wiki/.audit/agentmemory-migration-*.md`
- [ ] Dashboard `/api/status` count of `wiki` pages increases by the imported amount
- [ ] No secrets committed, no OneDrive paths anywhere
- [ ] 595+ tests still green; new tests added for every new module

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.
