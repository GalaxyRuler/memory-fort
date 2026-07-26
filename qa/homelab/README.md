# Homelab QA

Project-owned Homelab runner profiles for container, CLI, API, unit, integration, and
headless checks live here. Do not put project-specific profile details in Homelab core.

## broad-validation profile

`qa/profiles/broad-validation.json` (referenced as the `broadValidation` profile in
`.codex/homelab-runner.json`) runs the **full Vitest suite** in a Linux container.

The full suite **is** container-equivalent. OS-specific code (Windows registry,
scheduled tasks, `.lnk` shortcuts, VS Code / APPDATA paths) is tested through injected
`platform` / `execFile` parameters and tmpdir-scoped env vars, not real syscalls, so the
full suite passes on Linux once the build generates `dist/` and
`src/dashboard-ui/routeTree.gen.ts`. This supersedes the earlier note that no
container-equivalent full-suite profile was possible. Verified 2026-07-19 on the VPS at
branch tip: 356 files / 2309 tests.

Lane shape:

- class `container`, hardware `cpu`, image `node:22-bookworm` (engines require Node `>=22`)
- network `bridge`, used only for `npm install` against the public npm registry
- commands: `ONNXRUNTIME_NODE_INSTALL=skip npm install --no-audit --no-fund` -> `npm run build` -> `npm run typecheck`
  (+ `typecheck:ui`) -> `npm test -- --reporter=dot`. Install is `npm install`, NOT
  `npm ci`: the Windows-generated lockfile omits Linux's electron-builder optional
  subtree, so `npm ci` hard-fails on Linux (see the `install` note in the profile and
  the `electron-builder-lockfile-linux` project memory).

### Live gate is open

`liveExecution.allowed` is `true` and `dryRunOnly` is `false` — the project owner
approved a live VPS Docker run with bridge networking for `npm install`. Before each live
dispatch, confirm the selected runner (`vps`) is healthy; its dispatch-health overlay
goes stale past 72h and must be re-probed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:CODEX_HOMELAB_ROOT\tools\codex-runner\Test-CodexContainerRunnerHealth.ps1" -RunnerName vps -SshTarget vps -OutputDirectory "$env:TEMP\vps-health" -Json
```

To re-close the gate, set both flags back (`dryRunOnly: true`, `liveExecution.allowed: false`).

### Resolve the route (dry, no execution)

The Homelab root is read from the `CODEX_HOMELAB_ROOT` env var (see
`homelabRootEnv` in `.codex/homelab-runner.json`). Run from the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:CODEX_HOMELAB_ROOT\tools\codex-runner\Resolve-CodexRunnerRoute.ps1" -ProjectPath "." -Class container -Json
```

## Local full-suite policy

The full `npm test` suite is noisy on an active local desktop runner. Prefer this
container lane for broad validation. For local feedback use focused Vitest commands
(see the repo `AGENTS.md`).
