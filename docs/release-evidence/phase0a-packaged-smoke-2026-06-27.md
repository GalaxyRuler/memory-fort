# Phase 0a — packaged smoke (Task 0a.3) — Windows x64

**Date:** 2026-06-27 · **Release:** v0.10.15 · **Build:** CI run 28275398715 (all 3 jobs green).

## Toolchain (verified at runtime, not just installed)

Captured from `<vault>/logs/dashboard-service.log` `[memory-fort runtime]` entry on the **installed** app:

```json
{
  "main":  { "electron": "42.5.0", "node": "24.17.0", "modules": "146",
             "platform": "win32", "arch": "x64",
             "appPath": "…\\MemoryFort\\resources\\app",
             "servicePath": "…\\app\\dist\\dashboard\\dashboard-service.mjs",
             "parentPid": 22404, "utilityChildPid": null },
  "child": { "electron": "42.5.0", "node": "24.17.0", "modules": "146",
             "platform": "win32", "arch": "x64",
             "childPid": 19332, "parentPid": 22404,
             "serviceEntryPath": "…\\app\\dist\\dashboard\\dashboard-service.mjs",
             "parentPortPresent": true }
}
```

**Why this is the real gate, not "health ok":** `modules: 146` is Electron 42's Node ABI — the child
process is running under Electron's runtime, not system Node. `parentPortPresent: true` proves it is a
genuine `utilityProcess` fork (has `process.parentPort`). `childPid 19332` is exactly the process that
owns `:4410`. The 35→42 upgrade did not change the fork+supervisor architecture.

## Packaged smoke results — ALL GREEN

| Check | Result |
| --- | --- |
| Installer hash (sha512, base64) vs `latest.yml` | **match** (`7ySp7Ty…83Zuw==`), size 278656881 |
| Silent install `/S` (per-user NSIS, no UAC) | exit 0 |
| `MemoryFort.exe` ProductVersion | **0.10.15.0** |
| Uninstall-registry `DisplayVersion` | **0.10.15** |
| App launches (process count) | 5 Electron processes |
| `:4410` owner is `--type=utility` | **yes** (PID 19332) |
| `:4410` owner's parent is main (no `--type=`) | **yes** (PID 22404, `MemoryFort.exe`) |
| `GET /api/health` | **HTTP 200**, real report (warn = no cached verify yet — benign) |
| Runtime-env log present + complete | **yes** (table above) |

## Publish decision (deviation from the plan, called out)

The Phase 0 plan marks 0a as an **internal RC** — "do not publish to users; one combined public release
after 0b." This release **was** published as `latest` under the plan's own carve-out:

> *Exception: a security-driven Electron-only ship, called out explicitly.*

Electron 35 is **EOL since 2025-09-02** (no security patches). Shipping 42.5.0 (supported through
2026-10-20) is exactly that security ship. 0b (native-capability bootstrap + sqlite-vec in the installed
app) still gates Phase 3; this publish does not change that.

## CI fixes required for the release (recorded for next time)

1. **`npm ci` → `npm install`** in `release.yml`. A Windows-generated `package-lock.json` prunes
   electron-builder's cross-platform optional deps (Linux/macOS-only packages), so `npm ci` fails on
   those runners with `EUSAGE … Missing: …@26.15.x from lock file`. `npm install` resolves per-platform
   deps on each runner. (Simpler than the prior "regenerate lockfile in a Linux node:20 container"
   workaround.)
2. **Dropped `npx electron --version`** from the toolchain-verify step. The Electron binary aborts on
   Linux GitHub runners (`SUID sandbox helper … not configured … chrome-sandbox … mode 4755`). The three
   `package.json` version `test`s already prove the exact installed versions; the binary launch was
   redundant and platform-fragile.
