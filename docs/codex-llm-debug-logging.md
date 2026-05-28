# Codex Implementation Brief — LLM Debug Logging (Phase 4.3.H)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Diagnostic-only follow-up to Phase 4.3.G. Live-vault testing of the grounded propose pipelines (2026-05-28) shows the procedure pipeline correctly rejecting two clusters as "proposal skipped or malformed" — but the operator has no way to tell *why* without modifying source. The default audit log records only SHA-256 hashes of prompts and responses, never plaintext, because LLM responses can echo back observation content that includes personal data, paths, and credentials.

This brief adds **opt-in plaintext logging** of prompts and responses, gated on an environment variable, with loud startup signals so it's never enabled by accident. It also surfaces structured rejection reasons from the proposal parsers so the operator can tell whether the parser is rejecting valid output or whether the LLM is genuinely producing junk.

After this lands, when `MEMORY_LLM_DEBUG_LOG=1` is set:

- Every `chatWithAudit()` call writes prompt + response plaintext to `~/.memory/wiki/.audit/llm-debug-{YYYY-MM-DD}.md`
- The hashed `llm-{YYYY-MM-DD}.md` log remains unchanged (existing operator workflows continue working)
- A red banner prints on every CLI invocation: `⚠️  MEMORY_LLM_DEBUG_LOG=1 — prompt/response plaintext is being persisted`
- `memory thread propose` and `memory procedure propose` print rejection reasons per skipped cluster (e.g., "rejected: missing required field `proposed_slug`")

When the env var is unset, behavior is identical to today — no plaintext on disk, no banner, no behavioral change.

---

## Scope guard

You will:

- Add `MEMORY_LLM_DEBUG_LOG` env-var support in `src/llm/audit.ts`:
  - When `MEMORY_LLM_DEBUG_LOG === "1"` (string match, no truthy parsing — explicit only), `chatWithAudit()` appends a new entry to `<vaultRoot>/wiki/.audit/llm-debug-{YYYY-MM-DD}.md`
  - Entry format: markdown H2 header with ISO timestamp + consumer name, then fenced code blocks for `prompt` (the messages array, JSON-stringified) and `response` (the content string). Include the same metadata fields the hashed log records: model, tokens, duration, error
  - File is created with mode 0600 on POSIX; on Windows, write with default permissions but include a banner inside the file itself: `# LLM debug log — contains plaintext prompts and responses. Treat as sensitive.`
  - The debug write happens *after* the hashed audit write succeeds. Hashed log is the source of truth; debug log is supplementary
- Add a loud startup banner in `src/cli.ts` (or wherever the CLI entry resolves env vars) that prints to stderr when `MEMORY_LLM_DEBUG_LOG=1` is set. Banner text:
  ```
  ⚠️  MEMORY_LLM_DEBUG_LOG=1 — prompt/response plaintext is being persisted to ~/.memory/wiki/.audit/llm-debug-{date}.md
  ⚠️  Disable with `unset MEMORY_LLM_DEBUG_LOG` (POSIX) or `Remove-Item Env:MEMORY_LLM_DEBUG_LOG` (PowerShell)
  ```
  Banner prints once per CLI invocation, not per LLM call
- Refactor `parseThreadProposal()` in `src/llm/thread-propose.ts` and `parseProcedureProposal()` in `src/llm/procedure-propose.ts` to return a discriminated union instead of `T | null`:
  - Replace `T | null` with `{ ok: true; proposal: T } | { ok: false; reason: string }`
  - Each existing `return null` becomes `return { ok: false, reason: "<specific reason>" }`. Reasons must be specific enough to debug: `"empty content"`, `"yaml parse error: <error message>"`, `"missing required field: proposed_slug"`, `"title length out of bounds (got 7, expected 10-80)"`, `"steps array empty"`, etc.
  - Call sites in `proposeThread()` and `proposeProcedure()` adapt to the new shape; their public return type stays `T | null` (or becomes the same discriminated union — your call, document the choice)
- Update `src/cli/commands/thread.ts` and `src/cli/commands/procedure.ts` skipped-cluster reporting:
  - When the propose call returns the `{ ok: false, reason }` shape, store the reason in the `skipped[]` array (extend the existing `{ clusterIndex, reason }` shape)
  - When `MEMORY_LLM_DEBUG_LOG=1`, also include the prompt/response hashes from the audit log so operator can grep them
  - When the env var is unset, the skipped output still shows the reason — exposing parser reasons is not sensitive, only the LLM input/output content is
- Add `MEMORY_LLM_DEBUG_LOG=1` to the schema docs (`templates/schema.md`) under a new "Diagnostic env vars" section, with a clear warning about plaintext persistence
- Tests covering:
  - Env var unset → no debug file written, no banner
  - Env var set to `"1"` → debug file written with full plaintext, banner printed to stderr
  - Env var set to `"true"` or `"yes"` or anything other than `"1"` → no debug file (strict opt-in)
  - Parse rejection reasons are specific and surface to CLI output
  - The discriminated-union refactor doesn't break any existing call site

You will **not**:

