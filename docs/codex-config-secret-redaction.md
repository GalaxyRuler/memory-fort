# Codex Implementation Brief — Robust Config Secret Redaction (Phase 4.3.M)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

A full-system checkup (2026-05-28) found a latent secret-leak path in the dashboard config API. Two issues compound:

1. **`redactConfig()` in `src/dashboard/loaders.ts` is a one-path allowlist.** It only redacts the exact path `voyage.api_key`:
   ```ts
   if (path.length === 1 && path[0] === "voyage" && key === "api_key" && ...) {
     result[key] = "[REDACTED]";
   }
   ```
   Any secret living at a different path — `llm.api_key`, `openrouter.api_key`, `voyage.apiKey` (camelCase), a nested `llm.options.token`, a future provider's key — passes through to the `GET /api/config` response un-redacted.

2. **`resolveVoyageApiKey()` in `src/retrieval/embedder/voyage.ts` reads the key from `config.yaml` as a fallback:**
   ```ts
   const configKey = config.voyage?.api_key?.trim();
   if (configKey) return configKey;
   ```
   This directly contradicts the project's stated security rule — *"API keys NEVER in config.yaml; env-var-only."* It means the system actively supports the exact pattern the redaction is trying to defend against.

Today nothing leaks because the operator keeps all keys in env vars (`VOYAGE_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`) and `config.yaml` carries no secrets. But the combination is a loaded gun: the moment any key lands in config.yaml (a future provider, a careless edit, a copy-paste), the one-path redaction won't catch it and the dashboard's `GET /api/config` will serve it to any same-origin caller.

This brief makes redaction defense-in-depth: redact by key-NAME anywhere in the config tree, and stop reading secrets from config.yaml.

---

## Scope guard

You will:

### Task 1 — Name-based recursive redaction

- Rewrite `redactConfig()` in `src/dashboard/loaders.ts` to redact any key whose name matches a secret pattern, at any depth, regardless of path:
  - Secret-key regex: `/(?:^|[_-])(api[_-]?key|apikey|secret|token|password|passwd|credential|private[_-]?key)s?$/i` — matches `api_key`, `apiKey`, `apikey`, `secret`, `access_token`, `password`, `private_key`, etc.
  - When a key matches AND its value is a non-empty string, replace with `"[REDACTED]"`
  - Recurse through nested objects and arrays as today
  - Keep the existing behavior of preserving non-secret values verbatim
- Add a unit test matrix in `test/dashboard/loaders.test.ts` (or wherever `redactConfig` is tested) covering: `voyage.api_key`, `llm.api_key`, `openrouter.api_key`, a camelCase `apiKey`, a deeply-nested `llm.options.access_token`, an array of objects containing a `secret`, and a confirmation that non-secret keys like `model`, `max_tokens`, `voyage.dim` survive untouched

### Task 2 — Stop reading secrets from config.yaml

- Modify `resolveVoyageApiKey()` in `src/retrieval/embedder/voyage.ts`:
  - Remove the `config.voyage?.api_key` fallback. Resolve from `process.env.VOYAGE_API_KEY` only
  - If the env var is missing, throw `VoyageUnavailableError` with a message pointing the operator at the env var (not config.yaml)
- Grep the codebase for any other config-key reads (`config.*api_key`, `config.*token`, `\.voyage\?\.api_key`, similar) and remove them. The embedder + LLM factories from Phase 4.3.A/B should already be env-only — verify and fix any stragglers
- Remove `api_key` from the `voyage` config schema in `src/storage/config.ts` if it's declared there, so the schema no longer advertises a place to put secrets. (If removing it breaks a type, replace with a comment documenting that keys are env-only.)

### Task 3 — Defense-in-depth test on the API path

- Add a test in `test/dashboard/server.test.ts` that seeds a config object containing a secret at a non-`voyage.api_key` path (e.g., `llm.api_key`), calls the `GET /api/config` handler, and asserts the response body contains `[REDACTED]` and never the raw secret value. This locks the end-to-end guarantee, not just the unit-level redaction

### Task 4 — Docs

- `templates/schema.md`: under the config/security section, state explicitly that (a) all provider secrets are env-var-only, (b) `config.yaml` must never contain keys, (c) the dashboard redacts any secret-named field defensively
- `docs/ROADMAP.md`: Phase 4.3.M shipped 2026-05-28 — security hardening from the full-system checkup

You will **not**:

