# Memory Fort Supervisor Run-Key Runbook

Memory Fort starts the dashboard at Windows logon through the current user's Run
key:

```powershell
HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MemoryFortDashboard
```

The value launches `scripts/start-memory-fort.ps1`. The launcher owns
`VOYAGE_API_KEY` lookup from the user environment; the supervisor installer does
not read or print the key.

## Install

```powershell
npm run build
npm run memory -- install supervisor --apply
reg.exe QUERY HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v MemoryFortDashboard
```

`--apply` is idempotent. If the current value already matches the expected
command, it reports `already installed` and leaves the registry untouched. If
the value exists but points somewhere else, `--apply` overwrites it with the
current repo's launcher command.

## Status

```powershell
npm run memory -- supervisor status
npm run memory -- supervisor status --json
```

Human output shows the registry key, shell choice, launcher path, stored value,
and drift state. JSON output includes the same fields:

```json
{
  "installed": true,
  "shell": "pwsh",
  "launcherPath": "C:\\CodexProjects\\memory-system\\scripts\\start-memory-fort.ps1",
  "value": "pwsh.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"C:\\CodexProjects\\memory-system\\scripts\\start-memory-fort.ps1\"",
  "drift": false
}
```

`drift: true` means the Run-key value exists but differs from the command this
checkout would install. To remediate, run:

```powershell
npm run memory -- install supervisor --apply
```

## Remove

```powershell
npm run memory -- install supervisor --remove
reg.exe QUERY HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v MemoryFortDashboard
```

After removal, `reg.exe QUERY` should exit `1` with the standard missing-value
message. Running `--remove` again is safe and reports `not installed`.

## Manual Startup Controls

Task Manager > Startup apps, Settings > Apps > Startup, and `msconfig` can be
used to inspect or disable startup behavior, but disabling there is not the same
as uninstalling the Run-key value. Use `memory install supervisor --remove` for
a clean uninstall, or manually remove the value with:

```powershell
reg.exe DELETE HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v MemoryFortDashboard /f
```

## Smoke Check

No reboot is required for a local smoke. Invoke the exact command stored in the
Run key:

```powershell
pwsh.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\CodexProjects\memory-system\scripts\start-memory-fort.ps1"
```

Then verify the dashboard search endpoint reports `degraded: false`.

## Auto-Heal Spend Controls

Auto-heal capture-time embeds are debounced per raw path. Each post-tool-use
hook records a pending capture in `embeddings/auto-heal-capture-queue.jsonl`;
the worker embeds only after the raw file has been quiet for
`auto_heal.capture_debounce_seconds` (default `30`). The reconciler remains the
backstop for raws that were missed while the dashboard was not running.

Daily spend is derived from `embeddings/auto-heal.jsonl`, filtered to the
current UTC day and `outcome:"embedded"` rows. The persisted
`auto-heal-status.json` file keeps last tick/embed timestamps, but it is not the
budget source of truth.

Embedding sidecar writes use temp-file atomic replace without the previous
`.prev` copy by default. This avoids paying for an embed and then losing the
write to a Windows `.prev` copy race. The dimension/write guard still runs
before every sidecar write.
