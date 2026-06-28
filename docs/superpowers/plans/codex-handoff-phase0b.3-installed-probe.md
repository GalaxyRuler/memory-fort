# Codex handoff — Phase 0b.3: installed-app native probe on all four targets (THE Phase-0 gate)

> Self-contained task brief. Codex cannot read the conversation that produced this. **Builds on 0b.1 (`ebad1d5`) + 0b.2 (`ccf7415`), both merged.** This is the **real Phase-0 gate** and the largest 0b task. **Revised 2026-06-28 after a GPT-5.5 Pro adversarial review + Claude verification of the load-bearing API claims** — see the audit note. **Do not bump version / release** — the combined public release comes after 0b.3.

> **AUDIT NOTE (2026-06-28).** GPT-5.5 review + primary-source verification changed this plan:
> - **Run the probe in the REAL dashboard-service utilityProcess host**, not a naively-forked separate process. A divergent fork (different cwd/env/appPath/options) can pass while the real index host fails. Reuse the dashboard-service supervisor's exact fork path/options.
> - **"Use the unpacked artifact" is NOT acceptable for the gate.** Unpacked dirs, locally-built unquarantined DMGs, and `--appimage-extract` all have different path/security/process semantics than a real user install. Gate on real NSIS install / DMG mount+copy / AppImage exec; unpacked = non-gating evidence only.
> - **Split the big-bang into 0b.3a → 0b.3b → 0b.3c (+ advisory scale)** so vendoring, installed-load, and WAL/recovery don't fail under one red light.
> - **Step-6 restart-recovery must be an UNGRACEFUL kill.** Verified: Electron `utilityProcess.kill()` sends **SIGTERM on POSIX (graceful)** — a child that closes SQLite cleanly masks WAL crash recovery. Use SIGKILL / forced termination, write+don't-checkpoint, then reopen.
> - **Demote the ~30 MB test** from hard gate to advisory evidence (scale/checkpoint, not native-load; CI-flake risk).
> - **vec0 does NOT need to match better-sqlite3's exact SQLite version.** Verified: SQLite loadable extensions load at runtime via `dlopen`/`LoadLibrary` and bind to the host's `sqlite3_api_routines` — the real risk is host-API compatibility, not source-version matching. Log `sqlite_version()` + `pragma compile_options` and prove `loadExtension` + KNN at runtime. (better-sqlite3 12.11.1 bundles SQLite 3.53.1.)
> - **macOS unsigned posture:** the app is unsigned (`CSC_IDENTITY_AUTO_DISCOVERY:false`), so library validation is NOT enforced and is not the current `loadExtension` blocker — **Gatekeeper/quarantine on first launch is**. Test it (`spctl --assess`, add a quarantine xattr). Forward constraint: **if signing is ever enabled**, the dashboard-service utilityProcess fork must set **`allowLoadingUnsignedLibraries: true`** (macOS opt, default false — verified) or the nested `vec0.dylib` must be signed, else `loadExtension` fails under hardened runtime.

## Goal

Prove the native stack (better-sqlite3 FTS5 + sqlite-vec exact KNN, on WAL, with ungraceful-restart recovery and concurrent WAL) loads and runs inside the **real Electron dashboard-service utilityProcess of the INSTALLED app** on **Windows x64, Windows ARM64, macOS ARM64, Linux x64**. The 0b.1/0b.2 gates ran `npx electron .` in the **main** process from a built repo; this gate runs the **packaged installer's** app and the **utilityProcess** that will actually host the index — proving the native binaries resolve at the **installed runtime paths**. **The hardest target is win-arm64** (no sqlite-vec prebuilt → vendored from-source `vec0.dll`).

## Background (read — grounds everything)

**MemoryFort:** single-user Electron 42.5.0 desktop app, GPL-3.0-only (`memory-fort-private`; public mirror `memory-fort`). The dashboard HTTP backend runs in a long-lived Electron **`utilityProcess`** forked from `electron/main.ts` via `src/dashboard/dashboard-service-supervisor.ts` (`forkService()` builds a runtime-env, derives paths from `app.getAppPath()`, postMessages the child). `asar:false`; native modules ship in `node_modules/**` (+ a new `vendor/**`) under `resources/app/` and load via `createRequire` / `db.loadExtension`.

