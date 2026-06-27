# Codex handoff — Phase 0b.1: native capability bootstrap + better-sqlite3, Electron-runtime FTS5 gate

> Self-contained task brief. Codex cannot read the conversation that produced this. Everything needed is here. **Scope is 0b.1 only** — better-sqlite3 + FTS5. sqlite-vec / vector KNN is the **next** task (0b.2); do not implement it here, but leave the seams for it.

## Goal

Stand up the reusable **native-capability bootstrap module** and prove that `better-sqlite3`'s **FTS5** works **under Electron 42's Node ABI in the installed/launched Electron runtime** — not just under system Node. A green vitest with a red Electron-runtime result is the **dual-ABI trap**; the Electron-runtime result is the real gate.

## Background (read — it grounds every decision)

**MemoryFort** is a single-user Electron desktop app (`github.com/GalaxyRuler/memory-fort-private`; public mirror `github.com/GalaxyRuler/memory-fort`), GPL-3.0-only. The dashboard HTTP backend runs in a long-lived Electron `utilityProcess` (forked from `electron/main.ts` via a supervisor). Today every search loads the full Markdown vault into the JS heap — the cause of the desktop OOM. The fix is a **derived SQLite index** (FTS5 lexical + sqlite-vec vectors). This task lays the FTS5 half of the native foundation.

**Phase 0 status (already done):**
- **0.0 (GO):** sqlite-vec KNN proven on win-arm64 via a from-source `vec0.dll` (MSVC `vcvarsall + cl.exe`) on a `windows-11-arm` runner. (Feeds 0b.2, not this task.)
- **0a (shipped v0.10.15):** Electron upgraded 35→**42.5.0**, electron-builder **26.15.5**, `@electron/rebuild` **4.0.4** added. Packaged smoke green: installed app runs **Electron 42.5.0 / Node 24.17.0 / `process.versions.modules` = 146**, dashboard served from a genuine `utilityProcess`.

**The ABI fact that dominates this task:** `process.versions.modules` is **146** under Electron 42, but a *different* number under system Node 24. A native addon (`better_sqlite3.node`) compiled for one ABI throws `NODE_MODULE_VERSION` mismatch when loaded under the other. So the addon must be **rebuilt against Electron's ABI** (`@electron/rebuild`, already wired as the `electron:rebuild` npm script = `electron-rebuild -f`) **before** any Electron-runtime test loads it. vitest (system Node) and the Electron gate need *different* builds of the same addon.

**Why better-sqlite3 (not `node:sqlite`):** Node 22/24's built-in `node:sqlite` ships **without FTS5**. better-sqlite3 compiles its own SQLite **with FTS5 enabled**, and has a win-arm64 prebuilt on npm. It is the chosen engine. (See `tier2-search-stack-constraints`.)

**Already wired by 0a (do not re-add, just use):** `tsdown.config.js` already marks native modules external so the bundler never rewrites their `require`/`bindings`:
```js
const nativeRuntimeExternals = ["better-sqlite3", "bindings", "file-uri-to-path", "sqlite-vec", /^sqlite-vec-.+$/];
```
applied as `neverBundle` on every entry. `electron-builder.yml` (`asar: false`) ships `node_modules/better-sqlite3/**` (+ `bindings`, `file-uri-to-path`). **Verify these are present; add any that are missing.** `better-sqlite3` is **not yet** a dependency in `package.json` — this task adds it.

## What to build

### 1. Add the dependency
- Add **`better-sqlite3`** as a **production** dependency in `package.json`, **pinned exact** (no caret). Use the current latest stable (verify it ships a win-arm64 + Node 24 prebuilt and builds clean under `@electron/rebuild` for Electron 42; ~v12.x at time of writing).
- Run `npm install` so `package-lock.json` updates. **Do not** hand-edit versions.
- **Lockfile note:** CI uses `npm install` (not `npm ci`) in `release.yml`; a Windows-generated lock prunes cross-platform optional deps. Generating the lock on Windows is fine for that workflow. (Do not switch release.yml back to `npm ci`.)

