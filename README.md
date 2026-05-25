# Memory Fort

Memory Fort is a cross-tool memory system: a single `~/.memory/` directory of
markdown files that Claude Code, Codex (desktop + CLI), and
Google Antigravity all read and write. No daemon, no ports,
no database - just files + Karpathy LLM Wiki + a thin stdio
MCP server spawned per-session by the host tool.

**Status:** Phase 1 in progress. See
[docs/superpowers/specs/2026-05-20-cross-tool-memory-system-design.md](docs/superpowers/specs/2026-05-20-cross-tool-memory-system-design.md)
for the design and
[docs/superpowers/plans/2026-05-20-phase-1-foundation-plan.md](docs/superpowers/plans/2026-05-20-phase-1-foundation-plan.md)
for the current implementation plan.

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

## Environment variables

- `MEMORY_FORT_INJECTION_CONF_FLOOR`: minimum confidence for pages injected by
  the session-start hook. Defaults to `0`, which injects all index entries.
  Set to `0.5` to suppress low-confidence drafts from the startup context.
- `MEMORY_FORT_SPREADING_ACTIVATION`: enables the associative graph retrieval
  stream. Defaults to `true`; set to `false`, `0`, or `off` to benchmark search
  with only the original one-hop graph expansion.

## License

Personal use - not packaged for public consumption.
