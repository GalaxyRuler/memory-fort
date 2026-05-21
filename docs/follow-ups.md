# Follow-ups

Known issues, refinements, and observations that surfaced during Phase 1 implementation but aren't blocking the current step. Each entry: what it is, where it was discovered, hypothesis, and when to address.

Update this file whenever a real issue is observed but deferred. Keep entries terse. When an entry is resolved, move it to a `## Resolved` section with the resolving commit hash.

---

## Open

### F1. ~~PostToolUse hook captures empty `**Output:**` block (Claude Code)~~ — RESOLVED at d243ae2

**Discovered:** 2026-05-21 step #7-fix checkpoint. **Resolved:** 2026-05-21 at step #16.5 (`d243ae2`) — the field-fallback chain in `readToolOutput` (`tool_output ?? tool_response ?? output`) picked up Claude Code's payload shape. Verified at `c08532d` regression test: real headless Claude session produced `claude-code-ef879585-7049-4bd5-a083-3e2698f7a296.md` with the Output section populated (stdout, stderr, interrupted, isImage fields). Same fix that closed F7 (Codex) also closed F1 (Claude Code) — that's the value of platform-agnostic fallback chains over per-platform branching.

---

### F2. tsdown emits PLUGIN_TIMINGS performance warnings on every build

**Discovered:** 2026-05-21, step #7-fix build (also visible in step #6, step #7).

**Symptom:** `npm run build` succeeds (exit 0) but tsdown emits PLUGIN_TIMINGS lines after the bundle summaries. Not errors, but noise in build output.

**Hypothesis:** tsdown ^0.22 enables performance instrumentation by default; the warnings show plugin timings that exceed some threshold. Likely tunable via `tsdown.config.ts` — probably a `silent: true` or `logLevel: 'error'` option.

**Suggested fix:** Look up tsdown 0.22 config option to suppress non-error output. Add to `tsdown.config.ts`. Verify build still works and CI-style output is clean.

**Phase:** Phase 6 (Polish) — purely cosmetic; the warnings don't change behavior.

---

### F3. ~~MCP integration~~ — FULLY RESOLVED at 84143e8 + verified 2026-05-21

**Discovered:** 2026-05-21, after step #7 install. **Fully resolved:** 2026-05-21 — script existed at step #8 (`d8a00c2`), wrong-location fixed at step #7-fix-2 (`84143e8`), end-to-end verified via real `claude --plugin-dir ...` session where Claude Code connected to `plugin:memory:memory` server in 544ms, selected `mcp__plugin_memory_memory__log_observation`, called it, produced `~/.memory/raw/2026-05-21/manual-mcp-1779378835136.md` with the expected content.

**Key learning for future installs:** plugin-bundled MCPs live at `<plugin>/.mcp.json` (NOT user-level `~/.claude/.mcp.json`). Tool name in session is `mcp__plugin_<source>_<server>__<tool>`.

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

### F7. ~~Codex hooks fire but produce no raw files~~ — RESOLVED at d243ae2

**Discovered:** 2026-05-21 step #16 E2E smoke. **Resolved:** 2026-05-21 at step #16.5 commit `d243ae2`. The fix added field-fallback chains in `src/hooks/util/payload-fields.ts` (`session_id ?? turn_id`, `tool_output ?? tool_response ?? output`, etc.) plus loud diagnostic logging on malformed stdin. Smoke verified: `codex exec` → raw file `~/.memory/raw/2026-05-21/codex-019e4bfa-3ed3-7cf0-94fe-a1a429cc0464.md` appeared with `source: codex`, real session UUID, prompt block, and ToolUse block including captured output. Phase 1 multi-platform passive ingestion now works for Claude Code + Codex (Antigravity is MCP-only by design).

---

### F7 (original entry, preserved for audit trail)

**Discovered:** 2026-05-21, during step #16 E2E smoke. Running `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "..."` correctly fires hooks (`hook: PostToolUse Completed`, `hook: Stop Completed` visible in Codex output) but no `codex-*` raw file appears under `~/.memory/raw/<date>/`. `errors.log` is empty — meaning the silent-skip path in `error-handler.ts` is being taken (JSON.parse on stdin fails, hook exits 0 without writing).

