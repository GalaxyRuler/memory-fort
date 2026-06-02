# Codex Implementation Brief — Claude Code Hook-Firing Fix + Capture Watchdog (Phase 4.34)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Two parts. Task 1 fixes the **active** bug: Claude Code captures stopped on 2026-05-31 and a brand-new session still writes nothing. Task 2 adds a **watchdog** so an installed-but-not-firing client can never again hide as a soft warn — the exact 4-day-silent-outage class this whole observability arc began with.

---

## The bug (verified live 2026-06-02)

- `memory verify` shows `client.claude-code.enabled: pass`, plugin `memory@memory-local` enabled, MCP present, `hooks.json` registers all 5 events (SessionStart, UserPromptSubmit, PostToolUse, PreCompact, Stop).
- **Direct invocation of the hook script writes a capture:** piping a synthetic `PostToolUse` payload to `~/.memory/claude-code-plugin/scripts/post-tool-use.mjs` produces `raw/<today>/claude-code-*.md`. The script is healthy.
- **Claude Code is not invoking it.** `raw/2026-06-02/claude-code-*.md` count = 0 despite a heavy tool-use session AND a fresh session window. Newest claude-code capture is **2026-05-31**. Codex (9 today) and Antigravity (ok) capture fine — only Claude Code is dark.
- Capture warns also on `vscode` and `claude-desktop` (no capture 24h) — confirm those are merely idle, not the same firing bug.

### Prime suspect — plugin hook resolution
`~/.memory/claude-code-plugin/.claude-plugin/plugin.json`:
```json
{ "name": "memory", "version": "0.1.0", "hooksPath": "../hooks/hooks.json", "mcpConfig": "../.mcp.json" }
```
`~/.memory/claude-code-plugin/hooks/hooks.json` commands use `node ${CLAUDE_PLUGIN_ROOT}/scripts/<hook>.mjs`.

Hypotheses to test, in order:
1. **`hooksPath`/`mcpConfig` `../` escape.** The manifest sits in `.claude-plugin/` and points *up and over* (`../hooks/...`). Current Claude Code plugin spec may require the hooks file inside the plugin-manifest dir, an inline `hooks` array, or a `./`-relative path. A `../` that escapes the manifest dir may be silently rejected (MCP still loads because `mcpConfig` is read differently than hooks).
2. **`CLAUDE_PLUGIN_ROOT` mismatch.** The marketplace install `memory@memory-local` may expose the plugin from a cached/symlinked root whose `scripts/` differs from `~/.memory/claude-code-plugin/scripts/`. If `${CLAUDE_PLUGIN_ROOT}` resolves somewhere without the scripts, the command no-ops or errors silently.
3. **`settings.json` `hooks: []`.** User settings has an empty `hooks` array — confirm it does not shadow/override plugin-provided hooks in the current Claude Code precedence rules.

