# Phase 0a Native Packaging Design

Date: 2026-06-26

Scope: Electron 42 baseline packaging design only. Phase 0a does not add the
Tier-2 native runtime dependencies or `src/index/**` feature code; Phase 0b
adds the bootstrap that actually imports and loads these artifacts.

## Verify-First Notes

- Electron `42.5.0` is the pinned Electron baseline for Phase 0a. The local
  npm package metadata reports `electron@42.5.0`, and the release workflow
  verifies the installed package plus `npx electron --version`.
- Electron 42's npm package requires Node `>=22.12.0`; the release workflow
  already uses Node 24, and local validation ran on Node 24.18.0.
- electron-builder `26.15.5` is the pinned builder baseline. The local npm
  package metadata reports `electron-builder@26.15.5`, and the release
  workflow verifies the installed package plus `npx electron-builder --version`.
- The current electron-builder 26 package still supports the configured NSIS,
  DMG, and AppImage target shapes and the `files`/`asar:false` options this app
  uses. A local config smoke ran `npx electron-builder --dir --win --x64
  --publish never` and produced `dist/electron-installer/win-unpacked/MemoryFort.exe`
  under Electron `42.5.0`. No Phase 0a config migration was required beyond the
  native path design below. electron-builder v27 remains out of scope.
- `@electron/rebuild@4.0.4` is pinned as the Electron-ABI rebuild tool. The
  release workflow runs `npm run electron:rebuild` after `npm ci` and before
  packaging. It is a no-op until Phase 0b adds native runtime dependencies.
- Electron 36-42 API review for this repo's current Electron surface found no
  required changes for `app.requestSingleInstanceLock`, `BrowserWindow`,
  `webContents.setWindowOpenHandler`, `shell.openExternal`, or
  `utilityProcess.fork(servicePath)`. Electron 37 changed utility-process
  behavior around child-process fatal exceptions, so Phase 0a adds explicit
  parent/child runtime logging to keep packaged smoke evidence concrete.

## Runtime Path Map

The app keeps `asar:false`, so `app.getAppPath()` points at the unpacked app
root. Native artifacts must stay under that root, not in `extraResources`, so
the utility process can resolve Node packages normally and the Phase 0b
bootstrap can also check explicit paths relative to `app.getAppPath()`.

| Platform | App root | better-sqlite3 native path | sqlite-vec native path |
| --- | --- | --- | --- |
| Windows x64 | `resources/app` | `resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node` | `resources/app/node_modules/sqlite-vec-windows-x64/vec0.dll` |
| Windows arm64 | `resources/app` | `resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node` | `resources/app/node_modules/sqlite-vec-windows-arm64/vec0.dll` once the Phase 0.0 vcvarsall-built binary is vendored |
| macOS arm64 | `Contents/Resources/app` | `Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node` | `Contents/Resources/app/node_modules/sqlite-vec-darwin-arm64/vec0.dylib` |
| Linux x64 | `resources/app` | `resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node` | `resources/app/node_modules/sqlite-vec-linux-x64/vec0.so` |

## Build Design

- `tsdown.config.js` marks `better-sqlite3`, `bindings`,
  `file-uri-to-path`, `sqlite-vec`, and `sqlite-vec-*` as external. The native
  packages must not be bundled or rewritten, because `better-sqlite3` resolves
  `better_sqlite3.node` through runtime package-relative paths.
- `electron-builder.yml` copies the future native package directories under
  `node_modules/` in the app root. Keeping them in `files` instead of
  `extraResources` preserves the `app.getAppPath()`-relative path contract.
- `@electron/rebuild` runs in CI before packaging so native `.node` modules are
  rebuilt against Electron's Node ABI rather than system Node's ABI.
- `sqlite-vec` npm packages currently cover Windows x64, macOS arm64/x64, and
  Linux x64/arm64. Phase 0.0 proved the Windows arm64 fallback: build
  `vec0.dll` from the sqlite-vec amalgamation with `vcvarsall + cl.exe` on a
  native `windows-11-arm` runner, then package it at the Windows arm64 path
  above.
