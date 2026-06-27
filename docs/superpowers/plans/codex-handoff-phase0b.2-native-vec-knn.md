# Codex handoff — Phase 0b.2: sqlite-vec into the bootstrap, Electron-runtime KNN gate

> Self-contained task brief. Codex cannot read the conversation that produced this. Everything needed is here. **Builds directly on 0b.1** (already merged to main, commit `ebad1d5`). **Scope is 0b.2 only** — sqlite-vec load + exact vec0 KNN, gated under Electron's ABI on all three CI OSes. The win-arm64 installed-artifact probe is 0b.3, not here.

## Goal

Extend the native-capability bootstrap so it **loads sqlite-vec and runs an exact vec0 K-nearest-neighbour query under Electron 42's Node ABI** on macOS, Linux, and Windows-x64 in CI — filling the `TODO(0b.2)` seam left in `src/index/native/capability.ts`. Like 0b.1, vitest is dev signal only; the **Electron-runtime gate is the real gate**, and it must be **mutation-proven** (break it, watch it go red).

## Background (read — grounds every decision)

**MemoryFort:** single-user Electron desktop app (`github.com/GalaxyRuler/memory-fort-private`; public mirror `github.com/GalaxyRuler/memory-fort`), GPL-3.0-only. Dashboard HTTP backend runs in a long-lived Electron `utilityProcess`. Tier-2 replaces full-vault-in-heap search with a derived SQLite index: **FTS5 (lexical, done in 0b.1) + sqlite-vec (vectors, this task)**.

