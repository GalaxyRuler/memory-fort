# Contributing to memory-fort

Thank you for your interest in contributing. This guide covers everything you need to get started.

---

## Ways to contribute

- **Bug reports** — Open an issue with a minimal reproduction, expected vs. actual behavior, and your Node/OS version.
- **Feature requests** — Open an issue describing the use case first. PRs without a linked issue or prior discussion may be closed.
- **New tool integrations** — Implement a new install/uninstall pair (see below). Uses the hook-injection pattern (sentinel blocks) or JSON-patch for structured config files. MCP-backed tools should wire up the appropriate MCP server prefix.
- **Documentation** — Fix typos, improve examples, extend the README's Supported Tools table.

---

## Dev setup

**Prerequisites**

- Node.js >= 20
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) — must be on `PATH`; used by the search stack at runtime

**Steps**

```sh
git clone https://github.com/GalaxyRuler/memory-fort.git
cd memory-fort
npm ci
npm run build
npm run install:dev-hooks   # installs the pre-push scan-leaks gate
```

The `install:dev-hooks` step sets up a pre-push hook that runs `npm run scan:leaks` before every push. It will block pushes that introduce secrets or PII patterns.

---

## Project structure

```
src/
  cli/
    commands/           # Top-level CLI commands (install, uninstall, status, …)
    commands/install/   # Per-tool install/uninstall implementations
  sniffers/             # Backfill sniffers — scan existing vaults/configs
  retrieval/            # Search stack (ripgrep wrappers, ranking, MCP queries)
  dashboard-ui/         # React SPA served by the local dashboard server
templates/              # Vault scaffolding — copied on first init
test/                   # Mirrors src/ structure
```

---

## Adding a new tool integration

### 1. Implement the installer

Create `src/cli/commands/install/<tool>.ts`. It must export:

```ts
export async function install(opts: InstallOptions): Promise<void> { … }
export async function uninstall(opts: InstallOptions): Promise<void> { … }
```

- **Hook-injection pattern** (shell/git configs) — wrap injected content in sentinel blocks:
  ```
  # >>> memory-fort:<tool> >>>
  …
  # <<< memory-fort:<tool> <<<
  ```
  `uninstall` removes the block. `install` replaces it if already present rather than appending.

- **JSON-patch pattern** (structured config files like `settings.json`) — read → mutate → write. `uninstall` removes only the keys your installer added. Never clobber unrelated keys.

### 2. Register the command

Add your installer to the dispatch map in `src/cli/commands/install.ts`:

```ts
import * as myTool from './install/my-tool.js';
// …
case 'my-tool': return myTool.install(opts);
```

Add the matching `uninstall` case to `src/cli/commands/uninstall.ts` (or the shared dispatch if the file combines both).

### 3. Write tests

Add `test/cli/commands/install-<tool>.test.ts`. Tests must:

- Cover the happy path (fresh install, idempotent re-install).
- Cover `uninstall` — verify the sentinel block or JSON keys are fully removed.
- Not touch real user home directories; use `tmp` fixtures.

### 4. Update the README

Add a row to the **Supported tools** table in `README.md`:

| Tool | Config target | Pattern |
|------|---------------|---------|
| my-tool | `~/.my-tool/config` | sentinel block |

---

## Running tests

```sh
npm test              # run all tests
npm run typecheck     # tsc --noEmit
npm run scan:leaks    # check for secrets/PII patterns in staged output
```

All three must pass before a PR is merge-ready. The pre-push hook enforces `scan:leaks` automatically.

---

## Submitting a PR

1. Branch off `main`: `git checkout -b feat/my-tool`.
2. One feature or fix per PR — keep diffs reviewable.
3. All gates must pass locally: `npm run typecheck && npm run build && npm run scan:leaks && npm test`.
4. PR description must explain:
   - What the change does.
   - Why it is useful (the concrete use case).
   - Any config files or user home directories that the new code touches.
5. Link to the issue that motivated the change (if one exists).

PRs that break the typecheck, build, scan:leaks, or test gates will not be reviewed until they are green.

---

## License

By contributing you agree that your contributions will be released under the same [GNU General Public License v3.0](LICENSE) (`GPL-3.0-only`) that covers the rest of the project.

If you are contributing on behalf of a company, make sure you are authorized to contribute GPLv3-licensed code before opening a PR.
