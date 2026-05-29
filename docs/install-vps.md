# Install VPS

`memory install-vps` lays out the Phase 3 server-side directory tree on the VPS over SSH. It creates `/root/memory-system/`, initializes the bare memory git repository, locks down permissions, writes install metadata, and installs the memory-owned systemd units for the read-only dashboard and local backups. It does not touch Tailscale Serve, Caddy, Vaultwarden, or any existing non-memory service configuration.

## Prerequisites

- Tailscale SSH access to the VPS as `root`
- `git` installed on the VPS
- The local CLI has been built with `npm run build`

## Defaults

- Host: `srv1317946`
- Install root: `/root/memory-system`

You can override both:

```powershell
node dist/cli.mjs install-vps --ssh-host srv1317946 --install-root /root/memory-system
```

Expected output:

```text
VPS install complete at srv1317946:/root/memory-system
  steps: 18
  services changed: no
  node path:        /usr/local/node22/bin/node
  dashboard:        active
  backup timer:     active
  backup next:      2026-05-23T04:00:00Z
  healthz:          ok
```

If the service snapshots differ before and after the run, the command exits non-zero and prints a warning. That means something outside the expected directory layout changed and should be inspected before continuing.

## Dry Run

Use `--dry-run` to print the SSH commands without executing them:

```powershell
node dist/cli.mjs install-vps --dry-run
```

Each line is printed in this format:

```text
[dry-run] $ ssh srv1317946 'tailscale serve status'
```

## Directory Layout

After install, the VPS has:

```text
/root/memory-system/
├── backups/
├── env/
├── logs/
├── memory.git/
├── services/
├── vault/
└── install-info.json
```

`/root/memory-system/` and `/root/memory-system/env/` are mode `700`. Future environment files should live under `env/` and remain root-only.

## Voyage API key

For Phase 3 search (Slices 11+), the VPS needs a Voyage AI API key. Create `/root/memory-system/env/voyage.env` with `VOYAGE_API_KEY=<your-key>` (one line) and `chmod 600`. The key lives in Vaultwarden on this VPS. Future systemd units that need Voyage (dashboard, MCP search backend) will load this file via `EnvironmentFile=` in their unit definitions.

## Systemd Integration

The installer writes three unit files under `/etc/systemd/system/`:

- `memory-dashboard.service` runs the read-only Node dashboard on `127.0.0.1:4410`.
- `memory-backup.service` runs `/root/memory-system/services/memory-backup.sh` as a one-shot backup job.
- `memory-backup.timer` triggers the backup service daily at `04:00 UTC`.

The service units keep `User=root` for the current `/root/memory-system` layout, but run with systemd hardening (`NoNewPrivileges`, strict system protection, private tmp, read-only home, restricted namespaces/address families, and narrow write paths). `MemoryDenyWriteExecute` is intentionally not enabled because Node/V8 JIT compatibility should be validated separately before applying that restriction. The env directory is `0700`, and env files are reset to `0600` on install.

Slice 6 replaced the original placeholder with `dashboard.mjs`, which imports the bundled dashboard server from `dashboard-bundle.mjs`. The older `dashboard-placeholder.mjs` file remains on disk as a fallback reference, but systemd no longer points at it. The dashboard responds on `/healthz` with `ok`, exposes `/api/status` as JSON, and serves server-rendered HTML at `/`. It binds to localhost only; Tailscale Serve owns the tailnet-only `/memory/` route.

Slice 7 adds read-only browse pages and JSON endpoints for the curated vault: `/wiki/` and `/api/wiki` list wiki pages by category, `/wiki/<category>/<slug>` and `/api/wiki/<category>/<slug>` show one page with resolved relations and inbound references, `/raw/` and `/api/raw` list raw sessions by date, `/raw/<date>/<filename>` and `/api/raw/<date>/<filename>` show one raw file, and `/log` plus `/api/log?lines=N` tail `log.md`. The HTML views are server-rendered and escape vault content; markdown bodies are intentionally shown as plain text for this phase.

Backups are local tarballs under `/root/memory-system/backups/`. The backup script archives `memory.git`, `vault`, `services`, `env`, and `install-info.json`, skips logs and backups, writes to a temporary archive first, verifies the archive is non-empty and listable, then moves it into place before rotating older archives. A `tar` failure exits non-zero and does not print a success message. The `04:00 UTC` schedule intentionally avoids the known `03:00 UTC` Vaultwarden and OpenClaw backup windows. Because `env/` is included, backup archives are sensitive and should remain permission-restricted.

Inspect the units:

```powershell
ssh root@srv1317946 'systemctl status memory-dashboard'
ssh root@srv1317946 'systemctl status memory-backup.timer'
ssh root@srv1317946 'systemctl list-timers memory-backup.timer --no-pager'
ssh root@srv1317946 'journalctl -u memory-dashboard --no-pager -n 50'
ssh root@srv1317946 'journalctl -u memory-backup --no-pager -n 50'
ssh root@srv1317946 '/root/memory-system/services/memory-backup.sh --verify /root/memory-system/backups/<archive>.tar.gz'
```

Disable them if needed:

```powershell
ssh root@srv1317946 'systemctl disable --now memory-dashboard memory-backup.timer'
```

## Idempotency

Re-running the command is safe. If `/root/memory-system/` already exists, the command skips the directory creation step. The bare repository step is guarded with `[ -d /root/memory-system/memory.git ] || git init --bare ...`, so it is harmless on repeat runs. `install-info.json` is refreshed with the latest install timestamp. The systemd templates and scripts are re-uploaded each time, then `systemctl daemon-reload`, `systemctl enable --now ...`, and a dashboard restart are run idempotently so the latest dashboard bundle is active.

## Troubleshooting

**SSH refused**

Check that Tailscale is connected locally and that the VPS is reachable:

```powershell
tailscale status
tailscale ping srv1317946
```

**Permission denied**

Confirm you can SSH as root:

```powershell
ssh root@srv1317946 'whoami'
```

The command writes under `/root/memory-system/`, so non-root accounts usually cannot complete the install.

**git init failed**

Confirm `git` is installed on the VPS:

```powershell
ssh root@srv1317946 'git --version'
```
