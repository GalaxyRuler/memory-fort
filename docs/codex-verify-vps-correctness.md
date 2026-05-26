# Codex Implementation Brief — Verify VPS Correctness (vaultRoot Plumbing, Role Detection, Installer Env Vars)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

After the role-awareness brief (`docs/codex-verify-role-awareness.md`, commits `bd196c5..e6a6f9c`) landed, the live VPS dashboard exposed three correctness gaps that prevent `/api/health?deep=true` from being honest. None of them are caused by the role-awareness work — two predate it, the third is an installer-completeness gap. The role-awareness brief made the symptoms visible because the HealthBadge now actually reflects the report.

1. **`runVerify()` hardcodes `vaultRoot: memoryRoot()`** at `src/cli/commands/verify.ts:58`, ignoring whatever `vaultRoot` the caller already has. `memoryRoot()` returns `~/.memory/` (resolves to `/root/.memory/` on the VPS), which is empty. The dashboard's `/api/health` handler at `src/dashboard/server.ts:312-313` calls `runVerify({ offline: false, includeSearch, role })` **without** forwarding `opts.vaultRoot`, even though the dashboard itself reads from `opts.vaultRoot = /root/memory-system/vault`. Net effect: `search.pipeline` returns 0 results, `episodic.relations.coverage` reports "no episodic memories found", and `vault.read-write` only passes by accident because `/root/.memory/raw/` happens to be writable. The bug existed since the health-monitoring brief shipped; role-awareness inherited it without making it worse.

2. **`detectRole()` is brittle.** The auto-detector at `src/cli/commands/verify/role.ts` only returns `'server'` when ALL three conditions are true: `MEMORY_INSTALL_ROOT === '/root/memory-system'` AND `~/.codex/config.toml` does not exist AND `~/.claude/settings.json` does not exist. On the live VPS, one of those operator-config files exists under `/root/` (left over from earlier debugging), so auto-detect returns `'operator'` despite the VPS install root. The operator workaround is `Environment=MEMORY_ROLE=server` in a systemd drop-in — that works, but the "auto-detect" code is mostly theater. Simpler and more honest: drop the negative-file checks entirely; rely on `MEMORY_ROLE` env (explicit) and default to `'operator'` otherwise. The VPS installer sets the env var as part of normal install.

3. **`memory install-vps`** today lays out `/root/memory-system/` and writes a systemd unit, but does not set `MEMORY_ROLE=server` or `MEMORY_ROOT=<install-root>/vault` in the unit. Fresh VPS installs would inherit the same problem we just hand-fixed with a manual drop-in. The installer should write a drop-in (or extend the main unit) with both env vars so newly installed VPSes auto-detect-via-env correctly with zero manual steps.

After this lands, a fresh `memory install-vps` produces a dashboard that returns ✓ green on `/api/health?deep=true` with no manual systemd drop-in required, and the verify subsystem reports against the actual vault the dashboard is serving.

### Workaround currently applied to the live VPS (do NOT touch)

The operator has manually added `/etc/systemd/system/memory-dashboard.service.d/role.conf`:

```
[Service]
Environment=MEMORY_ROLE=server
Environment=MEMORY_ROOT=/root/memory-system/vault
```

After daemon-reload and dashboard restart, `/api/health?deep=true` returns 200 with `overallStatus=pass` (verified live). **This brief preserves the workaround**: `install-vps` writing the same env vars via code is idempotent and the operator's manual drop-in stays in place. Codex must NOT delete or edit the existing `role.conf` drop-in on the live VPS, and must NOT write a new drop-in named `role.conf` (collision).

---

## Scope guard

You will:

