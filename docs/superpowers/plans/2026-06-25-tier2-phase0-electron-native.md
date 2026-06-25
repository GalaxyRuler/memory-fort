# Tier-2 Phase 0 — Electron upgrade + packaged native-capability matrix

> **Detailed plan for Phase 0 of [the Tier-2 roadmap](2026-06-25-tier2-search-index.md).** The de-risk gate: prove the native stack (better-sqlite3 FTS5 + sqlite-vec) loads in the **installed** app on **all four targets** — on a **supported** Electron — *before* any index feature code. Codex implements task-by-task; Claude audits (read + run + packaged smoke). No Tier-2 logic ships until 0b is green on Win-arm64.

**Why first:** the single biggest Tier-2 risk is a native module that compiles in CI but won't `dlopen` in the packaged app on a target (esp. Windows arm64) — it would violate a hard shipping constraint and we've already eaten two packaged-app misdiagnoses (0.10.12/13). Electron 35 is **EOL** (since 2025-09-02), so we also can't rebuild native against an unsupported runtime. Fix both here, once.

**Grounded targets (verified 2026-06-25):**
- Electron has **no LTS**; supported = latest ~3 majors, ~8-week cadence (41 EOS 2026-08-25; **42.4.1** latest). → target **Electron 42** (longest runway; accept future bumps). Sources: [endoflife.date/electron](https://endoflife.date/electron), [electron releases](https://releases.electronjs.org/).
- `electron-builder` **^25 → ^26** (26.15.3; v27 is breaking native-ESM — defer). [npm](https://www.npmjs.com/package/electron-builder?activeTab=versions).
- `better-sqlite3` bundles FTS5; `sqlite-vec` (MIT/Apache) is the vector ext; both rebuilt against Electron 42 ABI via `@electron/rebuild`.

**Out of scope:** any `src/index/**` code, the reconciler, search routes (those are Phase 3+). Phase 0 ships an Electron-upgraded baseline + a throwaway capability spike.

---

## Phase 0a — Electron 35 → 42 upgrade, ship a re-verified baseline

**Architecture:** bump Electron + electron-builder, fix main-process API breakage across 7 majors, keep the v0.10.14 utilityProcess architecture intact, rebuild installers for all four targets, confirm the **existing** app still works packaged (server in the child utility process, `/api/health` real). This is a standalone release (decoupled from Tier-2 feature risk).

### Task 0a.1: pick the target + bump build tooling

**Files:** `package.json`, `electron-builder.yml`, `.github/workflows/release.yml`.

- [ ] **Verify-first:** read electron-builder 26 changelog for breaking changes vs 25; confirm it supports Electron 42 + our targets (win x64/arm64 nsis, mac arm64 dmg/zip, linux AppImage). Record findings inline in the PR description.
- [ ] Bump `devDependencies`: `electron ^42.4.1`, `electron-builder ^26.15.3`. Add `@electron/rebuild` (latest 4.x).
- [ ] `npm install`; resolve peer/engine warnings (electron-builder 27 needs Node ≥22.12 — we pin 26 to avoid the ESM break).
- [ ] **Acceptance:** `npx electron --version` → `v42.x`; `npx electron-builder --version` → `26.x`. Commit: `build(deps): electron 35→42, electron-builder 25→26, add @electron/rebuild`.

### Task 0a.2: fix main-process API breakage (35→42)

**Files:** `electron/main.ts`, `src/dashboard/dashboard-service.ts`, `dashboard-service-supervisor.ts`, any `electron/*` modules.

- [ ] **Verify-first:** grep `electron/` + `src/dashboard/` for APIs deprecated/removed across 36–42 (e.g. `utilityProcess` signature changes, `app.*` removals, `BrowserWindow` option renames, `protocol.*`, `nativeImage`). Cross-check each against the Electron breaking-changes docs for 36→42.
- [ ] Fix breakages minimally; keep the utilityProcess fork + supervisor + second-instance handler behavior identical.
- [ ] **Test:** `npx tsc --noEmit` + `npx tsc -p tsconfig.ui.json --noEmit` (both — UI typecheck gap is real); `npx vitest run` (full suite green; the known slow/flaky CLI/routing suites pass isolated — see verify-tests-slow-flaky note; authoritative green = VPS lane).
- [ ] **Acceptance:** typecheck (both) + tests green. Commit: `fix(electron): adapt main/utilityProcess to Electron 42 API`.

### Task 0a.3: build all-4-target installers + packaged smoke (existing app)

**Files:** none (build + verify); evidence → `docs/release-evidence/`.

- [ ] `npm run build` (tsdown self-contained entries + vite UI). Assert each shipped entry still has 0 relative imports: for `electron-main`, `dashboard/{dashboard-service,scheduled-vault-worker,verify-worker}` → `grep -cE 'from "\.\.?/' dist/<entry>.mjs` == 0. (Guard test `test/build/dashboard-build.test.ts` must pass.)
- [ ] Build installers for win x64, **win arm64**, mac arm64, linux AppImage (CI `release.yml` matrix; the macOS-arm64-only / no-Intel / no-.deb matrix is fixed — don't widen).
- [ ] **Packaged smoke (the gate, by output not memory):** install (kill app first; assert `MemoryFort.exe` exists, not just the registry key), launch. Confirm: window surfaces; `:4410` owner is a child `--type=utility` process of main (`type=utility:True`); `/api/health` returns a real report; version string = new build. Record in `docs/release-evidence/phase0a-<date>.md`.
- [ ] **Acceptance:** all four installers build; Windows packaged smoke green (server in child utility process, health real). Ship as the Electron-42 baseline release (follow `docs/RELEASING.md`: CHANGELOG, version bump, scan:leaks, push public+private, installers, packaged smoke). Commit/tag per the release ritual.

---

## Phase 0b — packaged native-capability spike (better-sqlite3 + sqlite-vec)

**Architecture:** a **throwaway** capability-probe entry, shipped in the app like a worker, that runs inside the real utilityProcess and exercises the entire native path end-to-end, logging each step's result to a temp file. Run the **installed** artifact on all four targets. This proves the Phase 3+ foundation without writing any of it. Delete the probe (or gate it behind an env flag) before Phase 3 feature work.

### Task 0b.1: add better-sqlite3, rebuild for Electron, prove FTS5 in vitest

**Files:** `package.json`, `test/index/native-fts5.test.ts`, build scripts.

- [ ] **Failing test:** open an in-memory better-sqlite3 DB, create an FTS5 table, insert + bm25-query.
```ts
import Database from "better-sqlite3";
it("better-sqlite3 has FTS5", () => {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body)");
  db.exec("INSERT INTO t(body) VALUES ('kafka streams'),('postgres rows')");
  const row = db.prepare("SELECT body, bm25(t) s FROM t WHERE t MATCH 'kafka' ORDER BY s").get() as any;
  expect(row.body).toContain("kafka");
});
```
- [ ] **Run, expect:** PASS if the local Node ABI matches; if it fails to load, that's the rebuild signal — wire `@electron/rebuild` into the dev/build flow (rebuild against Electron 42's ABI for the Electron context; keep a Node-ABI copy for vitest, or run this test via electron's node). Document the dual-ABI handling (vitest runs on system Node; the app runs Electron's Node).
- [ ] **Acceptance:** FTS5 test green on system Node. Commit: `feat(index): add better-sqlite3 + @electron/rebuild; prove FTS5`.

### Task 0b.2: add sqlite-vec, prove load + exact vector query in vitest

**Files:** `package.json`, `src/index/vectors/sqlite-vec.ts` (loader only), `test/index/native-vec.test.ts`.

- [ ] **Failing test:** load the sqlite-vec extension into a better-sqlite3 DB; create a vec table; insert 2 vectors; KNN-query nearest.
```ts
import Database from "better-sqlite3";
import { loadSqliteVec } from "../../src/index/vectors/sqlite-vec.js";
it("sqlite-vec loads and does exact KNN", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);                       // db.loadExtension(resolved .so/.dylib/.dll)
  db.exec("CREATE VIRTUAL TABLE v USING vec0(embedding float[3])");
  db.prepare("INSERT INTO v(rowid, embedding) VALUES (?, ?)").run(1, new Float32Array([1,0,0]));
  db.prepare("INSERT INTO v(rowid, embedding) VALUES (?, ?)").run(2, new Float32Array([0,1,0]));
  const hit = db.prepare("SELECT rowid FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 1").get(new Float32Array([0.9,0,0])) as any;
  expect(hit.rowid).toBe(1);
});
```
- [ ] **Implement** `loadSqliteVec(db)`: resolve the platform-correct prebuilt (`vec0.dll`/`.dylib`/`.so`), `db.loadExtension(path)`; throw a typed error if missing (Phase 5 catches → degrade to lexical).
- [ ] **Acceptance:** KNN test green. Commit: `feat(index): sqlite-vec loader + exact KNN proof`.

### Task 0b.3: the packaged "hello-index" probe entry (all-4-target spike)

**Files:** `src/index/capability-probe.ts` (throwaway), `tsdown.config.js` (add entry, `codeSplitting:false`), `electron-builder.yml` (ship the probe `.mjs` + the native `.node` + the sqlite-vec ext binaries, `asar:false`), `electron/main.ts` (fork the probe behind `MEMORY_CAP_PROBE=1`).

- [ ] **Implement** `capability-probe.ts` (runs in the utilityProcess; `if (process.parentPort)` guard): in a temp dir, step through and log each to `<tmp>/cap-probe.log`:
  1. `new Database(path)` (WAL) → `step1 sqlite-open ok`
  2. create FTS5 + bm25 query → `step2 fts5 ok`
  3. `db.close()`, reopen, read back → `step3 wal-reopen ok`
  4. `loadSqliteVec(db)` → `step4 vec-load ok`
  5. vec0 insert + KNN → `step5 vec-knn ok`
  6. signal parent "ready"; parent kills + re-forks; probe re-runs steps 1–5 on the same DB file → `step6 restart-recover ok`
  Any throw → log `stepN FAIL <err>` and exit non-zero. (Mirrors the diagnostic-swap technique: a missing native file produces a specific load error, not silence.)
- [ ] **Ship it self-contained:** assert `grep -cE 'from "\.\.?/' dist/index/capability-probe.mjs` == 0; native `.node` + ext binaries listed in electron-builder `files` and unpacked (asar:false already).
- [ ] **Run the INSTALLED app** with `MEMORY_CAP_PROBE=1` on **Win x64, Win arm64, macOS arm64, Linux x64** (CI matrix + local Windows). Collect each `cap-probe.log`.
- [ ] **Acceptance (THE GATE):** all six steps `ok` on **all four targets** — especially **Win arm64 + step4/5 (sqlite-vec)**. Record every target's log in `docs/release-evidence/phase0b-<date>.md`. If a target fails step4/5 (e.g. no win-arm64 sqlite-vec prebuilt), STOP: resolve (build the ext from source in CI, or vendor a binary) or revise the vector decision in the roadmap before Phase 3.

### Task 0b.4: guard test for native-file shipping + cleanup

**Files:** `test/build/native-packaging.test.ts`, remove/flag the probe.

- [ ] **Test (mutation-proven):** parse `electron-builder.yml` `files` + assert every native artifact the probe/app loads (`better_sqlite3.node`, the sqlite-vec ext per platform) is in the shipped set and unpacked. Invert it (drop one) → test must fail. (Extends the existing relative-import guard to native deps.)
- [ ] Gate the probe behind `MEMORY_CAP_PROBE` (don't run in normal launch) or delete it; keep `loadSqliteVec` + the better-sqlite3 dep (Phase 3 uses them).
- [ ] **Acceptance:** guard test green + mutation-verified; normal launch unaffected (packaged smoke still green). Commit: `test(build): guard native module + sqlite-vec shipping`.

---

## Acceptance (Phase 0 done = Phase 3 unblocked)

1. App ships on **Electron 42** (supported), all four installers build, existing packaged smoke green (utilityProcess server, `/api/health` real) — verified by output.
2. The capability probe passes **all six steps on all four targets**, incl. **Win arm64 + sqlite-vec** — logs banked in `docs/release-evidence/`.
3. `@electron/rebuild` is wired into the build; native-shipping guard test is green + mutation-verified.
4. No `src/index/**` feature code yet (catalog/reconciler/search are Phase 3).

## Self-review

- **Spec coverage:** 0a = supported-Electron baseline (the EOL fix); 0b = the native-load gate (the biggest risk) end-to-end in the packaged app on every target. Together they de-risk everything Phase 3+ assumes.
- **Placeholders:** none — each task has a test/probe, the contract, exact assertions, and a recorded-evidence gate.
- **Risks flagged:** dual ABI (vitest=system Node vs app=Electron Node — handled in 0b.1); win-arm64 sqlite-vec prebuilt may not exist (0b.3 stop-condition → build-from-source/vendor); electron-builder 26 breaking changes (0a.1 verify-first); Electron's no-LTS treadmill (accepted — periodic bumps).

## Execution handoff

Codex implements 0a.1 → 0b.4 in order; Claude audits each (read diff + run typecheck/tests + the packaged probe on Windows; CI covers the other targets). 0a ships as its own release per `docs/RELEASING.md`. **Hard gate: do not start Phase 3 until 0b.3 is green on Win arm64.** Next detailed plan (Phase 3) already exists in [the roadmap](2026-06-25-tier2-search-index.md#phase-3--detailed-tasks).
