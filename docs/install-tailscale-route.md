# Install Tailscale Route

`memory install-tailscale-route` adds the `/memory/` subpath route to the VPS Tailscale Serve configuration. It makes the memory dashboard placeholder reachable from any Tailnet-connected device while preserving the existing root and `:8443` routes.

## Prerequisites

- Phase 3 Slices 1-4 have run successfully.
- `memory-dashboard.service` is active on the VPS.
- The dashboard answers locally on the VPS at `http://127.0.0.1:4410/healthz`.
- Tailscale Serve is already configured with:
  - `/` -> `http://127.0.0.1:18789`
  - `:8443 /` -> `http://127.0.0.1:5678`

The command refuses to modify Tailscale Serve if either existing route is missing.

## Defaults

- Host: `srv1317946`
- Path prefix: `/memory`
- Dashboard target: `http://127.0.0.1:4410`

Run it:

```powershell
node dist/cli.mjs install-tailscale-route
```

Expected output:

```text
Tailscale route install complete.
  host:             srv1317946
  route:            /memory -> http://127.0.0.1:4410
  already configured: no
  reachability VPS:   ok
  reachability local: ok
  serve command:      tailscale serve --bg --https=443 --set-path=/memory http://127.0.0.1:4410
```

## Dry Run

Use `--dry-run` to print the Serve command without applying it:

```powershell
node dist/cli.mjs install-tailscale-route --dry-run
```

The command still reads the current Tailscale Serve status first, so missing prerequisite routes are caught before you make changes.

## Before And After

Before:

```text
https://srv1317946.tail6916d8.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:18789

https://srv1317946.tail6916d8.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:5678
```

After:

```text
https://srv1317946.tail6916d8.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:18789
|-- /memory proxy http://127.0.0.1:4410

https://srv1317946.tail6916d8.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:5678
```

## Access

Open this URL from any Tailscale-connected device:

```text
https://srv1317946.tail6916d8.ts.net/memory/
```

Health check:

```powershell
curl -sS https://srv1317946.tail6916d8.ts.net/memory/healthz
```

The route is Tailscale-only. From a non-Tailscale connection, the `tail6916d8.ts.net` URL should not be publicly reachable.

## Troubleshooting

**Existing route missing**

Run:

```powershell
ssh root@srv1317946 'tailscale serve status'
```

If root or `:8443` is missing, stop and inspect before retrying. The installer intentionally refuses to rewrite a diverged Serve configuration.

**Serve syntax changed**

This slice uses Tailscale `1.98.3` syntax:

```text
tailscale serve --bg --https=443 --set-path=/memory http://127.0.0.1:4410
```

If a future Tailscale release changes Serve flags, check the current docs and `tailscale serve --help` on the VPS before rerunning.

**Reachability fails**

Confirm the dashboard service is healthy locally first:

```powershell
ssh root@srv1317946 'systemctl is-active memory-dashboard && curl -sS http://127.0.0.1:4410/healthz'
```

Then confirm the Tailnet route:

```powershell
curl -sS https://srv1317946.tail6916d8.ts.net/memory/healthz
```