- Default to plaintext logging. Strict opt-in via `=1` only — `=true`, `=on`, `=yes`, `=anything-else` all leave the behavior off
- Send plaintext over the wire to any remote service. Debug log is local-only
- Log API keys, even in debug mode. The OpenRouter SDK never includes the key in request bodies; double-check that the `messages` array doesn't carry it
- Add a CLI flag like `--debug-log`. Env-var-only enforces the "you have to actively set this" friction
- Auto-rotate or auto-delete the debug log. The operator decides when to delete it. (The hashed audit log doesn't auto-rotate either — same pattern.)
- Add the debug log to git. `.audit/` is already gitignored at the vault level; double-check and explicitly add `llm-debug-*.md` to `.gitignore` if not covered
- Backfill rejection reasons for historical audit entries. Only new runs get the structured reason field
- Touch the propose orchestrator's *promotion* logic or write-time grounding filter. Phase 4.3.G's grounding remains untouched

If the env-var detection logic surfaces in more than one place (e.g., audit module + CLI entry), centralize it in `src/llm/audit.ts` as an exported `isDebugLogEnabled(env?: NodeJS.ProcessEnv): boolean` helper. Single source of truth.

---

## Repo orientation (verified before brief)

- `src/llm/audit.ts` (Phase 4.3.B) — `chatWithAudit()` hashes prompts/responses and appends to `.audit/llm-{date}.md`. New debug-write path hooks here, after the hashed write
- `src/llm/thread-propose.ts` (Phase 4.3.D) — `parseThreadProposal()` currently returns `ThreadProposal | null`. ~10 `return null` sites become `return { ok: false, reason: ... }`
- `src/llm/procedure-propose.ts` (Phase 4.3.E) — `parseProcedureProposal()` same shape, same refactor. The 38-token cluster response observed 2026-05-28 likely hits the `"empty content"` or `"yaml parse error"` branch — we'll know after this lands
- `src/cli/commands/thread.ts` and `src/cli/commands/procedure.ts` (Phase 4.3.D/E) — `skipped[]` array currently stores `{ clusterIndex, reason: "proposal skipped or malformed" }`. New reason comes from the parser, not a hardcoded string
- `src/cli.ts` — CLI entry. Banner-print logic lives near the top of the command-router, before any command executes
- `templates/schema.md` — current docs reference the hashed audit log under `## LLM audit log`. New section heading: `### Diagnostic env vars` under that, documenting `MEMORY_LLM_DEBUG_LOG`

---

## Acceptance contract

1. With `MEMORY_LLM_DEBUG_LOG` unset, every existing test continues to pass — no behavioral change
2. With `MEMORY_LLM_DEBUG_LOG=1` set, a fresh `memory provider test-llm` call writes both `llm-{date}.md` (hashed, as before) and `llm-debug-{date}.md` (plaintext, new). The plaintext file contains the test prompt and response verbatim
3. With `MEMORY_LLM_DEBUG_LOG=1` set, `memory thread propose --plan` against a cluster that hits a parser rejection prints the specific reason (e.g., `"cluster 0: missing required field: proposed_slug"`) to stdout, and the plaintext response is in `llm-debug-{date}.md`
4. With `MEMORY_LLM_DEBUG_LOG=true` (string mismatch), no debug file is written. Strict opt-in
5. Banner prints once to stderr per CLI invocation when enabled. Not once per LLM call
6. `git status` after a propose run with debug enabled shows no new tracked files in the repo (debug logs stay in `~/.memory/wiki/.audit/`, which is outside the repo)
7. Full test suite passes. New tests cover the four state-table rows: env-set-and-=1, env-set-and-=true, env-unset, env-empty-string
8. `templates/schema.md` documents the env var with the privacy warning

---

## Verification commands

After implementation, the operator (separately, not Codex) runs:

```powershell
# Baseline: no debug
node dist/cli.mjs provider test-llm
ls "C:\Users\Admin\.memory\wiki\.audit\llm-debug-*.md"  # should not exist

# Enable debug
$env:MEMORY_LLM_DEBUG_LOG = "1"
node dist/cli.mjs provider test-llm
# Banner should print to stderr
ls "C:\Users\Admin\.memory\wiki\.audit\llm-debug-*.md"  # should exist now
cat "C:\Users\Admin\.memory\wiki\.audit\llm-debug-2026-05-28.md"  # contains plaintext prompt + response

# Re-run procedure propose to see the rejection reason
node dist/cli.mjs procedure propose --plan
# Output should now say "cluster 0: <specific reason>" instead of "proposal skipped or malformed"

# Disable when done
Remove-Item Env:MEMORY_LLM_DEBUG_LOG
```

---

## Commit boundaries

Suggested chunking (5 commits, mirrors prior phases):

- Task 1: `feat: MEMORY_LLM_DEBUG_LOG plaintext debug log in audit module`
- Task 2: `feat: discriminated-union rejection reasons in thread + procedure parsers`
- Task 3: `feat: surface parse rejection reasons in CLI skipped output`
- Task 4: `feat: startup banner when MEMORY_LLM_DEBUG_LOG is enabled`
- Task 5: `docs: diagnostic env vars in schema + roadmap (Phase 4.3.H)`

---

## Security review

This brief intentionally creates a path to persist LLM plaintext to disk. Justification:

- Default-off, strict-opt-in (`=1` only, not `=true`)
- Loud per-invocation banner so the operator can't forget it's on
- Files land in `~/.memory/wiki/.audit/` which is outside the git tree by default
- No network egress of plaintext — local-only diagnostic
- The hashed audit log (Phase 4.3.B) remains the audit source of truth; debug log is supplementary

If during implementation you find a cleaner way to surface rejection reasons *without* persisting plaintext (e.g., in-memory only, printed once to stderr when the parser fails), prefer that approach and skip the file-write entirely. **Stop and ask** before adding plaintext persistence if you can solve the diagnostic need another way.

---

## Out-of-scope follow-ups

Do not bundle these into this brief:

- LLM-side fix for the gpt-4o-mini procedure-cluster rejections (separate work — needs the debug log to even diagnose)
- Auto-rotation or retention policy for either audit log
- A web UI surface for browsing audit logs
- Streaming the debug log to a remote sink
- Cost-tracking fix (audit-summary reports $0.0000 for gpt-4o-mini — pricing table is stale)
