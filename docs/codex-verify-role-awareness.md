# Codex Implementation Brief — Verify Role Awareness (Operator vs Server)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The health-monitoring brief (`docs/codex-health-monitoring.md`) shipped `runVerify()` and `/api/health` returning a structured `VerifyReport`. The HealthBadge on the dashboard polls that endpoint and shows a glanceable green/red pill. Good in theory.

In practice the VPS deploy exposed a design gap: `/api/health` on the live server **permanently returns 503 fail** because several checks describe operator-machine concerns that can never pass on the server:

1. `git.remote` — checks the vault has a remote named `vps` and that it is reachable. The vault on the VPS has no `vps` remote; the VPS *is* the destination, not a source.
2. `client.claude-code.enabled` — checks the Claude Code plugin is enabled in `~/.claude/settings.json`. The server doesn't run Claude Code.
3. `client.claude-code.capture` — checks capture freshness for the Claude Code sniffer. Operator-only.
4. `client.codex.config` — checks the Codex MCP block is present in `~/.codex/config.toml`. The server doesn't run Codex.
5. `sniffer.claude-code.backfill` — checks the local sniffer backfill state. Operator-only.

Result: the HealthBadge on the production dashboard is **permanently red**, defeating the glanceable green/red intent and training the user to ignore it.

This brief teaches verify about **roles**. Each check declares whether it applies to the `operator` machine, the `server`, or both. `runVerify({ role })` filters accordingly. `/api/health` auto-detects `server` and returns only server-relevant checks. The CLI gains a `--role` flag. The HealthBadge stays role-agnostic — the endpoint hands it pre-filtered data.

After this lands, the live dashboard shows ✓ green when the server-side surface is healthy, regardless of whether the operator's laptop is currently online or has its Claude Code plugin enabled.

---

## Scope guard

You will:

- Introduce a `role: 'operator' | 'server'` concept in the verify subsystem
- Add a `roles: VerifyRole[]` field on each check's metadata declaring where it applies
- Refactor existing checks in `src/cli/commands/verify/*.ts` so each declares its roles (most are `['operator']`; `vault.read-write`, `dashboard.status`, `search.pipeline`, `episodic.relations.coverage`, and `compile.recent` are `['operator', 'server']`)
- Update `runVerify()` to accept a `role` option and filter checks by that field
- Add a role auto-detection helper at `src/cli/commands/verify/role.ts`
- Update the `/api/health` route to detect role server-side and accept a `?role=` query parameter (default to detected)
- Add a `--role <operator|server>` flag to `memory verify` (default auto-detect)
- Tests asserting each check's declared roles, that role-filtering works, and that server-mode skips the right checks

You will **not**:

- Touch the `<HealthBadge>` UI — the badge stays role-agnostic; the endpoint hands it pre-filtered data
- Add new checks — only annotate existing ones
- Restructure check storage beyond adding the metadata field
- Change check semantics — a check that returns `pass` today still returns `pass` after this brief; it just won't be invoked in roles that don't apply
- Add new dependencies
- Touch the scheduled-verify task or notification surfaces

If a check's correct role assignment is ambiguous from the brief (e.g., a borderline check that could plausibly apply to either machine), **stop and ask** rather than guessing. Wrong role assignments either re-introduce the red-on-VPS problem or hide real operator-side breakage.

---

## Repo orientation (verified before brief)