- Add an optional `vaultRoot?: string` field to `VerifyOptions` in `src/cli/commands/verify.ts`. When provided, `runVerify` uses it; otherwise fall back to `memoryRoot()` (CLI behavior unchanged).
- Update the dashboard's `/api/health` `verifyRunner` closure at `src/dashboard/server.ts:312-313` to forward `opts.vaultRoot` into `runVerify`.
- Simplify `detectRole()` at `src/cli/commands/verify/role.ts`: drop the `MEMORY_INSTALL_ROOT` and home-dir-file existence checks. New behavior is env-only.
- Update `docs/codex-verify-role-awareness.md` Task 3 contract block so it matches the simplified `detectRole()`.
- Update `src/cli/commands/install-vps.ts` (or wherever the systemd unit is written) so the generated dashboard unit includes `Environment=MEMORY_ROLE=server` and `Environment=MEMORY_ROOT=<MEMORY_INSTALL_ROOT>/vault`. Idempotent on re-run.
- New tests per task (see each task's "Files" section).

You will **not**:

- Touch the `<HealthBadge>` UI
- Modify check semantics — checks already see `vaultRoot` via the descriptor context, so plumbing it through `runVerify` is purely an option-routing change
- Delete or edit the existing `role.conf` drop-in on the live VPS
- Write a new drop-in named `role.conf` (it collides with the operator's manual file)
- Add new checks
- Add new dependencies
- Touch the scheduled-verify task or notification surfaces
- Touch the `<HealthBadge>` polling cadence or display

**Scope guard nuance**: the role-awareness brief renamed `vault.readwrite` → `vault.read-write`, `compile.typecheck` → `compile.recent`, etc. Treat the IDs already in code as authoritative. If a check id mentioned in this brief does not match the repo, **stop and ask**.

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Repo orientation (verify before editing)

- `src/cli/commands/verify.ts` — `runVerify` and `VerifyOptions`. The hardcoded `vaultRoot: memoryRoot()` lives near line 58.
- `src/cli/commands/verify/role.ts` — `detectRole`. Today's logic does the brittle three-condition check.
- `src/cli/commands/verify/types.ts` — check context type, including the `vaultRoot` field that descriptors already consume.
- `src/cli/commands/verify/registry.ts` — `ALL_CHECKS`. No changes here; this brief does not touch any check.
- `src/dashboard/server.ts` — `/api/health` route. The `verifyRunner` closure lives around lines 312-313 and currently calls `runVerify({ offline: false, includeSearch, role })` without forwarding `opts.vaultRoot`.
- `src/cli/commands/install-vps.ts` — writes the systemd unit for the dashboard. The unit content is template-string-built; add the `Environment=` lines to the `[Service]` section.
- `src/storage/paths.ts` — `memoryRoot()` definition. Honors `MEMORY_ROOT` env when set; otherwise resolves to `~/.memory/`.

---

## Task 1 — Plumb `vaultRoot` through `runVerify`

### Why
The dashboard reads from `/root/memory-system/vault` but verify reads from `~/.memory/` (i.e., `/root/.memory/`) because `runVerify` hardcodes `vaultRoot: memoryRoot()` and the `/api/health` handler does not forward `opts.vaultRoot`. The two surfaces look at different vaults. `search.pipeline` and `episodic.relations.coverage` report empty corpora; `vault.read-write` passes only because `/root/.memory/raw/` is incidentally writable. The fix is purely option-routing — checks already consume `vaultRoot` from descriptor context, so plumbing it through `runVerify` is enough.

### Contract

```ts
// src/cli/commands/verify.ts
export interface VerifyOptions {
  offline?: boolean;
  includeSearch?: boolean;
  role?: VerifyRole;
  vaultRoot?: string;        // NEW — when provided, used as-is; otherwise falls back to memoryRoot()
  // existing fields preserved
}

export async function runVerify(opts: VerifyOptions = {}): Promise<VerifyReport> {
  const vaultRoot = opts.vaultRoot ?? memoryRoot();
  // existing iteration; checks see this vaultRoot via descriptor context
}
```

```ts
// src/dashboard/server.ts (around the verifyRunner closure at lines 312-313)
const verifyRunner = async (req: Request) => {
  const role = parseRole(req);
  const includeSearch = req.query.deep === 'true';
  return runVerify({
    offline: false,
    includeSearch,
    role,
    vaultRoot: opts.vaultRoot,   // NEW — forward the dashboard's vaultRoot
  });
};
```

### Files

- Modify: `src/cli/commands/verify.ts` — add `vaultRoot?: string` to `VerifyOptions`; use `opts.vaultRoot ?? memoryRoot()` at the call site that today hardcodes `memoryRoot()`.
- Modify: `src/dashboard/server.ts` — forward `opts.vaultRoot` in the `verifyRunner` closure.
- Tests:
  - `test/cli/commands/verify.test.ts` (or sibling): seed a tempdir vault with one wiki page and one raw observation, call `runVerify({ vaultRoot: tempDir, includeSearch: true })`, assert `search.pipeline` returns a non-zero corpus and `episodic.relations.coverage` does not report "no episodic memories found".
  - Same file: call `runVerify()` with no `vaultRoot` and assert the report's vault-related checks resolve against `memoryRoot()` (mock `memoryRoot` or assert the path indirectly via a `detail` field on `vault.read-write`).
  - `test/dashboard/server.test.ts` (or sibling): integration test asserting that when the dashboard is started with `opts.vaultRoot = '/tmp/foo'` and `/api/health` is hit, the resulting `VerifyReport` was produced with that `vaultRoot` (mock `runVerify` to capture its arg).

---

## Task 2 — Simplify `detectRole()`

### Why
The current `detectRole()` fingerprint check is theater: in practice it returns `'operator'` on the live VPS because a stray operator config file exists under `/root/`. The operator already overrides with `MEMORY_ROLE=server`. Drop the negative-file checks; rely on the env var. The VPS installer will set it as part of normal install (Task 3), so auto-detect-via-env is the only behavior we actually use.

### Contract

```ts
// src/cli/commands/verify/role.ts
import type { VerifyRole } from './types.js';

export function detectRole(env: NodeJS.ProcessEnv = process.env): VerifyRole {
  const override = env.MEMORY_ROLE?.toLowerCase();
  if (override === 'server') return 'server';
  if (override === 'operator') return 'operator';
  return 'operator';
}
```

That is the entire function body. Delete:

- The `MEMORY_INSTALL_ROOT` check
- The `existsSync(join(homedir(), '.codex', 'config.toml'))` check
- The `existsSync(join(homedir(), '.claude', 'settings.json'))` check
- The `homedir`/`join`/`existsSync` imports if no longer needed

### Documentation update

Update `docs/codex-verify-role-awareness.md` Task 3 contract block (lines roughly 254-280, the `// src/cli/commands/verify/role.ts` code block) to match the new implementation. Delete the "Server fingerprint" comment and the auto-detect discussion. The brief should read as if the role helper has always been env-only. The "default to operator" line stays.

Also update the Task 3 test bullet list (lines roughly 286-292) to remove the fingerprint-related cases:

- Keep: `MEMORY_ROLE=server` returns `'server'`
- Keep: `MEMORY_ROLE=operator` returns `'operator'`
- Keep: `MEMORY_ROLE=SERVER` (uppercase) returns `'server'`
- Keep: empty env returns `'operator'`
- Delete: VPS-install-root fingerprint cases
- Delete: Codex-config-present case

### Files

- Modify: `src/cli/commands/verify/role.ts` — strip the fingerprint logic.
- Modify: `test/cli/commands/verify/role.test.ts` — remove fingerprint-related test cases, keep the four env-only cases.
- Modify: `docs/codex-verify-role-awareness.md` — Task 3 contract block and test bullet list.

---

## Task 3 — `memory install-vps` writes `MEMORY_ROLE` and `MEMORY_ROOT` env vars

### Why
A fresh VPS install today produces a dashboard unit with no `MEMORY_ROLE` and no `MEMORY_ROOT`. Combined with Task 2, that means the dashboard would auto-detect to `'operator'` and `memoryRoot()` would resolve to `/root/.memory/` (empty). The installer should set both env vars in the generated unit so the install is correct out of the box.

### Contract

The systemd unit content generated by `install-vps` must include both lines under `[Service]`:

```
Environment=MEMORY_ROLE=server
Environment=MEMORY_ROOT=<MEMORY_INSTALL_ROOT>/vault
```

where `<MEMORY_INSTALL_ROOT>` is whatever the installer is using (typically `/root/memory-system`). Implementation options:

- **Option A (preferred)**: extend the main unit template — append the two `Environment=` lines to the `[Service]` section that already exists.
- **Option B**: write a separate drop-in alongside the main unit at `/etc/systemd/system/memory-dashboard.service.d/install-vps.conf` (do **not** use the name `role.conf` — that name is in use by the live VPS operator workaround).

Either option must be idempotent: re-running `install-vps` on a host that already has the env vars must not append duplicate `Environment=` lines, and must not delete or overwrite the operator's manual `role.conf` drop-in if present.

If choosing Option A, the simplest idempotency check is: read the existing unit file content; if both `Environment=MEMORY_ROLE=server` and `Environment=MEMORY_ROOT=<install-root>/vault` lines are already present, write nothing; otherwise regenerate the unit from the template with the env lines included.

### Files

- Modify: `src/cli/commands/install-vps.ts` (or wherever the unit is constructed — verify the path before editing).
- Tests: `test/cli/commands/install-vps.test.ts` (or sibling) — integration test with mocked SSH that asserts:
  - The generated unit content (or drop-in content) contains both `Environment=MEMORY_ROLE=server` and `Environment=MEMORY_ROOT=/root/memory-system/vault` lines.
  - Re-running the install on a host with the env vars already present does not append duplicate lines (compare generated content before/after second run).
  - The unit/drop-in path does not collide with `/etc/systemd/system/memory-dashboard.service.d/role.conf`.

---

## Execution order

1. **Task 1** (vaultRoot plumb) — option-routing only; lowest risk.
2. **Task 2** (detectRole simplify) — strips brittle logic; small diff; updates the prior brief.
3. **Task 3** (install-vps env vars) — installer-side fix; closes the loop so fresh installs are correct.

Each task = one commit. Run `npx vitest run` between every commit. Do not batch tasks into a single commit.

---

## Build / test / deploy

```
npx vitest run                                            # full suite (756 currently passing)
npx vitest run test/cli/commands/verify                   # verify tests only
npx vitest run test/cli/commands/install-vps              # installer tests only
npm run build

# Deploy the updated dashboard server to the VPS (manual path; see Future Work for auto-deploy):
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify the live endpoint:
curl -s -o /dev/null -w "%{http_code}\n" https://<dashboard-host>/api/health?deep=true
curl -s "https://<dashboard-host>/api/health?deep=true" | jq '.role, .overallStatus, .checks[] | {id, status}'

# Expected after Task 1 deploy: search.pipeline and episodic.relations.coverage report against
# /root/memory-system/vault and pass; vault.read-write reports against the same vault.
# The operator's role.conf drop-in remains in place (do NOT touch it).
```

---

## Acceptance checklist

- [ ] `runVerify({ vaultRoot: '/tmp/foo' })` uses `/tmp/foo`, not `~/.memory/`
- [ ] `runVerify()` with no `vaultRoot` still resolves `memoryRoot()` (CLI behavior unchanged)
- [ ] `/api/health` on the operator machine still passes (no regression)
- [ ] `/api/health` on the VPS reports 5 server-role checks all passing in `?deep=true` mode without the systemd `MEMORY_ROOT` pin (the env var becomes redundant but still works if set)
- [ ] `detectRole()` returns `'server'` if `MEMORY_ROLE=server`, `'operator'` otherwise — no file-existence checks
- [ ] `MEMORY_ROLE=SERVER` (uppercase) still returns `'server'`
- [ ] `docs/codex-verify-role-awareness.md` Task 3 contract block matches the simplified implementation
- [ ] `memory install-vps` generates a systemd unit (or drop-in) that includes `Environment=MEMORY_ROLE=server` and `Environment=MEMORY_ROOT=<install-root>/vault`
- [ ] Re-running `install-vps` is idempotent (does not append duplicate env lines, does not overwrite the operator's `role.conf`)
- [ ] No new drop-in named `role.conf` is created
- [ ] All 756 existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] `<HealthBadge>` UI untouched
- [ ] No check semantics changed

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

Belong in separate briefs:

1. **Post-receive hook auto-deploys the dashboard server bundle on push** — eliminate the manual `scp dist/dashboard/server.mjs … && ssh … "systemctl restart memory-dashboard"` dance. Either a git post-receive hook on the VPS bare repo, or a GitHub Actions deploy on push to main with SSH key auth, so the live dashboard tracks main automatically.
2. **Surface `MEMORY_ROOT` in the CLI help output** — `memory --help` and `memory verify --help` should document `MEMORY_ROOT` and `MEMORY_ROLE` as recognized environment variables, since they materially change behavior. Today they are undocumented operator folklore.
3. **Run verify against a remote vault over SSH** — `memory verify --remote root@srv1317946:/root/memory-system/vault` for cross-machine sanity checks. Useful for confirming the VPS-side health from an operator's laptop without curling `/api/health`. Would need a small remote-exec wrapper around `runVerify({ vaultRoot })`.
