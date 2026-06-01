# Memory Fort Health And Test Hardening Plan

> **For agentic workers:** Use `superpowers:test-driven-development` for code changes and `superpowers:systematic-debugging` for any failing command before changing implementation. Track progress by checking off each `- [ ]` item.

**Goal:** Make Memory Fort reliably accessible from the local dashboard, resolve the real health failures for the intended vault, and leave frontend/backend verification repeatable.

**Current evidence from 2026-06-01 testing:**
- `npm test` passed: 212 files, 1224 tests.
- `npm run test:ui` passed: 58 files, 206 tests.
- `npm run typecheck` passed.
- `npm run build:all` passed.
- Focused regressions passed for dashboard root selection, Whitedragon-style `sync.remote_name`, compressed-fact compile watermarks, and compacted raw watermark remapping.
- Dashboard status returned HTTP 200 at `http://127.0.0.1:4410/api/status` against `C:\Users\Admin\.memory` with 231 wiki pages and 1364 raw observations.
- Source diagnostics now prefer explicit/configured `dashboard.url` and `sync.remote_name` instead of assuming the legacy VPS host/remote name.
- Operator-owned external state remains out of scope here: no Whitedragon SSH/deploy/global service changes were made.

**Assumptions:**
- App repo: `C:\CodexProjects\memory-system`.
- Intended vault for this work: `C:\Users\Admin\OneDrive\Documents\Memory Fort`, unless the operator decides `C:\Users\Admin\.memory` should remain canonical.
- No Whitedragon/VPS SSH, deploy, force push, hard reset, or secret inspection happens in this plan without explicit operator approval.
- Runtime logs should not be written to the repo root.

**Non-goals:**
- Do not redesign the dashboard.
- Do not change retrieval ranking behavior unless a verification step proves it is broken beyond empty-vault state.
- Do not modify lockfiles or add dependencies.
- Do not run live provider calls unless the operator explicitly chooses to test configured providers.

---

## Phase 0: Freeze Baseline And Choose The Canonical Vault

**Purpose:** Avoid fixing the wrong checkout or wrong vault.

**Files likely touched:** none, unless documentation needs a clarification.

- [ ] Confirm repo and branch.

  ```powershell
  git -C C:\CodexProjects\memory-system status --short --branch
  ```

- [ ] Remove or relocate Codex-created runtime logs outside the repo root.

  Current known artifact: `C:\CodexProjects\memory-system\dashboard-local.log`.

- [ ] Decide canonical vault root.

  Option A: `C:\Users\Admin\OneDrive\Documents\Memory Fort` is canonical.

  Option B: `C:\Users\Admin\.memory` remains canonical and the OneDrive folder is only a workspace folder.

- [ ] Record the chosen vault in the execution notes before making operational changes.

**Exit criteria:**
- The team agrees which vault root should power the dashboard and verification.
- `git status --short` contains only intended source/doc changes.

---

## Phase 1: Make Dashboard Startup Explicit And Hard To Misroute

**Problem:** The smoke test initially served `C:\Users\Admin\.memory` because the PowerShell launch command interpolated `$env:MEMORY_ROOT` too early. The app already supports an internal `vaultRoot` option, but the CLI only exposes environment-driven root selection.

**Files:**
- Modify: `src/cli/commands/dashboard.ts`
- Modify: `docs/cli.md`
- Test: `test/cli/commands/dashboard.test.ts`
- Optional docs: `README.md` or `docs/troubleshooting.md`

- [ ] Write failing tests for an explicit dashboard root option.

  Add tests that `memory dashboard --root <path>` passes that exact path to `createServer`, takes precedence over `MEMORY_ROOT`, and still respects `--host`, `--port`, and `--no-open`.

  ```powershell
  npm test -- test/cli/commands/dashboard.test.ts
  ```

- [ ] Implement `--root <path>` on `memory dashboard`.

  Resolve the path with `path.resolve`, pass it as `vaultRoot`, and include the resolved vault root in stdout so misroutes are visible.

- [ ] Document safe Windows startup commands.

  Preferred command after implementation:

  ```powershell
  npm run memory -- dashboard --root "C:\Users\Admin\OneDrive\Documents\Memory Fort" --no-open
  ```

  If using environment variables, show the escaped PowerShell form for background processes and keep logs under `$env:TEMP`.

- [ ] Verify the focused test passes.

  ```powershell
  npm test -- test/cli/commands/dashboard.test.ts
  ```

