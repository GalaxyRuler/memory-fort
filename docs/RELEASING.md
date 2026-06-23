# Releasing Memory Fort

Run this checklist for **any** change that ships publicly — feature, fix, upgrade, or docs. Docs ship **with** the change, in the same release: a feature without README + CHANGELOG updates is not done.

## 1. Verify
- `npx tsc --noEmit` — zero errors
- `npm test` (or at least the affected suites) — green

## 2. Update docs FOR THE CHANGE (do not skip)
- **README.md** — document new features, CLI flags, config knobs, and usage. Add any new wiki types, graph edge types, or `config.yaml` keys to their tables.
- **CHANGELOG.md** — add a versioned entry under a new `## [X.Y.Z] - YYYY-MM-DD` heading (Added / Changed / Fixed).
- **docs/** — update affected references (e.g. `docs/cli.md`) for new commands/flags.

## 3. Version (SemVer)
- Bump with `npm version patch|minor|major` (features → minor; fixes/docs → patch). It updates `package.json` **and** `package-lock.json` and creates the `vX.Y.Z` git tag in one atomic step. Do **not** hand-edit the version — a package.json/lockfile mismatch breaks CI `npm ci`.
- **One unified version** across the public repo and the private mirror — **no `-private` suffix**. (`-private` is a SemVer pre-release identifier that ranks the build *below* the public release, e.g. `0.9.1-private` < `0.9.1`.) If a private build must be marked, use build metadata `X.Y.Z+private` (ignored for precedence), but prefer not to.

## 4. Privacy gate
- `npm run scan:leaks` — must pass. Scrub any local paths / secrets it flags (including in test fixtures) before pushing.

## 5. Build (REQUIRED — do not skip)
- `npm run build`. The dashboard bakes its version and UI assets at **build time** (Vite `__APP_VERSION__`); skipping the build leaves the dashboard showing the old version.

## 6. Publish
- Commit, then push to the public remote as a fast-forward (`git merge-base --is-ancestor public/main main` should be true).
- Push the same commit + tag to the private mirror. Versions are now identical (no `-private`), so the mirror is a true fast-forward with no version conflict.

## 7. Desktop installers (when shipping the app)
- Pushing the `vX.Y.Z` tag to the **public** repo triggers `.github/workflows/release.yml`: a Windows/macOS/Linux build matrix produces installers and uploads them to a **draft** GitHub Release.
- Build matrix (fixed in `electron-builder.yml`): **Windows** NSIS `x64 + arm64`, **macOS** DMG `arm64` only (no Intel), **Linux** AppImage. See [memoryfort-build-targets].
- Publish the draft once builds are green: `gh release edit vX.Y.Z --repo GalaxyRuler/memory-fort --draft=false --latest`.
- **Lockfile gotcha:** after any `electron-builder` dependency change, regenerate `package-lock.json` inside a Linux `node:20` Docker container — Windows `npm install` prunes electron-builder's optional deps from the lock and CI `npm ci` then fails.
- Verify the desktop app on all three OSes via the `electron` job in `.github/workflows/smoke.yml` (launches the real Electron shell headless and asserts the dashboard serves).

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
