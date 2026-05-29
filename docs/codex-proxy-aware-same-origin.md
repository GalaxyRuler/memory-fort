# Codex Implementation Brief — Proxy-Aware Same-Origin Check (Phase 4.3.T)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The dashboard's same-origin CSRF guard rejects **legitimate same-origin requests** when the dashboard is accessed through a TLS-terminating reverse proxy (Tailscale Serve, which is how the operator reaches it). Symptom reported: clicking "Run compile now" returns `403 cross-origin compile runs are not allowed`. The same failure affects PATCH `/api/config` and the `/api/proposed/promote|reject` endpoints — all three share one guard.

### Root cause

`sameOriginAllowed` in `src/dashboard/server.ts`:

```ts
function sameOriginAllowed(reqOrigin: string | undefined, requestUrl: URL): boolean {
  if (!reqOrigin) return true;
  return reqOrigin === requestUrl.origin;
}
```

`requestUrl` is built from the backend's view: `new URL(req.url, \`http://${req.headers.host}\`)` — always `http://`, because the Node server itself is plain HTTP. The deployment topology:

```
browser  ──HTTPS──►  Tailscale Serve (TLS termination)  ──HTTP──►  127.0.0.1:4410 (dashboard)
   Origin: https://srv1317946.tail6916d8.ts.net          Host: 127.0.0.1:4410 (or rewritten)
```

So on a mutating request the browser sends `Origin: https://srv1317946.tail6916d8.ts.net`, but `requestUrl.origin` reconstructs to `http://127.0.0.1:4410` (or `http://srv1317946...` — either way the **scheme is http, not https**). `reqOrigin === requestUrl.origin` is false → 403. The guard can never pass behind a TLS-terminating proxy.

`tailscale serve` confirms the topology: `/memory proxy http://127.0.0.1:4410`, fronted by `https://srv1317946.tail6916d8.ts.net`.

### Why the fix is safe

The dashboard binds to **127.0.0.1 only** (`dashboard listening on http://127.0.0.1:4410`). It is not reachable from the network except through Tailscale Serve. Tailscale Serve sets `X-Forwarded-Proto` and `X-Forwarded-Host` on proxied requests. A remote attacker cannot set forged `X-Forwarded-*` headers because they cannot reach the backend directly — they must traverse Tailscale Serve, which sets these headers itself. Therefore reconstructing the effective external origin from `X-Forwarded-Proto`/`X-Forwarded-Host` (when present) is trustworthy in this topology, and restores a correct same-origin comparison without weakening CSRF protection.

---

## Scope guard

You will:

### Task 1 — Make `sameOriginAllowed` proxy-aware

- Reconstruct the **effective request origin** from forwarded headers when present:
  - scheme = `X-Forwarded-Proto` (first value if comma-list) ?? `requestUrl.protocol`-derived
  - host = `X-Forwarded-Host` (first value) ?? `req.headers.host`
  - effective origin = `${scheme}://${host}`
