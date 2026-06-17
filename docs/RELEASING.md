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
- Bump `package.json`. Features → minor; fixes/docs → patch.

## 4. Privacy gate
- `npm run scan:leaks` — must pass. Scrub any local paths / secrets it flags (including in test fixtures) before pushing.

## 5. Build (REQUIRED — do not skip)
- `npm run build`. The dashboard bakes its version and UI assets at **build time** (Vite `__APP_VERSION__`); skipping the build leaves the dashboard showing the old version.

## 6. Publish
- Commit, then push to the public remote as a fast-forward (`git merge-base --is-ancestor public/main main` should be true).
- Maintainers with a private mirror: keep versions aligned and push the mirror too.

## 7. Restart + verify
- Restart the dashboard (stop the `:4410` listener, relaunch `memory dashboard`); hard-refresh the browser (Ctrl+Shift+R) to drop the cached bundle.
- `memory verify` — confirm no new failures.

## One-time VPS git durability
- For existing VPS bare repositories, run:
  `ssh <vps> 'git -C <bare-repo-path> config core.fsync committed && git -C <bare-repo-path> config receive.fsckObjects true'`
- This should move into a future bootstrap command instead of staying a manual release step.

## Rule of thumb
If you bumped behavior, you bumped the README and the CHANGELOG in the same commit. If you bumped the version, you rebuilt and restarted the dashboard.
