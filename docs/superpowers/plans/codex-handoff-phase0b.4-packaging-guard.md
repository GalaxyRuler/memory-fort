# Codex handoff — Phase 0b.4: runtime-path native packaging guard + cleanup (final Phase-0 task)

> Self-contained task brief. Codex cannot read the conversation that produced this. **Builds on merged 0b.3a/b/c (main `76c16ae`).** This is the **last Phase-0 task** — after it, Phase 0 is done and the next step is **one combined public release** (separate task, per `docs/RELEASING.md`). **Do not bump version / release in this task.**

## Goal

Turn the native-packaging contract — *the exact native artifacts the app loads exist at the exact installed runtime path, with the right arch, not inside an asar* — into a **mutation-proven, repeatable guard test**, and do the Phase-0 cleanup. Much of the runtime side is already proven by 0b.3b's in-probe `runtime-path guard` and my local mutation (rename `vec0.dll` → probe fails). 0b.4 makes the **build/packaging** side a tested invariant so a future change that drops a `files` entry, flips `asar:true`, re-bundles a native module, or breaks the vendored-hash chain fails **in CI**, not in a user's installed app.

## Background (what already exists — reuse, don't duplicate)

- **Runtime guard (0b.3b, merged):** `src/index/native/capability-probe.ts` asserts at runtime, inside the installed utilityProcess, that `better_sqlite3.node` + the resolved sqlite-vec binary exist inside the installed app (`resourcesPath`/`app.getAppPath()` subtree), arch matches `process.arch` (PE/`file` parse), and rejects dev/`defaultApp`/unpacked trees. The installed CI gate (`.github/workflows/installed-native-probe.yml`) runs this on all 4 targets. **This is the runtime half — keep it.**
- **Packaging config (0a/0b.3a):** `electron-builder.yml` has `asar: false` and `files` shipping `node_modules/{better-sqlite3,bindings,file-uri-to-path,sqlite-vec,sqlite-vec-*}/**` + `vendor/sqlite-vec/**`. `tsdown.config.js` keeps native modules in `nativeRuntimeExternals` (`neverBundle`) and the shipped entries (`electron-main`, `dashboard/dashboard-service`, `index/native/capability-probe`) are `codeSplitting:false`.
- **Vendored win-arm64:** `vendor/sqlite-vec/win32-arm64/{vec0.dll,manifest.json}`; `scripts/assert-vendored-sqlite-vec.mjs` checks the packaged win-arm64 app carries the manifest sha256. `resolveVendoredSqliteVecBinary()` in `capability.ts` validates absolute+exists+sha256+arch for win32/arm64.

## What to build

### 1. Build-time packaging guard — `test/build/native-packaging.test.ts` (NEW, vitest/system-Node, runs in `ci.yml`)
Static, fast, mutation-provable. Assert the **contract**, reading the repo's own config + the vendored manifest (no packaging needed for these):
- `electron-builder.yml`: `asar` is `false`; `files` includes every native dir the runtime loads — `node_modules/better-sqlite3/**`, `node_modules/bindings/**`, `node_modules/file-uri-to-path/**`, `node_modules/sqlite-vec/**`, `node_modules/sqlite-vec-*/**`, `vendor/sqlite-vec/**`.
- `tsdown.config.js`: `nativeRuntimeExternals` contains `better-sqlite3`, `bindings`, `file-uri-to-path`, `sqlite-vec`, and the `sqlite-vec-*` pattern; the three shipped entries (`electron-main`, `dashboard/dashboard-service`, `index/native/capability-probe`) are present with `codeSplitting:false`.
- Vendored chain: `vendor/sqlite-vec/win32-arm64/manifest.json` `output.sha256` + `size` **equal the actual committed `vec0.dll`**, and `target.peMachine === "ARM64"` with the DLL's real PE machine = `0xAA64`.
- Each assertion must be **mutation-provable**: design the test so flipping `asar:true`, removing a `files` entry, dropping a `nativeRuntimeExternals` member, setting an entry to `codeSplitting:true`, or tampering the manifest/DLL turns it **red**. (Document the mutation for each in a comment.)