**Exit criteria:**
- Dashboard startup can explicitly select the intended vault without relying on fragile shell interpolation.
- `/memory/api/status` reports the expected `vaultRoot`.

---

## Phase 2: Repair Operator Health For The Chosen Vault

**Problem:** Runtime health is failing for operator role because the chosen vault has no configured sync remote, and the verify check fell back to the legacy `vps` name. The repo dashboard has moved to Whitedragon, so source diagnostics must accept a configured remote/dashboard URL instead of assuming VPS naming. The same vault also has prompt drift and client capture warnings.

**Files likely touched:** vault files only, after the operator confirms the canonical vault. Source changes should not be needed unless commands produce unclear diagnostics.

- [ ] Inspect current vault git remotes without changing them.

  ```powershell
  git -C "C:\Users\Admin\OneDrive\Documents\Memory Fort" remote -v
  ```

- [ ] If the vault is supposed to sync to Whitedragon or another hosted mirror, run the project bootstrap path with the intended remote name rather than hand-editing `.git/config`.

  Dry-run or plan first where available. Use the project command documented in `docs/cli.md`:

  ```powershell
  $env:MEMORY_ROOT = "C:\Users\Admin\OneDrive\Documents\Memory Fort"
  npm run memory -- sync-bootstrap --remote-name whitedragon
  ```

  Stop before SSH/deploy actions if credentials, host choice, or deploy authority is unclear.

- [ ] Resolve prompt drift.

  Preview first:

  ```powershell
  $env:MEMORY_ROOT = "C:\Users\Admin\OneDrive\Documents\Memory Fort"
  npm run memory -- sync-prompts --plan
  ```

  Apply only if drift is unintentional:

  ```powershell
  npm run memory -- sync-prompts --apply
  ```

  If a prompt was intentionally customized, add the repo-supported `# memory:custom` marker instead of overwriting it.

- [ ] Refresh client capture integration deliberately.

  Start with:

  ```powershell
  $env:MEMORY_ROOT = "C:\Users\Admin\OneDrive\Documents\Memory Fort"
  npm run memory -- doctor
  ```

  Then reconnect only the clients the operator actually uses on this machine:

  ```powershell
  npm run memory -- connect codex
  npm run memory -- connect claude-code
  npm run memory -- connect vscode
  npm run memory -- connect antigravity
  ```

- [ ] Re-run operator health through the running dashboard.

  ```powershell
  Invoke-RestMethod "http://127.0.0.1:4410/memory/api/health?role=operator" | ConvertTo-Json -Depth 20
  ```

**Exit criteria:**
- `git.remote` no longer fails, or the remaining failure is documented as an operator-owned Whitedragon/remote-sync boundary.
- Prompt drift warnings are either applied or marked custom.
- Client capture warnings are either fixed for active clients or explicitly accepted as inactive-client warnings.

---

## Phase 3: Populate Or Repoint The Vault So Search And Compile Checks Mean Something

**Problem:** Offline verify failed because the intended vault looked effectively empty to the search and compile checks: zero indexed/searchable results and no recent compile state.

**Files likely touched:** vault `raw/`, `wiki/`, `facts/`, `state/`, and generated index files. Source changes are out of scope unless empty-vault diagnostics are misleading.

- [ ] Confirm whether an empty OneDrive vault is expected.

  ```powershell
  $env:MEMORY_ROOT = "C:\Users\Admin\OneDrive\Documents\Memory Fort"
  npm run memory -- stats
  ```

- [ ] If the OneDrive vault should contain existing memory, backfill or sync it from the real source instead of seeding dummy data.

  Use read-only planning commands first:

  ```powershell
  npm run memory -- backfill --plan
  npm run memory -- provider reindex-embeddings --plan
  ```

- [ ] If the OneDrive vault is intentionally new, initialize and create a first real observation.

  ```powershell
  npm run memory -- init
  npm run memory -- log "Memory Fort local dashboard access was verified against the OneDrive vault."
  ```

- [ ] Run a no-write compile preview first.

  ```powershell
  npm run memory -- compile --plan
  ```

- [ ] Only after reviewing the plan, run the write path needed for the chosen workflow.

  ```powershell
  npm run memory -- compile --execute --plan
  ```

  Apply execution only when provider configuration and write intent are confirmed.

- [ ] Re-run offline verification.

  ```powershell
  $env:MEMORY_ROOT = "C:\Users\Admin\OneDrive\Documents\Memory Fort"
  npm run memory -- verify --offline --json
  ```

