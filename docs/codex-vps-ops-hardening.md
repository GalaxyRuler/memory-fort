# Codex Implementation Brief — VPS Ops Hardening (Phase 4.11)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Two VPS operational findings from the 2026-05-29 audit, verified against the templates.

### F-03 — backup script masks `tar` failure and reports success (HIGH)

`templates/scripts/memory-backup.sh` (~L16) runs `tar -czf "$ARCHIVE" ... 2>/dev/null || true` and (~L21) unconditionally echoes a completion/success message. A failed `tar` (disk full, permission error, missing source) produces a 0-byte or absent archive but the script exits 0 and logs "backup complete". `install-vps.ts` (~L511-540) deploys this as a systemd `backup.service` + `backup.timer`, so **backups can silently fail forever** while reporting success. This is the worst kind of reliability bug — it's invisible until a restore is attempted.

### F-02 — dashboard systemd unit runs as root with no hardening (MEDIUM)

`templates/systemd/memory-dashboard.service` (~L8) sets `User=root` with no hardening directives. Mitigations exist (binds `127.0.0.1`, exposed only via private Tailscale, same-origin CSRF guard), so network surface is operator-controlled — but a process flaw or proxy mistake has root blast radius over the vault + `env/` secrets. Defense-in-depth is cheap here.

---

## Scope guard

You will:

### Task 1 — Backup fails closed + verifiable (F-03)

- Rewrite `templates/scripts/memory-backup.sh` to **fail loudly**:
  - Remove `|| true` from the `tar` invocation. Use `set -euo pipefail` at the top.
  - Check `tar`'s exit code explicitly; on failure, log the error (stderr + a log file under `logs/`) and `exit 1` — do NOT print success.
  - After a successful `tar`, verify the archive is non-empty and listable (`tar -tzf "$ARCHIVE" >/dev/null`) before printing success; treat a 0-byte/corrupt archive as failure.
  - Keep the rotation/retention of old archives, but never delete the previous good archive until the new one is verified.
- The systemd `backup.service` should surface failures: ensure it does not mask non-zero exit (no `|| true` in the unit), and document checking `systemctl status memory-backup.timer` / `journalctl -u memory-backup`.
- Add a **restore-verification** affordance: a documented `memory-restore.sh --verify <archive>` (or a section in the script) that lists/dry-run-extracts an archive so the operator can confirm a backup is restorable. (Implement the verify path at minimum; full restore can be documented.)
- Add a shell-level test (or a Node test that runs the script with a stubbed failing `tar`) asserting: failing `tar` → non-zero exit + no "complete" message; succeeding `tar` → archive verified + success only then.
- Update `docs/MEMORY-FORT-SPEC.md` §17 (deployment) + the backup section: document that backups fail closed, how to monitor the timer, and the restore-verification step. Note `env/` is included in backups → backups must be permission-restricted (and consider encryption — see Task 2 note).

### Task 2 — Least-privilege + hardened dashboard service (F-02)

- Update `templates/systemd/memory-dashboard.service` with systemd hardening directives (these work even while keeping `User=root` initially, but prefer a dedicated user):
  - Prefer a dedicated service user (e.g. `User=memory`, `Group=memory`) owning `/root/memory-system` — OR, if migrating ownership is out of scope for this pass, keep root but **add** the hardening directives and note the dedicated-user migration as a follow-up.
  - Add: `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `ProtectHome=read-only` (or `tmpfs`), `ReadWritePaths=/root/memory-system`, `ProtectKernelTunables=yes`, `ProtectControlGroups=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `RestrictNamespaces=yes`, `LockPersonality=yes`, `MemoryDenyWriteExecute=yes` (verify Node tolerates this; if it breaks the JIT, drop just this one), `SystemCallFilter=@system-service`.
  - Restrict `env/` file permissions to `0600` and document it.
- Apply the same hardening to `backup.service` where applicable (it needs read of the vault + write of the archive dir only).
- Update `docs/MEMORY-FORT-SPEC.md` §16/§17: document the deployment threat model explicitly — single-user, 127.0.0.1-bound, Tailscale-private exposure, same-origin CSRF as the auth boundary, and the systemd hardening as defense-in-depth. State plainly that there is **no token/mTLS auth** today and that remote (non-Tailscale) exposure is unsupported without adding one.
- If `memory install-vps` writes these unit files programmatically (`src/cli/commands/install-vps.ts`), update the generator to emit the hardened units; keep templates and generator in sync. Update/extend `test/cli/commands/install-vps.test.ts` to assert the hardening directives are present in the generated unit.

You will **not**:

- Change the dashboard's bind host or the Tailscale Serve route.
- Add token/mTLS auth in this brief (note it as the path for remote exposure, but it's a separate feature).
- Hard-delete the prior good backup before verifying the new one.
- Break Node under `MemoryDenyWriteExecute` — if the runtime needs W^X for JIT, omit that single directive and note why.
- Remove the CLI `backup` stub or change the local (non-VPS) flow — this is the VPS systemd path.

If migrating `/root/memory-system` to a dedicated non-root user turns out to require chowning live data + reworking the bare-repo/post-receive ownership (risky on a live box), **stop and ask** — ship the hardening directives on the current user first and split the user migration into its own change.

---

## Repo orientation

- `templates/scripts/memory-backup.sh` — the masking bug.
- `templates/systemd/memory-dashboard.service` (+ any `backup.service`/`backup.timer` templates under `templates/systemd/`).
- `src/cli/commands/install-vps.ts` ~L509-540 — deploys the script + units (and may generate unit text).
- `test/cli/commands/install-vps.test.ts` — assert hardened units + fail-closed script.
- `docs/MEMORY-FORT-SPEC.md` §16 (security), §17 (deployment).

---

## Acceptance contract

1. `memory-backup.sh` exits non-zero and prints no success on `tar` failure; verifies archive integrity before reporting success; never deletes the last good archive before verifying the new one.
2. A restore-verification path exists and is documented.
3. The dashboard systemd unit carries the hardening directives (and ideally a dedicated user); `env/` is `0600`.
4. `install-vps` generates the hardened units; test asserts the directives.
5. Spec §16/§17 document the deployment threat model + backup fail-closed + restore verification.
6. Full suite + `npm run typecheck` green; build clean; `git diff --check` clean.

---

## Commit boundaries

- Task 1: `fix: backup script fails closed + verifies archive (Phase 4.11 Task 1)`
- Task 2: `feat: hardened least-privilege dashboard/backup systemd units (Phase 4.11 Task 2)`

---

## Note

Deploying the hardened units + fixed backup to the live VPS is an operator step after this lands (`memory install-vps` re-run, or manual unit replacement + `systemctl daemon-reload`). Flag it; don't auto-deploy from the brief.
