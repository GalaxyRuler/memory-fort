# Codex Implementation Brief — Installer + Hook Capture + Galactic Camera Bugs

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Three bugs surfaced by a live audit of the deployed Memory Fort:

1. **Claude Code hooks are silently inert.** The `install-claude-code` command writes the plugin files to `~/.memory/claude-code-plugin/` and creates a symlink, and `memory doctor` reports "claude-code plugin manifest ok / scripts symlink resolves" — but the plugin is **not enabled** in `~/.claude/settings.json:enabledPlugins`. Claude Code never loads it, so `SessionStart`, `PostToolUse`, `Stop`, and `SessionEnd` hooks never fire. Result: across the last 4 days, **zero** observations captured from Claude Code sessions (only Codex CLI captures landed, because Codex uses a separate, working integration). The user has lost ~4 days of conversation memory.

2. **Galactic graph camera locks to Semantic.** On the live `/memory/graph` route, switching zoom level (`1/2/3` keys, or clicking the zoom chips) at SOLAR_SYSTEM level always animates the camera to the Semantic galaxy, regardless of what the user was previously looking at. There's a hardcoded fallback `galaxies.semantic.cx/.cy` somewhere in the React port that fires when no node is selected. The intended behavior is to keep the camera centered on whichever galaxy the user is currently looking at, or fall back to the **focused galaxy** (the one whose center is closest to current `camX/camY`), not always Semantic.

3. **VS Code installer doesn't actually install.** Codex's `install-vscode.ts` lands without errors and tests pass, but `memory doctor` on the user's machine reports `✗ vscode not installed`. Likely the installer is writing to the wrong path on Windows (e.g., POSIX-style `~/.config/Code/User/settings.json` instead of Windows `%APPDATA%\Code\User\settings.json`), or the path detection assumes Linux/macOS without a Windows branch.

Plus a related cleanup item:

4. **claude-desktop config got corrupted.** Doctor reports `⚠ claude-desktop installed but memory entry missing or invalid`. Need to detect this case and offer a one-shot re-install via the existing installer.

5. **errors.log noise.** 242 KB of `auto-push schedule failed: ENOENT ... rename '.auto-push-pending.tmp' -> '.auto-push-pending'` entries across multiple days. The rename race is happening because two auto-push schedulers are colliding. Diagnose and fix the tempfile race so errors.log stays clean.

---

## Scope guard

You will:

- Fix the claude-code installer so the plugin actually gets enabled by Claude Code after `memory install` runs (Task 1)
- Fix the galactic camera default-target logic (Task 2)
- Fix the VS Code installer's Windows path detection (Task 3)
- Patch the claude-desktop installer to detect and repair corrupted entries (Task 4)
- Fix the auto-push tempfile rename race (Task 5)

You will **not**:

- Touch the retrieval pipeline, search, conflicts, pruning, or migration code
- Change the dashboard layout or any non-graph route
- Add new install targets beyond what this brief lists
- Modify the LongMemEval-S harness or galactic visual mechanics (planet shapes, physics, glow, etc.)
- Add Windows-only or Unix-only code paths without a fallback for the other platform

If a fix requires changing the Claude Code plugin registration model (e.g., needing to publish the plugin to a marketplace), **stop and ask**.

---

## Repo orientation (verified before brief)

- `src/cli/commands/install/claude-code.ts` — writes plugin files to `~/.memory/claude-code-plugin/`, creates scripts symlink, prints success. Does **not** modify `~/.claude/settings.json`.
- `src/cli/commands/install/vscode.ts` — Codex's recent installer. Some Windows-path handling is wrong; verify and fix.
- `src/cli/commands/install/claude-desktop.ts` — writes Claude Desktop's MCP config.
- `src/cli/commands/doctor.ts` + `src/cli/commands/client-status.ts` — reports install status per client.
- `src/sync/auto-push-worker.ts` (or similar; locate via `grep auto-push-pending`) — the worker doing the failing rename.
- Live evidence: `~/.claude/settings.json` shows `enabledPlugins` map. Memory plugin is absent. ~/.memory/errors.log shows the auto-push failures.