### 2. Packaged-output arch check (extend the installed CI gate, per target)
The 4-target `installed-native-probe.yml` already installs the real artifact and runs the probe. Add a small assertion step **in each target job** (or fold into the existing probe assertions) that, against the **installed** app dir, confirms the native binary the app loads sits at the expected installed relative path and is **not** inside an `.asar`:
- Windows: `resources\app\node_modules\better-sqlite3\build\Release\better_sqlite3.node` + (x64) `resources\app\node_modules\sqlite-vec-windows-x64\vec0.dll` / (arm64) `resources\app\vendor\sqlite-vec\win32-arm64\vec0.dll`; assert no `resources\app.asar`.
- macOS arm64: `Contents/Resources/app/node_modules/...`; assert no `app.asar`.
- Linux x64: the AppImage's mounted/extracted `resources/app/node_modules/...`.
- (The probe already stat+sha256+arch-checks these at runtime — this step makes the **on-disk packaging path** an explicit, separate assertion so a packaging regression is caught even if the probe were skipped.)

### 3. Cleanup (Phase-0 close-out)
- **Reconcile `installed-native-probe.yml` triggers:** 0b.3 added a branch-pattern push trigger for iteration. The 4-target installed gate is **expensive** — set it to run on **PRs to `main`** + **`workflow_dispatch`** (and optionally release tags), NOT every push to every branch. Keep it cheap to run intentionally.
- Confirm the capability **probe stays env-gated** (`MEMORY_CAP_PROBE=1`) and the 0b.1/0b.2 `MEMORY_CAP_TEST` gate intact — normal launch must not run either. Keep the bootstrap module + native deps (Phase 3 uses them).
- Remove any dev-only scaffolding left from 0b.3 iteration (temp scripts, stray logs); do not remove `scripts/assert-vendored-sqlite-vec.mjs` or `scripts/preflight-vec.mjs` (both are load-bearing).

## Tests / verification before handing back
- `npx tsc --noEmit` + `npx tsc -p tsconfig.ui.json --noEmit` — both 0.
- `npm test -- test/build/native-packaging.test.ts --reporter=dot` — green; **and demonstrate the mutation** for at least `asar` and one `files`/`externals` entry (flip locally → test red → revert). Report the red output.
- `npm run build` — green; shipped entries still self-contained (0 relative runtime imports).
- Do NOT run the full vitest suite on the local box (`server.test.ts` is a known CPU-load flake) — targeted files only.

## Acceptance criteria
- `test/build/native-packaging.test.ts` green in `ci.yml`, asserting asar:false + all native `files` + tsdown externals/codeSplitting + the vendored-hash chain; each assertion mutation-provable (documented).
- The installed gate additionally asserts the on-disk native path + no-asar per target.
- `installed-native-probe.yml` triggers reconciled to PR/dispatch (not every push); probe stays env-gated; normal launch unaffected.
- Both typechecks + build green.
- Commit: `test(build): runtime-path guard for native module + sqlite-vec`.

## What NOT to do
- No `src/index/**` feature code; no version bump / release (the combined public release is a separate task after 0b.4).
- Don't weaken/remove the 0b.1/0b.2 `MEMORY_CAP_TEST` gate or the 0b.3 installed probe; 0b.4 is additive + cleanup.
- Don't set `asar:true`, don't bundle native modules into JS, don't revert `npm install`→`npm ci`.
- Don't make the guard a no-op — if you can't make an assertion fail under mutation, it isn't testing anything; fix it.

## After Codex hands back — Claude's audit
1. Read `test/build/native-packaging.test.ts`; for each assertion, confirm the documented mutation actually turns it red (spot-check `asar`, a `files` entry, a `codeSplitting` flag, the manifest hash).
2. Confirm the installed-gate path/no-asar assertions are present per target and the trigger reconciliation is sane (not running the heavy gate on every push).
3. Run typechecks + the new test locally; confirm probe stays env-gated + normal launch unaffected.
4. On green: tick 0b.4 → **Phase 0 COMPLETE** in the plan; the next action is the **combined public release** (its own task — verify → CHANGELOG/README → version bump → build installers → 4-target installed re-check → publish, per `docs/RELEASING.md`).

## References (repo-root-relative)
- Plan: `docs/superpowers/plans/2026-06-25-tier2-phase0-electron-native.md` (Phase 0b.4)
- Runtime guard to complement: `src/index/native/capability-probe.ts` (the `runtime-path guard` step)
- Config under test: `electron-builder.yml`, `tsdown.config.js`, `vendor/sqlite-vec/win32-arm64/manifest.json`, `scripts/assert-vendored-sqlite-vec.mjs`
- CI: `.github/workflows/installed-native-probe.yml`, `.github/workflows/ci.yml`
- Release process (next task): `docs/RELEASING.md`