**Hypothesis:** Codex's hook payload shape differs from Claude Code's. Per Codex docs (verified May 2026): the PostToolUse payload uses `tool_response` (not `tool_output`), `turn_id` (not `session_id`), and may not include `prompt` on UserPromptSubmit in the shape we expect. Either:
1. Codex sends an empty stdin (no JSON at all) — `JSON.parse("")` fails → silent skip
2. Codex sends JSON but with different field names — parse succeeds, but our writers see `payload.prompt`/`tool_name`/`session_id` as undefined and bail early
3. Codex sends nested JSON (e.g., `{ payload: {...} }`) — parse succeeds, but our code reads top-level fields

**Suggested fix:** Diagnostic step first — instrument the error-handler (or session-end.mjs as the always-fires hook) to dump the actual Codex stdin payload to a debug file. Confirm the shape. Then update `HookPayload` interface + the field-reading logic in the writer hooks (prompt-submit, post-tool-use) to accept BOTH Claude Code's shape AND Codex's shape.

**Phase:** Phase 1 step #16.5 (queued — fix before v0.1.0-phase1 tag). Critical because it's the difference between "memory captures from all three platforms" and "memory captures only from Claude Code".

**Workaround in the meantime:** Codex MCP works (`memory.log_observation` via MCP succeeds — verified at 19:01 in this session). Users in Codex can `Use the memory log_observation tool to remember X` explicitly; they just don't get the passive firehose.

---

### F6. Orphan raw file at `~/.memory/raw/2026-05-21/claude-code-checkpoint-test-1779374918.md`

**Discovered:** 2026-05-21, during the checkpoint verification.

**Symptom:** A test raw file was produced by piping fake JSON payloads to the hook scripts during checkpoint verification. It mimics a real session but uses a synthetic session ID. Harmless but noise.

**Hypothesis:** N/A — it's intentional test residue.

**Suggested fix:** Delete manually whenever convenient: `del C:\Users\Admin\.memory\raw\2026-05-21\claude-code-checkpoint-test-1779374918.md`. Or leave as a memento of the checkpoint pass.

**Phase:** N/A — user discretion.

---

### F8. js-yaml auto-coerces YYYY-MM-DD frontmatter dates to Date objects

**Discovered:** 2026-05-22, during Step #8 (memory page) implementation. **Workaround in place:** page.ts has a local `renderScalar` helper that handles `Date instanceof` for the Created/Updated header fields.

**Symptom:** Wiki pages with unquoted ISO dates in frontmatter — e.g. `created: 2026-05-22` — get parsed by gray-matter/js-yaml as JavaScript `Date` objects, not strings. The Frontmatter type declares `created: string` and `updated: string`, but the runtime values violate that contract.

**Affected code paths:**
- `src/curation/checks.ts` § `checkStale`: guards with `typeof updated !== "string"` then `continue`. Every page with an unquoted `updated:` date is silently skipped by stale-detection. The check appears to work but produces zero stale issues against real wikis.
- `src/cli/commands/page.ts` § `renderScalar`: handles it locally for display purposes. Not propagated upstream.
- Potentially `compile.ts` and any future code that compares `created` / `updated` as strings.

**Hypothesis:** js-yaml's default schema (YAML 1.1) auto-casts `YYYY-MM-DD` literals to `Date`. Two clean fixes:
1. Configure `parseFrontmatter` in `src/storage/frontmatter.ts` to use a YAML schema that disables date auto-casting (e.g. `JSON_SCHEMA` or `CORE_SCHEMA` instead of the default — verify which one js-yaml exposes for the version installed).
2. Quote dates in all templates and in the docs examples: `created: "2026-05-22"`.

Fix (1) is the root-cause fix — guarantees strings regardless of how users author their pages. Fix (2) is a workaround and doesn't protect against users hand-writing pages with unquoted dates.

**Suggested fix:** Option 1 in a small Phase 2 follow-up slice before tagging `v0.2.0-phase2`. Add a focused test in `test/storage/frontmatter.test.ts` asserting that `parseFrontmatter("---\ncreated: 2026-05-22\n---\n")` returns `frontmatter.created === "2026-05-22"` (string), not a `Date`. Then update parseFrontmatter to use the non-date-casting schema. Confirm no other tests break.

**Phase:** Phase 2 — fix before v0.2.0-phase2 tag. Same-tier priority as F4 (template literal in schema.md): a real silent-miss bug, but not blocking the rest of the Phase 2 curation work.

---

## Resolved

(none yet)

---

## Conventions

- Numbered F-prefix (F1, F2, …) for stable references in commits and discussions.
- Move resolved items to the `## Resolved` section with the resolving commit hash for traceability. Don't delete — preserve the audit trail.
- Add new items at the bottom of `## Open`. Don't insert in the middle (avoids renumbering churn).