The Claude Code plugin model (verify against current docs at time of implementation):
- Plugins live under `~/.claude/plugins/<marketplace>/plugins/<name>/` OR are registered via `extraKnownMarketplaces`
- Plugins must appear in `enabledPlugins` map as `"<name>@<marketplace>": true` to load
- A local-path plugin can be enabled via the marketplace system using `extraKnownMarketplaces` with a `source.path` entry

### React galactic graph
- `src/dashboard-ui/components/GalacticCanvas.tsx`, `GalacticHUD.tsx` — Codex's recent port
- `src/dashboard-ui/components/galactic/{Inspector,Legend,MemoryModal,ZoomIndicator}.tsx`
- `src/dashboard-ui/lib/galactic/{layout,physics,planets}.ts`
- Look for the `setLevel` or equivalent function that handles SOLAR_SYSTEM zoom; the hardcoded `galaxies.semantic` reference is there.

---

## Task 1 — Fix Claude Code plugin enablement (critical)

### Why
This is the biggest user-visible bug: every Claude Code conversation since install has not been captured. Restoring this is the priority of the entire brief.

### Contract

`memory install claude-code` (or whatever the current invocation is) must:

1. Continue writing the plugin files to `~/.memory/claude-code-plugin/` (no change)
2. Continue creating the scripts symlink (no change)
3. **NEW**: register the plugin so Claude Code actually loads it. Two possible mechanisms — pick whichever Claude Code's current version supports:
   - **a)** Add an entry to `~/.claude/settings.json:extraKnownMarketplaces` pointing at the local plugin path, then add `"memory@memory-local": true` (or matching name) to `enabledPlugins`
   - **b)** Copy/symlink the plugin into `~/.claude/plugins/<marketplace>/plugins/memory/` and add the matching key to `enabledPlugins`
4. Preserve all existing entries in `enabledPlugins` and `extraKnownMarketplaces` — never overwrite
5. On re-install: idempotent. If `memory@...` is already enabled, leave settings alone but update the plugin files
6. Update `memory doctor` to specifically verify the `enabledPlugins` map contains the memory entry — not just that the manifest exists

### Verification (manual, post-implementation)

After running `memory install claude-code`, the user must be able to:
- Open Claude Code
- Start a new conversation
- Send any message
- Immediately see a file appear under `~/.memory/raw/{today}/claude-{session-id}.md`

If this end-to-end test doesn't pass on the user's machine, the fix is incomplete.

### Files
- `src/cli/commands/install/claude-code.ts`
- `src/cli/commands/client-status.ts` (extend the check)
- `src/cli/commands/doctor.ts` (surface the deeper status)
- Tests: extend `test/cli/commands/install-claude-code.test.ts` with a fixture that has a pre-existing `enabledPlugins` map containing other entries, asserts memory entry is added without touching the others
- Tests: add `test/cli/commands/client-status.test.ts` cases for "plugin installed but not enabled" → ⚠ warning, distinct from "✓ installed and enabled"

---

## Task 2 — Galactic camera default-target

### Why
The user reports that pressing 1/2/3 or clicking a zoom chip while looking at any galaxy other than Semantic always pans the camera back to Semantic. Read the prototype at `docs/galactic-graph-prototype.html`'s `setLevel()` function — there's a fallback `galaxies.semantic.cx/.cy` that the React port replicated. That fallback is the bug.

### Contract

In `GalacticCanvas.tsx` (or wherever the zoom-level handler lives):

- When the user changes zoom level and no node is selected:
  - Find which galaxy the camera is currently closest to (compute distance from `(camX, camY)` to each `galaxy.cx/.cy`, pick the minimum)
  - Animate to that galaxy's center, not to Semantic
- When a node IS selected, pan to that node's galaxy (existing behavior, no change)
- At GALACTIC level (level 0), camera goes to world origin `(0, 0)` regardless of focus — existing behavior, no change

### Files
- `src/dashboard-ui/components/GalacticCanvas.tsx` (or wherever `setLevel` lives)
- New test: `test/dashboard-ui/components/galactic-zoom-target.test.tsx` — fixture cameras pointed at procedural/episodic/core and verifies the zoom transition targets the nearest galaxy, not Semantic

---

## Task 3 — VS Code installer Windows path

### Why
`memory doctor` reports `✗ vscode not installed` on Windows despite the installer claiming success. The path probably resolves to a Linux/macOS location.

### Contract

`install/vscode.ts` must:

