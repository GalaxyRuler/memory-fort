# Codex handoff — Phase 0b.3c: WAL durability (ungraceful restart-recovery + concurrent WAL)

> Self-contained task brief. Codex cannot read the conversation that produced this. **Builds directly on the merged 0b.3a+0b.3b (main `99a4ffd`+, commit also tagged in plan).** This is the **last 0b.3 sub-task**. After it, 0b.4 (formal runtime-path guard test) and then Phase 0 is done → one combined public release. **Do not bump version / release.**

> **⚠️ CI billing note:** GitHub Actions were spending-limit-blocked at handoff time (new runs fail in ~3s, no runner). The full 0b.3c proof needs the 4-target **installed** CI lane (`.github/workflows/installed-native-probe.yml`) to run. Implement + locally verify on Windows-x64 now; the 4-target CI gate must be green before Claude marks 0b.3c done — so this can't fully close until Actions are live again. Say clearly in your report which evidence is local vs CI.

## Goal

Extend the installed-app capability probe with the two WAL-durability proofs deferred from 0b.3b, on all four installed targets:
- **Step 7 — ungraceful restart-recovery:** prove a SQLite WAL DB written by the utilityProcess survives a **forced (crash-style) kill** of that process and is correctly recovered on reopen.
- **Step 8 — concurrent WAL:** prove a writer and a reader connection coexist on the same WAL DB in the packaged runtime without corruption or lock errors.

## Background (what 0b.3b already shipped — your base)

Merged `src/index/native/capability-probe.ts` runs inside the **real dashboard-service utilityProcess** (forked via `dashboard-service-supervisor`'s exact path/options from `electron/main.ts`'s `MEMORY_CAP_PROBE=1` branch). It already does steps 1–6: runtime/path log, WAL-open + sha256 of both binaries + `sqlite_version()`/`compile_options`, FTS5, `loadSqliteVec`, vec0 KNN, and a **runtime-path guard** (rejects dev/`defaultApp`, unpacked trees, binaries outside the installed app, arch mismatch). It uses `openCapabilityDb`/`assertFts5`/`loadSqliteVec`/`assertVec0Knn` from `capability.ts`, logs to `<probeDir>/cap-probe.log` + `parentPort`, and exits 0 only if all steps pass. The probe currently `mkdtemp`s a **fresh** dir each run (space+Unicode name) — **0b.3c needs a STABLE DB path across forks** (see below).

The installed CI lane `.github/workflows/installed-native-probe.yml` installs the real artifact per target (NSIS `/S /D=<spaced path>`, DMG mount+copy+quarantine, AppImage/xvfb) and greps the log for the step needles. You will extend both the probe and these per-target assertions.

**Verified fact (primary source):** Electron `utilityProcess.kill()` is **SIGTERM/graceful** — a child that closes SQLite cleanly would MASK crash recovery. Step 7 MUST use a **forced** kill: `process.kill(child.pid, "SIGKILL")` on POSIX; on Windows `process.kill(child.pid)` (forceful) or `taskkill /F /PID`. Do NOT use the supervisor's graceful `kill()` for the crash.

## What to build

