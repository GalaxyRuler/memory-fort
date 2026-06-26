# Codex handoff — Phase 0.0: Win-ARM64 sqlite-vec preflight

> Self-contained task brief. Codex cannot read the conversation that produced this. Everything needed is here.

## Goal

Prove (or disprove) that `sqlite-vec` can load and run a K-nearest-neighbour query on **Windows ARM64**, using a **native `windows-11-arm` GitHub Actions runner**. This is the Phase-0 go/no-go: if neither the official npm binary nor a from-source build works on win-arm64, all further Tier-2 index work stops and the vector decision gets revised. Settle this cheaply, before any Electron migration effort.

## Background (read this — it grounds every decision below)

**MemoryFort** is a single-user Electron desktop app (`github.com/GalaxyRuler/memory-fort-private`; public mirror `github.com/GalaxyRuler/memory-fort`). The dashboard HTTP backend runs in a long-lived Electron `utilityProcess`. Today it loads the full vault (~3.5 GB) into the JS heap on every search. The fix is a derived SQLite index (FTS5 + vectors). The whole stack is **GPL-3.0-only**.

**The blocker:** `sqlite-vec` (asg017, MIT/Apache — the chosen vector extension) is **binary-only on npm**. It has **no pre-built win-arm64 binary** (see [issue #211](https://github.com/asg017/sqlite-vec/issues/211) and [issue #73](https://github.com/asg017/sqlite-vec/issues/73) which documents a `__popcnt64` intrinsic error on win-arm64). We **cannot** require end-users to have a compiler. So this preflight must determine: can we build `vec0.dll` from the C amalgamation on a GitHub-hosted `windows-11-arm` runner and ship it?

**Why `windows-11-arm` runner:** GitHub ARM64-hosted runners for public repos went GA in August 2025. The runner label is `windows-11-arm`. This is a **native** ARM64 Windows environment, not emulation — so any binary it builds and tests will actually work on a user's Windows ARM64 machine.

**Better-sqlite3:** used for FTS5. It compiles its own SQLite **with FTS5 enabled** (unlike Node's built-in `node:sqlite` which ships without FTS5 in Node 22). better-sqlite3 does have a win-arm64 prebuilt on npm, so it should install cleanly.

**sqlite-vector rejected:** `sqliteai/sqlite-vector` uses Elastic License 2.0 — incompatible with GPL-3.0-only. Not an option.

## What to build

Two files:

1. **`.github/workflows/preflight-winarm64-vec.yml`** — CI workflow
2. **`scripts/preflight-vec.mjs`** — the probe script

### File 1: `.github/workflows/preflight-winarm64-vec.yml`

```yaml
name: Preflight — Windows ARM64 sqlite-vec

on:
  workflow_dispatch:
  push:
    paths:
      - 'scripts/preflight-vec.mjs'
      - '.github/workflows/preflight-winarm64-vec.yml'

jobs:
  probe:
    name: win-arm64 sqlite-vec probe
    runs-on: windows-11-arm
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      # Try official npm binary first (expected to fail — no win-arm64 prebuilt)
      - name: Install better-sqlite3 + sqlite-vec
        run: npm install --no-save better-sqlite3 sqlite-vec
        continue-on-error: true
        id: npm_install

      # Run the probe (it handles the "no prebuilt" case internally)
      - name: Run win-arm64 preflight probe
        run: node scripts/preflight-vec.mjs
        env:
          PROBE_RESULT_DIR: docs/release-evidence

      # Upload the evidence file as an artifact
      - name: Upload evidence
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: phase0.0-winarm64-evidence
          path: docs/release-evidence/phase0.0-winarm64-*.md
```

### File 2: `scripts/preflight-vec.mjs`

The probe must:

1. Log `process.platform`, `process.arch`, `process.versions.node`.
2. Open an in-memory better-sqlite3 database.
3. Run `CREATE VIRTUAL TABLE t USING fts5(body)` and insert + query a row → confirm FTS5 works on win-arm64 via better-sqlite3.
4. **Try to load the official sqlite-vec binary** via `sqliteVec.load(db)` (from the `sqlite-vec` npm package). This is expected to fail with a "no prebuilt" error on win-arm64.
5. **If step 4 fails:** build `vec0.dll` from source:
   - Download (or use the file in `node_modules/sqlite-vec/sqlite-vec.c` if it's there; otherwise fetch from `https://github.com/asg017/sqlite-vec/releases/latest` — look for the `sqlite-vec-v*.c` amalgamation file).
   - Compile with `cl.exe` (MSVC, available on the runner) or `clang-cl`: `cl /LD /O2 /DSQLITE_CORE sqlite-vec.c /Fe:vec0.dll` (shared lib). If `cl` is not available, try `clang-cl` or `gcc -shared`.
   - **`__popcnt64` note (issue #73):** if the MSVC compile fails with `__popcnt64` unresolved, add `/arch:AVX2` or compile with `/D__popcnt64=__popcnt64` and link against `intrin.h`. On ARM64 Windows the intrinsic should be available via `<intrin.h>`; if not, stub it as a pure-C popcount.
   - `db.loadExtension('./vec0.dll')`.
6. Whichever path loaded sqlite-vec:
   - `CREATE VIRTUAL TABLE v USING vec0(embedding float[3])`.
   - Insert two vectors: `[1.0, 0.0, 0.0]` (rowid 1) and `[0.0, 1.0, 0.0]` (rowid 2).
   - KNN query: `SELECT rowid FROM v WHERE embedding MATCH '[1.0, 0.1, 0.0]' LIMIT 1`.
   - Assert returned rowid === 1.
7. Write a result file to `docs/release-evidence/phase0.0-winarm64-<YYYYMMDD>.md` with:
   - Platform/arch/node version
   - FTS5 result (pass/fail)
   - sqlite-vec load path: `official-binary` | `from-source-msvc` | `from-source-clang` | `FAILED`
   - Binary provenance (path, size, sha256 of vec0.dll or the official .node file)
   - KNN assertion result (pass/fail)
   - Any error messages
8. Exit 0 if both FTS5 and KNN passed; exit 1 otherwise.

**Important:** The script must handle the case where the `sqlite-vec` npm package installs but has no prebuilt binary gracefully — catch the load error, log it, then proceed to from-source build. Don't let an unhandled throw skip the from-source path.

## Acceptance criteria (the go/no-go)

- **GO:** Step outputs a `phase0.0-winarm64-*.md` showing FTS5 `pass` and KNN `pass` via either `official-binary` or `from-source-*`. The CI job exits 0.
- **NO-GO:** Both paths fail (no prebuilt AND from-source compile/load fails). CI exits 1. In this case: stop, do not proceed to Phase 0a (the Electron upgrade), and report the exact error so the vector decision can be revised.

## What NOT to do

- Do NOT modify any existing app code (`electron/`, `src/`, `dashboard/`, etc.).
- Do NOT add `better-sqlite3` or `sqlite-vec` to `package.json` as production deps — this is a standalone preflight only.
- Do NOT require a compiler on the end-user machine — the probe runs in CI only; any built binary would be **vendored** for the installer builds (that's a Phase 0b concern).
- Do NOT use a different vector extension. sqlite-vec is the chosen one.
- Do NOT create a `node_modules/` commit. The `npm install --no-save` in the workflow is ephemeral.

## Evidence file format (example)

```markdown
# Phase 0.0 — Win-ARM64 sqlite-vec preflight evidence

Date: 2026-07-01
Runner: windows-11-arm (GitHub-hosted)
Node: 22.x.x
Platform: win32 / arm64

## FTS5 (better-sqlite3)
Result: PASS
Query: SELECT snippet(t, 0, '<b>', '</b>', '...', 10) FROM t WHERE t MATCH 'hello'
Returned: 'say hello world'

## sqlite-vec official binary
Attempt: FAILED
Error: "no prebuilt for win32-arm64" (or similar)

## sqlite-vec from-source (MSVC)
Compiler: cl.exe 19.x.x
Source: node_modules/sqlite-vec/sqlite-vec.c (v0.1.x)
Output: vec0.dll (size: 312 KB, sha256: abc123...)
Load: SUCCESS

## KNN assertion
Query: SELECT rowid FROM v WHERE embedding MATCH '[1.0, 0.1, 0.0]' LIMIT 1
Expected rowid: 1
Returned rowid: 1
Result: PASS

## Verdict: GO
```

## After CI runs — Claude's audit steps

1. Read the uploaded evidence artifact.
2. Verify the sha256 of vec0.dll is recorded (proves binary provenance).
3. Check: did the official npm binary actually fail? If it somehow passed (sqlite-vec shipped a win-arm64 prebuilt since this was written), that's good — note it in the rounds log.
4. If GO: update `docs/superpowers/plans/2026-06-25-tier2-phase0-electron-native.md` Phase 0.0 acceptance box; unblock Phase 0a.
5. If NO-GO: report exact error; don't start Phase 0a; revisit the vector decision.

## References

- Plan: `docs/superpowers/plans/2026-06-25-tier2-phase0-electron-native.md`
- Roadmap: `docs/superpowers/plans/2026-06-25-tier2-search-index.md`
- ADR: `docs/adr/0001-tier2-search-index.md`
- sqlite-vec repo: https://github.com/asg017/sqlite-vec
- Issue #211 (no win-arm64 prebuilt): https://github.com/asg017/sqlite-vec/issues/211
- Issue #73 (`__popcnt64` win-arm64): https://github.com/asg017/sqlite-vec/issues/73
- GitHub ARM64 runners GA: https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/
