# Codex Implementation Brief — Health Monitoring (Passive Active Verify)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

`memory verify` (shipped in `4242f2b`) checks every connection — plugin enablement, MCP blocks, capture freshness, auto-push errors, dashboard reachability, search pipeline. **But it only runs on manual invocation.** That's how the 4-day Claude Code capture silence happened: the plugin was inert, verify would have caught it instantly, but no one typed the command. Silent breakdown until the user noticed missing conversations.

This brief makes the verify status **passively visible in places you already look**:

1. **`/api/health` endpoint** on the dashboard server that runs the same checks as `memory verify` and returns structured JSON
2. **Health widget on the Overview page** that polls the endpoint every 30s and shows a compact ✓/⚠/✗ grid — prominently at the top
3. **Scheduled background run** (Windows Task Scheduler / systemd timer) that runs `memory verify --json` daily, writes results to `wiki/.audit/verify-{date}.json`, and surfaces any ✗ failures via Windows toast notification

After this lands, if claude-code stops capturing, you see a red pill on the dashboard within 30 seconds of next loading it — not 4 days later when you notice missing files.

---

## Scope guard

You will:

- Add a `/api/health` endpoint to the dashboard server that runs all the existing verify checks
- Add a `--json` flag to `memory verify` so machines can consume the same checks
- Build a `<HealthBadge>` component on the dashboard Overview page that polls and displays per-check status
- Add a scheduler hook command `memory verify --schedule install` that creates the OS-appropriate scheduled task and a `--schedule uninstall` to remove it
- The scheduled run writes `wiki/.audit/verify-{YYYY-MM-DD}.json` and triggers a Windows toast (via `New-BurntToastNotification` PowerShell cmdlet or native node-notifier package) when any check fails

You will **not**:

- Re-implement the verify checks — reuse `src/cli/commands/verify/*` modules
- Modify any sniffer, hook, or capture mechanism
- Add cloud/SaaS notification channels (Slack, email, etc.) — local-only for now
- Touch other dashboard routes
- Add a heavy notification library; prefer node-notifier or PowerShell `New-BurntToastNotification` (already commonly installed on Windows; fall back gracefully)

If the existing verify check modules don't expose a usable async function (e.g., they're tightly coupled to console output), refactor them minimally — **stop and ask** before doing a large refactor.

---

## Repo orientation (verified before brief)

- `src/cli/commands/verify.ts` — entry point for `memory verify`. Wraps checks from `src/cli/commands/verify/` subdir.
- `src/cli/commands/verify/` — one file per check (vault, git, dashboard, search, clients, autopush, compile)
- `src/dashboard/server.mjs` (compiled from `src/dashboard/server.ts`) — the dashboard HTTP server. Add `/api/health` route here.
- `src/dashboard-ui/components/OverviewPage.tsx` (or wherever the Overview lives) — top-level dashboard page. Add `<HealthBadge>` near the top.
- `src/dashboard-ui/hooks/useStatus.ts` — pattern for polling endpoints. Use the same pattern for `useHealth`.

---

## Task 1 — Refactor verify checks to return structured results

### Why
Today the verify checks print to console. The endpoint and the dashboard widget need structured data — not text. Refactor minimally: each check returns a `CheckResult` object, the existing console renderer wraps the structured output.

### Contract

```ts
export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  id: string;             // 'vault.readwrite', 'clients.claude-code.enabled', etc.
  label: string;          // human-readable description
  status: CheckStatus;
  detail?: string;        // why it warned/failed
  suggestedFix?: string;  // e.g., "run `memory connect claude-code`"
  durationMs: number;
}

export interface VerifyReport {
  startedAt: string;
  finishedAt: string;
  overallStatus: CheckStatus;   // worst status across checks
  checks: CheckResult[];
}

export async function runVerify(opts: { offline?: boolean }): Promise<VerifyReport>;
```

The existing `memory verify` console output becomes a renderer that takes a `VerifyReport` and prints the current ✓/⚠/✗ formatted text. Same visual output, structured underlying data.

### Files

- Refactor: `src/cli/commands/verify.ts` and `src/cli/commands/verify/*.ts`
- New: `src/cli/commands/verify/types.ts`
- New: `src/cli/commands/verify/render.ts` (console formatter)
- Add `--json` flag to `memory verify` that prints `VerifyReport` as JSON instead of formatted text
- Tests: extend `test/cli/commands/verify.test.ts` to assert structure of returned report

---

## Task 2 — `/api/health` endpoint on the dashboard server

### Why
The dashboard widget needs to fetch verify state from the server. The dashboard already proxies vault content; this endpoint runs the verify suite server-side and returns the report.

### Contract

`GET /api/health` → returns `VerifyReport` as JSON with HTTP status:
- 200 if `overallStatus === 'pass'` or `'warn'`
- 503 if `overallStatus === 'fail'` (so external monitors like UptimeRobot can detect outages)