**Exit criteria:**
- Search failure is either fixed by real indexed content or documented as an expected empty-vault condition.
- Compile recency is present, or the operator has explicitly deferred compile execution.

---

## Phase 4: Stabilize The One Observed Test Flake

**Problem:** The first full `npm test` run timed out once in `test/cli/commands/init-prompts.test.ts`, while the isolated test file and the full rerun passed. Treat it as a flake until reproduced.

**Files:**
- Inspect: `test/cli/commands/init-prompts.test.ts`
- Inspect related helpers in `test/cli/commands/`
- Modify only if reproduction identifies a real shared-state or timing bug.

- [ ] Try to reproduce with a tight loop before changing code.

  ```powershell
  1..10 | ForEach-Object { npm test -- test/cli/commands/init-prompts.test.ts; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
  ```

- [ ] If it reproduces, instrument temp directory setup, fixture copying, and any git/process calls used by the test.

- [ ] Fix the smallest confirmed cause.

  Likely candidates to investigate:
  - Shared temp paths.
  - Slow or inherited git state.
  - Unawaited async file work.
  - Test timeout too low for Windows filesystem contention.

- [ ] Add or adjust a focused regression test before implementation if the cause is behavioral.

- [ ] Re-run focused and full backend tests.

  ```powershell
  npm test -- test/cli/commands/init-prompts.test.ts
  npm test
  ```

**Exit criteria:**
- Either 10 focused runs pass and the flake is documented as not reproduced, or a real cause is fixed with a regression test.

---

## Phase 5: Triage Build Warnings Without Widening Scope

**Problem:** `npm run build:all` passes, but warnings reduce signal quality.

**Files to inspect before editing:**
- `vite.config.ts`
- `tsdown.config.ts`
- `src/dashboard-ui/**`
- Import sites for `gray-matter` and `zod`

- [ ] Reproduce warnings from a clean build command.

  ```powershell
  npm run build:all
  ```

- [ ] Trace why `gray-matter` is entering the UI bundle.

  If markdown parsing is only needed server-side, split the import path so the React bundle does not include it.

- [ ] Decide whether large chunks are actionable.

  If the largest chunk is caused by route-level code that can be lazy-loaded, add dynamic imports or `manualChunks` consistent with the existing Vite setup. Do not split only to silence a warning if it makes the UI harder to maintain.

- [ ] Address the `zod` tsdown warning only if the bundler config already has a local pattern for bundled dependencies.

  Prefer an explicit config change over adding a dependency.

- [ ] Verify after each accepted warning fix.

  ```powershell
  npm run build:all
  npm run test:ui
  ```

**Exit criteria:**
- Warnings are either fixed or documented as accepted with a clear reason.
- Build remains passing.

---

## Phase 6: End-To-End Verification Matrix

**Run after the previous phases are complete.**

- [ ] Backend tests.

  ```powershell
  npm test
  ```

- [ ] Frontend tests.

  ```powershell
  npm run test:ui
  ```

- [ ] Typecheck.

  ```powershell
  npm run typecheck
  ```

- [ ] Full build.

  ```powershell
  npm run build:all
  ```

- [ ] Start local dashboard with explicit root.

  ```powershell
  npm run memory -- dashboard --root "C:\Users\Admin\OneDrive\Documents\Memory Fort" --no-open
  ```

- [ ] API smoke.

  ```powershell
  Invoke-RestMethod "http://127.0.0.1:4410/memory/api/status" | ConvertTo-Json -Depth 20
  Invoke-RestMethod "http://127.0.0.1:4410/memory/api/graph-health" | ConvertTo-Json -Depth 20
  Invoke-RestMethod "http://127.0.0.1:4410/memory/api/search?q=memory&k=3&noRerank=true" | ConvertTo-Json -Depth 20
  ```

- [ ] Operator health.

  ```powershell
  Invoke-RestMethod "http://127.0.0.1:4410/memory/api/health?role=operator" | ConvertTo-Json -Depth 20
  ```

- [ ] Browser smoke.

  Open `http://127.0.0.1:4410/memory/`, confirm the dashboard renders, console is clean, and status reports the selected vault.

**Final acceptance criteria:**
- Local dashboard URL is reachable.
- Dashboard status shows the chosen vault root.
- Frontend tests, backend tests, typecheck, and full build pass.
- Health failures are either fixed or explicitly classified as operator-owned external state.
- The repo has no accidental runtime artifacts.
