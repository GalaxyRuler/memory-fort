# Follow-ups

Known issues, refinements, and observations that surfaced during Phase 1 implementation but aren't blocking the current step. Each entry: what it is, where it was discovered, hypothesis, and when to address.

Update this file whenever a real issue is observed but deferred. Keep entries terse. When an entry is resolved, move it to a `## Resolved` section with the resolving commit hash.

---

## Open

> **Status (2026-05-29):** Genuinely open: **F5** (`MEMORY_*_DIR` override pattern), **F6** (orphan raw checkpoint file), **F21** (search-quality thresholds hardcoded in `runSearch`). Every other F-item below is **resolved** — struck through with its resolving commit. They remain in place (not yet relocated to `## Resolved`) for the audit trail; treat any struck-through entry as done.

### F1. ~~PostToolUse hook captures empty `**Output:**` block (Claude Code)~~ — RESOLVED at d243ae2

**Discovered:** 2026-05-21 step #7-fix checkpoint. **Resolved:** 2026-05-21 at step #16.5 (`d243ae2`) — the field-fallback chain in `readToolOutput` (`tool_output ?? tool_response ?? output`) picked up Claude Code's payload shape. Verified at `c08532d` regression test: real headless Claude session produced `claude-code-ef879585-7049-4bd5-a083-3e2698f7a296.md` with the Output section populated (stdout, stderr, interrupted, isImage fields). Same fix that closed F7 (Codex) also closed F1 (Claude Code) — that's the value of platform-agnostic fallback chains over per-platform branching.

---

### F2. ~~tsdown emits PLUGIN_TIMINGS performance warnings on every build~~ — RESOLVED at 6d0d9cf

**Discovered:** 2026-05-21, step #7-fix build (also visible in step #6, step #7).

**Symptom:** `npm run build` succeeds (exit 0) but tsdown emits PLUGIN_TIMINGS lines after the bundle summaries. Not errors, but noise in build output.

**Hypothesis:** tsdown ^0.22 enables performance instrumentation by default; the warnings show plugin timings that exceed some threshold. Likely tunable via `tsdown.config.ts` — probably a `silent: true` or `logLevel: 'error'` option.

**Suggested fix:** Look up tsdown 0.22 config option to suppress non-error output. Add to `tsdown.config.ts`. Verify build still works and CI-style output is clean.

**Resolved:** 2026-05-23 — Phase 3 polish Slice 20 set Rolldown `checks.pluginTimings` to `false` through `tsdown.config.ts`. Build output now has zero `PLUGIN_TIMINGS` lines.

**Phase:** Phase 6 (Polish) — purely cosmetic; the warnings don't change behavior.

---

### F3. ~~MCP integration~~ — FULLY RESOLVED at 84143e8 + verified 2026-05-21

**Discovered:** 2026-05-21, after step #7 install. **Fully resolved:** 2026-05-21 — script existed at step #8 (`d8a00c2`), wrong-location fixed at step #7-fix-2 (`84143e8`), end-to-end verified via real `claude --plugin-dir ...` session where Claude Code connected to `plugin:memory:memory` server in 544ms, selected `mcp__plugin_memory_memory__log_observation`, called it, produced `~/.memory/raw/2026-05-21/manual-mcp-1779378835136.md` with the expected content.

**Key learning for future installs:** plugin-bundled MCPs live at `<plugin>/.mcp.json` (NOT user-level `~/.claude/.mcp.json`). Tool name in session is `mcp__plugin_<source>_<server>__<tool>`.

---

### F4. ~~`{{install_commit}}` template variable left literal in rendered schema.md~~ — RESOLVED at 6d0d9cf

**Discovered:** 2026-05-21, after `memory init` ran on the real machine.

**Symptom:** The schema.md template variable `{{install_commit}}` is supposed to be substituted with the source repo's HEAD commit hash, but `memory init` runs at `~/.memory/` where there's no source repo to query. The rendered `~/.memory/schema.md` still shows `{{install_commit}}` literal (or "unknown" depending on Codex's choice during step #6 implementation — verify by inspecting the file).

**Hypothesis:** `memory init` needs a way to know the source repo's location. Options: (a) accept `--source-repo-dir <path>` flag on init, (b) embed the commit hash at build time via tsdown define, (c) drop the template variable (it's informational only).

**Suggested fix:** Option (b) is cleanest. Use tsdown's `define` option to inject `process.env.MEMORY_BUILD_COMMIT` at build time; init reads it and substitutes.

**Resolved:** 2026-05-23 — Phase 3 polish Slice 20 injects `__MEMORY_BUILD_COMMIT__` with `git rev-parse --short HEAD` at build time and uses it while rendering `schema.md`. Fresh `memory init` output replaces `{{install_commit}}` with a concrete short commit hash, falling back to `unknown` if git is unavailable.

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