- Detect platform via `process.platform` and resolve the per-user settings.json path:
  - Windows: `%APPDATA%\Code\User\settings.json`
  - macOS: `~/Library/Application Support/Code/User/settings.json`
  - Linux: `~/.config/Code/User/settings.json`
- Use the right separator (`path.join`, `path.sep`)
- For the workspace mode (`--workspace <path>`), write `${workspace}/.vscode/mcp.json` (cross-platform)
- Fall back gracefully (print + exit 0) if VS Code isn't installed (no settings file AND no user data dir)

### Files
- `src/cli/commands/install/vscode.ts`
- `test/cli/commands/install-vscode.test.ts` — add cases mocking each `process.platform` value (`win32`, `darwin`, `linux`)

---

## Task 4 — Claude Desktop repair

### Why
Doctor reports `⚠ claude-desktop installed but memory entry missing or invalid`. Some prior install attempt produced a half-written config. The installer should detect this on re-run and offer to repair it cleanly.

### Contract

`install/claude-desktop.ts`:

- On invocation, read existing config (if any)
- If a `memory` entry exists but is malformed (missing required fields, wrong type, etc.) — log "repairing corrupted entry" and overwrite just that entry with a fresh one. Preserve all other entries.
- If no `memory` entry exists — current behavior (add fresh)
- If a fully valid `memory` entry exists — no-op

### Files
- `src/cli/commands/install/claude-desktop.ts`
- `test/cli/commands/install-claude-desktop.test.ts` (extend with corrupted-entry repair case)

---

## Task 5 — auto-push tempfile race

### Why
`errors.log` is 242 KB of repeated:
```
auto-push schedule failed: ENOENT: no such file or directory, rename '.auto-push-pending.tmp' -> '.auto-push-pending'
```

The race: two auto-push workers (or one worker firing concurrently) both attempt `rename(tmp, target)`. One succeeds; the second fails with ENOENT because the tmp file is gone.

### Contract

Find the worker writing `.auto-push-pending` (likely `src/sync/auto-push-worker.ts` or similar):

- Add a file-lock (use `proper-lockfile` if already in deps, otherwise `fs.openSync(path, 'wx')` for atomic create) around the rename
- On lock acquisition failure: skip this run, do not log to errors.log
- On ENOENT during rename: tolerate silently (another worker won the race), don't log
- Add a test that simulates concurrent rename attempts and verifies no errors.log entries are produced

### Files
- Locate via `grep -r auto-push-pending src/`
- Tests in matching location

---

## Task 6 — Cognitive type inference rebalance

### Why
Live audit of the deployed graph: **1028 of 1044 nodes (98.5%) are classified as `episodic`**. The other three galaxies are nearly empty (semantic: 11, procedural: 5, core: 1). This isn't a 4-galaxy visualization — it's one giant blob with three lonely satellites.

Root cause: the inference rule in `src/retrieval/corpus.ts:inferCognitiveType()` (or wherever Subagent A landed it) treats nearly every imported raw observation as episodic. Specifically, the rule `source = claude-code | codex | antigravity AND located under wiki/raw/` matched almost every migrated agentmemory entry because they ALL went into `raw/{date}/` with one of those three sources.

### Contract

Rebalance the inference so the four cognitive types actually carry semantic load:

- **`core`** — pinned, permanent, always-loaded: keep current rule (category=projects AND status=active AND inboundCount≥5). Add: `imported_from.system === "agentmemory" AND original_key matches "mem:slots:*"` (slot data is explicitly long-lived)
- **`procedural`** — rules, workflows, how-we-do-it: tighten to `category IN [tools, lessons]` only. Currently too narrow; do not loosen.
- **`semantic`** — facts, references, persisted knowledge: explicit fallback for `category IN [references, decisions, crystals]` if no other rule fires. Critically: an imported observation whose original_key matches `mem:semantic:*` or `mem:summaries:*` should become `semantic`, NOT `episodic`.
- **`episodic`** — events, sessions, time-bound: tighten to:
  - File located under `raw/` (not `wiki/raw/` — actual filesystem path) AND
  - Frontmatter `created` within last 30 days (not just "any time")
  - Otherwise the entry is a stale episodic that should age into semantic (per cognitive memory theory). If `created` > 30 days ago AND raw-located, classify as `semantic` (the memory has settled).