**0b.1 + 0b.2 foundation (reuse, don't duplicate):**
- `src/index/native/capability.ts`: `openCapabilityDb(path)` (WAL for file DBs), `assertFts5`, `resolveSqliteVecBinary`, `loadSqliteVec` (= `db.loadExtension`), `assertVec0Knn`, `closeCapabilityDb`; typed `CapabilityError { step }`. **`resolveSqliteVecBinary` already calls `resolveVendoredSqliteVecBinary()` which currently returns `null` for `win32/arm64` — 0b.3a fills it**; everything else uses the npm `getLoadablePath()`.
- Electron-runtime FTS5+KNN gate proven + mutation-proven on macOS/Linux/Win-x64 via `MEMORY_CAP_TEST=1` in `electron/main.ts` (runs in **main**) + the `electron-native-capability` smoke job. Keep that gate; 0b.3 adds the heavier **installed utilityProcess** probe.
- tsdown: entries are `codeSplitting:false`, native modules in `nativeRuntimeExternals` (`neverBundle`). `electron-builder.yml` ships `better-sqlite3`, `bindings`, `file-uri-to-path`, `sqlite-vec`, `sqlite-vec-*`.

**Win-arm64 (Phase 0.0, GO):** no sqlite-vec npm prebuilt ([#211](https://github.com/asg017/sqlite-vec/issues/211), [#73](https://github.com/asg017/sqlite-vec/issues/73) — `__popcnt64`, still open). Phase 0.0 proved a from-source `vec0.dll` (MSVC `vcvarsall + cl.exe` from `sqlite-vec.c` on `windows-11-arm`) loads + KNN-works. Recipe in `scripts/preflight-vec.mjs` (`PROBE_FORCE_SOURCE=1`).

**Verified facts (2026-06-28, primary sources):** `utilityProcess.fork` has `allowLoadingUnsignedLibraries` (macOS, default `false`); `kill()` is SIGTERM/graceful on POSIX. better-sqlite3 12.11.1 (Jun 15 2026) fixes Electron-42 Windows builds; bundles SQLite 3.53.1. GitHub hosted runners include `windows-11-arm` (admin, UAC off) and `macos-latest`(arm64); NSIS supports `/S` + `/D=<path>` (last arg, unquoted, spaces ok).

---

## Task 0b.3a — vendor the win-arm64 `vec0.dll` + resolver + packaged-hash assertion

**Files:** `vendor/sqlite-vec/win32-arm64/vec0.dll` (+ `manifest.json`), `src/index/native/capability.ts`, `electron-builder.yml`, a CI assertion, third-party notices.

- Build `vec0.dll` for win-arm64 in CI (reuse the 0.0 `from-source-msvc` recipe on `windows-11-arm`). **Commit** `vendor/sqlite-vec/win32-arm64/vec0.dll` + `vendor/sqlite-vec/win32-arm64/manifest.json` recording: upstream sqlite-vec tag/commit, source amalgamation sha256, build-script hash, MSVC version, runner image label, build date, **output sha256**, file size, and the Apache-2.0/MIT license notice. (MSVC output is not byte-reproducible — trust model is "shipped binary sha256 == manifest sha256", not "rebuild reproduces the bytes".)
- `electron-builder.yml`: ship `vendor/sqlite-vec/**` so the win-arm64 installer carries it; compute its installed path from `app.getAppPath()`.
- `resolveVendoredSqliteVecBinary()`: for `win32/arm64` return the absolute installed `vec0.dll` path; validate **absolute + exists + sha256 == manifest + file size + arch** before returning; `null` for every other platform/arch.
- Add the sqlite-vec Apache-2.0/MIT notice to the app's third-party notices (GPL-3.0 app shipping an Apache/MIT binary — compliance).
- **CI assertion:** the built **win-arm64** app contains exactly the manifest sha256 at the expected installed path.
- **Acceptance:** vendored DLL + manifest committed; resolver returns the validated win-arm64 path; CI proves the packaged win-arm64 app contains the exact hash at the right path. Commit: `build(index): vendor win-arm64 sqlite-vec vec0.dll + provenance manifest`.

## Task 0b.3b — micro installed native-load gate (win-arm64 FIRST, then all targets) — THE load-bearing gate

**Files:** `src/index/native/capability-probe.ts` (NEW), `tsdown.config.js` (entry), `electron/main.ts` (fork via the supervisor), `src/dashboard/dashboard-service-supervisor.ts` (reuse/extend the fork path), `electron-builder.yml`, `.github/workflows/*`.

- **`capability-probe.ts`** runs ONLY inside a utilityProcess (`if (!process.parentPort) bail`), gated behind `MEMORY_CAP_PROBE=1`. It must be forked through the **same `dashboard-service-supervisor` fork path/options** the dashboard-service uses (same cwd, env, runtime-env construction, `app.getAppPath()` resolution) — so it proves the **real index host**, not a divergent process. (Acceptable alternative: run the probe inside the dashboard-service entry itself behind the env flag, before the HTTP server starts. A naive standalone `utilityProcess.fork` of a different entry is NOT acceptable — it can diverge.)
- The micro-gate runs ONLY these steps (file DB in a temp dir with a **space and Unicode** in the path), logging each to `<tmp>/cap-probe.log` + parentPort; any throw → `stepN FAIL <err>` + non-zero exit:
  1. **Log the runtime + paths:** `process.execPath`, `process.cwd()`, `process.resourcesPath`, parent `app.getAppPath()`, `process.platform`, `process.arch`, `process.versions.{electron,node,modules}`.
  2. Open SQLite **WAL** file DB → log resolved path + `fs.stat` (size/mtime) + **sha256** for `better_sqlite3.node` AND the resolved sqlite-vec binary; log `select sqlite_version()` + `pragma compile_options`.
  3. FTS5 bm25 (reuse `assertFts5`) → `fts5 ok`.
  4. `loadSqliteVec` → `vec-load ok`.
  5. vec0 insert + KNN (reuse `assertVec0Knn`) → `vec-knn ok`.
  6. **Runtime-path guard (pulled forward from 0b.4):** assert both native binaries resolved from **inside the installed app** (`resourcesPath`/`app.getAppPath()` subtree) — NOT a dev path, global npm cache, or unpacked build tree; arch matches `process.arch`. Mismatch → fail.
- **Run the INSTALLED app** with `MEMORY_CAP_PROBE=1` on **win-arm64 FIRST**, then Win x64, macOS arm64, Linux x64 — via real distribution artifacts:
  - Win x64 + **win-arm64**: NSIS silent install into a path **with spaces** (`/S /D=<path with spaces>`), launch the installed `.exe`. (`windows-11-arm` runner.)
  - macOS arm64: mount the DMG, copy `.app` to a non-build path with spaces, **add a `com.apple.quarantine` xattr**, run `codesign -dv --verbose=4` + `spctl --assess --type execute -vv`, then launch with the env flag. Record whether Gatekeeper/quarantine blocks launch.
  - Linux x64: run the real **AppImage** under `xvfb-run`. If FUSE is unavailable and you must `--appimage-extract`, **label that result weaker/non-gating** — do not treat it as equivalent.
- **Acceptance (THE GATE):** steps 1–6 `ok` on **all four targets via real installed artifacts — especially win-arm64 vec-load+vec-knn and macOS arm64 (launch + load under quarantine)**. Logs → `docs/release-evidence/phase0b3-<date>.md`. A skipped target is a **NO-GO**, not a pass. Commit: `feat(index): installed-app native-load gate (4 targets, win-arm64 vendored vec0)`.

## Task 0b.3c — WAL durability: ungraceful restart-recovery + concurrent WAL (after 0b.3b green)

**Files:** `src/index/native/capability-probe.ts` (extend), the CI gate.

- Extend the probe (still in the real utilityProcess host, installed artifacts) with:
  7. **Ungraceful restart-recover:** write committed WAL frames, **avoid checkpoint**, then **forcibly terminate** the utility child (SIGKILL on POSIX / forced process kill on Windows — NOT `utilityProcess.kill()`, which is graceful SIGTERM), keep the DB dir stable, re-fork, reopen + read back + re-run load/KNN → `restart-recover ok`.
  8. **Concurrent WAL (small):** one writer + one reader connection open at once; read during/after a write txn; assert correct read, no corruption, no lock error → `concurrent-wal ok`. Keep it small — file-locking proof in the packaged runtime, NOT index-feature testing.
- **Acceptance:** steps 7–8 `ok` on all four installed targets. Logs appended to the 0b3 evidence file. Commit: `feat(index): WAL crash-recovery + concurrent-WAL probe steps`.

## Advisory (NOT a hard gate) — ~30 MB scale smoke
- Optionally, after 0b.3b/0b.3c are green, build a ~30 MB DB (force WAL growth + checkpoint), reopen, query → record as **evidence** in the 0b3 file. **Not a release blocker** for Phase 0 (it's scale/checkpoint, not native-load; it adds CI-timeout/disk flake). If it flakes, it does not fail the gate.

## Tests / verification Codex must run before handing back (each sub-task)
- `npx tsc --noEmit` + `npx tsc -p tsconfig.ui.json --noEmit` — both 0.
- `npm run build` — green; `capability-probe.mjs` (and `electron-main.mjs`) **self-contained** (`grep -cE '(from|import\()\s*"\.\.?/' dist/...` == 0; better-sqlite3 + sqlite-vec external).
- Local Windows-x64: `npm run electron:rebuild`, run the packaged app with `MEMORY_CAP_PROBE=1`; confirm the relevant steps `ok` and the logged binary paths/stats are **inside the installed app**.
- Do NOT run the full vitest suite on WHITEDRAGON (repo policy; `server.test.ts` is a known CPU-load flake) — targeted files only.

## What NOT to do
- **No `src/index/**` feature code** — no reconciler/search/index wiring; probe + bootstrap only.
- Do not weaken/remove the 0b.1/0b.2 `MEMORY_CAP_TEST` gate; the probe is additive.
- Do not fork a **divergent** probe process — reuse the dashboard-service supervisor's fork path/options (or run inside dashboard-service behind the flag).
- Do not accept "unpacked artifact" as the gate; do not pretend `--appimage-extract` == real AppImage.
- Do not use graceful `utilityProcess.kill()` for step 7 (it's SIGTERM) — use forced termination.
- Do not require an end-user toolchain (win-arm64 `vec0.dll` is CI-built + vendored).
- Do not switch vector extensions, bundle native modules into JS, set `asar:true`, or revert `npm install`→`npm ci`.
- Do not bump version / cut a release.

## After each sub-task — Claude's audit steps
- **0b.3a:** verify the manifest provenance + that the packaged win-arm64 app contains exactly the manifest sha256 at the installed path; resolver win32/arm64 branch validated (sha256+arch+exists); license notice present.
- **0b.3b:** read each target's `cap-probe.log`; confirm steps 1–6 ok on **real installed artifacts** on all four targets (win-arm64 + macOS arm64 load-bearing); eyeball that the logged binary paths are **inside the installed app**, not the repo; confirm the probe ran via the supervisor fork path (same appPath/resourcesPath as dashboard-service). **Mutation-prove:** rename the installed win-arm64 `vec0.dll` (and separately `better_sqlite3.node`) → probe fails at the right step. macOS: confirm the quarantine/spctl result is recorded.
- **0b.3c:** confirm step 7 used a **forced** kill (not `utilityProcess.kill()`); steps 7–8 ok on all four.
- On all green: tick 0b.3 in the plan; hand off **0b.4** (formal runtime-path guard test, mutation-proven — much of it proven by 0b.3b step 6) → then Phase 0 done → **one combined public release** per `docs/RELEASING.md`.

## References (repo-root-relative)
- Plan: `docs/superpowers/plans/2026-06-25-tier2-phase0-electron-native.md` (Phase 0b.3)
- Bootstrap: `src/index/native/capability.ts`; merges 0b.1 `ebad1d5`, 0b.2 `ccf7415`
- Win-arm64 recipe: `scripts/preflight-vec.mjs`; 0.0 brief `docs/superpowers/plans/codex-handoff-phase0.0-winarm64-vec.md`
- Fork pattern to reuse: `src/dashboard/dashboard-service-supervisor.ts`, `electron/main.ts`
- Packaging: `electron-builder.yml`, `tsdown.config.js`; CI `.github/workflows/release.yml`, `smoke.yml`
- Electron utilityProcess (`allowLoadingUnsignedLibraries`, `kill` SIGTERM): https://www.electronjs.org/docs/latest/api/utility-process · SQLite loadext: https://sqlite.org/loadext.html · NSIS CLI: https://nsis.sourceforge.io/Docs/Chapter3.html · sqlite-vec: https://github.com/asg017/sqlite-vec · better-sqlite3 releases: https://github.com/WiseLibs/better-sqlite3/releases
