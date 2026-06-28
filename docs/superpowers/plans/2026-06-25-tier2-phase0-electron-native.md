# Tier-2 Phase 0 — native-stack proof + Electron upgrade

> **Detailed plan for Phase 0 of [the Tier-2 roadmap](2026-06-25-tier2-search-index.md).** The de-risk gate: prove the native stack (better-sqlite3 FTS5 + sqlite-vec exact KNN) loads in the **installed** Electron app on **all four targets** — on a **supported** Electron — *before* any index feature code. Codex implements; Claude audits (read + run + the packaged probe). **Revised 2026-06-26 after a GPT-5.5 Pro review + independent verification** — see the audit note.

**Why first:** the biggest Tier-2 risk is a native module that builds in CI but won't `dlopen` in the packaged app on a target — and **sqlite-vec ships no Windows-ARM64 prebuilt**, which is a hard target. Electron 35 is **EOL**. Both get resolved here, cheapest-risk-first.

> **AUDIT NOTE (2026-06-26).** GPT-5.5 review + verification changed this plan:
> - **sqlite-vec has NO win-arm64 npm prebuilt** (binary-only; issues [#211](https://github.com/asg017/sqlite-vec/issues/211), [#73](https://github.com/asg017/sqlite-vec/issues/73)). → **Phase 0.0 preflight proves win-arm64 FIRST**, before any Electron work. This is the single most likely hard stop.
> - **GitHub `windows-11-arm` runners are GA** ([changelog](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/)) → we can build + test a win-arm64 `vec0.dll` from source natively. Mitigation is real.
> - **System-Node vitest is NOT an ABI gate** — Electron runs its own Node ABI. The release gate is **Electron-runtime + installed-artifact**, vitest is dev feedback only.
> - **Do NOT ship 0a as a public release** — a zero-feature 7-major Electron jump before the native gate is wasted risk. 0a = internal RC; **one public release after 0b passes**.
> - **Don't throw the probe away** — extract a small reusable **native-capability bootstrap module** (Phase 3 reuses it); honors "no `src/index/**` feature code."
> - **Pin exact versions** (Electron 42.5.0, electron-builder 26.15.5 — latest stable as of 2026-06-25), not carets. v27 (native-ESM) deferred.

**Grounded targets (verified 2026-06-25/26):** Electron **no LTS**, latest-3-majors supported; **42.5.0** current (EOL 2026-10-20; 41 EOS 2026-08-25; 43 stable 2026-06-30) → target **42.x, pinned**. electron-builder **26.15.5** (v27 alpha, deferred). better-sqlite3 FTS5; sqlite-vec (MIT/Apache) exact KNN. Sources: [Electron schedule](https://releases.electronjs.org/schedule), [electron-builder releases](https://github.com/electron-userland/electron-builder/releases), [sqlite-vec](https://github.com/asg017/sqlite-vec).

**Out of scope:** `src/index/**` feature code (reconciler, real search) — Phase 3+. Phase 0 ships an upgraded baseline + a reusable native bootstrap proven on every target.

---

## Phase 0.0 — Win-arm64 sqlite-vec preflight (do this FIRST, outside the app)

**The most likely hard stop, settled cheaply before any migration effort.** A standalone CI job on a **native `windows-11-arm` runner** (not the full app): prove sqlite-vec can load + KNN on win-arm64, by official binary or a from-source `vec0.dll`.

### Task 0.0.1: win-arm64 sqlite-vec load + KNN spike (CI, no app)

> **✅ COMPLETE — GO (2026-06-26). CI run #28221618101 on `windows-11-arm` runner (Node 22.23.0, win32/arm64).**
> - Official binary: FAILED (no win-arm64 prebuilt — as expected; issues #211/#73).
> - From-source MSVC cl.exe direct: FAILED (no cl.exe in PATH on runner).
> - **From-source MSVC vcvarsall + cl.exe: SUCCESS** — `vec0.dll` built from `sqlite-vec.c` amalgamation, loaded, FTS5 PASS, KNN PASS.
> - Load path: `from-source-msvc`. Evidence artifact: run 28221618101 / artifact 7898781613 (expires 2026-09-24).
> - **Phase 0a is unblocked.** Win-arm64 mitigation: build `vec0.dll` via `vcvarsall + cl.exe` on `windows-11-arm` CI runner.

**Files:** `.github/workflows/preflight-winarm64-vec.yml`, `scripts/preflight-vec.mjs`.

- [x] Workflow on `runs-on: windows-11-arm`; install pinned `better-sqlite3` + `sqlite-vec`; run `scripts/preflight-vec.mjs`: log `process.platform/arch/versions.node`; open better-sqlite3; resolve + `loadExtension` the sqlite-vec binary; `CREATE VIRTUAL TABLE v USING vec0(embedding float[3])`; insert 2 vectors; KNN-query nearest; assert correct rowid.
- [x] **If the official npm package has no win-arm64 binary (expected):** in the same runner, build `vec0.dll` from the sqlite-vec C amalgamation (`sqlite-vec.c` — single file, no deps; mind the `__popcnt64` win-arm64 intrinsic, issue #73 workaround), then `loadExtension(builtDll)` and re-run the KNN assertion.
- [x] **Acceptance (THE PHASE-0 GO/NO-GO):** win-arm64 sqlite-vec KNN works via **official binary OR a from-source `vec0.dll`**, plus better-sqlite3 FTS5 on win-arm64. Record the winning path + the exact binary provenance in `docs/release-evidence/phase0.0-winarm64-<date>.md`.
- [x] **If neither works:** N/A — GO.

---

## Phase 0a — Electron 35 → 42 upgrade, internal baseline (NOT a public release)

> **✅ COMPLETE — shipped as v0.10.15 (2026-06-27).** All four installers built green (CI run 28275398715, win x64+arm64 / mac arm64 / linux AppImage). Windows packaged smoke green with runtime-env logged: installed app runs **Electron 42.5.0 / Node 24.17.0 / modules 146**, child is a genuine `utilityProcess` (`parentPortPresent: true`, childPid owns `:4410`), `/api/health` HTTP 200. Installed binary upgraded to 0.10.15 (exe ProductVersion + registry DisplayVersion). Evidence: `docs/release-evidence/phase0a-packaged-smoke-2026-06-27.md`.
> **Publish deviation (called out):** plan said 0a = internal RC; **published as `latest`** under the plan's own **security-driven Electron-only ship** exception — Electron 35 is EOL since 2025-09-02. 0b still gates Phase 3.

**Architecture:** pin Electron 42.x + electron-builder 26.x, design native-dep packaging up front, fix main-process API breakage 36→42, keep the v0.10.14 utilityProcess architecture identical, build all four installers, prove the **existing** app still works packaged — as an **internal RC / CI checkpoint**, not a user release.

### Task 0a.1: pin versions + native-dep packaging design

**Files:** `package.json`, `electron-builder.yml`, `tsdown.config.js`, `.github/workflows/release.yml`.

- [x] **Verify-first:** read electron-builder 26 breaking-changes vs 25; confirm Electron 42 + our four targets supported. Record inline.
- [x] Pin (exact, not caret): `electron 42.5.0`, `electron-builder 26.15.5`; add `@electron/rebuild` (4.x). (Use the latest 42.x/26.x patch at implementation time.)
- [x] **Native-dep packaging design (do this NOW, not after 0b):** decide how `better_sqlite3.node` + the sqlite-vec ext binary reach the installed runtime path the utilityProcess loads from. Mark native deps **external** in tsdown (don't let the bundler rewrite `bindings`/`require`); add them + their binaries to electron-builder `files`; resolve at runtime via `app.getAppPath()`-relative paths (asar:false). Document the exact installed path per platform.
- [x] **Acceptance:** runtime-confirmed `electron 42.5.0` (smoke log), `electron-builder --version` → 26.15.5; native-packaging path map in `docs/release-evidence/phase0a-native-packaging-design-2026-06-26.md`. Commit: `build(deps): pin electron 42 + electron-builder 26, add @electron/rebuild`. (CI `electron --version` dropped — Electron binary aborts on Linux runners, SUID sandbox; the version `test`s cover it.)

### Task 0a.2: fix main-process API breakage (35→42) + runtime-env logging

**Files:** `electron/main.ts`, `src/dashboard/dashboard-service.ts`, `dashboard-service-supervisor.ts`, `electron/*`.

- [x] **Verify-first:** check Electron 36–42 breaking-changes for APIs the app uses (`utilityProcess.fork` opts, `app.*`, `BrowserWindow` opts, `protocol.*`, notifications/signing). Fix minimally; keep fork + supervisor + second-instance behavior identical.
- [x] **Add runtime-env logging** to the packaged smoke (so 0a actually proves the child runtime, not just "health ok"): log `process.versions.{electron,node,modules}`, `process.platform`, `process.arch`, `app.getAppPath()`, utility child PID, parent PID, service entry path, and whether `process.parentPort` exists. → confirmed in installed-app log (Electron 42.5.0 / Node 24.17.0 / modules 146 / parentPortPresent true).
- [x] **Test:** `npx tsc --noEmit` + `npx tsc -p tsconfig.ui.json --noEmit` (both — UI typecheck gap is real); `npx vitest run`.
- [x] **Acceptance:** typecheck (both) + tests green. Commit: `fix(electron): adapt main/utilityProcess to Electron 42`.

### Task 0a.3: build 4 installers + packaged smoke (existing app) — internal RC

**Files:** none (build + verify); evidence → `docs/release-evidence/`.

- [x] `npm run build`; assert each shipped entry still self-contained (`grep -cE 'from "\.\.?/' dist/<entry>.mjs` == 0 for electron-main + the three dashboard workers; guard test green).
- [x] Build win x64, **win arm64**, mac arm64, linux AppImage (CI matrix unchanged — mac arm64 only, no .deb). → CI run 28275398715, all 3 jobs green; 11 release assets complete.
- [x] **Packaged smoke (by output):** install (kill app first; assert `MemoryFort.exe` exists, not just registry), launch; confirm window surfaces, `:4410` owner is a child `--type=utility` process of main, `/api/health` real, version correct, **+ the runtime-env log from 0a.2**. Record in `docs/release-evidence/phase0a-<date>.md`. → `docs/release-evidence/phase0a-packaged-smoke-2026-06-27.md`.
- [x] **Acceptance:** four installers build; Windows packaged smoke green with runtime-env logged. ~~Tag as internal RC — do not publish~~ → **published as v0.10.15 `latest`** under the security-driven Electron-only ship exception (Electron 35 EOL 2025-09-02). 0b still gates Phase 3.

---

## Phase 0b — native-capability bootstrap, proven in the installed app (all 4 targets)

**Architecture:** build a **small reusable bootstrap module** (NOT index feature code) that opens the DB, asserts FTS5, resolves + loads sqlite-vec, asserts vec0 KNN; gate it under **Electron's Node runtime** and inside the **installed utilityProcess** on every target. vitest stays as fast dev feedback only.

### Task 0b.1: bootstrap module + better-sqlite3, Electron-runtime FTS5 gate

> **✅ COMPLETE — merged to main (2026-06-27, commit ebad1d5, PR #6).** better-sqlite3 **12.11.1** pinned; `src/index/native/capability.ts` (`openCapabilityDb`/`assertFts5`/`closeCapabilityDb`, typed `CapabilityError`, 0b.2 vec seam). Electron-runtime gate = `MEMORY_CAP_TEST=1` branch in `electron/main.ts` + tri-OS `electron-native-capability` job in `smoke.yml` (runs `electron:rebuild` then asserts `CAP_FTS5 ok`). **Claude audit:** both typechecks 0, dev test green, `electron-main.mjs` self-contained (capability inlined, better-sqlite3 external, 0 relative imports); gate reproduced locally (exit 0, **modules=146**) and **mutation-proven** (rebuild for system-Node ABI 137 → gate RED at the open step). CI green on all 3 OS (capability gate macOS+Linux+Windows). Also fixed `ci.yml`+`smoke.yml` `npm ci`→`npm install` (same Windows-lockfile prune as release.yml). Bonus: `tsdown` `codeSplitting:false` on `electron-main` (now imports capability).

**Files:** `src/index/native/capability.ts` (reusable: `openCapabilityDb`, `assertFts5`, `resolveSqliteVecBinary`, `loadSqliteVec`, `assertVec0Knn`), `test/index/native-fts5.test.ts` (vitest, dev), CI Electron-runtime test.

- [x] vitest (dev signal): `openCapabilityDb(':memory:')` + `assertFts5` (create fts5, bm25 query). **Not a gate.**
- [x] **Gate:** the SAME FTS5 assertion runs under **Electron's Node** in CI (headless Electron main/utility test), after `@electron/rebuild` against Electron 42's ABI. A green vitest with a red Electron-runtime test = the dual-ABI trap; the Electron one wins. → mutation-proven: ABI-137 build makes the gate RED.
- [x] **Acceptance:** FTS5 green under Electron runtime. Commit: `feat(index): native capability bootstrap + better-sqlite3 (Electron-ABI FTS5)`.

### Task 0b.2: sqlite-vec into the bootstrap, Electron-runtime KNN gate

> **✅ COMPLETE — merged to main (2026-06-27, commit ccf7415, PR #7).** `sqlite-vec` **0.1.9** pinned; `capability.ts` `resolveSqliteVecBinary` (npm `getLoadablePath()`; win-arm64 vendored chokepoint returns null → 0b.3 fills it) / `loadSqliteVec` / `assertVec0Knn`; typed steps `vec-resolve|vec-load|vec-knn`. `electron/main.ts` `MEMORY_CAP_TEST` runs FTS5 then sqlite-vec load + KNN; `smoke.yml` asserts `CAP_VEC_KNN ok`. **Claude audit:** tri-OS KNN gate green (macOS+Linux+**Windows-x64**); gate reproduced locally (modules=146, `CAP_FTS5 ok` + `CAP_VEC_KNN ok`); **mutation-proven** (remove `vec0.dll` → RED at `vec-resolve`, FTS5 still ok); native-vec dev test green; both typechecks 0; `electron-main.mjs` self-contained (sqlite-vec external). ⚠️ ubuntu full-suite CI flakes on `test/dashboard/server.test.ts` (604s suite-timeout under native-addon CPU load — **pre-existing on main since 0b.1, unrelated**: nothing links sqlite-vec to the dashboard, passes isolated 6s, real-dashboard smoke green). Follow-up task filed to fix the GH lane; authoritative full suite = VPS.

**Files:** `src/index/native/capability.ts` (`resolveSqliteVecBinary`, `loadSqliteVec`, `assertVec0Knn`), `test/index/native-vec.test.ts`.

- [x] `resolveSqliteVecBinary()` → platform/arch-correct binary (npm `getLoadablePath()`; **win-arm64 vendored `vec0.dll` chokepoint left for 0b.3**); `loadSqliteVec(db)` = `db.loadExtension(path)`, typed error if missing (Phase 5 degrades to lexical).
- [x] vitest (dev) + **Electron-runtime gate**: vec0 table, insert, KNN nearest assertion.
- [x] **Acceptance:** KNN green under Electron runtime. Commit: `feat(index): sqlite-vec load + exact KNN in the bootstrap`.

### Task 0b.3: installed-app probe (all 4 targets) — the real gate

> **REVISED 2026-06-28 after GPT-5.5 review + Claude verification (round 3). Split into 0b.3a→0b.3b→0b.3c (+ advisory).** Full Codex brief: `docs/superpowers/plans/codex-handoff-phase0b.3-installed-probe.md`. Key changes: probe runs in the **real dashboard-service utilityProcess host** (not a divergent fork); **gate on real installed artifacts** (NSIS `/S /D=` into a spaced path, DMG mount+copy+quarantine, AppImage under xvfb) — "unpacked artifact" removed from acceptance; **ungraceful** kill for restart-recovery (verified `utilityProcess.kill()` is graceful SIGTERM); **30 MB demoted to advisory**; vec0 needs runtime API compat not exact SQLite-version match (log `sqlite_version()`+`compile_options`); win-arm64 `vec0.dll` committed-vendored with provenance manifest; runtime-path guard pulled forward from 0b.4; macOS `allowLoadingUnsignedLibraries` is the forward escape-hatch if signing is enabled (unsigned today → Gatekeeper/quarantine is the real first-launch risk).

**Files:** `src/index/native/capability-probe.ts` (env-gated `MEMORY_CAP_PROBE=1`, forked via the dashboard-service supervisor's exact path/options), `vendor/sqlite-vec/win32-arm64/{vec0.dll,manifest.json}`, `src/index/native/capability.ts` (`resolveVendoredSqliteVecBinary` win32/arm64), `tsdown.config.js`, `electron-builder.yml`, `electron/main.ts`, `.github/workflows/*`.

- [x] **0b.3a (merged 99a4ffd):** committed vendored win-arm64 `vec0.dll` (sha256 `8fc0ec99…`) + provenance manifest (upstream v0.1.9/commit/source-sha256/recipe/MSVC 19.44-ARM64/runner); `resolveVendoredSqliteVecBinary()` validates absolute+exists+sha256+arch for win32/arm64, null elsewhere; ships `vendor/**`; Apache/MIT notice in `LICENSE-NOTICE.md`; `scripts/assert-vendored-sqlite-vec.mjs` CI-asserts the packaged win-arm64 app carries the exact hash. **Claude-audited.**
- [x] **0b.3b (THE load-bearing gate — merged 99a4ffd):** `capability-probe.ts` forked via the **real dashboard-service supervisor** (verified in code + runtime logs); steps 1-6 (runtime/path log, WAL open + sha256 both binaries + `sqlite_version`/`compile_options`, FTS5, `loadSqliteVec`, vec0 KNN, runtime-path guard rejecting dev/unpacked/outside/arch-mismatch). **CI green on all 4 installed targets** (run 28309434573, strict needle assertions incl. win-arm64 `vec-load`/`vec-knn ok`; macOS quarantine+`spctl` tested). **Claude independently verified on win-x64:** normal launch intact, packaged probe steps 1-6 ok, **mutation-proven** (rename installed `vec0.dll` → step2 `vec-resolve` FAIL exit 1). ⚠️ CI Actions currently **billing-blocked** (post-merge ci/smoke can't run); evidence is the pre-block green run + local verification.
- [x] **0b.3c (merged d859012):** parent-orchestrated two-fork **ungraceful** restart-recover — write-hold commits un-checkpointed WAL (`wal_autocheckpoint=0`) + holds; parent force-kills (`taskkill /F` / `SIGKILL`, throws if clean exit); reopen-verify recovers + reads back + KNN. Concurrent-WAL: reader sees committed snapshot (not in-flight row) during the write txn, both after commit, no BUSY. `installed-native-probe.yml` asserts `step7`/`step8`/`steps 1-8`/`forced-kill confirmed` on all four targets. **Claude audit:** 4-target installed CI green (win-arm64+win-x64+macOS-arm64+linux-x64, strict needles) + all PR#8 checks green (incl. CI lane — flake didn't bite); independently reproduced on win-x64 (forced kill `taskkill /F`, WAL 119512, exit code 1, steps 1-8 ok). **Phase 0b.3 COMPLETE.**
- [ ] **Advisory (not a gate):** ~30 MB DB reopen/checkpoint as evidence only — never blocks the gate.
- [ ] **Acceptance (THE GATE):** 0b.3a hash-assertion green; 0b.3b steps `ok` on **all four installed targets** (esp. **win-arm64 vec-load/KNN + macOS arm64 launch-under-quarantine**), mutation-proven (rename a binary → fail at the right step); 0b.3c restart+concurrent `ok`. Logs in `docs/release-evidence/phase0b3-<date>.md`. (Disk-full / corrupt-DB recovery deferred to the index feature phase.)

### Task 0b.4: runtime-path native guard + cleanup

**Files:** `test/build/native-packaging.test.ts`.

- [ ] **Guard (mutation-proven):** for each target arch, assert the native artifacts the app loads exist **at the exact installed runtime path** (`better_sqlite3.node`, the per-platform sqlite-vec binary `.dll/.dylib/.so`) — present on disk, not inside asar, `process.arch` matches. Remove one → installed smoke must fail.
- [ ] Keep the bootstrap module + deps (Phase 3 uses them); probe stays env-gated.
- [ ] **Acceptance:** guard green + mutation-verified; normal launch unaffected. Commit: `test(build): runtime-path guard for native module + sqlite-vec`.

---

## Phase 0 done = Phase 3 unblocked

1. **0.0:** win-arm64 sqlite-vec proven (official or from-source) — the go/no-go, settled before migration.
2. **0a:** app on Electron 42.x, four installers build, existing packaged smoke green w/ runtime-env logged — as an **internal RC**.
3. **0b:** the bootstrap passes all probe steps on all four targets (incl. win-arm64 + sqlite-vec + concurrent WAL + 30 MB reopen); runtime-path guard green + mutation-verified.
4. **One combined public release** after 0b (per `docs/RELEASING.md`). No `src/index/**` feature code yet.

## Self-review

- **Spec coverage:** 0.0 settles the load-bearing unknown first; 0a = supported-Electron baseline (EOL fix) as an internal RC; 0b = the native gate end-to-end in the installed app, under Electron's ABI, on every target, via reusable code.
- **Placeholders:** none — each task has a test/probe, the contract, exact assertions, and a recorded-evidence gate.
- **Risks flagged:** win-arm64 sqlite-vec (now Phase 0.0, with a from-source mitigation on `windows-11-arm`); dual ABI (Electron-runtime tests are the gate, vitest demoted); native packaging from a bundler (designed in 0a.1, guarded in 0b.4); macOS unsigned dlopen (test the DMG as a user gets it); Electron no-LTS treadmill (pinned 42.x, accepted bumps); electron-builder 26 churn (verify-first, v27 deferred).

## Execution handoff

Codex implements **0.0 → 0a → 0b** in order; Claude audits each (read diff + run typecheck/tests + the installed probe on Windows; CI covers the other targets + win-arm64). **Hard gates:** (1) don't start 0a until **0.0** is green on win-arm64; (2) don't publish until **0b.3** is green on all four targets; (3) don't start Phase 3 until 0b is fully green. Phase 3 detail: [the roadmap](2026-06-25-tier2-search-index.md#phase-3--detailed-tasks).
