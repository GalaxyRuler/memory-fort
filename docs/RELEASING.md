# Releasing Memory Fort

Run this checklist for **any** change that ships publicly — feature, fix, upgrade, or docs. Docs ship **with** the change, in the same release: a feature without README + CHANGELOG updates is not done.

## 1. Verify
- `npm run typecheck` — zero errors

## 2. Update docs FOR THE CHANGE (do not skip)
- **README.md** — document new features, CLI flags, config knobs, and usage. Add any new wiki types, graph edge types, or `config.yaml` keys to their tables.
- **CHANGELOG.md** — add a versioned entry under a new `## [X.Y.Z] - YYYY-MM-DD` heading (Added / Changed / Fixed).
- **docs/** — update affected references (e.g. `docs/cli.md`) for new commands/flags.

## 3. Version (SemVer)
- Bump with `npm version patch|minor|major` (features → minor; fixes/docs → patch). It updates `package.json` **and** `package-lock.json` and creates the `vX.Y.Z` git tag in one atomic step. Do **not** hand-edit the version — a package.json/lockfile mismatch breaks CI `npm ci`.
- **One unified version** across the public repo and the private mirror — **no `-private` suffix**. (`-private` is a SemVer pre-release identifier that ranks the build *below* the public release, e.g. `0.9.1-private` < `0.9.1`.) If a private build must be marked, use build metadata `X.Y.Z+private` (ignored for precedence), but prefer not to.

## 4. Build + generated UI verification (REQUIRED — do not skip)
- `npm run build`. The dashboard bakes its version and UI assets at **build time** (Vite `__APP_VERSION__`); skipping the build leaves the dashboard showing the old version.
- `npm run typecheck:ui` — zero errors. Run it immediately after the build so it checks the freshly generated `src/dashboard-ui/routeTree.gen.ts`.
- `npm test` (or at least the affected suites) — green. Run tests after the build because dashboard route tests can consume the generated route tree.

## 5. Privacy gate
- `npm run scan:leaks` — must pass after the build so it inspects the freshly generated `dist`. Scrub any local paths / secrets it flags (including in test fixtures) before pushing.

## 6. Publish
- Commit, then push to the public remote as a fast-forward (`git merge-base --is-ancestor public/main main` should be true).
- Push the same commit + tag to the private mirror. Versions are now identical (no `-private`), so the mirror is a true fast-forward with no version conflict.

## 7. Desktop installers (when shipping the app)
- Pushing the `vX.Y.Z` tag to the **public** repo triggers `.github/workflows/release.yml`: a Windows/macOS/Linux build matrix produces installers, scans every expected unpacked runtime payload, validates the complete artifact set, then creates, uploads, and publishes the GitHub Release automatically. A packaging or validation failure creates no public release; an upload failure leaves its draft non-public for inspection.
- Build matrix (fixed in `electron-builder.yml`): **Windows** NSIS `x64 + arm64`, **macOS** DMG `arm64` only (no Intel), **Linux** AppImage. See [memoryfort-build-targets].
- The Windows NSIS output is one multi-architecture installer even though the release scan requires two unpacked app payloads. Do not replace the expected-root check with an installer-file count.
- The privacy gate scans `resources/app` (or the extracted AppImage equivalent): that is the runtime tree the installer lays down. The raw installer and its zipped copy are hash-bound in the platform artifact manifest before publication; the binary containers themselves are not decoded by the leak scanner.
- **Lockfile gotcha:** after any `electron-builder` dependency change, validate the lockfile on both Windows and Linux Node 22 with `ONNXRUNTIME_NODE_INSTALL=skip`. npm can reconcile platform-specific optional dependencies differently on each OS, so current CI and release workflows intentionally use `npm install`; inspect and commit only intentional lockfile changes.
- The `electron` job in `.github/workflows/smoke.yml` launches the real shell headlessly, but it is not an installed-artifact smoke. Run the manual `.github/workflows/installed-native-probe.yml` before calling an installer release complete.

### Host-Node recovery after local packaging

`npm run electron:build` runs `electron-rebuild`, which retargets native modules such as
`better-sqlite3` to Electron's ABI. If host-Node Vitest needs to run after packaging, use
an **isolated worktree** and run `npm rebuild better-sqlite3` there before the focused host
tests. This repairs only ignored `node_modules` for host validation; it is not a substitute
for validating the packaged artifact and must not be used to alter a release payload.

## 8. Upgrade the local install (REQUIRED — a release is not done until the installed binary is current)
- Publishing the installer to the GitHub Release is **not enough**. The `memory` CLI is `npm link`'d to the repo, so it tracks the rebuilt `dist` automatically and is already current — but the installed desktop app (`%LOCALAPPDATA%\Programs\MemoryFort\MemoryFort.exe`) is a **separate artifact** that nothing in the build/publish steps touches. Leaving it stale means "released" while the running app is the old version.
- Steps: download `MemoryFort-Setup-X.Y.Z.exe` from the release, verify its sha512 against the release `latest.yml`, stop any running `MemoryFort.exe`, run it silently (`/S` — NSIS is `oneClick:false` assisted but per-user, so no UAC), then confirm **both** the uninstall-registry `DisplayVersion` **and** the exe `ProductVersion` read `X.Y.Z`.
- A release ends only when the npm path (CLI/`dist`) **and** the installed binary report the same new version.

## 9. Restart + verify
- Restart the dashboard (stop the `:4410` listener, relaunch `memory dashboard`); hard-refresh the browser (Ctrl+Shift+R) to drop the cached bundle.
- `memory verify` — confirm no new failures.

## One-time VPS git durability
- For existing VPS bare repositories, run:
  `ssh <vps> 'git -C <bare-repo-path> config core.fsync committed && git -C <bare-repo-path> config receive.fsckObjects true'`
- This should move into a future bootstrap command instead of staying a manual release step.

## Rule of thumb
If you bumped behavior, you bumped the README and the CHANGELOG in the same commit. If you bumped the version, you rebuilt and restarted the dashboard. A release is not shipped until **both** the npm path (CLI/`dist`) **and** the installed binary report the new version — publishing the GitHub installer is not the same as upgrading the machine.