- `src/cli/commands/verify/types.ts` — `VerifyReport` and `CheckResult` types. Add `VerifyRole` here.
- `src/cli/commands/verify/*.ts` — one file per check (vault, git, dashboard, search, clients, autopush, compile, episodic-relations). Each exports an async function returning `CheckResult` (or array of them for the client checks).
- `src/cli/commands/verify.ts` — the orchestrator that calls `runVerify()` and renders the report.
- `src/dashboard/server.ts` (compiled to `.mjs`) — `/api/health` route lives here.
- Existing pattern: each check file exports a check function. The metadata (id, label) currently lives inside the returned `CheckResult`. This brief adds a sibling **check descriptor** alongside the function that carries the roles, so role-filtering can happen **before** the check runs (we don't want to invoke an operator-only check on the server just to throw the result away).

### Role assignment table (the source of truth)

This table covers every check id that exists in `src/cli/commands/verify/*.ts` as of the brief date. If a new check is added by a later commit, **stop and ask** before assigning a role.

| Check id | Roles | Rationale |
|---|---|---|
| `vault.read-write` | `['operator', 'server']` | Vault must be readable/writable on both |
| `dashboard.status` | `['operator', 'server']` | Dashboard runs in both environments |
| `search.pipeline` | `['operator', 'server']` | Retrieval is used by both the CLI and the live dashboard |
| `episodic.relations.coverage` | `['operator', 'server']` | Content-quality signal; environment-agnostic |
| `compile.recent` | `['operator', 'server']` | Server reads compile timestamp from synced vault state |
| `autopush.errors` | `['operator']` | Server never auto-pushes — `errors.log` is operator-local |
| `git.remote` | `['operator']` | Server *is* the destination; has no `vps` remote |
| `client.claude-code.enabled` | `['operator']` | Operator-local plugin install |
| `client.claude-code.capture` | `['operator']` | Operator-local capture freshness |
| `sniffer.claude-code.backfill` | `['operator']` | Operator-local `~/.claude/projects/` |
| `client.codex.config` | `['operator']` | Operator-local `~/.codex/config.toml` |
| `client.codex.capture` | `['operator']` | Operator-local capture freshness |
| `client.antigravity.config` | `['operator']` | Operator-local antigravity install |
| `sniffer.antigravity.plugin` | `['operator']` | Operator-local plugin files |
| `client.antigravity.capture` | `['operator']` | Operator-local capture activity |
| `client.vscode.config` | `['operator']` | Operator-local VS Code MCP config |
| `sniffer.vscode.extension` | `['operator']` | Operator-local VS Code extension |
| `sniffer.vscode.capture` | `['operator']` | Operator-local capture freshness |
| `client.claude-desktop.config` | `['operator']` | Operator-local Claude Desktop MCP config |
| `sniffer.claude-desktop.watcher` | `['operator']` | Operator-local watcher source dir |
| `sniffer.claude-desktop.capture` | `['operator']` | Operator-local capture freshness |

21 checks total: 5 `['operator', 'server']`, 16 `['operator']`. Zero `['server']`-only checks today — that's expected; there's no check that would *only* make sense on the server.

If a check exists in the repo that isn't in this table, **stop and ask** — don't guess.

---

## Task 1 — Add the `VerifyRole` type and check-descriptor pattern

### Why
Today `runVerify()` calls each check function and collects results. To filter by role *before* running a check (so server-side `/api/health` doesn't try to read `~/.codex/config.toml`), each check needs to expose its metadata alongside the function, not only inside its return value.

### Contract

```ts
// src/cli/commands/verify/types.ts
export type VerifyRole = 'operator' | 'server';

export interface CheckDescriptor {
  id: string;             // e.g., 'vault.read-write'
  label: string;          // human-readable
  roles: VerifyRole[];    // which roles invoke this check
  run: (opts: RunCheckOptions) => Promise<CheckResult | CheckResult[]>;
}

export interface RunCheckOptions {
  offline?: boolean;
  // existing options preserved
}
```

`CheckResult` and `VerifyReport` keep their existing shape from the health-monitoring brief. The `id`, `label`, and `status` on `CheckResult` remain populated by the check function as today.

### Files

- Modify: `src/cli/commands/verify/types.ts` — add `VerifyRole` and `CheckDescriptor`
- Tests: no new tests for the type itself — verified via downstream tests in Task 2

---

## Task 2 — Refactor each check to export a `CheckDescriptor`

### Why
The orchestrator needs a single registry of descriptors keyed by id so role-filtering happens before invocation.

### Contract

Each `src/cli/commands/verify/*.ts` file exports a named `CheckDescriptor` (or array of them, for the client checks that produce multiple). Example:

```ts
// src/cli/commands/verify/git.ts
export const gitRemoteCheck: CheckDescriptor = {
  id: 'git.remote',
  label: 'Vault git remote reachable',
  roles: ['operator'],
  run: async (opts) => { /* existing logic */ },
};
```

```ts
// src/cli/commands/verify/autopush.ts
export const autopushErrorsCheck: CheckDescriptor = {
  id: 'autopush.errors',
  label: 'Auto-push has no recent errors',
  roles: ['operator'],
  run: async (opts) => { /* existing logic */ },
};
```

The `clients.ts` file today returns a `CheckResult[]` from one function `checkClients(ctx)` that internally fans out to 14 per-client/per-sniffer probes. Split that into 14 sibling `CheckDescriptor` exports — one per id in the role table — moving the existing per-client helper bodies into each descriptor's `run`. Example:

```ts
// src/cli/commands/verify/clients.ts
export const claudeCodeEnabledCheck: CheckDescriptor = {
  id: 'client.claude-code.enabled',
  label: 'Claude Code plugin enabled',
  roles: ['operator'],
  run: async (opts) => { /* existing checkClaudeCodeEnabled() body */ },
};

export const codexCaptureCheck: CheckDescriptor = {
  id: 'client.codex.capture',
  label: 'Codex capture is fresh',
  roles: ['operator'],
  run: async (opts) => { /* existing checkRecentCapture(...) call for codex */ },
};

// ...and 12 more for the remaining client.*/sniffer.* ids in the role table
```

A central registry file collects all descriptors in the exact order of the role-assignment table:

```ts
// src/cli/commands/verify/registry.ts
import { vaultReadWriteCheck } from './vault.js';
import { dashboardStatusCheck } from './dashboard.js';
import { searchPipelineCheck } from './search.js';
import { episodicRelationsCoverageCheck } from './episodic-relations.js';
import { compileRecentCheck } from './compile.js';
import { autopushErrorsCheck } from './autopush.js';
import { gitRemoteCheck } from './git.js';
import {
  claudeCodeEnabledCheck,
  claudeCodeCaptureCheck,
  claudeCodeBackfillCheck,
  codexConfigCheck,
  codexCaptureCheck,
  antigravityConfigCheck,
  antigravityPluginCheck,
  antigravityCaptureCheck,
  vscodeConfigCheck,
  vscodeExtensionCheck,
  vscodeCaptureCheck,
  claudeDesktopConfigCheck,
  claudeDesktopWatcherCheck,
  claudeDesktopCaptureCheck,
} from './clients.js';

export const ALL_CHECKS: CheckDescriptor[] = [
  vaultReadWriteCheck,
  dashboardStatusCheck,
  searchPipelineCheck,
  episodicRelationsCoverageCheck,
  compileRecentCheck,
  autopushErrorsCheck,
  gitRemoteCheck,
  claudeCodeEnabledCheck,
  claudeCodeCaptureCheck,
  claudeCodeBackfillCheck,
  codexConfigCheck,
  codexCaptureCheck,
  antigravityConfigCheck,
  antigravityPluginCheck,
  antigravityCaptureCheck,
  vscodeConfigCheck,
  vscodeExtensionCheck,
  vscodeCaptureCheck,
  claudeDesktopConfigCheck,
  claudeDesktopWatcherCheck,
  claudeDesktopCaptureCheck,
];
```

The export-name conventions above are suggestions, not mandates — pick whatever matches the existing helper-function names in `clients.ts` as long as the `id` field on each descriptor matches the role table exactly.

The existing check function logic moves **unchanged** into the `run:` property of each descriptor. No behavior changes. Only the surface shape changes.

If an existing check is genuinely shaped such that wrapping its logic in a descriptor is non-trivial (e.g., the function is constructed dynamically at orchestrator load time), **stop and ask** before doing a large refactor.

### Files

- Modify: every `src/cli/commands/verify/*.ts` file to export descriptors
- New: `src/cli/commands/verify/registry.ts`
- Tests: a new `test/cli/commands/verify/registry.test.ts` that asserts every descriptor in `ALL_CHECKS` has a non-empty `roles` array, a unique `id`, a non-empty `label`, and a callable `run`

---

## Task 3 — Role auto-detection helper

### Why
The endpoint needs to pick the right default role without operator intervention. The CLI also needs to default sensibly. One detection helper, two call sites.

### Contract

```ts
// src/cli/commands/verify/role.ts
import type { VerifyRole } from './types.js';

export function detectRole(env: NodeJS.ProcessEnv = process.env): VerifyRole {
  // 1. Explicit override always wins
  const override = env.MEMORY_ROLE?.toLowerCase();
  if (override === 'server') return 'server';
  if (override === 'operator') return 'operator';

  // 2. Server fingerprint: install root is the VPS path AND no operator-side configs exist
  const installRoot = env.MEMORY_INSTALL_ROOT;
  const isVpsInstall = installRoot === '/root/memory-system';
  const codexConfigExists = existsSync(join(homedir(), '.codex', 'config.toml'));
  const claudeSettingsExists = existsSync(join(homedir(), '.claude', 'settings.json'));

  if (isVpsInstall && !codexConfigExists && !claudeSettingsExists) {
    return 'server';
  }

  // 3. Default to operator
  return 'operator';
}
```

`MEMORY_ROLE` is the explicit escape hatch (case-insensitive). The auto-detection logic mirrors the brief context exactly: VPS install root AND no operator-side configs.

### Files

- New: `src/cli/commands/verify/role.ts`
- Tests: `test/cli/commands/verify/role.test.ts` covering:
  - `MEMORY_ROLE=server` returns `server`
  - `MEMORY_ROLE=operator` returns `operator`
  - `MEMORY_ROLE=SERVER` (uppercase) returns `server`
  - VPS install root + no configs returns `server` (mock `existsSync`)
  - VPS install root + a Codex config present returns `operator`
  - Non-VPS install root returns `operator`
  - Empty env returns `operator`

---

## Task 4 — `runVerify({ role })` filters by role

### Why
The orchestrator iterates `ALL_CHECKS` and runs each one. Now it must skip any descriptor whose `roles` does not include the requested role.

### Contract

```ts
export async function runVerify(opts: {
  offline?: boolean;
  role?: VerifyRole;
} = {}): Promise<VerifyReport> {
  const role = opts.role ?? detectRole();
  const applicable = ALL_CHECKS.filter((c) => c.roles.includes(role));
  // existing iteration, but over `applicable` instead of all checks
  // existing aggregation into VerifyReport
  // include `role` in the report metadata
}
```

Add `role: VerifyRole` to `VerifyReport` so consumers (HealthBadge, audit JSON, scheduled task log) can see which role the report was generated for.

The console renderer (from the health-monitoring brief) prints the role at the top of the formatted output: `Role: operator (auto-detected)` or `Role: server (MEMORY_ROLE=server)`. Keep this terse — one line.

### Files

- Modify: `src/cli/commands/verify.ts` and wherever `runVerify` lives
- Modify: `src/cli/commands/verify/types.ts` to add `role` to `VerifyReport`
- Modify: the console renderer to print the role
- Tests: `test/cli/commands/verify.test.ts` extended to assert:
  - `runVerify({ role: 'server' })` excludes operator-only check ids from the report
  - `runVerify({ role: 'operator' })` includes all check ids
  - The report includes the `role` it ran with
  - `runVerify()` with no role falls back to `detectRole()` (mock the helper)

---

## Task 5 — `/api/health` accepts `?role=` and defaults to detected

### Why
The dashboard endpoint must default to `server` on the VPS so the HealthBadge sees only relevant checks. An explicit `?role=operator` exists for completeness (e.g., the same dashboard binary running on an operator's laptop for testing).

### Contract

`GET /api/health[?role=server|operator][&deep=true]`

- If `role` query param is present and valid, use it
- Otherwise call `detectRole()` and use that
- Invalid `role` values (e.g., `?role=admin`) → 400 with a clear error body
- The response body includes `role` (already added in Task 4)
- Cache key includes the role — `pass` for operator and `pass` for server are different cached entries
- HTTP status mapping unchanged: 200 for pass/warn, 503 for fail

The `?deep=true` flag from the health-monitoring brief still works orthogonally to `?role=`.

### Files

- Modify: `src/dashboard/server.ts` (or `.mjs`) — the `/api/health` handler
- Tests: integration test asserting:
  - `/api/health` on a mocked server-role environment returns 200 with only server-applicable check ids
  - `/api/health?role=operator` returns the full check set
  - `/api/health?role=bogus` returns 400
  - The cache differentiates by role (two calls with different roles produce two distinct reports, not the same cached entry)

---

## Task 6 — `memory verify --role <operator|server>` CLI flag

### Why
Operators want to manually inspect the server-side view from their laptop (`memory verify --role server` against the same vault) and CI wants an explicit flag rather than relying on env vars.

### Contract

```
memory verify [--role operator|server] [--json] [--offline]
```

- `--role` overrides `detectRole()`
- Default is `detectRole()`
- Invalid value → exit code 2 with a clear error message
- The console output (Task 4) already prints the role; nothing else changes
- `--json` output (from the health-monitoring brief) includes the `role` field

### Files

- Modify: `src/cli/commands/verify.ts` to register the flag
- Tests: `test/cli/commands/verify.cli.test.ts` (or wherever CLI flag parsing is tested) asserting:
  - `--role server` filters as expected
  - `--role operator` runs the full set
  - `--role bogus` exits non-zero
  - No flag falls back to `detectRole()`

---

## Execution order

1. **Task 1** (types) — pure type addition, no behavior change
2. **Task 2** (descriptors + registry) — mechanical refactor; biggest diff but no behavior change
3. **Task 3** (role.ts) — small standalone helper with focused tests
4. **Task 4** (runVerify filtering) — wires Tasks 1-3 together; this is the behavior change
5. **Task 5** (/api/health) — exposes role to the dashboard; unblocks the live VPS fix
6. **Task 6** (CLI flag) — operator-facing surface

Each task = one commit. Run `npx vitest run` between every commit. Do not batch tasks into a single commit even if they feel small — the descriptor refactor in Task 2 is the highest-risk change and needs to land alone.

---

## Build / test / deploy

```
npx vitest run                                            # full suite (740 currently passing)
npx vitest run test/cli/commands/verify                   # verify tests only
npm run build

# Deploy the updated dashboard server to the VPS:
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify the live endpoint now returns 200 instead of 503:
curl -s -o /dev/null -w "%{http_code}\n" https://<dashboard-host>/api/health
curl -s https://<dashboard-host>/api/health | jq '.role, .overallStatus, .checks[].id'

# On the VPS the role should auto-detect to 'server' (MEMORY_INSTALL_ROOT=/root/memory-system).
# Optionally pin it explicitly in the systemd unit:
#   Environment=MEMORY_ROLE=server
```

---

## Acceptance checklist

- [ ] `VerifyRole` type exported from `src/cli/commands/verify/types.ts`
- [ ] Every check in the role-assignment table exports a `CheckDescriptor` with the correct `roles` array
- [ ] `ALL_CHECKS` registry in `src/cli/commands/verify/registry.ts` contains every descriptor
- [ ] `detectRole()` returns `server` on the VPS fingerprint and `operator` otherwise; `MEMORY_ROLE` env var overrides
- [ ] `runVerify({ role: 'server' })` omits every operator-only check from the report
- [ ] `runVerify({ role: 'operator' })` includes every check (behavior unchanged from today)
- [ ] `VerifyReport` includes the `role` it ran with
- [ ] `/api/health` defaults to `detectRole()`; accepts `?role=` override; returns 400 on invalid role
- [ ] `/api/health` cache is keyed by role
- [ ] On the VPS (or with `MEMORY_ROLE=server`), `/api/health` returns 200 with `overallStatus='pass'` if all server-relevant checks pass
- [ ] On an operator machine with no env override, behavior is unchanged from today
- [ ] `memory verify --role server` runs only server-relevant checks
- [ ] `memory verify --role operator` runs everything
- [ ] `memory verify` with no flag falls back to `detectRole()`
- [ ] All 740 existing tests still green
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] `<HealthBadge>` UI untouched

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

Belong in separate briefs:

1. **Per-check role overrides via config** — let operators move a check between roles via a config file rather than code (e.g., a homelab operator who *does* run Claude Code on a server might want `client.claude-code.enabled` to apply to `server` for their setup)
2. **Multi-role checks with role-specific thresholds** — e.g., dashboard latency tolerance could be stricter on the server than on a laptop on a flaky home wifi
3. **A `headless` role** — for CI runners that have neither operator configs nor the VPS fingerprint; today they fall through to `operator` and will see Claude Code/Codex checks fail
4. **Surfacing the role in the HealthBadge expanded view** — a small "viewing: server checks" caption so the operator knows the badge is role-filtered
