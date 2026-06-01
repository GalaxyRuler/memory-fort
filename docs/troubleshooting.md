# Troubleshooting

Top failure modes per platform with diagnosis steps. Start with `memory doctor` and `memory tail-errors` for the broadest signals.

## Universal first checks

```bash
memory doctor              # structural health
memory stats               # file counts + install status
memory tail-errors         # live errors.log (Ctrl+C to exit)
```

If `memory doctor` shows failures, follow the hint on each `✗` line — most are "run X to fix."

If `errors.log` has recent entries, the hook command failed but didn't break the host session. Each entry has timestamp + hook name + message + stack — usually enough to diagnose.

---

## Using `memory verify` for diagnostics

`memory verify` runs structural + operational checks for your role and prints a `✓ / ⚠ / ✗` line per check with a fix hint.

```bash
memory verify                  # all checks for your role (default: operator)
memory verify --role server    # vault / sync / search / dashboard only (no client-capture checks)
memory verify --dashboard-url https://<whitedragon-host>/memory
memory verify --remote-name whitedragon
memory verify --json           # machine-readable
```

Checks worth knowing when something looks off:

- **`storage.atomic-write-retries`** — Windows file-write retry rate. Transient `EPERM/EACCES/EBUSY/ENOENT` are retried automatically (50/150/400 ms); a high rate (≥10%) points at Defender/OneDrive/file-lock contention.
- **`sync.uncommitted-vault`** — warns when vault mutations sit uncommitted >10 min (a write that bypassed the commit path). Run `memory sync`.
- **`config.valid`** — `config.yaml` parses + validates. A malformed file is reported here instead of silently reverting to defaults.
- **`compile.recent`** — fails when compile is >1 week stale. Run `memory compile --execute` (or the dashboard "Run compile now").
- **`compile.execute-health`** — executed-compile success/strip rate.
- **`retrieval.intent-classifier-health`** — query-intent classifier readiness.
- **`git.remote`** — checks the configured vault sync remote. If your remote is not named `vps`, set `sync.remote_name` in `config.yaml` or pass `--remote-name`.

Note: `/api/health` returns 503 when any check fails (including data-quality checks like `graph.cohesion`), so a 503 doesn't always mean the server is down — read the failing check.

---

## Symptom: local dashboard says "can't be reached" or shows the wrong vault

Build the UI bundle, start the dashboard explicitly, and check the printed vault root:

```powershell
npm run build:ui
memory dashboard --root "C:\Users\Admin\OneDrive\Documents\Memory Fort" --no-open
```

Then open `http://127.0.0.1:4410/memory/`. If the command reports a different port because 4410 is busy, open the printed URL instead.

If you start the dashboard from a background PowerShell process, prefer `--root` over assigning `MEMORY_ROOT` inside a quoted command string. It avoids accidental early interpolation of `$env:MEMORY_ROOT` and makes the selected vault visible in stdout. Pass the root as one quoted `--root=...` argument so paths with spaces stay intact:

```powershell
$root = "C:\Users\Admin\OneDrive\Documents\Memory Fort"
$out = Join-Path $env:TEMP "memory-dashboard.out.log"
$err = Join-Path $env:TEMP "memory-dashboard.err.log"
Start-Process -FilePath "node" `
  -ArgumentList @("dist/cli.mjs", "dashboard", "`"--root=$root`"", "--no-open") `
  -WorkingDirectory "C:\CodexProjects\memory-system" `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err `
  -WindowStyle Hidden
```

---

## Symptom: hooks don't fire when I use Claude Code / Codex

### Step 1: Verify the install

```bash
memory doctor
```

`claude-code plugin manifest` and `scripts symlink resolves` checks must both pass.

If `scripts symlink resolves` fails:
- The symlink at `~/.memory/claude-code-plugin/scripts/` points at `<source-repo>/dist/hooks/`. If you rebuilt with `npm run build` and the dist directory was cleaned, the symlink may be intact but the target's contents changed. Usually self-healing.
- If the symlink itself is broken (target moved/deleted), `memory install claude-code` recreates it.

### Step 2: Verify the plugin was loaded by Claude Code

```bash
claude --plugin-dir C:/Users/Admin/.memory/claude-code-plugin --debug-file /tmp/claude.log -p "ping" --allowedTools "Bash"
grep -iE "memory|plugin|hook" /tmp/claude.log | head -20
```

Look for:
- `Loaded inline plugin from path: memory` — plugin recognized
- `Loading hooks from plugin: memory` — hooks registered
- `Plugin claude-code-plugin has an invalid manifest file` — manifest schema mismatch (re-run install)

### Step 3: Verify hook scripts are reachable

```bash
ls ~/.memory/claude-code-plugin/scripts/*.mjs
```

Should list five hook scripts. If empty, run `npm run build` in the source repo and `memory install claude-code` again.

### Step 4: Try a fresh real session

After install, the simplest verification is to spawn a headless session:

```bash
claude --plugin-dir C:/Users/Admin/.memory/claude-code-plugin -p "Use the Bash tool to echo hello"
ls ~/.memory/raw/$(date -u +%Y-%m-%d)/
```

A new `claude-code-<session-uuid>.md` file should appear.

---

## Symptom: MCP tools (memory.log_observation, etc.) don't appear in my session

### Claude Code

In an active Claude Code session, ask the LLM: "What MCP tools do you have available?" If memory tools aren't listed:

```bash
# Verify the plugin's .mcp.json exists and is well-formed
cat ~/.memory/claude-code-plugin/.mcp.json

# Verify the MCP server script exists
ls ~/.memory/claude-code-plugin/scripts/mcp-server.mjs

# Check Claude Code's MCP startup logs
claude --plugin-dir ~/.memory/claude-code-plugin --debug-file /tmp/c.log -p "ping"
grep -iE "mcp.*memory|memory.*mcp" /tmp/c.log
```

Look for `MCP server "plugin:memory:memory": Successfully connected (transport: stdio)`.

The MCP tool name inside a session is `mcp__plugin_memory_memory__log_observation` (double "memory" — once for source namespace, once for server name). If you allow-list MCP tools, use that full name.

### Codex desktop / CLI

```bash
codex mcp list
# Should show: memory: node C:/Users/Admin/.memory/claude-code-plugin/scripts/mcp-server.mjs - ✓ Connected
```

If absent, verify the install:

```bash
grep -A5 "mcp_servers.memory" ~/.codex/config.toml
```

If the block is malformed or absent, re-run `memory install codex`.

### Antigravity

```bash
cat ~/.gemini/antigravity/mcp_config.json
# Should contain: { "mcpServers": { "memory": { "command": "node", "args": [...] } } }
```

If the path looks right but Antigravity doesn't see the MCP, restart Antigravity desktop. Antigravity loads MCP configs at startup; in-session updates aren't picked up.

---

## Symptom: errors.log keeps growing

Run `memory tail-errors` in one terminal while you use Claude Code / Codex in another. Watch which hook is failing — every entry starts with `<timestamp> <hook-name> <message>`.

Common entries:
- `prompt-submit` ENOENT or permissions error → check that `~/.memory/raw/` is writable
- `post-tool-use` JSON parse error → Claude Code or Codex sent a payload shape we don't expect (rare; file a follow-up)
- `mcp-server` errors → typically schema validation failures on MCP tool input

If errors.log > 100 KB, `memory doctor` flags it. Investigate, fix the root cause, then truncate:

```bash
# After understanding what was failing
echo "" > ~/.memory/errors.log
```

---

## Symptom: raw file source is wrong tool (e.g., Codex session attributed to "claude-code")

`detect-tool.ts` reads env vars to identify the platform. Each platform sets:
- Claude Code: `CLAUDECODE=1`
- Codex: `CODEX_AGENT=1` or `CODEX_HOME`
- Antigravity: `ANTIGRAVITY_AGENT=1` or `GEMINI_AGENT=1`

If detection misfires, the env var your platform actually sets may differ from what the script checks. Workaround: set the env var explicitly in your shell before launching the agent. Long-term: file a follow-up so the detect-tool heuristic gets updated.

---

## Symptom: Permission errors on Windows

- **Junction creation failed during install** — junctions (Windows directory symlinks) don't require admin, but Defender / antivirus may block them on the first try. Run install again. If still failing, you can `mklink /J` manually.
- **`~/.memory/` is under OneDrive** — DO NOT install memory under a OneDrive-synced path. OneDrive's file locking will fight with hook script writes. Move `~/.memory/` outside OneDrive (override via `MEMORY_ROOT` env var, OR detach OneDrive from your home dir).

---

## Symptom: install command leaves my real `~/.claude/` or `~/.codex/` modified by accident

This shouldn't happen, but if it does:

- For `~/.claude/.mcp.json` — the install no longer writes there (Phase 1 step #7-fix-2). If it exists with a `memory` entry, the next `memory install claude-code` will migrate/remove it.
- For `~/.codex/config.toml` — our content is bracketed by sentinel markers `# === BEGIN memory-system v<VERSION> ===` and `# === END memory-system v<VERSION> ===`. To remove manually, delete the lines between (and including) those markers. Re-running `memory install codex` will append a fresh block.
- For `~/.gemini/antigravity/mcp_config.json` — our entry is `mcpServers.memory`. Delete that key, leaving other entries intact.

---

## Symptom: `memory grep` says "ripgrep not found"

The grep command requires `rg` on PATH. Install ripgrep from https://github.com/BurntSushi/ripgrep/releases or via your package manager (`winget install BurntSushi.ripgrep.MSVC` on Windows).

Note: Claude Code includes ripgrep internally for its `Grep` tool, but that copy isn't on shell PATH. Install ripgrep system-wide.

---

## Symptom: `memory tail-errors` shows nothing even though hooks are failing

The watcher uses `fs.watch` which is unreliable on some Windows configurations (especially when the file lives on a network drive or is OneDrive-synced). Workaround:

```bash
# Alternative: open the file in an editor that auto-refreshes
code ~/.memory/errors.log
```

Or `tail -f` it with WSL / Git Bash if Node's watcher misbehaves.

---

## When all else fails

Read [follow-ups.md](follow-ups.md) — known issues with detailed hypotheses and phase-targeting. Your symptom may already be documented there with workarounds.

Beyond that:
- Full spec: [superpowers/specs/2026-05-20-cross-tool-memory-system-design.md](superpowers/specs/2026-05-20-cross-tool-memory-system-design.md)
- Implementation plan: [superpowers/plans/2026-05-20-phase-1-foundation-plan.md](superpowers/plans/2026-05-20-phase-1-foundation-plan.md)

If you genuinely hit a wall, the safe recovery is:
```bash
# Backup current state
cp -r ~/.memory ~/.memory.backup-$(date +%s)
# Re-init (preserves files, but you can --reset for fresh)
memory init
# Re-install platforms
memory install claude-code
memory install codex
memory install antigravity
```
