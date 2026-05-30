# Local Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 4.15 so local dashboards can persist writes while hosted detached checkouts are read-only.

**Architecture:** Add one shared vault write capability helper based on the existing git-repo detection logic, expose that capability through `/api/status`, and reuse it for server write guards, scheduler construction, and UI disabled states. Add `memory dashboard` as a thin CLI command around the existing dashboard `createServer`, passing `dist/dashboard-ui` explicitly.

**Tech Stack:** TypeScript, Node `http`, Commander, React, TanStack Query, Vitest.

---

### Task 1: Shared Vault Write Capability

**Files:**
- Create: `src/sync/git-repo.ts`
- Create: `src/sync/vault-capability.ts`
- Modify: `src/cli/commands/sync-bootstrap.ts`
- Test: `test/sync/vault-capability.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that create a temp vault with a `.git` directory, a temp vault with `.git` as a file plus a stub runner returning `true`, and a detached checkout with no `.git` and a stub runner returning `false`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/sync/vault-capability.test.ts`
Expected: FAIL because `src/sync/vault-capability.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Move/extend the existing `isGitRepo(repoPath, runner)` logic into `src/sync/git-repo.ts`, import it from `sync-bootstrap.ts`, and implement `getVaultWriteCapability(vaultRoot)` returning `{ writable: true }` or `{ writable: false, reason: "read-only mirror — run `memory dashboard` on your machine to make changes" }`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/sync/vault-capability.test.ts`
Expected: PASS.

### Task 2: Server Capability, Endpoint Guards, Scheduler Gate

**Files:**
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/auto-promote-scheduler.ts`
- Test: `test/dashboard/server.test.ts`
- Test: `test/dashboard/auto-promote-scheduler.test.ts`

- [ ] **Step 1: Write failing server and scheduler tests**

Add tests that `/api/status` includes `capabilities`, `POST /api/compile/run` with `execute:true`, `POST /api/proposed/promote`, `POST /api/proposed/reject`, and `PATCH /api/config` return 403 on read-only vaults, and scheduler construction creates no intervals when capability is read-only.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/dashboard/server.test.ts test/dashboard/auto-promote-scheduler.test.ts`
Expected: FAIL because guards and scheduler capability injection do not exist.

- [ ] **Step 3: Implement the guards**

Load capability once during `createServer`, merge it into `/api/status`, refuse write endpoints with 403 and a clear error when not writable, and pass the capability into `createAutoPromoteScheduler`. Gate scheduler construction before interval creation.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/dashboard/server.test.ts test/dashboard/auto-promote-scheduler.test.ts`
Expected: PASS.

### Task 3: CLI Dashboard Command

**Files:**
- Create: `src/cli/commands/dashboard.ts`
- Modify: `src/cli.ts`
- Test: `test/cli/commands/dashboard.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Add tests for default options (`127.0.0.1`, `4410`, `~/.memory` or `MEMORY_ROOT`, explicit `dist/dashboard-ui`), missing UI dist error, and no-open behavior.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/cli/commands/dashboard.test.ts`
Expected: FAIL because the command module does not exist.

- [ ] **Step 3: Implement command module and registration**

Add `runDashboard()` plus `registerDashboardCommand(program)`, resolve `dist/dashboard-ui` from the repo root, call `createServer`, print `http://host:port/memory/`, open the browser unless `--no-open`, and close cleanly on SIGINT/SIGTERM.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/cli/commands/dashboard.test.ts`
Expected: PASS.

### Task 4: UI Read-Only Gating

**Files:**
- Modify: `src/dashboard-ui/hooks/useStatus.ts`
- Modify: `src/dashboard-ui/components/CompilePage.tsx`
- Modify: `src/dashboard-ui/components/InboxPage.tsx`
- Modify: `src/dashboard-ui/components/SettingsPage.tsx`
- Modify as needed: `src/dashboard-ui/components/LLMConfigCard.tsx`, `src/dashboard-ui/components/EmbedderConfigCard.tsx`
- Test: `test/dashboard-ui/components/compile-page.test.tsx`
- Test: `test/dashboard-ui/components/inbox-page.test.tsx`
- Test: `test/dashboard-ui/components/settings-page.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Add tests that read-only status shows the read-only mirror notice and disables compile execute, inbox promote/reject, and settings save actions while leaving prompt-only generation and read views enabled.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/dashboard-ui/components/compile-page.test.tsx test/dashboard-ui/components/inbox-page.test.tsx test/dashboard-ui/components/settings-page.test.tsx`
Expected: FAIL because components do not read capability yet.

- [ ] **Step 3: Implement UI gating**

Extend `DashboardStatus` with `capabilities`, use `useStatus()` in the write-capable pages/components, render a small read-only banner, disable write buttons when `writable === false`, and pass disabled state into nested config cards.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/dashboard-ui/components/compile-page.test.tsx test/dashboard-ui/components/inbox-page.test.tsx test/dashboard-ui/components/settings-page.test.tsx`
Expected: PASS.

### Task 5: Docs and Final Verification

**Files:**
- Modify: `docs/MEMORY-FORT-SPEC.md`
- Modify: `docs/cli.md`
- Modify: `README.md` or create a short dashboard doc if no suitable section exists
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Update docs**

Document local dashboard writes, hosted VPS read-only mirror behavior, `npm run build:ui`, and `memory dashboard`.

- [ ] **Step 2: Run focused verification**

Run the task-specific Vitest commands above plus `npm run typecheck`, `npm run build`, `npm run build:ui`, and `git diff --check`.

- [ ] **Step 3: Commit by requested boundaries if all verification passes**

Use the four commit messages from `docs/codex-local-dashboard.md`, with the requested author and co-author trailer.