**What 0b.1 shipped (your starting point — do not redo, extend):**
- `better-sqlite3` **12.11.1** pinned in `dependencies`. `src/index/native/capability.ts` exports `openCapabilityDb` / `assertFts5` / `closeCapabilityDb` with a typed `CapabilityError { step }`, and ends with `// TODO(0b.2): resolveSqliteVecBinary / loadSqliteVec / assertVec0Knn`.
- Electron-runtime gate pattern: `electron/main.ts` has an `if (process.env["MEMORY_CAP_TEST"] === "1")` branch that, in `app.whenReady()`, runs the capability assertions in-process (Electron's Node ABI — `process.versions.modules` = **146** under Electron 42), logs `[cap-test] electron=… node=… modules=… arch=…`, prints `CAP_FTS5 ok`, and `app.exit(0/1)` without opening a window.
- CI job `electron-native-capability` in `.github/workflows/smoke.yml` (ubuntu/macos/windows): `npm install` → `npm run build` → `npm run electron:rebuild` → launch Electron with `MEMORY_CAP_TEST=1` → assert the log lines + exit 0. **Fails (not skips) if the Electron binary is missing.**
- `tsdown.config.js`: `electron-main` entry has `codeSplitting:false` and `neverBundle: ["electron", ...nativeRuntimeExternals]`. `nativeRuntimeExternals` already includes `"sqlite-vec"` and `/^sqlite-vec-.+$/`. So when `capability.ts` `require`s sqlite-vec, the bundler leaves it as a runtime `require` (correct).
- `electron-builder.yml` already ships `node_modules/sqlite-vec/**` and `node_modules/sqlite-vec-*/**`, `asar:false`.

**The win-arm64 fact from Phase 0.0 (GO):** sqlite-vec ships **no win-arm64 npm prebuilt** ([#211](https://github.com/asg017/sqlite-vec/issues/211), [#73](https://github.com/asg017/sqlite-vec/issues/73)). Phase 0.0 proved a from-source `vec0.dll` (built with MSVC `vcvarsall + cl.exe` on a `windows-11-arm` runner) loads + KNN-works. **This task does NOT need win-arm64** — the 0b.2 CI gate runs ubuntu/macos/**windows-x64**, where sqlite-vec's official prebuilt binaries exist. `resolveSqliteVecBinary()` must be written so a win-arm64 vendored `vec0.dll` path can slot in **later (0b.3)** without redesign — but do not vendor or build it here.

**The dual-ABI reality (carried from 0b.1):** vitest runs under system Node (ABI 137 on the Windows dev box / whatever the CI Node is); Electron is ABI 146. `better-sqlite3` must be rebuilt against Electron's ABI (`npm run electron:rebuild`) before the Electron gate. **sqlite-vec is a different kind of dependency** — it is NOT a Node native addon (no `.node` / N-API). It is a **SQLite loadable extension** (`vec0.{dll,dylib,so}`) loaded via better-sqlite3's `db.loadExtension(path)`. So `@electron/rebuild` does **not** touch sqlite-vec, and the extension binary is **ABI-independent** of Node/Electron — it only has to match the **platform/arch**. What must work under Electron is `db.loadExtension(...)` itself (a better-sqlite3 call), so the gate still has to run under Electron's runtime.

**Why sqlite-vec (locked):** exact KNN, MIT/Apache (GPL-compatible). `sqlite-vector` (sqliteai) was rejected — Elastic License 2.0 vs our GPL-3.0-only, and no win-arm64. Do not switch extensions.

## What to build

### 1. Add the dependency
- Add **`sqlite-vec`** to `package.json` **`dependencies`**, **pinned exact** (no caret; current latest, e.g. `0.1.x` — verify it publishes prebuilt binaries for darwin-arm64, linux-x64, win32-x64, and that better-sqlite3 12.11.1 `loadExtension` accepts it). `npm install` to update the lock. (CI uses `npm install`, not `npm ci` — leave that as is.)
- sqlite-vec's npm layout: the main `sqlite-vec` package + per-platform packages `sqlite-vec-<platform>-<arch>` carrying the actual binary. Confirm the install pulls the right platform package on each runner.

### 2. Extend `src/index/native/capability.ts` (fill the 0b.2 seam — do not rewrite 0b.1 code)
Add, alongside the existing exports:

```ts
/** Resolve the absolute path to the platform/arch-correct sqlite-vec loadable
 *  extension (vec0.dll / .dylib / .so). Throws CapabilityError('vec-resolve')
 *  if no binary is available for this platform/arch. Must be structured so a
 *  vendored win-arm64 vec0.dll path can be added later (0b.3) without redesign. */
export function resolveSqliteVecBinary(): string;

/** db.loadExtension(resolveSqliteVecBinary()). Throws CapabilityError('vec-load')
 *  with a clear message if the extension can't load (so Phase 5 can degrade to
 *  lexical-only instead of crashing). */
export function loadSqliteVec(db: CapabilityDb): void;

/** Create a vec0 virtual table, insert known vectors, run a KNN MATCH query,
 *  assert the nearest row is the expected one. Throws CapabilityError('vec-knn'…). */
export function assertVec0Knn(db: CapabilityDb): void;
```
- Add the new `CapabilityStep` values: `"vec-resolve" | "vec-load" | "vec-knn"`.
- **Prefer the npm package's own resolver** if `sqlite-vec` exposes one (e.g. `getLoadablePath()` / a documented export) — use it rather than hand-rolling path guesses; fall back to an explicit per-platform/arch path map under `node_modules/sqlite-vec-*/` only if needed. Whatever you choose, `resolveSqliteVecBinary` is the single chokepoint where 0b.3 will add the win-arm64 vendored path.
- KNN assertion contract (mirror the 0.0 probe so results are comparable): `CREATE VIRTUAL TABLE … USING vec0(embedding float[3])`; insert rowid 1 = `[1.0, 0.0, 0.0]`, rowid 2 = `[0.0, 1.0, 0.0]`; query nearest to `[1.0, 0.1, 0.0]` (`… WHERE embedding MATCH ? ORDER BY distance LIMIT 1`); assert returned rowid === 1. Use better-sqlite3's loadExtension (the app must call `db.loadExtension`, not the npm `sqlite-vec.load()` helper, unless that helper just wraps loadExtension — keep it explicit and typed).
- No `db.loadExtension` is allowed by default in better-sqlite3 **only** when the DB is opened normally — confirm extension loading is enabled (better-sqlite3 enables `loadExtension` by default via a method on the Database; if a flag is needed, set it in `openCapabilityDb` or a dedicated path). Verify and handle.

### 3. vitest dev signal (NOT a gate) — extend `test/index/native-fts5.test.ts` or add `test/index/native-vec.test.ts`
- Under system Node: `openCapabilityDb(':memory:')` → `loadSqliteVec` → `assertVec0Knn` passes; a missing/!match binary throws `CapabilityError` with the right `step`. **Comment it is dev-only, not the ABI gate.**
- Note: this requires the system-Node sqlite-vec binary present — fine, the npm prebuilt covers the dev platform.

### 4. Electron-runtime KNN gate (THE gate) — extend the existing pattern
- In `electron/main.ts`'s `MEMORY_CAP_TEST=1` path: after the existing FTS5 assertion, also run `loadSqliteVec(db)` + `assertVec0Knn(db)`, then print `[cap-test] CAP_VEC_KNN ok` (keep `CAP_FTS5 ok` too). On throw → `[cap-test] CAP_VEC_KNN FAIL <err>` + `app.exit(1)`.
- In `.github/workflows/smoke.yml` `electron-native-capability` job: assert the new `[cap-test] CAP_VEC_KNN ok` line in addition to `CAP_FTS5 ok`, on all three OSes. (`electron:rebuild` step stays — it's for better-sqlite3; sqlite-vec needs no rebuild but the gate still runs under Electron.)
- **Matrix stays ubuntu/macos/windows-x64.** No win-arm64 here (that's 0b.3's installed-artifact probe).

## Tests / verification Codex must run before handing back
- `npx tsc --noEmit` **and** `npx tsc -p tsconfig.ui.json --noEmit` — both 0.
- `npm test` (vitest) — new vec dev test green under system Node.
- `npm run build` — green; `electron-main` stays self-contained (grep `dist/electron-main.mjs` for relative runtime imports == 0; sqlite-vec must appear as an external `require`, not inlined).
- Locally if you have Electron: `npm run electron:rebuild` then launch with `MEMORY_CAP_TEST=1`; confirm both `CAP_FTS5 ok` and `CAP_VEC_KNN ok`, exit 0, `modules=146`. If you can't run Electron locally, say so and rely on the CI gate.

## Acceptance criteria
- `sqlite-vec` pinned exact in `dependencies`; lock updated.
- `capability.ts` seam filled: `resolveSqliteVecBinary` / `loadSqliteVec` / `assertVec0Knn`, new typed steps, win-arm64-ready resolver chokepoint. No 0b.1 regression.
- vitest vec dev test green (system Node).
- **Electron-runtime gate prints `CAP_VEC_KNN ok` (and still `CAP_FTS5 ok`) + exit 0 on ubuntu/macos/windows-x64 in CI**, with `electron:rebuild` run first.
- Both typechecks + build green; `electron-main` self-contained.
- Commit: `feat(index): sqlite-vec load + exact KNN in the bootstrap`.

## What NOT to do
- **No win-arm64 build/vendoring**, no installed-app probe, no concurrent-WAL / 30MB / restart-recover steps — all that is **0b.3**. Just leave `resolveSqliteVecBinary` extensible.
- **No `src/index/**` feature code** — no reconciler, no real search, no wiring into the dashboard/retrieval. Bootstrap assertions only.
- Do **not** rewrite or weaken 0b.1's FTS5 path or the existing gate; extend alongside.
- Do **not** switch vector extensions, do **not** bundle the extension binary into JS, do **not** set `asar:true`, do **not** revert `npm install`→`npm ci`.
- Do **not** bump the app version or release — 0b is pre-public; the combined public release is after 0b.3.

## After Codex hands back — Claude's audit steps
1. Diff review: seam filled cleanly, new typed steps, no 0b.1 regression, no feature code, `resolveSqliteVecBinary` is a single extensible chokepoint.
2. `sqlite-vec` pinned exact in `dependencies`; lock updated; verify the per-platform `sqlite-vec-*` package resolves on each OS.
3. Local Windows-x64: typechecks + vec dev test + build; grep `electron-main.mjs` self-contained (sqlite-vec external).
4. Reproduce the Electron gate locally (exit 0, `CAP_VEC_KNN ok`, `modules=146`).
5. **Mutation-prove the new gate**: point `resolveSqliteVecBinary` at a bogus path (or temporarily rename the platform binary) → confirm the gate goes RED at `vec-load`/`vec-resolve`, exit 1. Revert. (This proves the KNN gate isn't a no-op the way the 0b.1 ABI mutation did.)
6. Open a PR; confirm `electron-native-capability` green on all 3 OS (the macOS/Linux/Win-x64 KNN confirmation). Merge to main + push public. **Do not release.**
7. Tick 0b.2 in `docs/superpowers/plans/2026-06-25-tier2-phase0-electron-native.md`; hand off **0b.3** (installed-app probe, 8 steps incl. **win-arm64** + concurrent-WAL + 30MB reopen, on all four targets — the real Phase-0 gate).

## References (repo-root-relative)
- Plan: `docs/superpowers/plans/2026-06-25-tier2-phase0-electron-native.md` (Phase 0b.2)
- 0b.1 (your base): merged `ebad1d5`; `src/index/native/capability.ts`, `electron/main.ts` `MEMORY_CAP_TEST` branch, `.github/workflows/smoke.yml` `electron-native-capability`
- 0.0 win-arm64 evidence (for 0b.3's resolver): `docs/superpowers/plans/codex-handoff-phase0.0-winarm64-vec.md`, `scripts/preflight-vec.mjs`
- sqlite-vec: https://github.com/asg017/sqlite-vec · KNN docs: https://alexgarcia.xyz/sqlite-vec/ · better-sqlite3 loadExtension: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#loadextensionpath-entrypoint---this
- No win-arm64 prebuilt: issues [#211](https://github.com/asg017/sqlite-vec/issues/211), [#73](https://github.com/asg017/sqlite-vec/issues/73)