### F8. ~~js-yaml auto-coerces YYYY-MM-DD frontmatter dates to Date objects~~ — RESOLVED at ce18692

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

**Resolved:** 2026-05-22 — `parseFrontmatter` and `serializeFrontmatter` now use `yaml.JSON_SCHEMA`, which omits the YAML 1.1 timestamp auto-cast. Regression tests in `test/frontmatter.test.ts` and `test/curation/checks.test.ts` lock the behavior.

**Phase:** Phase 2 — fix before v0.2.0-phase2 tag. Same-tier priority as F4 (template literal in schema.md): a real silent-miss bug, but not blocking the rest of the Phase 2 curation work.

---

### F11. ~~Claude Code plugin scripts tracked inside `~/.memory/` repo create rebuild noise~~ — RESOLVED at ee690b2

**Discovered:** 2026-05-23, during Phase 3 Slice 6.5b implementation when Codex had to make a `chore: update deployed auto-push worker bounded retry bundle` commit in the live `~/.memory/` repo after rebuilding the source repo.

**Symptom:** Every time `memory-system` source rebuilds (via tsdown), the plugin scripts under `~/.memory/claude-code-plugin/scripts/` change content. Git in `~/.memory/` sees them as modified files (they were committed back in Slice 1's catch-up commit `e1cb730`). The Slice 6.5b auto-sync worker correctly treats them as non-raw dirty files and refuses to push — but to clear the dirty state, the user (or in practice, Codex during slice verification) must manually commit them with a generic `chore: update deployed ...` message. One such commit accumulates per source rebuild.

**Hypothesis:** `claude-code-plugin/` shouldn't have been committed to the tracked `~/.memory/` repo in the first place. It's an install-time generated artifact created by `memory install claude-code`. The plugin scripts dir is a Windows junction (or symlink) pointing at `dist/hooks/` in the source repo; when git traverses INTO the junction, it sees the files as if they're inside the repo and tracks content changes.

**Suggested fix:** Small slice (Slice 7.5 or polish-phase task):
1. `git rm -r --cached claude-code-plugin/` in `~/.memory/`
2. Add `claude-code-plugin/` to `~/.memory/.gitignore`
3. Update the `memory init` template's .gitignore similarly so fresh installs never track the plugin dir
4. Commit + push the cleanup

**Resolved:** 2026-05-23 — Phase 3 polish Slice 19 un-tracked `claude-code-plugin/` in the live `~/.memory/` repo, added `claude-code-plugin/` to the live `.gitignore`, and updated the `memory init` template so fresh installs ignore it.

**Phase:** Phase 3 — slot before v0.3.0-phase3 tag if convenient; not blocking remaining slices. Workaround in place (Codex commits the bundle updates manually).

---

### F12. ~~CRLF warnings on raw files newly tracked under Windows~~ — RESOLVED at ee690b2

**Discovered:** 2026-05-23, during Phase 3 Slice 6.5 (un-gitignore raw/) when the existing 29 raws were first added to git on the Windows machine.

**Symptom:** Git emits CRLF normalization warnings ("LF will be replaced by CRLF the next time Git touches it") whenever raw files are tracked or restaged on Windows. Cosmetic noise; doesn't affect correctness because the post-receive hook on the VPS reads the files regardless of line endings.

**Hypothesis:** Windows machines have `core.autocrlf=true` by default. Raw files are written by hooks with LF endings (Node default), but git wants to convert to CRLF on checkout. The conversion is harmless for `.md` files but the warnings clutter terminal output during sync.

**Suggested fix:** Add `~/.memory/.gitattributes` with:
```gitattributes
*.md text eol=lf
```

This pins line endings to LF for all markdown files, suppressing the warnings and ensuring consistent content across Linux (VPS) and Windows (creator machines). One small commit in the live repo + an update to the `memory init` template so fresh installs ship the .gitattributes.

**Resolved:** 2026-05-23 — Phase 3 polish Slice 19 added live and init-template `.gitattributes` rules for `.md`, `.yaml`, and `.json` files.

**Phase:** Phase 3 — slot alongside F11 in the same cleanup slice if you do one.

---

### F14. ~~Embedding sidecars should be ignored wholesale~~ — RESOLVED at ee690b2

**Discovered:** 2026-05-23, during the Slice 10 audit after the fake-vector smoke created `embeddings/wiki.embeddings.jsonl`.

**Symptom:** The live `.gitignore` only ignored `embeddings/raw.*.jsonl`, so wiki/crystal embedding sidecars could appear as untracked files after local or VPS-side search refreshes.

**Hypothesis:** Embeddings are runtime sidecars computed from synced content and should not be tracked in the live `~/.memory/` git repo.

**Suggested fix:** Replace the narrow `embeddings/raw.*.jsonl` ignore rule with `embeddings/` in both the live repo and the `memory init` template.

**Resolved:** 2026-05-23 — Phase 3 polish Slice 19 broadened the ignore rule to `embeddings/` and verified no embedding sidecars remain tracked.

**Phase:** Phase 3 polish — same cleanup slice as F11/F12.

---

### F19. ~~Live `config.yaml` line 19 malformed inline allowlist/comment form~~ — RESOLVED at ee690b2

**Discovered:** 2026-05-23, during Phase 3 polish cleanup after repeated config parse checks targeted line 19 of the live `~/.memory/config.yaml`.

**Symptom:** The live config used an inline empty array plus trailing explanatory comment for `privacy.allowlist`, which was harder for the minimal config parser and humans to distinguish from malformed inline YAML.

**Hypothesis:** Keeping the comment on its own line and the value as a plain `allowlist: []` avoids parser ambiguity without changing the setting.

**Suggested fix:** In the live `~/.memory/config.yaml`, split the comment and value into two lines:
```yaml
privacy:
  # regex patterns that bypass the redaction filter
  allowlist: []
```

**Resolved:** 2026-05-23 — Phase 3 polish Slice 19 normalized the live config line and verified `memory stats` no longer emits a config parse warning.

**Phase:** Phase 3 polish — same cleanup slice as F11/F12/F14.

---

### F15. ~~Document `voyageai` 0.2.1 ESM directory-import workaround~~ — RESOLVED at 6d0d9cf

**Discovered:** 2026-05-23, during Slice 11 Voyage SDK integration when the SDK's ESM entry path failed under Node 22 due unsupported directory imports.

**Symptom:** Direct ESM import of `voyageai` could fail before the wrapper constructed a client, even though the SDK's CommonJS export loaded correctly.

**Hypothesis:** `voyageai@0.2.1` publishes an ESM entry that performs directory imports Node 22 rejects, while the CJS export path avoids that packaging quirk.

**Suggested fix:** Keep the existing `createRequire("voyageai")` workaround until the SDK publishes a fixed ESM entry. Document the quirk so future SDK cleanup does not accidentally regress it.

**Resolved:** 2026-05-23 — Phase 3 polish Slice 20 documents the `voyageai@0.2.1` ESM directory-import quirk and records the existing `createRequire` workaround as intentional and stable. Upstream issue not filed; low priority.

**Phase:** Phase 3 polish — documentation-only follow-up.

---

### F20. ~~`.gitattributes` was mistakenly ignored by the init template~~ — RESOLVED at 6d0d9cf

**Discovered:** 2026-05-23, during the Slice 19 audit after `.gitattributes` had to be force-added despite being a file that should be tracked.

**Symptom:** The `memory init` `.gitignore` template included `.gitattributes`, so fresh installs created a real git configuration file and then ignored it. Slice 19 worked around this with `git add -f`.

**Hypothesis:** `.gitattributes` is repository configuration, not a runtime artifact. It should be tracked normally, while `embeddings/` and `claude-code-plugin/` remain ignored.

**Suggested fix:** Remove `.gitattributes` from both the init `.gitignore` template and the live `~/.memory/.gitignore`, then remove the force-add workaround.

**Resolved:** 2026-05-23 — Phase 3 polish Slice 20 removes `.gitattributes` from the source and live `.gitignore` files. Fresh `memory init` now tracks `.gitattributes` with a normal `git add`.

**Phase:** Phase 3 polish — immediate typo cleanup after Slice 19.

---

### F16. ~~SearchDocument lacked frontmatter `updated` for metadata recency~~ — RESOLVED at 044660a

**Discovered:** 2026-05-23, during Phase 3 search-quality audit after metadata scoring was found to depend on filesystem `mtime`.

**Symptom:** `SearchDocument` exposed `mtime` but not frontmatter `updated`, so metadata recency could rank pages based on checkout/write time rather than the curated page's own update date.

**Hypothesis:** The corpus loader should carry `frontmatter.updated` as a first-class field and metadata scoring should prefer it, falling back to `mtime` only when frontmatter lacks a valid date.

**Suggested fix:** Add `updated: string | null` to `SearchDocument`, populate it from `frontmatter.updated` when it matches `YYYY-MM-DD`, and update metadata scoring to prefer that field.

**Resolved:** 2026-05-23 — Phase 3 polish Slice 21 added `SearchDocument.updated`, loaded it from frontmatter, and switched metadata recency to `updated ?? mtime`.

**Phase:** Phase 3 polish — ranking-quality cleanup.

---

### F18. ~~Metadata-only search results surface random pages for nonsense queries~~ — RESOLVED at 044660a

**Discovered:** 2026-05-23, during Phase 3 search-quality audit of the dashboard `/api/search` endpoint.

**Symptom:** Metadata scoring ranks every active document, so queries with no meaningful lexical/vector/exact/graph match could still return top pages purely because their status/confidence/recency metadata was strong.

**Hypothesis:** Metadata is useful as a tie-breaker but should not be a sufficient retrieval signal. Search should require at least one non-metadata source before a document can appear in final results.

**Suggested fix:** Filter fused RRF results to require a contributing source other than `metadata`. While validating against real Voyage embeddings, also keep low positive cosine scores from acting as universal vector matches and ignore tiny stopword-only lexical hits.

**Resolved:** 2026-05-23 — Phase 3 polish Slice 21 excludes metadata-only RRF results, applies a weak-vector floor, and filters stopwords from search-core lexical signals. The live VPS now returns zero results for the sentinel nonsense query while real Voyage queries still return ranked pages.

**Phase:** Phase 3 polish — ranking-quality cleanup.

---

### F13. ~~Bundling strategy for retrieval/dashboard/runtime dependencies was implicit~~ — RESOLVED at d6e0024

**Discovered:** 2026-05-23, during Phase 3 retrieval and dashboard slices as different bundles needed different dependency strategies.

**Symptom:** The project intentionally mixes self-contained retrieval bundles, external `voyageai` runtime loading, and cold-start hook bundles, but that strategy was only encoded in build/deploy behavior and slice notes.

**Hypothesis:** Future polish or dependency updates could accidentally re-bundle `gray-matter`/`js-yaml`, break the `voyageai` CommonJS workaround, or remove the VPS runtime dependency install unless the strategy is documented in architecture.

**Suggested fix:** Add a "Bundling strategy" subsection to `docs/architecture.md` explaining each major bundle family, why `voyageai` stays external, why some retrieval modules use self-contained parsers, and how `install-vps` supplies the runtime SDK.

**Resolved:** 2026-05-23 — Phase 3 polish Slice 22 documented the bundling/runtime strategy in `docs/architecture.md`.

**Phase:** Phase 3 polish — documentation-only closeout.

---

### F17. ~~Raw embedding refresh exceeds Voyage token caps on large sessions~~ — RESOLVED at d6e0024

**Discovered:** 2026-05-23, during Phase 3 `/api/search` raw/all-scope verification.

**Symptom:** Refreshing raw embeddings sent large batches of raw sessions to Voyage. Some raw sessions are huge, and the old fixed 64-doc batch could exceed Voyage's cumulative batch cap by an order of magnitude. The live pre-fix raw search produced 41 warnings, including a 400 response for a 905,271-token batch against a 120,000-token limit.

**Hypothesis:** Raw embedding refresh needs two guardrails: truncate each document before embedding, and split batches by estimated cumulative token count rather than document count alone.

**Suggested fix:** Estimate tokens with a stable chars/4 heuristic, truncate each document to a 30K-token safety margin, and build batches under a 100K-token cumulative safety margin while keeping `batchSize` as a max-doc soft cap.

**Resolved:** 2026-05-23 — Phase 3 polish Slice 22 added per-doc truncation plus token-aware batch construction in `refreshEmbeddings`. Post-deploy raw search returned 3 raw results with `degraded: false` and zero warnings.

**Phase:** Phase 3 polish — functional closeout before checkpoint/tag.

---

### F21. Search-quality thresholds are hardcoded in `runSearch`

**Discovered:** 2026-05-23, during Phase 3 polish Slice 21 when F18 exposed weak vector matches and tiny lexical stopword hits for sentinel nonsense queries.

**Symptom:** The search core now has good default ranking-quality thresholds (`MIN_VECTOR_SCORE = 0.25` and a small query-side lexical stopword set), but they are hardcoded inside `src/retrieval/search.ts`.

**Hypothesis:** Hardcoded values are fine for Phase 3, but future tuning may want these exposed as `SearchOptions` such as `cosineFloor` and `stopwords`, or loaded from config once real usage patterns settle.

**Suggested fix:** Leave the current defaults in place for Phase 3. In a future polish/tuning slice, make the thresholds configurable while preserving current defaults for CLI/MCP/dashboard callers.

**Phase:** Phase 4 polish/tuning — not blocking the Phase 3 checkpoint.

---

## Resolved

(none yet)

---

## Conventions

- Numbered F-prefix (F1, F2, …) for stable references in commits and discussions.
- Move resolved items to the `## Resolved` section with the resolving commit hash for traceability. Don't delete — preserve the audit trail.
- Add new items at the bottom of `## Open`. Don't insert in the middle (avoids renumbering churn).
