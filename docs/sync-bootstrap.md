# Sync Bootstrap

`memory sync-bootstrap` connects the local `~/.memory/` git repository to the VPS bare repository and installs the VPS checkout hook. After this runs, local pushes to the `vps` remote land in `/root/memory-system/memory.git`, and the post-receive hook checks the pushed `main` branch out into `/root/memory-system/vault/` for dashboard and retrieval services to read.

## Prerequisites

- `memory install-vps` has already run on the VPS
- Tailscale SSH to the VPS as root works
- Local `~/.memory/` exists and is a git repository from `memory init`

## Defaults

- Remote name: `vps`
- Host: `srv1317946`, or `vps.host` from `~/.memory/config.yaml`
- SSH user: `root`, or `vps.ssh_user` from `~/.memory/config.yaml`
- VPS install root: `/root/memory-system`, or `vps.install_root` from config
- Branch: `main`

Run the bootstrap:

```powershell
node dist/cli.mjs sync-bootstrap
```

Expected output:

```text
Sync bootstrap complete.
  remote:           vps -> root@srv1317946:/root/memory-system/memory.git
  remote created:   yes (new)
  post-receive:     installed
  initial push:     performed
```

## What Gets Installed

The command uploads `templates/vps/post-receive.sh` to:

```text
/root/memory-system/memory.git/hooks/post-receive
```

It then marks the hook executable. The hook writes checkout activity to:

```text
/root/memory-system/logs/checkout.log
```

On every push to `main`, the hook checks the new commit out into:

```text
/root/memory-system/vault/
```

## Idempotency

Re-running the command is safe. If the `vps` remote already exists with the same URL, it is left alone. If it exists with a different URL, it is updated with `git remote set-url`. The post-receive hook is re-uploaded every time so improvements to the template ship cleanly. The initial push is skipped when the remote already has commits on the target branch.

## Troubleshooting

**SSH refused**

Check Tailscale reachability and root SSH:

```powershell
tailscale ping srv1317946
ssh srv1317946 true
```

**Push rejected**

The remote may already contain commits that the local repo does not have. Inspect the remote and pull or rebase deliberately before pushing again:

```powershell
git -C "$env:USERPROFILE\.memory" ls-remote vps main
git -C "$env:USERPROFILE\.memory" status
```

**Hook not firing**

Confirm the hook exists and is executable:

```powershell
ssh root@srv1317946 'ls -la /root/memory-system/memory.git/hooks/post-receive'
```

Then inspect the checkout log:

```powershell
ssh root@srv1317946 'tail -50 /root/memory-system/logs/checkout.log'
```
