# Install VPS

`memory install-vps` lays out the Phase 3 server-side directory tree on the VPS over SSH. It creates `/root/memory-system/`, initializes the bare memory git repository, locks down permissions, writes install metadata, and installs the memory-owned systemd units for the dashboard placeholder and local backups. It does not touch Tailscale Serve, Caddy, Vaultwarden, or any existing non-memory service configuration.

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

## Systemd Integration

The installer writes three unit files under `/etc/systemd/system/`:

- `memory-dashboard.service` runs a minimal Node placeholder dashboard on `127.0.0.1:4410`.
- `memory-backup.service` runs `/root/memory-system/services/memory-backup.sh` as a one-shot backup job.
- `memory-backup.timer` triggers the backup service daily at `04:00 UTC`.

The dashboard placeholder responds on `/healthz` with `ok` and serves a small HTML page that says the real dashboard ships in Phase 3 Slice 6. It binds to localhost only; Tailscale routing is added later.

Backups are local tarballs under `/root/memory-system/backups/`. The backup script archives `memory.git`, `vault`, `services`, `env`, and `install-info.json`, skips logs and backups, and keeps the last 30 daily archives. The `04:00 UTC` schedule intentionally avoids the known `03:00 UTC` Vaultwarden and OpenClaw backup windows.

Inspect the units:

```powershell
ssh root@srv1317946 'systemctl status memory-dashboard'
ssh root@srv1317946 'systemctl list-timers memory-backup.timer --no-pager'
ssh root@srv1317946 'journalctl -u memory-dashboard --no-pager -n 50'
```

Disable them if needed:

```powershell
ssh root@srv1317946 'systemctl disable --now memory-dashboard memory-backup.timer'
```

## Idempotency

Re-running the command is safe. If `/root/memory-system/` already exists, the command skips the directory creation step. The bare repository step is guarded with `[ -d /root/memory-system/memory.git ] || git init --bare ...`, so it is harmless on repeat runs. `install-info.json` is refreshed with the latest install timestamp. The systemd templates and scripts are re-uploaded each time, then `systemctl daemon-reload` and `systemctl enable --now ...` are run idempotently.

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