After rebalance, run against the live vault and verify the distribution looks closer to:
- core: ~5–20
- semantic: ~600–800 (a lot of the agentmemory imports are actually settled facts)
- procedural: ~30–80
- episodic: ~200–400 (real recent observations)

### Files
- `src/retrieval/corpus.ts` (the `inferCognitiveType` function)
- `test/retrieval/cognitive-type-inference.test.ts` (extend with the new rules)
- Run `npx vitest run test/retrieval/cognitive-type-inference.test.ts` to gate

---

## Task 7 — Cross-galaxy edge visibility

### Why
The graph has 41 cross-galaxy edges (genuine information density across cognitive types) but the user reports each galaxy "feels like it's living on its own" — no visible connections between them. The edges are being rendered but with the weight × opacity formula `(0.4 + weight × 0.6) px line, opacity 0.2 + weight × 0.35`, edges between low-inbound nodes (most edges) render at <1px line / ~0.4 opacity, which disappears against the dark background at zoom-out.

### Contract

In `GalacticCanvas.tsx` (or wherever edge rendering happens):

1. **Boost cross-galaxy edges**: if `source.cognitiveType !== target.cognitiveType`, render with at least 1.5× line width and 1.5× opacity compared to same-galaxy edges. These are the most semantically interesting connections.
2. **Floor minimums for ALL edges at GALACTIC zoom level**: line width ≥ 0.8px, opacity ≥ 0.35. Below those, edges visually vanish at this zoom.
3. **At SOLAR_SYSTEM and PLANETARY levels** keep current weight-driven scaling (no floors), since the user has zoomed in to see detail.
4. The gravitational-lensing curve and particle-flow on edges stay as-is.

### Files
- `src/dashboard-ui/components/GalacticCanvas.tsx` (edge draw function)
- New test: `test/dashboard-ui/components/galactic-edge-rendering.test.tsx` — feed fixture with cross/within edges at each zoom level, assert minimum line widths and the cross-galaxy boost are applied

---

## Task 8 — `memory verify` end-to-end health check

### Why
The user just spent days believing Memory Fort was capturing their Claude Code conversations. It wasn't. The plugin file was on disk; doctor reported "ok"; but the plugin was never enabled in Claude Code's settings, so hooks never fired. **A "files exist on disk" check is not a connection test.** We need a verification command that proves the pipeline works end-to-end.

### Contract

`memory verify` (new command) runs the following checks and reports a single line per check (✓/✗/⚠):

1. **Vault read/write** — write a temp file under `raw/.verify-{ts}.tmp`, read it back, delete it. ✓ if all three succeed.
2. **Git remote reachable** — `git ls-remote vps` (or whatever remote is configured) succeeds within 5 seconds.
3. **Dashboard endpoint live** — HTTP GET `${dashboardUrl}/api/status` returns 200 with valid JSON.
4. **Search pipeline returns results** — call `runSearch({ query: "memory fort", scope: "all", k: 5 })` and assert at least 1 result is returned. ✗ if zero (means corpus is empty or search broken).
5. **Each installed client actually loads the plugin/MCP server**:
   - For claude-code: read `~/.claude/settings.json` and verify the memory entry is in `enabledPlugins`. Then check `~/.memory/raw/{today}/` for at least one `claude-*.md` file created in the last 24h. ⚠ if no file in 24h (might mean no sessions today; not a hard fail).
   - For codex: check `~/.codex/config.toml` has the memory MCP block AND check for a recent `codex-*.md` in `raw/{today}/`.
   - For antigravity/antigravity-ide: check the shared `~/.gemini/antigravity/mcp_config.json` has the memory entry AND check for any `antigravity-*.md` in `raw/`. Antigravity has no auto-hook so this check is informational only — print "⚠ antigravity captures rely on manual MCP tool calls" if no recent files.
   - For vscode: check the resolved per-user settings.json contains the memory entry. ⚠ if not, ✓ if yes. (No capture verification — VS Code's MCP doesn't write to disk by default.)
   - For claude-desktop: same shape as vscode — config-only verification.
6. **Auto-push worker healthy** — read `errors.log` last 100 lines, fail if any auto-push-related lines in the last hour. ⚠ if any in the last 24h, ✓ if none in 24h.
7. **Compile state recent** — `lastCompile` in the dashboard `/api/status` is within the last 7 days OR `compile.history` has at least one success entry.

