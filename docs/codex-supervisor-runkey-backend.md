# Codex Prompt — Swap Supervisor Backend: schtasks → HKCU Run Key

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Live vault**: `C:\Users\Admin\.memory`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (`main`). Stop and ask if scope creeps past this prompt.

---

## Mission

The auto-heal + supervisor commit (`a41759c`) shipped a working launcher script (`scripts/start-memory-fort.ps1`) but a broken install path: `memory install supervisor --apply` runs `schtasks.exe /Create /SC ONLOGON ...` which **fails with `ERROR: Access is denied.`** on this Windows box for the standard user — even with `/RU $env:USERNAME` and `/RL LIMITED`. Verified by running the exact command directly: still denied. Task Scheduler is policy-locked here (common on managed Windows accounts).

The launcher itself is correct. **Only the install backend is broken.** Operator already worked around it by writing the HKCU `Run` key manually:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MemoryFortDashboard =
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File
    "C:\CodexProjects\memory-system\scripts\start-memory-fort.ps1"
```

The manual edit works (no admin, no Task Scheduler), but it bypasses the CLI — `memory supervisor status` doesn't see it, and there's no scripted `--remove`. Your job: swap the supervisor's autostart backend from `schtasks` to **HKCU Run key** so `--apply`, `--remove`, and `status` all work without admin on any normal Windows account.

Treat *verify-before-claim* as a hard rule: a green test is not proof; the real registry value must match.

---

## Verified context (confirm by reading)

- **Launcher works.** `scripts/start-memory-fort.ps1` reads `VOYAGE_API_KEY` from User scope (never logs it), refuses to kill non-Memory-Fort port owners, spawns dashboard detached with env injected, smoke-tests `/api/search` `degraded=false`. Preserve as-is.
- **Current broken backend.** `src/cli/commands/supervisor.ts` (added in `a41759c`) shells out to `schtasks.exe /Create /SC ONLOGON /TN MemoryFortDashboard /TR <launcher> /RL LIMITED /F`. Confirmed denied on this user account.
- **HKCU Run key is writable without admin.** `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run` already has ~26 third-party entries (OneDrive, Steam, Discord, Notion, …). The operator's manual `Set-ItemProperty` succeeded.
- **CLI surface to preserve.** `memory install supervisor --apply | --remove`, `memory supervisor status`. Same names, same exit codes, same JSON shape from `status`. Tests live at `test/cli/commands/supervisor.test.ts`.

---

## Phase 1 — Confirm the diagnosis (read + measure)

Reproduce the `schtasks` failure: run the exact `schtasks /Create` command from `supervisor.ts` directly (PowerShell, non-elevated). Capture the stderr ("Access is denied"). Confirm `/RU $env:USERNAME` does not change the outcome. File:line cite the current implementation.

## Phase 2 — Ground (online, cite recency)

Search current best practice for: per-user Windows autostart without admin (HKCU Run vs. Task Scheduler vs. Startup folder), HKCU Run key semantics (cmd length limits ~260 chars on legacy / 8191 modern; quoting), and idempotent registry writes from Node.js (spawn `reg.exe ADD/QUERY/DELETE` vs. PowerShell). Note recency.

## Phase 3 — Options + trade-offs

Options to evaluate (don't assume):

- **A. HKCU Run key via `reg.exe`.** No PowerShell dependency at install time. Quoted command stored as `REG_SZ`. Idempotent. Removal via `reg DELETE`. Status via `reg QUERY`. *Recommended.*
- **B. HKCU Run key via spawning PowerShell.** Adds a PowerShell dependency for install/uninstall. Simpler quoting. Slower start.
- **C. Startup folder `.lnk` shortcut.** Visible to the user in Settings > Startup apps. Requires a shell COM call (`WScript.Shell.CreateShortcut`) or `pwsh` to author the `.lnk`. More moving parts.
- **D. Keep `schtasks` as a fallback when elevation is available.** Detect denied → fall back to Run key automatically.

Recommend **A** as the primary backend. Document **D** as a future option only — do not implement now; it doubles the surface and the elevation path isn't needed when **A** works for every account.

## Phase 4 — Implement (TDD, stay green)

Replace the schtasks calls in `src/cli/commands/supervisor.ts` with a Run-key backend:

- **`applySupervisor()`**: `reg.exe ADD HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v MemoryFortDashboard /t REG_SZ /d "<command>" /f`. Build `<command>` from the resolved `pwsh.exe` path (fall back to `powershell.exe` if `pwsh.exe` is absent — surface the choice in `status`) + the absolute path to `scripts/start-memory-fort.ps1`. Idempotent: writing the same value is a no-op.
- **`removeSupervisor()`**: `reg.exe DELETE HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v MemoryFortDashboard /f`. Treat "value does not exist" as success (already removed).
- **`supervisorStatus()`**: `reg.exe QUERY HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v MemoryFortDashboard`. Parse the value. Report `{ installed: true|false, value, shell: "pwsh"|"powershell", launcherPath }`. Mismatch between stored value and the expected value (e.g. operator-edited or stale path) → `installed: true, drift: true, expected, actual`.
- **CLI output**: human-readable + a `--json` flag returning the structured shape above. Match the current `status` text format where possible to avoid breaking existing test asserts; extend where needed.
- **Tests** (`test/cli/commands/supervisor.test.ts`) — replace schtasks expectations with reg.exe:
  - apply when absent → reg ADD called, status reports installed:true.
  - apply when present with same value → idempotent, no error.
  - apply when present with different value → overwrites (or surfaces drift; document and test the chosen behavior).
  - remove when present → reg DELETE called, status installed:false.
  - remove when absent → exit 0, message "not installed".
  - status when absent → installed:false.
  - status when present → installed:true, value parsed, drift flag correct.
  - missing `pwsh.exe` → falls back to `powershell.exe`, status reports `shell: "powershell"`.
- **No admin required.** No `Start-Process -Verb RunAs`. No schtasks. Don't print the Voyage key (the launcher already protects it; supervisor never sees it).
- Keep `npm run typecheck`, `npm run build`, and the suite green at every commit. Don't break `a41759c` auto-heal, `5b1aa08` perf, or `0566984` durability.

## Phase 5 — Adversarial self-audit (live registry reads)

Before claiming done, prove against the **real registry** on the operator's box:

1. Pre-state: operator pre-installed the Run key manually. Read it (`reg.exe QUERY ...`) and paste the actual value. `status` should report `installed: true` and either drift=false (if the value matches the new generator) or drift=true with a clear remediation message.
2. `memory install supervisor --remove` → reg QUERY exits 1 (value not found). Paste the output.
3. `memory install supervisor --apply` → reg QUERY shows the new value. Paste it. Run it twice → second is a no-op (exit 0).
4. `memory supervisor status --json` → matches the registry exactly. Paste the JSON.
5. Sanity: after `--apply`, **do not actually reboot** — but invoke the launcher path the Run key would call (`pwsh.exe -File <launcher>` directly) and confirm the dashboard comes up keyed with `/api/search` `degraded=false`. Paste timings.
6. Restore: leave the operator's Run key value in place at the end (whatever they had before; preserve it if `--apply` overwrote it, document how to put it back).

A green unit test is not acceptance — only the registry read + the launched-dashboard smoke counts.

## Constraints (hard)

- Never read, log, or commit `VOYAGE_API_KEY`. The supervisor must not touch the key at all — the launcher owns that.
- No admin/UAC. No `Start-Process -Verb RunAs`. No schtasks.
- No permanent file deletions; if any state files are written, archive on remove.
- Windows + PowerShell 7. The CLI itself is Node; shell out to `reg.exe` (a built-in Windows binary). Don't require PowerShell for the install/remove path.
- Preserve all prior wins: `0566984` durability, `5b1aa08` perf, `a41759c` auto-heal + launcher.

## Stop-and-ask

1. The operator's pre-existing Run key value differs from the new generator output (drift) — confirm overwrite policy: overwrite with `--apply`, surface `drift: true` in `status`, document in the runbook.
2. `pwsh.exe` is not on PATH on the target box — confirm the fallback to `powershell.exe`.
3. A clean solution would also write a `scripts/install-supervisor.ps1` companion for users who don't have Node installed — out of scope here, mention only.

## Output contract

- Phase 1 diagnosis with command + exact denied output (we already have it; reproduce for the record).
- Phase 2 sources + what you took from each.
- Phase 3 options + recommendation.
- Diff/commits + test names.
- Phase 5 live evidence: real `reg.exe QUERY` reads + the launcher smoke timings.
- Residual risks + an updated operator runbook covering: `--apply`, `--remove`, drift, removal via msconfig/Task Manager Startup tab, and uninstall instructions.

## Definition of done

- `memory install supervisor --apply` succeeds **without admin** on a standard Windows user account; the HKCU Run key is set to the expected value (verified by `reg.exe QUERY`).
- `--remove` clears it; `status` reports honestly with drift detection.
- A subsequent `pwsh -File <launcher>` brings the dashboard up keyed with `/api/search degraded=false`.
- `a41759c` auto-heal + launcher untouched; perf and durability gains intact; suite + typecheck + build green.
- Every claim above backed by a live `reg.exe QUERY` read or command output in the report.