Server-side considerations:
- **Cache the result** for 25 seconds (verify isn't free; many polls per minute hammer it)
- **Skip the "search pipeline" check by default** if it takes too long — it's the slowest check (~7s in current vault). Make it opt-in via `?deep=true` query parameter.
- The endpoint runs `runVerify({ offline: false })` and returns the result

### Files

- Modify: `src/dashboard/server.ts` (or `.mjs` — wherever the route table lives) to add the route
- Tests: integration test that hits `/api/health` and asserts the JSON shape

---

## Task 3 — `<HealthBadge>` widget on Overview page

### Why
This is the user-facing surface. Always visible, glanceable, polls in the background.

### Contract

A new `<HealthBadge>` component:
- Lives at the top of the Overview page, full-width, glass-panel style with corner brackets (matching existing components)
- Polls `/api/health` every 30 seconds via TanStack Query (cache settled for 25s to align with server-side cache)
- Renders:
  - **Compact**: a single status pill (`✓ all healthy` green / `⚠ N warnings` amber / `✗ N failures` red)
  - **Expanded** on click: shows the full grid of checks with status icons and detail text
- Per-check rendering shows the `suggestedFix` text when status is `fail` or `warn`, with the fix command in a copyable code block

When a check fails:
- The badge stays red until the failure clears
- A small `?` icon next to the failing check links to the suggested fix
- Does NOT auto-run any fixes — only surfaces the problem

When all checks pass:
- The badge collapses to a single green dot + "All systems connected" text
- Click expands to show the full check list anyway, for confidence

### Files

- New: `src/dashboard-ui/components/HealthBadge.tsx`
- New: `src/dashboard-ui/hooks/useHealth.ts` (TanStack Query wrapper)
- Modify: `src/dashboard-ui/components/OverviewPage.tsx` (or wherever Overview lives) to render `<HealthBadge>` at top
- Tests: render the badge with fixture reports (all pass / mixed / all fail) and verify the right states render

---

## Task 4 — Scheduled background verify + desktop notifications

### Why
The dashboard widget catches problems when you LOOK at the dashboard. But if you don't open it for a day, you still miss them. A scheduled daily verify with toast notification catches the case where you didn't visit the dashboard but something broke.

### Contract

CLI:
```
memory verify --schedule install [--daily HH:MM] [--shell powershell|systemd]
memory verify --schedule uninstall
memory verify --schedule status
```

Install:
- Detect platform. On Windows: create a Scheduled Task that runs `memory verify --json > wiki/.audit/verify-{date}.json` daily at the specified time (default 09:00 local).
- On any fail or warn, emit a desktop notification:
  - Windows: try `New-BurntToastNotification` first (no install needed if BurntToast module is present); fall back to `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(...)` if BurntToast not installed
  - Linux/macOS (systemd timer or launchd): use `notify-send` / `osascript` respectively
- The audit file is gitignored (it's per-machine state) — confirm `.gitignore` excludes `wiki/.audit/verify-*.json`
- Idempotent: re-running install removes the existing task first

Uninstall:
- Remove the scheduled task / systemd unit / launchd plist cleanly

Status:
- Prints whether the scheduled task is installed, when it last ran, and where the audit files live

### Files

- New: `src/cli/commands/verify-schedule.ts` (or absorb into `verify.ts`)
- New: `src/cli/commands/verify-schedule/{windows,linux,darwin}.ts` platform-specific installers
- Tests: each platform installer mocked, verify the right command is invoked

---

## Task 5 — Live verify on first install

### Why
When the user runs `memory connect --all` or `memory install`, immediately run `memory verify` and surface any issues. Catches "I just installed but my plugin didn't enable" cases at the moment of install instead of much later.

### Contract

- After every successful `memory connect <client>` and `memory connect --all`, automatically run `memory verify` and print the result
- After every `memory install`, run verify and print
- Behavior is opt-out via `--no-verify` flag
- This is essentially appending one line to the existing install/connect commands — small change, big behavioral improvement

### Files

- Modify: `src/cli/commands/connect.ts`, `src/cli/commands/install.ts` (or wherever they live)
- Tests: assert verify is invoked after install, can be disabled with flag

---

## Execution order

1. **Task 1 (refactor)** — must land first; everything depends on the structured report
2. **Task 2 (endpoint)** — straightforward once Task 1 is done
3. **Task 3 (widget)** — biggest user-visible impact; do this before scheduling because operators see results immediately
4. **Task 5 (live verify on install)** — small, high-value polish
5. **Task 4 (scheduler)** — catches the "didn't visit dashboard for a day" case

Each task = one commit. Run `npx vitest run` between every commit.

---

## Build / test / deploy

```
npx vitest run                                       # full suite
npx vitest run test/cli/commands/verify              # verify tests only
npm run build
npm run build:ui                                     # SPA for HealthBadge

# scp to correct path — note the dist/ prefix that bit us before:
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Local install of the scheduled task:
memory verify --schedule install --daily 09:00
```

---

## Acceptance checklist

- [ ] `memory verify --json` outputs valid VerifyReport JSON
- [ ] `GET /api/health` returns 200/503 with VerifyReport body, cached server-side for 25s
- [ ] `<HealthBadge>` appears on the Overview page and polls every 30s
- [ ] Clicking the badge shows the full per-check grid
- [ ] Each failing check shows its suggested fix command
- [ ] `memory verify --schedule install` creates a working Windows Scheduled Task
- [ ] Toast notification fires when any check fails during the scheduled run
- [ ] `memory connect --all` and `memory install` run verify automatically (suppressible via `--no-verify`)
- [ ] All 700+ tests still green
- [ ] No new heavy dependencies, no secrets, no OneDrive paths

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

Belong in separate briefs:

1. **Webhook notifications** — POST to a user-configured URL when checks fail (for users who want Slack/Discord integration)
2. **Capture-rate trending** — chart episodic-captures-per-day on the dashboard; alert if rolling average drops below a threshold
3. **Self-healing** — for known-recoverable failures (e.g., dashboard down → restart it), offer to auto-fix from the badge instead of just suggesting the command