### 2. The bootstrap module — `src/index/native/capability.ts` (NEW; `src/index/` does not exist yet)
Reusable, dependency-light, **no `src/index/**` feature code** (no reconciler, no real search — that's Phase 3). Export at minimum:

```ts
export interface CapabilityDb { /* thin handle wrapping the better-sqlite3 Database */ }

/** Open a better-sqlite3 DB at `path` (':memory:' or a file). WAL for file DBs. Typed throw on failure. */
export function openCapabilityDb(path: string): CapabilityDb;

/** Create an fts5 table, insert a row, run a bm25()-ranked MATCH query, assert the expected row ranks first.
 *  Throws a typed CapabilityError with a clear message if fts5 is unavailable or the query is wrong. */
export function assertFts5(db: CapabilityDb): void;

export function closeCapabilityDb(db: CapabilityDb): void;
```
- **Leave seams for 0b.2** (do **not** implement): a `// TODO(0b.2): resolveSqliteVecBinary / loadSqliteVec / assertVec0Knn` marker where the vector functions will live. Don't import `sqlite-vec` yet.
- Use a typed error (e.g. `class CapabilityError extends Error` with a `step` field) so callers can tell *which* capability failed.
- Keep it importable from both system-Node (vitest) and the Electron runtime — no Electron imports in this module.

### 3. vitest dev signal (NOT a gate) — `test/index/native-fts5.test.ts` (NEW)
- `openCapabilityDb(':memory:')` → `assertFts5` passes; bm25 ordering correct; a malformed query throws `CapabilityError`.
- This runs under **system Node** via `npm test` (`vitest run`). It is **dev feedback only** — explicitly comment that it is NOT the ABI gate.

### 4. The Electron-runtime FTS5 gate (THE gate) — CI
The same `assertFts5` must run under **Electron 42's Node**, after `@electron/rebuild`. Recommended mechanism (cheapest correct ABI gate):

- Add an **env-gated branch** in `electron/main.ts`: when `process.env.MEMORY_CAP_TEST === '1'`, the app must **not** open a window — instead run, in-process (Electron's Node ABI):
  ```
  log "[cap-test] electron=<v> node=<v> modules=<v> arch=<arch>"
  openCapabilityDb(':memory:'); assertFts5(db); closeCapabilityDb(db)
  on success → log "[cap-test] CAP_FTS5 ok" then app.exit(0)
  on throw   → log "[cap-test] CAP_FTS5 FAIL <err>" then app.exit(1)
  ```
  Guard it as the very first thing in `app.whenReady()` (or before window creation) so it never touches the dashboard/supervisor.
- Add a CI job (extend `.github/workflows/smoke.yml` — it already has an `electron:` launch job on ubuntu/macos/windows, with xvfb + `--no-sandbox` on Linux and the "Ensure Electron binary" retry shim). The new gate job (or an added step) must, in order:
  1. `npm install` → `npm run build`
  2. **`npm run electron:rebuild`** ← REQUIRED. Without it `better_sqlite3.node` is system-Node ABI and will throw `NODE_MODULE_VERSION` under Electron. This is the whole point of the task.
  3. Launch Electron with `MEMORY_CAP_TEST=1` (Linux: `xvfb-run -a npx electron . --no-sandbox`; Windows: the real `node_modules\electron\dist\electron.exe .`; macOS: `npx electron .`), capture stdout, assert it prints `CAP_FTS5 ok` and the process exits 0. On `CAP_FTS5 FAIL` or non-zero exit, fail the job and dump the log.
- Matrix: **ubuntu-latest, macos-latest, windows-latest** (win-arm64 + the installed-artifact probe come in 0b.3 — not here).

## Tests / verification Codex must run before handing back
- `npx tsc --noEmit` **and** `npx tsc -p tsconfig.ui.json --noEmit` (both — the UI typecheck gap is real; see `typecheck-ui-verification-gap`).
- `npm test` (`vitest run`) — the new FTS5 dev test green.
- `npm run build` — succeeds; the `electron-main` entry stays self-contained (native modules external, not inlined).
- Locally if possible: `npm run electron:rebuild` then launch with `MEMORY_CAP_TEST=1` and confirm `CAP_FTS5 ok`. (If no local Electron, rely on the CI gate — but say so.)

## Acceptance criteria
- `better-sqlite3` pinned exact in `package.json`; lock updated.
- `src/index/native/capability.ts` exports `openCapabilityDb` / `assertFts5` / `closeCapabilityDb` with typed errors and the 0b.2 seam.
- vitest FTS5 dev test green under system Node.
- **The Electron-runtime gate prints `CAP_FTS5 ok` and exits 0 on all three CI OSes, with `electron:rebuild` run first.** A green vitest + red Electron gate = not done.
- Both typechecks + build green.
- Commit message: `feat(index): native capability bootstrap + better-sqlite3 (Electron-ABI FTS5)`.

## What NOT to do
- **No sqlite-vec / vectors / KNN** — that's 0b.2. Leave the seam, import nothing.
- **No `src/index/**` feature code** — no reconciler, no real search, no wiring into the dashboard or retrieval pipeline. Bootstrap + assertions only.
- Do **not** remove or weaken the existing `electron:` launch smoke; add alongside it.
- Do **not** switch `release.yml` back to `npm ci`, and do **not** add an `npx electron --version` step to any Linux job (the Electron binary aborts on Linux runners — SUID sandbox).
- Do **not** bundle native modules into the JS (keep them in `nativeRuntimeExternals`); do **not** set `asar: true`.
- Do **not** bump the app version or cut a release — 0b is pre-public; the combined public release is after 0b.3.

## After Codex hands back — Claude's audit steps
1. Read the diff: `capability.ts` has no Electron imports, no `src/index` feature code, vector seam present not implemented.
2. Confirm `better-sqlite3` is pinned exact and in `dependencies` (not dev); lock updated; `electron-builder.yml files` ships its dir.
3. Run both typechecks + `vitest run` + `npm run build` locally; confirm `electron-main` self-contained.
4. **Trigger the smoke workflow; confirm the Electron-runtime gate prints `CAP_FTS5 ok` + exit 0 on ubuntu/macos/windows, and that the job runs `electron:rebuild` before launch.** Read the logged `electron=/node=/modules=` line — `modules` must be Electron 42's ABI (146), proving it ran under Electron, not system Node.
5. Mutation check: temporarily skip `electron:rebuild` (or point the gate at an unbuilt addon) and confirm the gate goes **red** (`NODE_MODULE_VERSION`) — proves the gate actually exercises the ABI and isn't a no-op. Revert.
6. On green: tick 0b.1 in `docs/superpowers/plans/2026-06-25-tier2-phase0-electron-native.md`; hand off 0b.2 (sqlite-vec into the same module + Electron-runtime KNN gate, using the win-arm64 `vec0.dll` path proven in 0.0).

## References (paths relative to repo root)
- Plan: `docs/superpowers/plans/2026-06-25-tier2-phase0-electron-native.md` (Phase 0b.1)
- Roadmap: `docs/superpowers/plans/2026-06-25-tier2-search-index.md`
- 0.0 brief (win-arm64 vec, for 0b.2): `docs/superpowers/plans/codex-handoff-phase0.0-winarm64-vec.md`
- 0a evidence: `docs/release-evidence/phase0a-packaged-smoke-2026-06-27.md`, `docs/release-evidence/phase0a-native-packaging-design-2026-06-26.md`
- Existing Electron-runtime harness to extend: `.github/workflows/smoke.yml` (`electron:` job)
- tsdown externals: `tsdown.config.js` (`nativeRuntimeExternals`); packaging: `electron-builder.yml`
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3 · @electron/rebuild: https://github.com/electron/rebuild