- `sameOriginAllowed(reqOrigin, req)` returns true when:
  - `reqOrigin` is absent (non-browser / same-origin fetch with no Origin — unchanged), OR
  - `reqOrigin` equals the **effective** origin (proxy-aware), OR
  - `reqOrigin` equals the direct `requestUrl.origin` (preserves today's behavior for direct localhost access, e.g. `http://127.0.0.1:4410`)
- Signature change is fine (pass `req` or the headers in, not just the pre-built URL) — update the three call sites
- Normalize before comparing: lowercase host, strip a trailing `:443` for https / `:80` for http, strip trailing slash. Avoid false mismatches on default ports

### Task 2 — Optional explicit allowlist (defense + escape hatch)

- Support an optional `dashboard.trusted_origins: string[]` in `~/.memory/config.yaml`. If set, an `Origin` exactly matching any entry is allowed regardless of forwarded-header reconstruction
- Default empty. This is a belt-and-suspenders escape hatch for unusual proxy setups; the Task 1 reconstruction should make it unnecessary for Tailscale Serve
- Add `dashboard.trusted_origins` to the config-patch safelist (it's a non-secret setting) so it's editable from Settings later if needed — but no UI is required in this brief

### Task 3 — Tests

- Unit tests for the origin logic:
  - Direct localhost: `Origin: http://127.0.0.1:4410`, Host `127.0.0.1:4410`, no forwarded headers → allowed (today's behavior preserved)
  - **The bug case**: `Origin: https://srv1317946.tail6916d8.ts.net`, `X-Forwarded-Proto: https`, `X-Forwarded-Host: srv1317946.tail6916d8.ts.net`, backend Host `127.0.0.1:4410` → **allowed**
  - Genuine cross-origin: `Origin: https://evil.example.com` with forwarded headers for the real host → **rejected (403)**
  - No Origin header → allowed (unchanged)
  - `trusted_origins` match → allowed; non-match falls through to reconstruction
- Update `test/dashboard/server.test.ts` cross-origin assertions to cover all three endpoints (config PATCH, proposed promote/reject, compile run) with the proxy-header scenario. The existing "cross-origin rejected" tests must still pass for the genuine-evil case

### Task 4 — Docs

- `templates/schema.md`: document that the dashboard honors `X-Forwarded-Proto`/`X-Forwarded-Host` for same-origin checks (for reverse-proxy deployments) and the optional `dashboard.trusted_origins`
- `docs/ROADMAP.md`: Phase 4.3.T shipped 2026-05-28 — proxy-aware same-origin guard

You will **not**:

- Weaken CSRF protection. A genuinely cross-origin `Origin` (not matching the effective host) must still be rejected. The fix recognizes the real external origin behind the proxy; it does not allow arbitrary origins
- Trust `X-Forwarded-*` to *grant* access beyond origin reconstruction. They only reconstruct the effective host/scheme for the equality check; an attacker setting `X-Forwarded-Host: evil.com` would just make the check compare against evil.com, which won't match the browser's real Origin for a real victim
- Bind the dashboard to anything other than 127.0.0.1, or change the Tailscale Serve config. The localhost binding is what makes trusting the proxy headers safe — keep it
- Remove the same-origin guard or add a blanket "allow all" mode
- Require `trusted_origins` to be set for normal operation. Task 1 must make Tailscale Serve work out of the box with no config

If `X-Forwarded-Host` turns out NOT to be set by Tailscale Serve in this deployment (verify against a real proxied request), fall back to comparing **host-only** (ignore scheme) between `Origin` and `Host` — still safe given the localhost binding — and note the decision. **Stop and ask** if neither forwarded headers nor host-only comparison cleanly resolves it.

---

## Repo orientation

- `src/dashboard/server.ts` — `sameOriginAllowed` (~line 252) and its three call sites: PATCH `/api/config` (~388), `/api/proposed/promote|reject` (~412), `/api/compile/run` (~438). The request handler already builds `url` from `req.headers.host`; forwarded headers are on `req.headers["x-forwarded-proto"]` / `["x-forwarded-host"]`
- `src/dashboard/config-patch.ts` — safelist; add `dashboard.trusted_origins` if doing Task 2
- `src/storage/config.ts` — config schema for `dashboard.trusted_origins`
- `test/dashboard/server.test.ts` — existing same-origin tests to extend

---

## Acceptance contract

1. A POST to `/api/compile/run` with `Origin: https://srv1317946.tail6916d8.ts.net` + `X-Forwarded-Proto: https` + `X-Forwarded-Host: srv1317946.tail6916d8.ts.net` (backend Host `127.0.0.1:4410`) is **allowed** (not 403)
2. The same fix applies to PATCH `/api/config` and `/api/proposed/promote|reject`
3. Direct localhost access (`http://127.0.0.1:4410`, no forwarded headers) still works
4. A genuinely cross-origin request (`Origin: https://evil.example.com`) is still **rejected**
5. No Origin header → still allowed (unchanged)
6. Tests cover all four scenarios across all three endpoints; existing reject-the-evil-origin tests still pass
7. Full suite passes (run ALL of it); `npm run typecheck` clean; build + build:ui clean; `git diff --check` clean

---

## Verification commands

Operator runs after the brief lands + redeploy:

```powershell
# From the operator's machine, through the real Tailscale URL, in the browser:
#   open https://srv1317946.tail6916d8.ts.net/memory/  -> Settings or Compile -> Run compile now
#   should NOT show "cross-origin ... not allowed"

# Or simulate the proxied request shape against the VPS backend:
ssh root@srv1317946 "curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4410/memory/api/compile/run -H 'Origin: https://srv1317946.tail6916d8.ts.net' -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-Host: srv1317946.tail6916d8.ts.net' -H 'Content-Type: application/json' -d '{}'"
# Expect 200/409 (allowed), NOT 403

# Genuine cross-origin still blocked:
ssh root@srv1317946 "curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4410/memory/api/compile/run -H 'Origin: https://evil.example.com' -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-Host: srv1317946.tail6916d8.ts.net' -d '{}'"
# Expect 403
```

---

## Commit boundaries

- Task 1: `fix: proxy-aware same-origin check honoring X-Forwarded-* (Phase 4.3.T Task 1)`
- Task 2: `feat: optional dashboard.trusted_origins allowlist (Phase 4.3.T Task 2)`
- Task 3: `test: same-origin behind reverse proxy across mutating endpoints (Phase 4.3.T Task 3)`
- Task 4: `docs: proxy-aware same-origin guard (Phase 4.3.T Task 4)`

---

## Context

This blocks all dashboard write actions through the hosted (Tailscale) URL: settings edits, inbox promote/reject, and compile run. The operator can currently only mutate via direct `http://127.0.0.1:4410` or the CLI. Land this so the hosted dashboard is fully usable. Same security posture preserved — genuine cross-origin stays blocked; the fix just recognizes the real origin behind the TLS-terminating proxy.
