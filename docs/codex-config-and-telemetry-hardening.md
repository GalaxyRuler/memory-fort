# Codex Implementation Brief — Config Parser + Cost Telemetry + Log Rotation (Phase 4.7)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Three independent, verified hygiene fixes bundled (all confirmed against the code during the 2026-05-29 audit review):

1. **`config.yaml` uses a brittle custom parser.** `parseYamlSubset` in `src/storage/config.ts` (~L67) is a hand-rolled indent-based parser. It skips own-line `#` comments but does **not** strip trailing inline comments (`model: x  # note` keeps `x  # note` as the value), throws on tabs, and is rigid (indent must be 0/2/4). **`js-yaml` is already a project dependency** (used by `frontmatter.ts` and `dashboard/config-patch.ts`), so the custom parser is gratuitous risk.

2. **Cost tracking is dead.** `chatWithAudit` in `src/llm/audit.ts` (~L111) writes a hardcoded `costUsd: 0` on every entry — no pricing lookup. `memory provider audit-summary` therefore always reports `$0.0000`.

3. **`.audit/` logs never rotate.** `wiki/.audit/llm-*.md`, `*-propose-*.md`, `consolidate-*.md` accumulate unbounded.

None are blocking; all are real. Severity: config Medium, cost Low, rotation Low.

---

## Scope guard

You will:

### Task 1 — Replace the custom YAML parser with js-yaml

- In `src/storage/config.ts`, replace `parseYamlSubset` with `js-yaml`'s `load` (pin `JSON_SCHEMA` like `frontmatter.ts` does, so `YYYY-MM-DD` strings are NOT auto-coerced to `Date` — this is a known footgun documented in the vault's own lessons).
- Map the parsed object into `MemoryConfig` with the same shape/defaults `loadMemoryConfig` returns today. Preserve the existing behavior: missing file → `{}`; parse error → log to stderr + return `{}` (don't throw and break callers).
- Confirm every config section still loads: `retention`, `embedding`/`embedder`, `llm`, `privacy`, `auto_promote`, `compile`, `dashboard.trusted_origins`, `search`, `voyage`, `vps`.
- This must accept standard YAML the custom parser rejected: trailing inline comments, blank lines, quoted strings, nested maps.

### Task 2 — Real cost estimation in the audit log

- Add a small pricing table (e.g. `src/llm/pricing.ts`) mapping `provider/model` → `{ promptPerMTok, completionPerMTok }` in USD. Seed with the models actually in use: `openai/gpt-4o-mini` (OpenRouter), the `google/gemini-3.1-flash-lite-preview*` ids seen in audit history, and Ollama models (cost 0 — local). Unknown model → `null` cost (not `0` — distinguish "free/local" from "unknown").
- In `chatWithAudit`, compute `costUsd` from `tokensIn`/`tokensOut` × the table instead of hardcoding `0`. When tokens or pricing are unavailable, write `null`.
- `provider audit-summary` already reads `costUsd`; confirm it sums correctly and renders `unknown` (or omits) when null rather than showing a misleading `$0.0000`.
- Keep it a static table — **do not** call a remote pricing API. Document that the table is manually maintained and may drift.

### Task 3 — `.audit/` log rotation

- Add rotation for `wiki/.audit/` logs: keep the last N days (default 30) of `llm-*.md` and the last N of each run-log family (`thread-propose-*`, `procedure-propose-*`, `consolidate-*`, `compile-*`), archiving or deleting older ones. **Per the no-permanent-deletion rule, prefer archiving** (move to `wiki/.audit/archive/` or gzip in place) over hard delete; if deleting, gate behind an explicit `--apply` (plan by default).
- Surface as `memory provider audit-rotate [--plan|--apply] [--keep-days N]` (or fold into an existing maintenance command — check `prune`/`retain` stubs first; if `retain` is the natural home, note it but don't implement the whole `retain` stub).
- Do not auto-run rotation in a hook or the scheduler in this brief — operator-invoked only. (Auto-scheduling can be a follow-up once the manual path is proven.)

### Task 4 — Tests + docs

- `test/storage/config.test.ts`: cases for trailing inline comments, quoted values, blank lines, a date value staying a string (JSON_SCHEMA), missing file → `{}`, malformed → `{}`. The existing config-load cases must pass unchanged.
- Tests for the pricing computation (known model → expected cost; unknown → null; local → 0) and for rotation (keeps N, archives older, plan vs apply).
- `templates/schema.md`: remove the note that `config.yaml` must avoid full YAML (now that js-yaml is used); document the cost table is static; document audit-log rotation.
- `docs/ROADMAP.md`: Phase 4.7 shipped 2026-05-29.

You will **not**:

- Change the `MemoryConfig` shape, defaults, or the config-patch safelist (Phase 4.3.C/J/O/T).
- Call any remote pricing API. Static table only.
- Hard-delete audit logs without an explicit `--apply`.
- Auto-schedule rotation in this brief.
- Touch the frontmatter or dashboard YAML handling (already on js-yaml).

If switching to js-yaml changes how any existing valid `config.yaml` parses (e.g. a value that the custom parser coerced differently), **stop and ask** — the live `~/.memory/config.yaml` must continue to load identically.

---

## Repo orientation

- `src/storage/config.ts` ~L67 `parseYamlSubset`, `loadMemoryConfig`. `js-yaml` import pattern + `JSON_SCHEMA` usage: see `src/storage/frontmatter.ts`.
- `src/llm/audit.ts` ~L111 `costUsd: 0`; `readLLMAuditSummary` for the summary render.
- `src/cli/commands/provider.ts` — `audit-summary` command; home for `audit-rotate`.
- `src/cli/commands/` — `prune`/`retain` stubs (check before adding a new command).
- `test/storage/config.test.ts`, `test/llm/audit.test.ts`, `test/cli/commands/provider-llm.test.ts`.

---

## Acceptance contract

1. `loadMemoryConfig` uses js-yaml, accepts trailing inline comments + standard YAML, keeps `YYYY-MM-DD` as strings, and the live `~/.memory/config.yaml` loads identically to before.
2. `chatWithAudit` writes a real `costUsd` (or `null` for unknown), never a misleading hardcoded `0`; `audit-summary` reflects it.
3. `memory provider audit-rotate --plan` lists rotation candidates; `--apply` archives (not hard-deletes by default) beyond the keep window.
4. Tests cover all three; full suite + typecheck green; build + build:ui clean; `git diff --check` clean.

---

## Commit boundaries

- Task 1: `fix: parse config.yaml with js-yaml instead of custom subset parser (Phase 4.7 Task 1)`
- Task 2: `feat: real LLM cost estimation from a static pricing table (Phase 4.7 Task 2)`
- Task 3: `feat: audit-log rotation (archive-by-default) (Phase 4.7 Task 3)`
- Task 4: `docs: config/cost/rotation (Phase 4.7 Task 4)`

---

## Out of scope (separate, lower priority)

- `/api/health` liveness-vs-data-quality split (behavior change with monitoring implications — its own brief).
- Auto-scheduling rotation.