### Task 1 — fix it, then prove it from a real session
1. **Ground against the current spec first** (lesson #1/#5): check the live Claude Code plugin-hooks documentation (use the `claude-code-guide` agent or context7 for "Claude Code plugin hooks", "CLAUDE_PLUGIN_ROOT", "plugin.json hooksPath") to learn the *current* required manifest shape. Do not guess from this repo's existing format — it may be stale.
2. Fix the plugin manifest + `hooks.json` to whatever the current spec requires (likely: hooks inside the `.claude-plugin/` dir or an inline `hooks` block; `${CLAUDE_PLUGIN_ROOT}`-relative script paths confirmed to resolve). Update the installer (`src/cli/commands/install/` claude-code path) and `memory connect` so a fresh install emits the correct shape.
3. Add a **drift guard**: `memory verify` (or `memory doctor`) should parse the installed `plugin.json` + `hooks.json` and assert the hook command paths resolve to existing files under the *actual* plugin root, not just that the files exist somewhere. A registered hook whose command path doesn't resolve = FAIL.
4. **Acceptance is a real session, not a direct invoke** (lesson #2/#3): after the fix + reinstall, the operator opens a fresh Claude Code window and runs one tool. Assert `raw/<today>/claude-code-*.md` appears. The brief is NOT accepted on a piped-payload test alone — that already passes today and hid the bug. If you cannot drive a real Claude Code session headlessly, emit a precise operator step and have the watchdog (Task 2) confirm the result on next verify.

### Task 2 — capture watchdog (close the silent-outage class)
Escalate the capture check so "installed but never firing" cannot read as a soft warn.

In the verify capture checks (`src/cli/commands/verify/` client/sniffer capture rules):
- Today: `client.<x>.capture` warns on "no capture file in last 24h". That is correct for an *idle* client.
- Add a distinct **FAIL** condition: a client is **enabled/installed** (its `.enabled`/`.config` check passes) **AND** has produced **zero** captures in the last `CAPTURE_STALE_FAIL_DAYS` (default 3) **AND** has captured at least once historically (so genuinely-never-used clients stay warn, not fail). Installed + previously-working + now-silent-for-3-days = **FAIL**, because that is an outage, not idleness.
- Distinguish the two in the detail string: `idle (no capture 24h, last seen <date>)` warn vs `OUTAGE: enabled but no capture in N days (last seen <date>)` fail.
- Make `CAPTURE_STALE_FAIL_DAYS` a named constant; document it. Per-client overrides optional (Claude Desktop / VS Code may be used rarely — if so, keep them warn-only and justify with a comment; do not blanket-fail rarely-used clients).
- Surface the same signal on the dashboard health card so it is visible without running the CLI.

### Task 3 — backfill the gap (optional, operator-gated)
Claude Code captures are missing 2026-05-31 → now. If a backfill store exists (`sniffer.claude-code.backfill: pass` suggests one), offer `memory backfill --client claude-code --since 2026-05-31 --plan` to recover the lost sessions from the local Claude Code transcript store. Plan only; operator approves apply. Do not fabricate captures.

---

## You will NOT
- Accept Task 1 on a piped-payload hook test — that passes today and masked the outage. Acceptance is a real fresh-session capture file.
- Blanket-fail rarely-used clients (Claude Desktop, VS Code) for idleness — only fail enabled + previously-capturing + now-silent-N-days.
- Guess the Claude Code plugin manifest shape from this repo's current (possibly stale) format — verify against current Claude Code docs first.
- Fabricate or backfill captures without operator approval.
- Touch Codex/Antigravity hook wiring — they capture fine; don't regress them.

## Stop and ask
1. Current Claude Code plugin spec wants a manifest shape that breaks Codex/Antigravity's shared installer assumptions — confirm the cross-client install refactor before landing.
2. The backfill store does not actually contain the 2026-05-31→now Claude Code sessions — report the real recoverable range; do not invent.
3. Making the watchdog FAIL would flip `verify` to exit 1 on a vault where a client is legitimately retired — add a `clients.<x>.retired: true` config opt-out rather than weakening the threshold.

## Acceptance
- A fresh Claude Code session writes `raw/<today>/claude-code-*.md` (operator-confirmed; show the file path + first lines).
- `memory verify` hook-path drift guard FAILs when a registered hook command resolves to a missing script (unit-tested with a broken fixture).
- Capture watchdog: unit tests prove enabled+silent-3-days+previously-captured → FAIL; enabled+never-captured → warn; idle-24h → warn.
- Codex + Antigravity capture checks still PASS (no regression).
- Full suite + typecheck + build clean.

## Commit boundaries
- Task 1: `fix(install): correct claude-code plugin hook registration so hooks fire (Phase 4.34 Task 1)`
- Task 1 guard: `feat(verify): assert plugin hook command paths resolve (Phase 4.34 Task 1)`
- Task 2: `feat(verify): capture watchdog — fail on enabled-but-silent client outage (Phase 4.34 Task 2)`
- Task 3 (if done): `feat(backfill): recover claude-code capture gap since 2026-05-31 (Phase 4.34 Task 3)`