### Step 7 — ungraceful restart-recovery (parent-orchestrated)
The crash + reopen spans two forks of the probe child against the **same DB file**, so the parent (`electron/main.ts`) orchestrates it and the DB path must be **stable** (passed in, not `mkdtemp`'d fresh each fork).

- **Stable DB dir:** the parent picks one durable probe dir (still space+Unicode, e.g. under `app.getPath("temp")`) and passes it to both forks via env (e.g. `MEMORY_CAP_PROBE_DB_DIR`) or the supervisor init payload. Both forks open `<dir>/capability.sqlite` (WAL).
- **Probe gains a mode** (env or init field), e.g. `MEMORY_CAP_PROBE_PHASE = "write-hold" | "reopen-verify" | "full"`:
  - **write-hold:** open WAL at the stable path, insert known FTS5 rows + vec0 vectors inside a committed transaction, **force a WAL state that is NOT checkpointed** (e.g. `pragma wal_checkpoint` must NOT run; optionally `pragma wal_autocheckpoint=0` so the data lives only in the `-wal` file), `fsync`/confirm the commit, post `wrote-uncheckpointed ok`, then **hold** (keep the connection open, do not close — a clean close could checkpoint).
  - parent **force-kills** the child (SIGKILL/forced) while it holds — simulating a crash with un-checkpointed WAL frames. Assert the `-wal` file exists + is non-empty before/at kill.
  - **reopen-verify:** parent re-forks; child opens the SAME `<dir>/capability.sqlite`, lets SQLite run WAL recovery on open, **reads back** the rows written pre-crash (assert they're all present + correct), then re-runs `loadSqliteVec` + `assertVec0Knn` → post `step7 restart-recover ok`.
- Parent drives: fork(write-hold) → await `wrote-uncheckpointed ok` → forced-kill → fork(reopen-verify) → await `step7 restart-recover ok`. Any deviation → fail, non-zero exit. Log each transition to the cap-probe log + parentPort.

### Step 8 — concurrent WAL (single fork, two connections)
- In one probe run (the `reopen-verify`/`full` phase is fine), open **two** better-sqlite3 connections to the same WAL file: a **writer** and a **reader**.
- Begin a write transaction on the writer (insert rows); from the reader, read the last committed snapshot **during** the open write txn (WAL readers see the last commit, not the in-flight txn) and **after** commit; assert: reader never errors with `SQLITE_BUSY`/locked, reads the correct committed data each time, no corruption. Keep it small — this proves file-locking + WAL reader/writer coexistence in the packaged runtime, NOT index throughput.
- Post `step8 concurrent-wal ok`.

### Wire-up
- `electron/main.ts`: extend `runInstalledCapabilityProbe` to orchestrate the two-fork step-7 sequence + the forced kill; keep the normal (no-`MEMORY_CAP_PROBE`) launch path untouched.
- `capability-probe.ts`: add the phase handling + steps 7/8, reusing `capability.ts` helpers. Stay self-contained (`grep` relative-runtime-imports == 0).
- `.github/workflows/installed-native-probe.yml`: extend each of the four per-target assertion blocks to also require `step7 restart-recover ok` and `step8 concurrent-wal ok`.
- **Advisory (NOT a gate):** optionally a ~30 MB DB reopen/checkpoint as evidence only — must never fail the gate.

## Tests / verification before handing back
- `npx tsc --noEmit` + `npx tsc -p tsconfig.ui.json --noEmit` — both 0.
- `npm run build` — green; `capability-probe.mjs` + `electron-main.mjs` self-contained (0 relative runtime imports).
- **Local Windows-x64:** package (`electron-builder --win dir --x64` is enough; or a real NSIS install), run the installed/packaged app with `MEMORY_CAP_PROBE=1`, confirm `step7 restart-recover ok` + `step8 concurrent-wal ok` (plus the existing steps 1–6), exit 0. Confirm the forced kill actually terminated the child (not a graceful close).
- Do NOT run the full vitest suite on the local box (`server.test.ts` is a known CPU-load flake) — targeted files only.
- The 4-target installed CI gate is required for done but is **billing-blocked** — note status; don't fake it.

## Acceptance criteria
- Steps 7 + 8 implemented in the probe, parent-orchestrated forced kill (NOT graceful `utilityProcess.kill()`), stable DB path across forks.
- Local Windows-x64: steps 1–8 `ok`, exit 0; forced-kill verified.
- 4-target installed CI gate (win-arm64/win-x64/macOS-arm64/linux-x64) asserts `step7`+`step8 ok` — green once Actions are live (NO-GO if any target skipped).
- Both typechecks + build green; normal launch unaffected.
- Commit: `feat(index): WAL crash-recovery + concurrent-WAL probe steps`.

## What NOT to do
- No graceful `utilityProcess.kill()` for the crash — forced kill only.
- No fresh `mkdtemp` between the two step-7 forks — the DB path must be stable so recovery is real.
- No `src/index/**` feature code; no version bump/release; keep the 0b.1/0b.2 `MEMORY_CAP_TEST` gate + 0b.3b steps intact.
- Don't make the ~30 MB scale test a hard gate; don't accept "unpacked artifact" as the CI gate (real installed artifacts only); don't revert `npm install`→`npm ci`.
- Don't push a branch that re-triggers paid Actions runs without need while billing is constrained — coordinate (the temp-ref CI churn in 0b.3 was noisy); prefer one clean CI run when Actions are restored.

## After Codex hands back — Claude's audit
1. Diff review: forced kill (not graceful) confirmed; stable DB path; steps reuse the bootstrap; no feature code; bundles self-contained.
2. Local win-x64: reproduce steps 1–8 ok in the packaged app; **mutation-prove step 7** (e.g. skip the reopen / corrupt-free baseline: confirm that if the pre-crash write is checkpointed-and-cleanly-closed the test still distinguishes real recovery — i.e. the forced kill path is what's exercised), and confirm step 8 reader actually reads concurrent committed data (not a no-op).
3. CI (when Actions restored): steps 7+8 `ok` on all four installed targets, esp. win-arm64 + macOS arm64. Read each log.
4. On green: tick 0b.3c + 0b.3 complete in the plan; hand off **0b.4** (formal `test/build/native-packaging.test.ts` runtime-path guard, mutation-proven — much already proven by 0b.3b's guard) → then Phase 0 done → combined public release per `docs/RELEASING.md`.

## References (repo-root-relative)
- Plan: `docs/superpowers/plans/2026-06-25-tier2-phase0-electron-native.md` (Phase 0b.3c)
- Base: `src/index/native/capability-probe.ts`, `electron/main.ts` (`runInstalledCapabilityProbe`), `src/dashboard/dashboard-service-supervisor.ts`, `.github/workflows/installed-native-probe.yml` (all merged at `99a4ffd`)
- Bootstrap helpers: `src/index/native/capability.ts`
- Electron utilityProcess (`kill()` = graceful SIGTERM): https://www.electronjs.org/docs/latest/api/utility-process · SQLite WAL: https://sqlite.org/wal.html
