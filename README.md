# Memory Fort

Memory Fort is a cross-tool memory system: a single `~/.memory/` directory of
markdown files that Claude Code, Codex (desktop + CLI), and
Google Antigravity all read and write. No daemon, no ports,
no database - just files + Karpathy LLM Wiki + a thin stdio
MCP server spawned per-session by the host tool.

**Status:** Phases 0–4.15 shipped — provider abstractions, retrieval (6-stream RRF), propose/promote pipelines, local writable dashboard + hosted read-only mirror, autonomous compile execution (opt-in), memory feedback loop, secret redaction + leak-surface hardening, config validation, and fail-closed hosted backups. See
[docs/MEMORY-FORT-SPEC.md](docs/MEMORY-FORT-SPEC.md)
for the current full system specification.

## Phase 1 quickstart (when shipped)

```bash
npm install
npm run build
node dist/cli.mjs init
node dist/cli.mjs install claude-code
node dist/cli.mjs install codex
node dist/cli.mjs install antigravity
node dist/cli.mjs stats
```

## Supported tools

```bash
memory-fort install claude-code     # Claude Code (full hooks + plugin)
memory-fort install codex           # Codex desktop + CLI (hooks + MCP)
memory-fort install antigravity     # Google Antigravity / Gemini (MCP + live-capture plugin)
memory-fort install hermes          # Hermes agent (YAML hooks + MCP in ~/.hermes/config.yaml)
memory-fort install pi              # Pi coding agent (YAML hooks in ~/.pi/config.yaml)
memory-fort install openclaw        # OpenClaw (MCP server in ~/.openclaw/openclaw.json)
memory-fort install claude-desktop  # Claude Desktop (MCP only)
memory-fort install vscode          # VS Code (MCP only)
```

## Development checks

Before merging changes, run the focused tests for the touched area, then:

```bash
npm run typecheck
npm run build
npm run build:ui
```

## Running the dashboard

The local dashboard is the canonical place for write actions because it serves
`--root`, `MEMORY_ROOT`, or `~/.memory` directly and can commit vault changes. Build the UI
once, then start the local server:

```bash
npm run build:ui
memory dashboard --root ~/.memory
```

The command binds `127.0.0.1:4410` by default and prints the `/memory/` URL plus the selected vault root.
A hosted dashboard can remain useful for reading, browsing, search, and backup
visibility, but write actions should stay disabled there when the hosted vault
checkout is a read-only mirror without its own `.git` work tree. Point CLI/MCP
remote search at it with `dashboard.url` in `config.yaml` or the
`--dashboard-url` flag.

## Compile and sync safety

`memory compile` still defaults to artifact mode: it assembles the prompt and
prints it, or writes it with `--output`. `memory compile --execute` is the
opt-in autonomous path: it sends the prompt to the configured LLM, requires a
fenced `compile-ops` JSON block, grounds wiki/raw references, redacts secret
patterns, and only applies append-only/create operations. Low-confidence
operations are staged in `wiki/compile-proposed/`; `--execute --plan` previews
the operations without writing.

Reviewed vault mutations now auto-commit explicit paths and schedule the
existing debounced auto-push. This covers thread/procedure promote and reject,
thread/procedure proposal apply, and entity review/merge/reject actions. The
`sync.uncommitted-vault` verify check warns when vault changes sit uncommitted
past the debounce window, and `compile.execute-health` reports the last
executed compile operation counts.

## Pruning

`memory prune --plan` reports archive-ready candidates without writing files.
`memory prune --apply` moves eligible files into
`wiki/archive/YYYY-MM-DD/<original vault path>` and marks matching embeddings
with `archived: true` so they can be restored cheaply. `memory prune --restore <path>`
moves an archived file back to its original active path.

Pruning policy is intentionally narrow: wiki pages must be stale, orphaned, and
below `confidence: 0.5`; raw observations must be older than 90 days and
unreferenced by wiki pages. Crystals are never automatically pruned.

## Environment variables

- `MEMORY_FORT_INJECTION_CONF_FLOOR`: minimum confidence for pages injected by
  the session-start hook. Defaults to `0`, which injects all index entries.
  Set to `0.5` to suppress low-confidence drafts from the startup context.
- `MEMORY_FORT_SPREADING_ACTIVATION`: enables the associative graph retrieval
  stream. Defaults to `true`; set to `false`, `0`, or `off` to benchmark search
  with only the original one-hop graph expansion.

## License

Personal use - not packaged for public consumption.
