# Install VPS

`memory install-vps` lays out the Phase 3 server-side directory tree on the VPS over SSH. It is intentionally narrow: it creates `/root/memory-system/`, initializes the bare memory git repository, locks down permissions, and writes install metadata. It does not touch Tailscale Serve, Caddy, Vaultwarden, or any existing service configuration.

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
  steps: 5
  services changed: no
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

## Idempotency

Re-running the command is safe. If `/root/memory-system/` already exists, the command skips the directory creation step. The bare repository step is guarded with `[ -d /root/memory-system/memory.git ] || git init --bare ...`, so it is harmless on repeat runs. `install-info.json` is refreshed with the latest install timestamp.

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