Output format:
```
memory verify · 2026-05-26T03:30:00Z

  ✓ vault read/write
  ✓ git remote vps reachable
  ✓ dashboard /api/status returns 200
  ✓ search pipeline returned 5 results in 47ms
  ✗ claude-code plugin enabled    ← critical: hooks NOT firing
  ✓ codex MCP block present       ← 12 captures today
  ✓ antigravity MCP entry present (informational)
  ✗ vscode MCP entry not in settings.json
  ✓ claude-desktop MCP entry present
  ⚠ auto-push: 3 errors in last 24h
  ✓ compile last ran 2026-05-22 (4 days ago)

8/11 checks passed; 2 failed; 1 warning.
Exit code: 1 (failures present)
```

Exit code conventions:
- All ✓: exit 0
- Any ⚠ but no ✗: exit 0 (warnings don't fail)
- Any ✗: exit 1 (failure)

The command must:
- Run in under 30 seconds (no compile, no benchmark)
- Be runnable without network IF `--offline` is passed (skip git/dashboard checks)
- Suggest the fix command for each failure (e.g., "✗ claude-code plugin enabled — run `memory connect claude-code` to fix")

### Files
- New: `src/cli/commands/verify.ts`
- New: `src/cli/commands/verify/` directory with one file per check (vault, git, dashboard, search, clients, autopush, compile)
- Register in `src/cli.ts`
- New: `test/cli/commands/verify.test.ts`
- New: `test/cli/commands/verify-each-check.test.ts` for unit tests per check

### Acceptance
The user runs `memory verify` and gets a clear diagnostic that catches the kind of silent failure they just hit ("plugin on disk, never enabled"). If we'd shipped this command 4 days ago, they'd have caught the missing claude-code capture within minutes.

---

## Execution order (updated)

1. **Task 1 (claude-code plugin enablement)** — biggest user impact, must restore capture
2. **Task 8 (memory verify command)** — second priority, so future silent failures get caught immediately
3. **Task 6 (cognitive inference rebalance)** — high-value: makes the galactic view actually informative
4. **Task 7 (cross-galaxy edge visibility)** — visual cleanup, pairs naturally with Task 6
5. **Task 3 (VS Code Windows path)** — quick win
6. **Task 4 (claude-desktop repair)** — quick win
7. **Task 5 (auto-push race)** — cleanup
8. **Task 2 (galactic camera)** — UX polish

Each task = one commit. Tests green between every commit.

---

## Build / test / deploy

```
npx vitest run                              # full suite — 652+ tests
npm run build
npm run build:ui                            # for Task 2 since it touches SPA
npm run memory -- install-vps               # ship Task 1/3/4/5 (CLI changes)
                                             # NOTE: chunked-printf upload is broken
                                             #  (line 523 in install-vps.ts).
                                             #  Either fix it as part of this brief
                                             #  or use the manual scp path the
                                             #  operator has documented.
```

After deploy, manually verify on the user's machine:
- Open Claude Code → start conversation → see a fresh raw observation file appear
- `memory doctor` shows ✓ for vscode, ✓ for claude-desktop (not ⚠)
- `errors.log` size stable over 24 hours
- `/memory/graph` zoom-level changes don't always land on Semantic

---

## Acceptance checklist

- [ ] Claude Code conversations capture into `~/.memory/raw/{date}/claude-*.md` after install
- [ ] `memory doctor` distinguishes "plugin file present but disabled" from "plugin enabled and loaded"
- [ ] `memory verify` exists, runs in <30s, catches the silent-failure pattern the user just hit
- [ ] Cognitive type distribution rebalanced: episodic <50% of total nodes (currently 98.5%)
- [ ] Cross-galaxy edges visibly thicker/brighter than within-galaxy edges
- [ ] Galactic graph zoom transitions target the nearest galaxy, not always Semantic
- [ ] VS Code installer works on Windows and writes to `%APPDATA%\Code\User\settings.json`
- [ ] Claude Desktop installer repairs corrupted entries
- [ ] errors.log stops growing from auto-push rename races
- [ ] All 652+ tests still green; new tests cover the changed paths
- [ ] No secrets committed, no OneDrive paths anywhere

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.
