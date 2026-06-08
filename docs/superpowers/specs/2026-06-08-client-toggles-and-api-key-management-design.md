# Client Toggles & API Key Management — Design

**Date:** 2026-06-08
**Status:** Approved (design), pending implementation plan
**Author:** a.o.alkulaib@gmail.com + Claude

## Motivation

Memory Fort is moving from a single-user tool (built by one person who set
env vars once and forgot them) toward something other people can adopt. Two
gaps block that:

1. **Client warnings for clients you don't use.** `memory verify` auto-detects
   clients (Claude Code, Codex, Antigravity, OpenCoven) and nags with warnings
   when an apparently-installed client has no recent captures. A user who only
   runs Claude Code shouldn't be warned about Codex forever.

2. **No in-app API key entry.** Embedder/LLM keys are read from environment
   variables only (`VOYAGE_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`).
   The settings UI lets a user pick a provider but gives nowhere to enter the
   key. Fine for the original author; a blocker for public users who each bring
   their own keys.

These are two separate features sharing one theme ("make it configurable per
user"). They ship together but are specified and built independently.

---

## Feature 1 — Client Toggles

### Behavior

A user can turn a client OFF. When off:
- `memory verify` goes **silent** for that client (no warn, no fail).
- The dashboard client card renders **dimmed/dark** with an "Off" badge so the
  user can see at a glance that it's intentionally disabled (not broken).
- **Capture/ingest is untouched.** If a disabled client ever sends data, it is
  still ingested normally. The toggle affects verify noise + card appearance
  only.

Default when unset = **enabled** (`true`), so existing installs see no change.

### Config

State lives in the vault `config.json` — it is not a secret.

```jsonc
{
  "clients": {
    "claude-code": { "enabled": true },
    "codex":       { "enabled": false },
    "antigravity": { "enabled": true },
    "opencoven":   { "enabled": true }
  }
}
```

### Components

- **`storage/config.ts`** — add `clients` section to the schema + validation
  (each entry's `enabled` must be boolean if present). Helper
  `isClientEnabled(config, id): boolean` returning `true` when absent.
- **`verify/types.ts`** — `CheckStatus` is currently `"pass" | "warn" | "fail"`
  with no neutral state. Add `"skip"` → `"pass" | "warn" | "fail" | "skip"`,
  plus a `skip(id, label, detail)` helper alongside `pass`/`warn`/`fail`. The
  verify reporter renders `skip` as silent (omitted or a dim "skipped" line),
  and `skip` does **not** count toward warn/fail exit codes.
- **`verify/clients.ts`** — every per-client check consults `isClientEnabled`.
  When `false`, the check short-circuits to `skip(...)` so verify output stays
  silent for that client.
- **Dashboard UI** — a `ClientToggle` control flips
  `config.clients[id].enabled` through the existing `PATCH /api/config` route
  (no new endpoint). The client card reads `enabled` and applies dimmed/dark
  styling + "Off" badge when false.

### Error handling

- Invalid `enabled` value in config → existing config-validation warning path.
- `PATCH /api/config` failure → existing error surface on the settings page.

### Testing

- Unit: `isClientEnabled` default-true behavior; config validation rejects
  non-boolean `enabled`.
- Unit: a disabled client check returns `skip`, not warn/fail; `skip` does not
  affect verify exit code.
- UI: disabled client card renders dimmed + "Off" badge; toggle issues the
  expected `PATCH`.

---

## Feature 2 — API Key Management

### Where keys live (security-critical)

Keys are stored in a secrets file **outside** the git-backed vault, never under
`~/.memory`. Path resolution, in priority order:

1. `$MEMORY_SECRETS_PATH` (explicit override)
2. OS config dir:
   - Windows: `%APPDATA%\memory-fort\secrets.json`
   - macOS: `~/Library/Application Support/memory-fort/secrets.json`
   - Linux: `~/.config/memory-fort/secrets.json`

The file is written with `0600` (owner-only) permissions where the OS supports
it. A `scan-leaks` guard test asserts the resolved secrets path can never fall
inside the vault root.

```jsonc
// secrets.json
{
  "VOYAGE_API_KEY": "...",
  "OPENAI_API_KEY": "...",
  "OPENROUTER_API_KEY": "..."
}
```

### How keys reach the code

Existing code reads `env["VOYAGE_API_KEY"]` etc. throughout. A new
`loadSecrets()` runs once at CLI/dashboard startup and layers the secrets file
**under** real environment variables:

```
effective key = process.env[KEY] ?? secretsFile[KEY]
```

A real environment variable always wins, so the original author's
set-and-forget env setup keeps working unchanged; public users get the file
path. Existing consumers (`makeConfiguredVoyageClient`, `createLLMFromConfig`,
…) are not modified — they see a populated `env` as before.

### Settings UI — test-then-save + masked display

`EmbedderConfigCard` (Voyage / OpenAI) and `LLMConfigCard` (OpenRouter) each
gain a key field:

- **Unset:** input box + "Save key" button.
- **On save:** the server fires one cheap real API call for that provider
  (tiny embed request / models ping). Valid → persist to the secrets file and
  show a green check. Invalid → reject, persist nothing, show the provider's
  error inline.
- **Saved:** the field shows `••••••••<last4>`; click to reveal; "Replace" to
  re-enter a new key.

### Endpoints

- **`PUT /api/secrets`** — body `{ provider, key }` → validate → write file.
  The key is never echoed back in the response.
- **`GET /api/secrets`** — returns only `{ provider, present: boolean, last4 }`
  per provider. **Never** returns a full key.

### Validation per provider

A `validateKey(provider, key, env)` function maps each provider to its cheapest
authenticated call:
- Voyage / OpenAI → a minimal embeddings request.
- OpenRouter → a models/auth ping.
Returns `{ ok: true }` or `{ ok: false, message }`.

### Error handling

- Validation failure → `422` + provider error message surfaced inline; nothing
  written.
- Secrets-file write failure (e.g. permissions) → clear error:
  "couldn't write secrets to `<path>`".
- Bad/expired key discovered at query time → existing `ConfigStatusPill` still
  goes red as a backstop.

### Components

- **`secrets/store.ts`** — path resolution, load, read, write, `0600` perms.
- **`secrets/validate.ts`** — per-provider `validateKey`.
- **Startup wiring** — call `loadSecrets()` + env layering in CLI and dashboard
  entrypoints.
- **2 endpoints** in `dashboard/server.ts` (`PUT`/`GET /api/secrets`).
- **UI** — key field on `EmbedderConfigCard` + `LLMConfigCard` (masked display,
  reveal, replace, test-then-save flow).
- **`scan-leaks` guard test** — secrets path is outside the vault.

### Testing

- Unit: `secrets/store.ts` path resolution never resolves inside the vault
  (explicit assertion); env-over-file precedence; `0600` write.
- Unit: `validateKey` ok/fail per provider with a mocked HTTP client.
- Integration: `PUT /api/secrets` validate→persist with a mocked provider;
  `GET /api/secrets` returns `present`/`last4` and never the full key.
- Guard: scan-leaks test proving the secrets path is outside `~/.memory`.
- UI: masked display + reveal; test-then-save success and failure paths.

---

## Non-goals (YAGNI)

- No OS keychain / credential-manager integration (chosen against for build
  cost; secrets file with `0600` is sufficient for v1).
- No full client disable (install-skip / capture-stop). Toggle is silence +
  dark card only.
- No per-key rotation policy, expiry tracking, or multi-profile key sets.
- No hiding of disabled client cards — they remain visible, just dimmed.

## Security summary

- Secrets never touch the git-backed vault.
- Secrets file `0600`; scan-leaks guard test enforces out-of-vault path.
- API responses never echo full keys (only `present` + `last4`).
- Real env vars override the file, preserving the existing trusted setup.
