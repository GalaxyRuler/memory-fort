# Codex Implementation Brief — Dashboard Build Robustness (Phase 4.35)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> `memory dashboard` keeps failing with `ENOENT ... dist\dashboard-ui\index.html`. Root cause is two compounding bugs. Fix both so a single `npm run build` followed by `memory dashboard` (from ANY directory) always serves, with no manual `build:ui`. A `scripts/start-dashboard.bat` launcher already exists as a workaround — this brief removes the need for it.

## Root cause (verified 2026-06-02)

1. **The build wipes the UI.** `tsdown.config.ts` entry 1 has `clean: true`. tsdown clears the whole `dist/` before the server build. Vite writes the UI to `dist/dashboard-ui/` (`vite.config.ts` `outDir`). So running `npm run build` (server) **deletes the `dist/dashboard-ui/` that `npm run build:ui` produced**. `build:all` only works because it runs `build` *then* `build:ui` — any later `npm run build` re-nukes the UI.
2. **Self-heal can't find the source when run globally.** `src/cli/commands/dashboard.ts` `findDashboardSourceRoot(start)` walks up from `start` looking for `package.json` + `vite.config.ts` + `src/dashboard-ui/index.html`. It is called with the process cwd. The globally-linked `memory dashboard` is usually run from some other directory, so the walk never reaches the repo, returns `null`, and the code throws the raw `ENOENT`/`missingDashboardDistError` instead of self-building.

## Task 1 — stop `npm run build` from deleting `dist/dashboard-ui/`

Make the server build's clean step **not** remove the UI output. Options (pick the most robust for tsdown's clean semantics):
- Scope tsdown `clean` to the server's own output globs only (e.g. clean `dist/*.mjs`, `dist/hooks`, `dist/retrieval`, etc.) so it never touches `dist/dashboard-ui/`; **or**
- Set entry-1 `clean: false` and add a small pre-build clean script that deletes everything in `dist/` **except** `dashboard-ui/`; **or**
- Point Vite's `outDir` somewhere tsdown's clean does not cover and have the server serve from there.

Whichever you choose, the invariant is: **`npm run build:ui` once, then any number of `npm run build`, and `dist/dashboard-ui/index.html` still exists.**

## Task 2 — make `npm run build` produce a complete, servable dist

A fresh `npm run build` should yield both server and UI so `memory dashboard` works with no extra step. Either:
- Make `build` run the UI build as its final stage (after the clean-scoping from Task 1, so it isn't wiped), **or**
- Keep `build` server-only but have CI/docs/install use `build:all`, AND ensure Task 3's self-heal covers the gap for end users.

Prefer making `build` complete — end users run `npm run build`, not `build:all`. Keep `build:ui` and `build:all` as-is for granular use.

## Task 3 — self-heal works for the global binary; never throw raw ENOENT

In `dashboard.ts`:
- Resolve the dashboard **dist root** and the **source root** from the installed module's own location (`import.meta.url`), not only from `process.cwd()`. The globally-linked binary still lives inside the repo's `dist/`, so its module path can locate the repo root and thus `vite.config.ts`. Try cwd first, then module-relative.
- If `index.html` is missing AND a source root is found → build it (existing `runNpmBuildUi`), log `building dashboard UI…`, then serve.
- If `index.html` is missing AND no source root is reachable (truly packaged install with no source) → throw a **clear, actionable** error naming the exact command (`npm run build:ui` in `<repoRoot>`), never a raw `ENOENT`.
- Guard against a half-written `dist/dashboard-ui/` (dir exists, `index.html` missing) — treat as missing and rebuild.

## You will NOT
- Delete or relocate the existing `scripts/start-dashboard.bat` launcher (it's a fine fallback).
- Bundle the built UI into git (`dist/` stays gitignored).
- Change the dashboard port (4410) or the served routes.
- Let `npm run build` silently leave a non-servable dist — if the UI isn't built, `memory dashboard` must self-build or error clearly.

## Acceptance (read the artifact, lessons #2/#3)
1. **The wipe is gone:** `npm run build:ui && npm run build && test -f dist/dashboard-ui/index.html` → file present. Add a CI/test assertion for this ordering.
2. **One build is complete:** from a clean tree (`rm -rf dist`), `npm run build` alone → `dist/dashboard-ui/index.html` exists.
3. **Global run self-heals:** `rm -rf dist/dashboard-ui`, then run the globally-linked `memory dashboard` **from a directory outside the repo** → it rebuilds the UI (or errors with the exact command), then serves **200** on `/memory/api/status`. No raw ENOENT.
4. **Normal start is fast:** when dist is present, no rebuild happens (assert no build log line, fast startup).
5. Full suite + typecheck + build clean. `dashboard.test.ts` covers: wipe-resistance, module-relative source resolution (mocked), and the clear-error path when no source is reachable.

## Commit boundaries
- Task 1: `fix(build): scope tsdown clean so npm run build keeps dist/dashboard-ui (Phase 4.35 Task 1)`
- Task 2: `feat(build): npm run build produces complete servable dist (Phase 4.35 Task 2)`
- Task 3: `fix(dashboard): module-relative self-heal + clear error, no raw ENOENT (Phase 4.35 Task 3)`
