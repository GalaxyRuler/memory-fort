# Codex Implementation Brief — Config & Retention Integrity (Phase 4.10)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Four config/data-lifecycle correctness bugs confirmed by the 2026-05-29 audit (verified against code). Each makes the system silently ignore operator configuration.

### F-07 — config parse failure silently returns `{}` (HIGH)

`loadMemoryConfig()` in `src/storage/config.ts` (~L49-69) returns `{}` on a missing file (ENOENT, fine) **and on a YAML parse error** (~L62) **and when the parsed value isn't a plain object** (~L69) — all silently. A typo in `config.yaml` therefore reverts the entire system to defaults (e.g. silently switching the embedder/LLM provider) with no error surfaced. There is no runtime schema validation of the parsed object.

### F-08 — `prune` hardcodes 90 days, ignores `retention.raw_window_days` (HIGH)

`src/cli/commands/prune.ts` (~L36) defines `const RAW_PRUNE_DAYS = 90` and uses it at ~L100. `runPrune()` never loads config, so `retention.raw_window_days` (which exists in the schema and `init` default) has no effect. An operator who sets a 30- or 180-day window gets 90 regardless.

### F-13 — `compile.execute` in config-patch safelist but not in the type (MEDIUM)

`src/dashboard/config-patch.ts` safelist (~L36-52) accepts `compile.execute`, but `MemoryConfig.compile` (`src/storage/config.ts` ~L39-42) has no `execute` field. Type/schema drift — a writable path with no typed home invites bugs.

### F-06 — `compile.scheduled` defaults `true`, contradicting the spec (MEDIUM)

`templates/config.yaml` (~L17) ships `scheduled: true` and `auto-promote-scheduler.ts` (~L172) treats undefined as truthy (`record["scheduled"] !== false`), so scheduled compile runs by default — but the spec documents the default as `false`. (Note: `compile.execute` correctly defaults `false`, so the scheduled runs are artifact-mode prompt generation, not autonomous LLM execution — but background automation running by default still contradicts the documented contract.)

---

## Scope guard

You will:

### Task 1 — Fail-visible config loading (F-07)

- In `src/storage/config.ts`, distinguish three cases:
  - **Missing file** → return `{}` (defaults) — unchanged, this is normal pre-init state.
  - **Parse error / not-an-object** → do NOT silently return `{}`. Surface it: log a clear error to stderr (and `~/.memory/errors.log`) naming the file + the parse error, and either throw (for CLI commands that must have valid config) or return a result flagged `{ ok: false, error }` so callers can warn. Pick the least-disruptive option that makes the failure visible — at minimum a prominent stderr warning, never a silent default.
- Add lightweight runtime validation of known fields (provider enums, numeric ranges) — log warnings for unknown/invalid values; don't hard-fail on unknown keys (forward-compat).
- `memory verify` (or `doctor`): add/extend a check that `config.yaml` parses and validates, reporting `warn`/`fail` with the specific problem.
- Tests: malformed YAML → visible error (not silent `{}`); invalid provider value → warning; valid config → loads unchanged.

### Task 2 — `prune` honors retention config (F-08)

- In `src/cli/commands/prune.ts`, load `MemoryConfig` and use `retention.raw_window_days` (falling back to the 90 default only when unset). Remove the hardcoded `RAW_PRUNE_DAYS` as the source of truth (keep `90` as the documented default constant).
- Also check whether other retention fields (`wiki_status_stale_days`, `embeddings_prune_with_raw`, `archive_before_delete`) are honored by prune; wire any that are silently ignored, or document them as not-yet-implemented.
- Tests: `prune --plan` with `raw_window_days: 30` selects files older than 30 days, not 90; with no config, defaults to 90.

### Task 3 — Add `execute` to the compile config type (F-13)

- Add `execute?: boolean` to the `compile` shape in `MemoryConfig` (`src/storage/config.ts` ~L39-42) so the config-patch safelist entry has a typed home. Confirm `auto_promote`/`compile` types fully match the config-patch safelist (audit for any other safelisted-but-untyped path).
- Test: the config type includes `compile.execute`; a `tsc --noEmit` would have caught the drift (it's now consistent).

### Task 4 — Reconcile `compile.scheduled` default (F-06)

- Make the **code/template default `false`** to match the spec's documented contract (off by default — the safest default; an operator opts into background compile). Update `templates/config.yaml` `scheduled: true` → `false` and the scheduler's truthy-default (`!== false`) → explicit `=== true`, so undefined/missing means OFF.
- Keep `compile.execute` defaulting `false` (already correct).
- Tests: with no `compile` config, the scheduler does NOT register a compile interval; with `scheduled: true`, it does.

You will **not**:

- Change what `prune` archives vs deletes (archive-first stays; per the no-hard-delete rule).
- Add new retention semantics — just wire existing config into existing behavior.
- Make config validation reject unknown keys (forward-compat: warn, don't fail).
- Turn `compile.execute` on by default. It stays false.
- Touch the auto-promote scheduling logic beyond the compile-scheduled default.

If making config parse-errors throw breaks a command that legitimately runs pre-init (no config yet), **stop and ask** — missing-file must stay a clean `{}`, only malformed-existing-file should be loud.

---

## Repo orientation

- `src/storage/config.ts` ~L49-69 (load/parse), ~L39-42 (`MemoryConfig.compile` type).
- `src/cli/commands/prune.ts` ~L36, ~L100.
- `src/dashboard/config-patch.ts` ~L36-52 (safelist).
- `src/dashboard/auto-promote-scheduler.ts` ~L172 (scheduled truthy-default).
- `templates/config.yaml` ~L16-18.
- `src/cli/commands/init.ts` ~L70 (DEFAULT_CONFIG — keep in sync).
- Tests: `test/storage/config.test.ts`, `test/cli/commands/prune.test.ts`, `test/dashboard/auto-promote-scheduler.test.ts`.

---

## Acceptance contract

1. Malformed `config.yaml` produces a visible error/warning naming the file + problem — never a silent revert to defaults; missing file still returns `{}` cleanly.
2. `prune` uses `retention.raw_window_days`; verified by a test with a non-90 window.
3. `MemoryConfig.compile` includes `execute`; config-patch safelist has no untyped paths.
4. `compile.scheduled` defaults `false` in template + code; scheduler is off unless opted in; spec and code agree.
5. Full suite + `npm run typecheck` green; build clean; `git diff --check` clean.

---

## Commit boundaries

- Task 1: `fix: config parse failures are visible, not silent defaults (Phase 4.10 Task 1)`
- Task 2: `fix: prune honors retention.raw_window_days (Phase 4.10 Task 2)`
- Task 3: `fix: type compile.execute in MemoryConfig (Phase 4.10 Task 3)`
- Task 4: `fix: compile.scheduled defaults false to match spec (Phase 4.10 Task 4)`
