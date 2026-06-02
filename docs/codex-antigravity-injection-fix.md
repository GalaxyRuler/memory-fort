# Codex Implementation Brief — Antigravity Injection Fix + De-Duplication (Phase 4.37)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> 4.36 shipped cwd-aware SessionStart memory injection. Claude Code + Codex work (verified against the real vault after a root-threading fix). **Antigravity is broken**: its hook emits schema/index/log but never the `Current project memory` section. Root issue is duplication — Antigravity reimplements the resolver inline as a generated string, it drifted from the shared logic, and **both copies passed tests because the tests use mocked roots/dirs, not the real vault**. This brief fixes Antigravity and removes the duplication so it can't drift again.

## Evidence (verified live 2026-06-02)

- Claude/Codex share `src/hooks/session-start.ts`; their deployed hook is a thin launcher that imports the repo dist. After a fix threading `memoryRoot()` explicitly (`6095bc7`), a real run with `cwd = C:\CodexProjects\memory-system` (no explicit dep, just `MEMORY_ROOT` env) injects `Current project memory` + `Related memory` (41522 chars). ✅
- Antigravity's hook is a **self-contained generated `.mjs`** emitted by `src/cli/commands/install/antigravity.ts` (it both captures raw AND is supposed to inject). It reimplements `resolveProjectForCwd`, `currentProjectMemoryBlock`, `normalizeMatchPath`, `listProjectCandidates` inline.
- Running the **deployed** Antigravity hook with `cwd = C:\CodexProjects\memory-system` produces 30298 chars (schema + index + log) but **0 `Current project memory` sections**. A probe shows `currentProjectMemoryBlock` returns before reaching the resolver — i.e. the `if (!cwd) return ""` guard fires, so **`stringField(payload, "cwd")` is not extracting cwd** from the Antigravity payload (or an equivalent early-return). The `try/catch` at the call site silently swallows any throw, hiding the failure. ❌

## Task 1 — find the actual Antigravity failure (don't guess)

Reproduce against the **real vault**, not a fixture:
1. Build, reinstall (`node dist/cli.mjs install antigravity --surface both`), then run the deployed `~/.gemini/antigravity/plugins/memory/hooks/session_start.mjs` with a real payload (`{"hookName":"session_start","session_id":"t","cwd":"C:\\CodexProjects\\memory-system"}`) and `MEMORY_ROOT` set to `~/.memory`.
2. Temporarily surface the swallowed error (the `catch {}` around the project block) and log the resolved cwd + project path. Confirm which is true:
   - (a) `stringField(payload, "cwd")` returns empty → the Antigravity SessionStart payload uses a different field name than `cwd`/`working_directory`. **Check a real Antigravity SessionStart payload's actual key** (inspect a live `antigravity-*.md` capture's frontmatter `cwd`, and/or log the raw payload). Add the correct field to the extraction chain.
   - (b) cwd is extracted but `resolveProjectForCwd` returns empty → compare the inline `normalizeMatchPath`/slug logic to the shared one; fix the divergence.
   - (c) a helper throws (swallowed) → fix it; and make the catch **log to errors.log** instead of silently dropping (a silent catch is what hid this).

## Task 2 — de-duplicate (the real fix)

Three copies of the resolver now exist (shared TS + inline-generated JS). They drift and both passed mocked tests. Reduce to one source of truth:

- **Preferred:** make the Antigravity hook a **thin launcher** like Claude/Codex — capture stays inline (Antigravity's hook writes the raw file), but the **injection** portion imports the shared, tested `currentProjectMemoryBlock` from the repo dist (`file://` import, as the Claude launcher already does). One resolver, tested once, used everywhere.
- **If a standalone hook is required** (no import allowed at runtime on Antigravity): generate the injection code from the **same shared source** (emit the compiled shared function, don't hand-maintain a parallel copy), and add a build-time check that the generated resolver matches the shared one.

Whichever path: there must be **exactly one** resolver implementation under test after this.

## Task 3 — tests that would have caught this (real-vault, not mocks)

The existing tests passed while both real hooks were broken — they inject mocked `readFile`/`readdir`/roots. Add tests that exercise the **default path**:
- A test that builds a temp vault on disk (real files: `wiki/projects/memory-system.md`, `index.md`), sets `MEMORY_ROOT` to it, and runs the **actual hook entry** (shared and Antigravity) end-to-end with `cwd` pointing into a project — asserting the emitted stdout **contains** `Current project memory` + the project body. No mocked root.
- A test asserting the Antigravity payload field actually used for cwd is in the extraction chain.
- A no-match test (unknown cwd → no project section, legacy output preserved) for both hooks.

## You will NOT
- Fix Antigravity by adding a third parallel resolver copy — reduce to one.
- Leave a silent `catch {}` around the injection — log swallowed errors to `errors.log`.
- Accept on mocked-root tests alone — at least one real-on-disk-vault end-to-end test per hook (this is the gap that hid two bugs).
- Regress capture: the Antigravity hook must still write its `antigravity-<session>.md` raw file.
- Touch Claude/Codex behavior — they're verified working; only de-duplicate if it doesn't regress them.

## Stop and ask
1. Antigravity's SessionStart payload has no cwd-equivalent field at all (the platform doesn't pass working directory to hooks) → injection is impossible there; document it as capture-only and revert the half-wired injection rather than leave it broken.
2. The thin-launcher approach can't work because Antigravity executes hooks in a sandbox that blocks `file://` imports of the repo dist → fall back to single-source code generation (Task 2 alternative).

## Acceptance (real vault, read the bytes — lessons #2/#3)
- Deployed Antigravity hook, real payload `cwd = C:\CodexProjects\memory-system`, `MEMORY_ROOT=~/.memory` → stdout **contains** `--- Current project memory` with the memory-system body AND `--- Related memory` with ≥1 linked page. Show the bytes.
- Worktree subpath resolves to the same project. Unknown cwd → no project section, schema/index/log preserved.
- Exactly one resolver implementation remains under test; a real-on-disk-vault end-to-end test exists for each hook and fails if injection silently returns empty.
- Capture still works (raw file written). Full suite + typecheck + build clean.

## Commit boundaries
- Task 1: `fix(antigravity): correct cwd extraction / resolver in session_start injection (Phase 4.37 Task 1)`
- Task 2: `refactor(hooks): single-source the cwd resolver across Claude/Codex/Antigravity (Phase 4.37 Task 2)`
- Task 3: `test(hooks): real-on-disk-vault end-to-end injection tests (Phase 4.37 Task 3)`
