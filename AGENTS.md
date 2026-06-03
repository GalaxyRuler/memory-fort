# memory-system

<!-- BEGIN CODEX HOMELAB RUNNER INTEGRATION -->
## Homelab Runner Integration

This project may use the central Homelab runner for isolated, noisy, GUI, installer, VM, container, or long-running validation.

Project runner config:
- .codex/homelab-runner.json

Before running noisy tests, GUI automation, installers, VM jobs, or long-running validation:
1. Read .codex/homelab-runner.json.
2. Use the configured Homelab runner route.
3. Prefer containers for CLI, API, unit, integration, and headless checks.
4. Do not run GUI automation, MSI install/uninstall, or destructive validation on the active WHITEDRAGON desktop unless explicitly approved.
5. Keep project-specific runner profiles inside this repo, not in Homelab core.

<!-- END CODEX HOMELAB RUNNER INTEGRATION -->

## Local Test Policy

The full Vitest suite is noisy on the active WHITEDRAGON desktop. During TDD
RED/GREEN loops, do not run unfiltered `npm test`, `npm run test:ui`, or
unfiltered `npx vitest` locally unless the user explicitly asks for a local
full-suite run.

Use focused Vitest commands for local feedback:

```powershell
npm test -- test/path/to/file.test.ts --reporter=dot
npm test -- test/path/to/file.test.tsx --reporter=dot
```

For multiple touched areas, list the relevant test files explicitly. Do not use
Jest-only flags such as `--runInBand`; this repo uses Vitest.

For broad/full validation, resolve the configured Homelab route first. There is
currently no live full-suite profile because the full `npm test` suite has
Windows-specific path and tool assumptions that are not equivalent in a Linux
container.

If the user explicitly asks for a local full-suite run on WHITEDRAGON, keep it
low priority and do not stream the full test output through Codex. Use a hidden
process with redirected logs and a compact reporter, then summarize the tail:

```powershell
$npm = (Get-Command npm.cmd).Source
$out = Join-Path $env:TEMP "memory-system-npm-test.out.log"
$err = Join-Path $env:TEMP "memory-system-npm-test.err.log"
$p = Start-Process -FilePath $npm -ArgumentList @("test", "--", "--reporter=dot") -WorkingDirectory "C:\CodexProjects\memory-system" -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
$p.PriorityClass = "Idle"
$p.WaitForExit()
Get-Content $out -Tail 80
Get-Content $err -Tail 40
exit $p.ExitCode
```

