# Follow-ups

Known issues, refinements, and observations that surfaced during Phase 1 implementation but aren't blocking the current step. Each entry: what it is, where it was discovered, hypothesis, and when to address.

Update this file whenever a real issue is observed but deferred. Keep entries terse. When an entry is resolved, move it to a `## Resolved` section with the resolving commit hash.

---

## Open

### F1. PostToolUse hook captures empty `**Output:**` block

**Discovered:** 2026-05-21, during the post-step-7-fix checkpoint verification (headless `claude -p` session with the memory plugin loaded).

**Symptom:** A real Claude Code session ran the Bash tool with `echo hooks-fired` (which produced visible stdout `hooks-fired`). The post-tool-use hook fired and produced a raw file, but the captured `**Output:**` block in the ToolUse section was empty. The block layout was correct; just the output content was missing.

**Hypothesis:** Claude Code's actual `PostToolUse` hook payload does NOT expose the tool output under `payload.tool_output` the way our [src/hooks/error-handler.ts](../src/hooks/error-handler.ts) `HookPayload` interface assumes. Field name may be different (`tool_response`? `output`? nested under a `result` key?), or output may not be passed to hooks at all (security/privacy default?). Need to inspect a real payload via `--debug` or by writing the raw JSON to disk for one invocation.

**Suggested fix:** In Phase 2's compile pass, instrument one of the hook scripts to dump the raw payload to a debug file, run a session, inspect the actual shape, update `HookPayload` + `formatToolUseBlock` accordingly. Test against the captured shape.

**Phase:** Phase 2 (Curation) — when we have real raw observations to compile, this gets re-examined.

**Workaround:** None needed for Phase 1 — Prompt blocks and ToolUse-with-input are still captured. Just tool OUTPUT is missing from the raw file.

---

### F2. tsdown emits PLUGIN_TIMINGS performance warnings on every build

**Discovered:** 2026-05-21, step #7-fix build (also visible in step #6, step #7).

**Symptom:** `npm run build` succeeds (exit 0) but tsdown emits PLUGIN_TIMINGS lines after the bundle summaries. Not errors, but noise in build output.

**Hypothesis:** tsdown ^0.22 enables performance instrumentation by default; the warnings show plugin timings that exceed some threshold. Likely tunable via `tsdown.config.ts` — probably a `silent: true` or `logLevel: 'error'` option.

**Suggested fix:** Look up tsdown 0.22 config option to suppress non-error output. Add to `tsdown.config.ts`. Verify build still works and CI-style output is clean.

**Phase:** Phase 6 (Polish) — purely cosmetic; the warnings don't change behavior.

---

### F3. MCP entry referenced a not-yet-built script — script now exists (d8a00c2); full integration pending step #7-fix-2

**Discovered:** 2026-05-21, after step #7 install. **Partial resolution:** 2026-05-21 at step #8 commit `d8a00c2` — `dist/hooks/mcp-server.mjs` exists; the plugin's `scripts/mcp-server.mjs` symlink resolves to it.

**Outstanding:** End-to-end verification (real `claude -p` session calling the memory MCP tool) revealed the MCP entry was written to the WRONG location (`~/.claude/.mcp.json` — not a Claude Code recognized path for plugin MCPs). The agentmemory reference uses `plugin/.mcp.json` inside the plugin dir, which Claude Code auto-loads. Step #7-fix-2 (queued) moves our entry to the right location and migrates the legacy file. Full F3 closure happens when step #7-fix-2 ships AND a real Claude session can call `log_observation` end-to-end.

---

### F4. `{{install_commit}}` template variable left literal in rendered schema.md

**Discovered:** 2026-05-21, after `memory init` ran on the real machine.

**Symptom:** The schema.md template variable `{{install_commit}}` is supposed to be substituted with the source repo's HEAD commit hash, but `memory init` runs at `~/.memory/` where there's no source repo to query. The rendered `~/.memory/schema.md` still shows `{{install_commit}}` literal (or "unknown" depending on Codex's choice during step #6 implementation — verify by inspecting the file).

**Hypothesis:** `memory init` needs a way to know the source repo's location. Options: (a) accept `--source-repo-dir <path>` flag on init, (b) embed the commit hash at build time via tsdown define, (c) drop the template variable (it's informational only).

**Suggested fix:** Option (b) is cleanest. Use tsdown's `define` option to inject `process.env.MEMORY_BUILD_COMMIT` at build time; init reads it and substitutes.

**Phase:** Phase 6 (Polish) — informational, not blocking any functionality.

---

### F5. `MEMORY_*_DIR` override pattern established in step #7-fix; future install steps must reuse

**Discovered:** 2026-05-21, step #7 (real `~/.claude/.mcp.json` was briefly touched during Codex's smoke test before the env var was added).

**Symptom:** Without an env-var override, the install CLI defaults to the user's real `~/.claude/`, `~/.codex/`, `~/.gemini/` config dirs. Tests and smoke runs must always use overrides to avoid mutating the user's real config during development.

**Hypothesis:** Already mitigated in step #7-fix by adding `MEMORY_CLAUDE_DIR`. The PLAN (plans/2026-05-20-phase-1-foundation-plan.md commit 6aac75e) documents the requirement. Steps #9 (Codex install) and #10 (Antigravity install) MUST add analogous overrides: `MEMORY_CODEX_DIR` and `MEMORY_ANTIGRAVITY_DIR`.

**Suggested fix:** Codex prompts for steps #9 and #10 will explicitly require the override pattern in their Section 3 / Section 5 (smoke test + boundaries).

**Phase:** Phase 1 — addressed in the next install steps as they're written.

---

### F6. Orphan raw file at `~/.memory/raw/2026-05-21/claude-code-checkpoint-test-1779374918.md`

**Discovered:** 2026-05-21, during the checkpoint verification.

**Symptom:** A test raw file was produced by piping fake JSON payloads to the hook scripts during checkpoint verification. It mimics a real session but uses a synthetic session ID. Harmless but noise.

**Hypothesis:** N/A — it's intentional test residue.

**Suggested fix:** Delete manually whenever convenient: `del C:\Users\Admin\.memory\raw\2026-05-21\claude-code-checkpoint-test-1779374918.md`. Or leave as a memento of the checkpoint pass.

**Phase:** N/A — user discretion.

---

## Resolved

(none yet)

---

## Conventions

- Numbered F-prefix (F1, F2, …) for stable references in commits and discussions.
- Move resolved items to the `## Resolved` section with the resolving commit hash for traceability. Don't delete — preserve the audit trail.
- Add new items at the bottom of `## Open`. Don't insert in the middle (avoids renumbering churn).
