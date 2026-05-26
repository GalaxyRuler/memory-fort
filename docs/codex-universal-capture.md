# Codex Implementation Brief — Universal Capture Coverage

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Memory Fort today auto-captures only from clients that expose lifecycle hooks. That's Codex CLI (working) and Claude Code (broken — Task 1 of `codex-installer-hooks-and-graph-bugs.md` fixes it). Antigravity, Claude Desktop, and VS Code currently have zero capture, despite the user being active in all three.

**The good news**: every one of these clients DOES expose a usable capture surface — we just haven't built the adapters yet. Online research confirms:

- **Antigravity 2.0 SDK** ([introduced May 19, 2026](https://antigravity.google/blog/introducing-google-antigravity-sdk)) ships **9 hook points** — session_start, session_end, pre_turn, post_turn, pre_tool_call, post_tool_call, tool_error_recovery, user_interaction, context_compaction — exposed as plugin decorators. This is the same hook model Claude Code uses, so a Memory Fort Antigravity plugin can mirror our existing claude-code plugin structure.
- **Claude Code stores every conversation** in `~/.claude/history.jsonl` (global) plus `~/.claude/projects/<project>/<session-id>.jsonl` (per-project). The "lost" 4 days of conversations are not actually lost — they're on disk. We can backfill historical sessions from this storage.
- **Claude Desktop logs** live at `%APPDATA%\Claude\logs` on Windows. Conversation history is in `%APPDATA%\Claude\` (web/desktop variant) or under the LocalCache path for Cowork. A file-watcher tails these.
- **VS Code Chat Participant API** lets an extension register as a chat participant and observe queries flowing through the chat panel. A Memory Fort VS Code extension is the path.

This brief delivers:
1. **Backfill from Claude Code's existing JSONL storage** (recovers history we thought was lost)
2. **Antigravity 2.0 plugin** with all 9 hooks
3. **Claude Desktop log watcher** (file-based capture)
4. **VS Code extension** implementing Chat Participant API
5. **`memory watch` daemon** that runs all the above sniffers continuously
6. **`memory backfill` command** for one-shot batch imports

When this brief lands, **every AI surface the user works in writes to Memory Fort**. The four-days-of-lost-Claude-conversations situation becomes structurally impossible.

---

## Scope guard

You will:

- Build sniffer adapters for Claude Code (backfill), Antigravity 2.0, Claude Desktop, VS Code
- Wire them through a common `Sniffer` interface
- Add `memory watch` and `memory backfill` CLI commands
- Reuse the existing `getMemoryBody`-style mapping pipeline so captured content lands in the same shape as Codex captures (frontmatter + sectioned body)
- Reuse the existing dedup logic from `import-agentmemory` so re-running backfill is idempotent

You will **not**:

- Reach into Claude Code / Claude Desktop / VS Code internal source code (we don't fork them)
- Modify the existing Codex MCP integration (it works)
- Build a global keylogger or system-wide watcher (privacy concern; only authorized client paths)
- Auto-import content that doesn't have clear provenance (must know which client + session)
- Send captured data anywhere other than the local vault (never the cloud)

If the Antigravity SDK isn't available on the user's machine (they may still be on Antigravity 1.x), the plugin should print a clear "upgrade Antigravity to 2.0" message and exit gracefully. Verify version at install time.

---

## Prerequisites verified at start of brief

- `~/.claude/projects/` exists on the user's machine. Each subdirectory is a project, containing `<session-id>.jsonl` files
- `~/.gemini/antigravity/` is the Antigravity workspace install (used by Antigravity 1.x). Antigravity 2.0 desktop app install path may differ — investigate at implementation
- `%APPDATA%\Claude\` (i.e. `C:\Users\Admin\AppData\Roaming\Claude\`) is Claude Desktop's data dir on Windows
- The existing `src/migration/map-agentmemory.ts` and `src/migration/agentmemory-kv-reader.ts` modules are the canonical pattern to follow for new sniffers — read source → normalize → write to vault

---

## Task 1 — Sniffer framework

### Why
Each client has a different storage format but the same downstream needs: parse → normalize → write to vault with proper frontmatter and dedup. Build a shared interface so each adapter only implements the parse step.

### Contract

```ts
// src/sniffers/types.ts
export interface Sniffer {
  name: string;                    // e.g. "claude-code", "antigravity", "claude-desktop", "vscode"
  available: () => Promise<boolean>;  // does this client appear to be installed?
  list: (opts: ListOpts) => AsyncIterable<RawSession>;
  watch?: (handler: (session: RawSession) => void) => Closable;  // optional live mode
}

export interface ListOpts {
  since?: Date;                    // skip sessions older than this
  limit?: number;
}

export interface RawSession {
  source: 'claude-code' | 'antigravity' | 'claude-desktop' | 'vscode' | 'codex';
  sessionId: string;
  startedAt: string;              // ISO timestamp
  updatedAt: string;              // ISO timestamp
  cwd?: string;                    // working directory if known
  body: string;                    // already-rendered markdown sections
  rawSource?: unknown;             // optional raw form for debugging
}
```

A driver `runSniffer(sniffer, opts)` consumes the async iterable, applies dedup via SHA-256 content hash (same pattern as `import-agentmemory`), and writes to `raw/{YYYY-MM-DD}/{source}-{session-id}.md` with frontmatter matching existing Codex captures.

### Files

- New: `src/sniffers/types.ts`
- New: `src/sniffers/run-sniffer.ts` (the shared driver: dedup + write)
- New: `test/sniffers/run-sniffer.test.ts`

---

## Task 2 — Claude Code backfill sniffer

### Why
The user lost ~4 days of Claude Code conversations because the plugin wasn't enabled. But Claude Code stored those conversations itself in `~/.claude/projects/<project>/<session>.jsonl`. This sniffer reads those JSONL files and imports them.

### Contract

`ClaudeCodeSniffer` implements `Sniffer`:
- `available()`: checks `~/.claude/projects/` exists
- `list({ since })`: yields every session JSONL file modified after `since`
- For each JSONL file:
  - Read it (one JSON object per line — likely each line is a message: prompt, response, tool use, tool result)
  - Normalize into a markdown body using the same section format as Codex captures (`## [HH:MM:SS] Prompt`, `## [HH:MM:SS] Response`, `## [HH:MM:SS] ToolUse: <name>`, etc.)
  - Extract `cwd` if present in the JSONL metadata
  - sessionId = filename without `.jsonl`

### Verification (mandatory)
Run against the user's actual `~/.claude/projects/` and verify all sessions from the last 7 days are present in `~/.memory/raw/` after the run. This is the test that "the user's lost 4 days were recovered."

### Files

- New: `src/sniffers/claude-code.ts`
- New: `test/sniffers/claude-code.test.ts` (with fixture JSONL files mimicking real Claude Code output)

---

## Task 3 — Antigravity 2.0 plugin

### Why
Antigravity 2.0's SDK provides session_start, session_end, pre_turn, post_turn, pre_tool_call, post_tool_call, tool_error_recovery, user_interaction_handling, and context_compaction hooks. We mirror the existing claude-code plugin pattern.

### Contract

Build a Memory Fort Antigravity plugin at `~/.gemini/antigravity/plugins/memory/` (verify the exact path against [Antigravity 2.0 SDK docs](https://antigravity.google/blog/introducing-google-antigravity-sdk) at implementation time):

- `plugin.json` (Antigravity plugin manifest)
- Hook handlers for:
  - `session_start` → create new raw observation file for the session
  - `pre_turn` / `post_turn` → append prompt + response sections
  - `pre_tool_call` / `post_tool_call` → append `## [HH:MM:SS] ToolUse: <name>` sections
  - `tool_error_recovery` → log to a sidebar section
  - `session_end` → finalize the file (close any open sections, write end timestamp)
  - `context_compaction` → record that a compaction happened (useful signal)
- The hooks write directly to `~/.memory/raw/{date}/antigravity-{session-id}.md`

Installer:
- Extend `src/cli/commands/install/antigravity.ts` to additionally copy/link the plugin to the Antigravity 2.0 plugin location
- Detect Antigravity version (CLI: `antigravity --version` or similar). If <2.0, print "Antigravity 2.0 required for live capture; you can still backfill via export" and exit gracefully

### Files

- New: `src/cli/commands/install/antigravity-plugin/manifest.json` (template)
- New: `src/cli/commands/install/antigravity-plugin/hooks/*.ts` (one file per hook)
- Extend: `src/cli/commands/install/antigravity.ts`
- New: `test/cli/commands/install-antigravity-plugin.test.ts`

### Acceptance
Open Antigravity 2.0, start a new conversation, ask one question. A file appears under `~/.memory/raw/{today}/antigravity-*.md` containing the prompt + response.

---

## Task 4 — Claude Desktop log watcher

### Why
Claude Desktop has no plugin/hook surface, but it writes conversation data to `%APPDATA%\Claude\` on Windows. A file watcher tails these files and imports new conversation segments.

### Contract

`ClaudeDesktopSniffer` implements `Sniffer`:
- `available()`: checks `%APPDATA%\Claude\` (or platform equivalent on macOS/Linux) exists
- `list({ since })`: finds session files modified after `since`. Investigate exact storage format at implementation:
  - On Windows, check both `%APPDATA%\Claude\logs\` and `%APPDATA%\Claude\local-agent-mode-sessions\` (Cowork variant)
  - On macOS: `~/Library/Application Support/Claude/`
- For each session file:
  - Parse the format (likely SQLite or JSONL — investigate)
  - Render into markdown sections matching Codex capture format
  - sessionId from the original file's id field or filename
- `watch()`: use `fs.watch` to detect new files / file growth. On any change, re-parse and emit new RawSessions

### Files

- New: `src/sniffers/claude-desktop.ts`
- New: `test/sniffers/claude-desktop.test.ts` (with fixture session files)

---

## Task 5 — VS Code extension (Memory Fort)

### Why
VS Code's Chat Participant API lets an extension register as a chat participant and observe queries. We ship a VS Code extension that:
- Registers a `@memory` chat participant (mostly to be discoverable)
- More importantly: subscribes to chat events so it can capture every query/response

### Contract

Create a new sub-package `vscode-extension/` in the repo:

```
vscode-extension/
  package.json           - extension manifest
  src/extension.ts       - registration + chat observer
  src/capture.ts         - writes to ~/.memory/raw/
  tsconfig.json
  README.md
```

- `package.json` declares activation events: `onChatParticipant:memory-fort.memory`, and `onLanguage:*` so the extension is always active in a coding session
- `extension.ts` registers a Chat Participant via `vscode.chat.createChatParticipant('memory-fort.memory', handler)`
- Listens to chat history events (the API provides `chatHistory` / `chatResponses` — verify against [Chat Participant API docs](https://code.visualstudio.com/api/extension-guides/ai/chat) at implementation)
- On each turn, writes to `~/.memory/raw/{date}/vscode-{session-id}.md`
- The extension is published to the user's VS Code install via the existing `memory connect vscode` installer (extend it to also install this extension)

### Files

- New: `vscode-extension/` (whole subpackage)
- Extend: `src/cli/commands/install/vscode.ts` to ALSO install the extension via `code --install-extension` or by writing to the extensions directory
- New: `test/cli/commands/install-vscode-extension.test.ts`

### Acceptance
After running `memory connect vscode`, opening VS Code Chat and sending one message produces a `vscode-*.md` file under `~/.memory/raw/{today}/`.

---

## Task 6 — `memory watch` daemon

### Why
Sniffers that support live capture (`watch()`) should run continuously. The user runs `memory watch` once (e.g., in a Windows Task Scheduler at boot, or manually in a terminal) and capture happens automatically forever.

### Contract

New command `memory watch [--clients <list>]`:
- Default: watch every available sniffer (claude-code, antigravity, claude-desktop, vscode)
- `--clients` to scope to a subset
- Logs activity to `~/.memory/logs/watch-{YYYY-MM-DD}.log`
- Graceful shutdown on SIGINT/SIGTERM (closes all watchers cleanly)
- Restarts individual sniffers on failure with exponential backoff
- Prints periodic status: "watching N clients · M sessions captured this session"

### Files

- New: `src/cli/commands/watch.ts`
- New: `src/sniffers/watch-runner.ts` (orchestrates multiple sniffers)
- Register in `src/cli.ts`
- New: `test/cli/commands/watch.test.ts`

---

## Task 7 — `memory backfill` command

### Why
For one-shot historical imports (e.g., "import every Claude Code session from before today"). Different from `watch` — this runs once, scans, imports, exits.

### Contract

New command `memory backfill [--from <client>] [--since <date>] [--plan]`:
- `--from`: which sniffer to run (default: all)
- `--since`: how far back to go (default: 30 days ago)
- `--plan`: dry-run (matches the pattern of `import-agentmemory --plan`)
- On `--plan`: prints counts per client + sample of what would be imported
- On apply: writes files to vault, logs to `wiki/.audit/backfill-{timestamp}.md`

### Files

- New: `src/cli/commands/backfill.ts`
- Register in `src/cli.ts`
- New: `test/cli/commands/backfill.test.ts`

### Acceptance
`memory backfill --from claude-code --since 2026-05-22` produces every Claude Code session from May 22 onwards as `raw/{date}/claude-code-*.md` files. The user's lost 4 days are recovered.

---

## Task 8 — Integration with `memory verify`

### Why
The `memory verify` command from `codex-installer-hooks-and-graph-bugs.md:Task 8` should check that sniffers are healthy.

### Contract

Extend `memory verify` to:
- Check each available sniffer (claude-code-backfill, antigravity-plugin, claude-desktop-watcher, vscode-extension)
- For each: verify install integrity AND that recent captures exist (within 24h if the user has been active there)
- Same `✓/⚠/✗` convention

### Files

- Extend: `src/cli/commands/verify/clients.ts` (or wherever client checks live after Task 8 of the bug brief lands)

### Acceptance
`memory verify` reports the health of every sniffer alongside the MCP / plugin checks from the bug-fix brief.

---

## Execution order

1. **Task 1 (sniffer framework)** — foundation, everything else depends on it
2. **Task 2 (Claude Code backfill)** — IMMEDIATE user value: recovers the 4 days of lost history
3. **Task 7 (backfill command)** — pairs with Task 2; lets the user run the recovery
4. **Task 3 (Antigravity 2.0 plugin)** — biggest live-capture gap to close
5. **Task 4 (Claude Desktop watcher)** — important for the Claude Desktop user base
6. **Task 5 (VS Code extension)** — completes the surface
7. **Task 6 (watch daemon)** — wraps live sniffers
8. **Task 8 (verify integration)** — polish

Each task = one commit. Run `npx vitest run` between every commit.

---

## Build / test / deploy

```
npx vitest run                                    # full suite
npx vitest run test/sniffers                      # sniffer tests only
npm run build                                     # everything
npm run build:ui                                  # SPA (no changes expected here)

# After install:
memory backfill --from claude-code --since 2026-05-19 --plan
memory backfill --from claude-code --since 2026-05-19 --apply
memory watch &  # background, or use Task Scheduler / launchd

# Verify
memory verify
```

---

## Acceptance checklist

- [ ] `Sniffer` interface defined; `runSniffer` driver works
- [ ] Claude Code backfill produces files in `~/.memory/raw/` for sessions from 2026-05-22 onward (recovers the 4 lost days)
- [ ] Antigravity 2.0 plugin installs to the correct Antigravity plugin directory and registers all 9 hook handlers
- [ ] Live test: opening Antigravity 2.0 and sending one message produces an `antigravity-*.md` file
- [ ] Claude Desktop watcher detects file changes in `%APPDATA%\Claude\` and imports them
- [ ] VS Code extension installs via `memory connect vscode` and captures chat panel queries
- [ ] `memory watch` runs all live sniffers, survives individual sniffer failures, shuts down gracefully
- [ ] `memory backfill` is idempotent (running twice produces zero new files on the second run)
- [ ] `memory verify` reports sniffer health alongside existing client checks
- [ ] All previous 652+ tests still green; new tests added per task
- [ ] No secrets committed, no OneDrive paths anywhere

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.