- Add encryption-at-rest for config.yaml. Env-var-only is the model; the file shouldn't hold secrets at all
- Add authentication to the dashboard. Same-origin remains the boundary
- Redact non-secret config (models, dims, cadences, thresholds). Operators need to see those in the Settings UI
- Change the PATCH /api/config safelist from Phase 4.3.C. That already blocks writing to key paths; this brief is about the READ path and the resolver
- Touch the LLM audit log redaction (Phase 4.3.B). That's a separate, already-correct mechanism (hashes only)
- Over-match the secret regex such that it redacts legitimate fields. `token` in `max_tokens` must NOT be redacted — anchor the regex to full key names (the `(?:^|[_-])...s?$` anchoring handles `max_tokens` correctly because `tokens` is preceded by `_` and the stem is `token` — VERIFY this case explicitly in tests; if `max_tokens` gets redacted, tighten the pattern to exclude it)

**Critical test case**: `max_tokens` must survive un-redacted. The regex `(?:^|[_-])(...|token|...)s?$` would match `max_tokens` (stem `token`, preceded by `_`, trailing `s`). That's a false positive. Either add a negative-lookbehind for `max[_-]` or maintain an explicit non-secret allowlist (`max_tokens`, `max_token`) that overrides the redaction. **Get this right** — redacting `max_tokens` would break the Settings UI display. Write the test first (TDD), watch it fail, then fix the pattern.

---

## Repo orientation

- `src/dashboard/loaders.ts` ~line 1331 — `redactConfig()`. The rewrite target
- `src/dashboard/server.ts` ~line 1206 — where `redactConfig` is applied to the `GET /api/config` response
- `src/retrieval/embedder/voyage.ts` ~line 145 — `resolveVoyageApiKey()` with the config fallback to remove
- `src/storage/config.ts` ~line 23 — the `voyage` config schema; remove `api_key` field if present
- `src/llm/factory.ts` ~line 70 and `src/retrieval/embedder/factory.ts` ~line 66 — already env-only per the audit; verify
- `test/dashboard/server.test.ts`, `test/dashboard/loaders.test.ts` (create if absent) — test homes

---

## Acceptance contract

1. `redactConfig` redacts any secret-named key (`api_key`, `apiKey`, `secret`, `*_token`, `password`, `credential`, `private_key`) at any depth, replacing the value with `[REDACTED]`
2. `max_tokens`, `model`, `dim`, `cadence`, `temperature`, and other non-secret fields survive un-redacted — verified by explicit test
3. `GET /api/config` never returns a raw secret value even when one is (incorrectly) present in config.yaml at any path
4. `resolveVoyageApiKey` reads only from `process.env.VOYAGE_API_KEY`; the config.yaml fallback is gone
5. No other code path reads provider secrets from config.yaml
6. Full test suite passes (current baseline 1039 tests, all green after the registry-test fix). New tests cover the redaction matrix + the end-to-end API guarantee
7. `npm run build`, `npm run build:ui`, `npx tsc --noEmit`, `git diff --check` all clean

---

## Verification commands

Operator runs after the brief lands:

```powershell
cd C:\CodexProjects\memory-system

# Seed a fake secret at a non-voyage path, confirm the API redacts it
# (temporarily add llm.api_key: "sk-FAKE12345" to ~/.memory/config.yaml)
curl.exe -s http://127.0.0.1:4410/memory/api/config | Select-String "sk-FAKE"
# Should return NOTHING (redacted). Then remove the fake key.

# Confirm max_tokens still shows
curl.exe -s http://127.0.0.1:4410/memory/api/config | Select-String "max_tokens"
# Should show the value, not [REDACTED]
```

---

## Commit boundaries

Suggested chunking (4 commits):

- Task 1: `fix: name-based recursive secret redaction in config API (Phase 4.3.M Task 1)`
- Task 2: `fix: resolve provider keys from env only, never config.yaml (Phase 4.3.M Task 2)`
- Task 3: `test: end-to-end secret-redaction guarantee on GET /api/config (Phase 4.3.M Task 3)`
- Task 4: `docs: config secrets are env-only (Phase 4.3.M Task 4)`

---

## Out-of-scope follow-ups (from the same checkup — separate briefs)

Do not bundle these; they're tracked for later:

- `graph.duplicate-entities` health check FAIL (33 duplicate entity pairs) — needs an entity-dedup / normalization pass
- `/api/health` returns 503 when a data-quality check fails — conflates liveness with data quality; split readiness from data-quality
- `compile` is 6 days stale with 1,173 raw observations un-consolidated — consolidation cadence gap
- 0 procedures ever extracted (every cluster skipped as one-off) — clustering threshold investigation
- `errors.log` never rotates (1,337 lines) — log rotation
- `/memory/graph` has multiple `<h1>`, `/memory/search` has none — minor a11y misses from 4.3.K
- Silent error swallowing in embedder/LLM factories (catch{} returns null with no diagnostic)
- Test coverage gaps: `src/compile/` (0 tests), `src/sniffers/` (untrusted-input parsing)
