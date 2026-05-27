# Codex Implementation Brief — Settings UI Editability (Phase 4.3.C)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Third and final brief in the Phase 4.3 sequence. Delivers the user-visible payoff that motivated the entire sequence: **switch embedder and LLM providers from the Settings UI, no CLI required**.

- ✓ **4.3.A** Embedder providers (Voyage + OpenAI + Ollama)
- ✓ **4.3.B** LLM providers (OpenRouter + Ollama + audit + kill switch)
- **4.3.C (this brief)** — Settings UI gains edit mode; new `PATCH /api/config` endpoint safelists non-secret fields; API keys stay env-var-only with `[REDACTED]` display

After this brief lands and deploys, the workflow is:
1. Operator visits `/memory/settings`
2. Clicks "Edit" on the Embedder or LLM card
3. Picks provider from dropdown, picks/enters model, optionally tunes max_tokens/temperature
4. Clicks Save
5. The change writes to `~/.memory/config.yaml`, auto-push hook syncs to VPS, dashboard picks up the new config on next request

API keys are never shown, never accepted via the UI. The card displays the env var name (e.g., `OPENROUTER_API_KEY`) with status `[REDACTED — set]` or `[not configured]`. Setting the key still requires shell access to the appropriate env file — that asymmetry is intentional security posture.

---

## Scope guard

You will:

- Add `PATCH /api/config` endpoint in `src/dashboard/server.ts`. Accepts JSON body; safelist enforced server-side — only specific fields under `embedder.*` and `llm.*` paths can be modified. Everything else rejected with 400 + clear error
- Atomic write via `atomicWrite` to `~/.memory/config.yaml` so failed writes never corrupt the file. Write a backup to `~/.memory/.config-backup-{timestamp}.yaml` before overwriting; retain last 5 backups (auto-prune older)
- Add `GET /api/providers` endpoint returning the catalog of available providers and their known models — so the UI knows what to render in dropdowns without hardcoding
- Rewrite `src/dashboard-ui/routes/settings.tsx` (or its component file) to support two modes:
  - **Read mode** (default) — current display
  - **Edit mode** (per-card toggle) — provider selection form
- New components: `EmbedderConfigCard.tsx` and `LLMConfigCard.tsx`. Each has its own edit/save flow
- New hook `useUpdateConfig` (TanStack Query mutation) that PATCHes `/api/config`. Invalidates `useConfig` on success so the read-mode view refreshes
- API key fields display the env var name and one of three states: `[REDACTED — set]`, `[not configured]`, or `[checking...]`. Never accepts key input
- Tests for: PATCH safelist (try to set unsafelisted field → 400), atomic write rollback (simulate filesystem error → original config intact), provider catalog shape, UI edit-mode toggle, save-and-refetch flow

You will **not**:

- Accept API keys via the API or UI. Period. Even with explicit operator confirmation. Keys remain env-var-only — the brief preserves this hard rule from prior security decisions
- Add provider-side credential management (e.g., "test this key for me") — that would require accepting the key on the server. Operator tests credentials via `memory provider test-embedder` / `test-llm` from CLI
- Add a "Save and apply now" that restarts the dashboard. The dashboard re-reads config on next request automatically (no in-memory cache for config). The save just writes the file
- Add field-level validation beyond what the factory does (e.g., "is this a real OpenAI model name?"). The factory throws clear errors on invalid config; the UI surfaces them as save errors
- Change the existing `GET /api/config` redaction. It already redacts secrets; keep it as-is
- Add CSRF tokens or auth — same-origin check is sufficient for the single-user Tailscale-only deployment. CSRF becomes relevant when there's a second human; defer
- Add settings for anything besides `embedder` and `llm`. Other config fields (retention, privacy allowlist, etc.) are out of scope for this brief
- Touch CLI commands. `memory provider` keeps working; this brief is purely additive UI

If a UI flow naturally suggests "let me show the operator the current API key value to confirm they have the right one," **stop and ask**. The answer is "no, never display key values" but the question is worth surfacing in case the brief missed a corner case

---

## Repo orientation (verified before brief)

- `src/dashboard/server.ts` — route table; `GET /api/config` lives near other GET endpoints. `PATCH` requires handling a new method (currently the route table rejects everything that isn't GET)
- `src/storage/config.ts` — `loadMemoryConfig` + `redactConfig` (used by `GET /api/config`)
- `src/storage/atomic-write.ts` — `atomicWrite(path, content)` used elsewhere for vault writes; reuse for config writes
- `src/dashboard-ui/routes/settings.tsx` — current read-only settings page wires up `useConfig`
- `src/dashboard-ui/hooks/useConfig.ts` — existing TanStack Query hook reading `GET /api/config`. The new `useUpdateConfig` mutation lives alongside
- `src/dashboard-ui/components/` — pattern for new card components (see `GraphHealthPanel.tsx`, `HealthBadge.tsx` for the existing styling system: GlassPanel, brackets, cyan accents)
- `src/retrieval/embedder/factory.ts` and `src/llm/factory.ts` — the catalog of supported providers + their valid model names. The new `GET /api/providers` endpoint reads from these

---

## Task 1 — `GET /api/providers` catalog endpoint

### Why
The UI needs to know what providers exist and what models each supports to render dropdowns. Hardcoding in the SPA risks drift when a new provider is added to the backend. A single catalog endpoint reads from the existing factory metadata.

### Contract

```ts
// Response shape
{
  "embedders": [
    {
      "provider": "voyage",
      "envVar": "VOYAGE_API_KEY",
      "envVarStatus": "set" | "missing",
      "models": [
        { "id": "voyage-4-large", "dim": 2048, "default": true },
        { "id": "voyage-3-large", "dim": 1024 },
        { "id": "voyage-3", "dim": 1024 }
      ]
    },
    { "provider": "openai", "envVar": "OPENAI_API_KEY", ... },
    { "provider": "ollama", "envVar": "OLLAMA_HOST", "envVarStatus": "set", "models": [...] }
  ],
  "llms": [
    {
      "provider": "openrouter",
      "envVar": "OPENROUTER_API_KEY",
      "envVarStatus": "set" | "missing",
      "models": [
        { "id": "openai/gpt-4o-mini", "default": true, "free": false },
        { "id": "anthropic/claude-3.5-sonnet", "free": false },
        { "id": "qwen/qwen-2.5-7b-instruct:free", "free": true },
        // ... small curated list, NOT the full OpenRouter catalog
      ]
    },
    { "provider": "ollama", ... }
  ]
}
```

The envVarStatus reports presence/absence of the env var on the server — never the value. UI uses this to show `[REDACTED — set]` vs `[not configured]`.

For OpenRouter's model list, ship a small curated subset (10-20 models) of common choices. The full OpenRouter catalog has 100+ models; rendering all of them in a dropdown is bad UX. Document the curated list in `src/llm/openrouter-catalog.ts` so it's easy to extend.

### Files

- New: `src/llm/openrouter-catalog.ts` — exported `OPENROUTER_CURATED_MODELS` array
- Modify: `src/dashboard/server.ts` — new route handler
- New: `src/dashboard/providers-catalog.ts` — builds the response by reading factory metadata + env state
- New: `test/dashboard/providers-catalog.test.ts` — assert shape, envVarStatus reflects env, no key values leak

---

## Task 2 — `PATCH /api/config` write endpoint with safelist

### Why
The single most security-sensitive part of this brief. A wrong implementation lets the UI write arbitrary fields to `config.yaml`. The safelist is the only thing standing between "switch providers" and "remote-write any config field."

### Contract

```
PATCH /api/config
Content-Type: application/json

Body:
{
  "embedder": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "options": {}
  },
  "llm": {
    "provider": "openrouter",
    "model": "anthropic/claude-3.5-sonnet",
    "max_tokens": 4096,
    "temperature": 0.2
  }
}

Either or both sections may be present. Other top-level keys → 400.
```

Server-side safelist enforcement:

```ts
// src/dashboard/config-patch.ts

const SAFELISTED_PATHS = [
  "embedder.provider",
  "embedder.model",
  "embedder.options",
  "llm.provider",
  "llm.model",
  "llm.max_tokens",
  "llm.temperature",
  "llm.options",
];

const VALID_EMBEDDER_PROVIDERS = ["voyage", "openai", "ollama"] as const;
const VALID_LLM_PROVIDERS = ["openrouter", "ollama"] as const;

export interface ConfigPatchValidation {
  ok: boolean;
  errors: Array<{ path: string; message: string }>;
}

export function validateConfigPatch(body: unknown): ConfigPatchValidation {
  // 1. Top-level keys must be subset of { embedder, llm }
  // 2. Every leaf path must be in SAFELISTED_PATHS
  // 3. Provider values must be in the valid enum
  // 4. max_tokens 1..32000; temperature 0..2
  // 5. options must be a plain object
  // Returns ok: true only if every check passes
}

export async function applyConfigPatch(
  vaultRoot: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const configPath = join(vaultRoot, "config.yaml");

  // 1. Load current config
  const current = await loadMemoryConfig(vaultRoot);

  // 2. Deep-merge patch into current (only safelisted paths)
  const next = mergeAtSafelistedPaths(current, patch);

  // 3. Write backup to ~/.memory/.config-backups/{timestamp}.yaml
  await writeBackup(vaultRoot, current);

  // 4. Atomic-write the new config
  await atomicWrite(configPath, yaml.dump(next));

  // 5. Auto-prune backups beyond the last 5
  await pruneBackups(vaultRoot, 5);
}
```

Response shapes:

```
200 OK
{ "ok": true, "applied": ["embedder.provider", "embedder.model", "llm.model"] }

400 Bad Request
{ "ok": false, "errors": [{ "path": "embedder.api_key", "message": "field not in safelist" }] }

500 Internal Server Error
{ "ok": false, "error": "failed to write config.yaml: <reason>" }
```

Same-origin check: reject any request whose `Origin` header is not the dashboard's own origin. Implementation: simple header comparison against the configured dashboard URL. This is enough for the single-user Tailscale-only deployment.

### Files

- New: `src/dashboard/config-patch.ts` — validation + apply logic
- Modify: `src/dashboard/server.ts` — handle `PATCH /api/config` method, call into the new module
- New: `test/dashboard/config-patch.test.ts` — at minimum:
  - Valid patch with `embedder.provider` succeeds
  - Patch with unsafelisted field (e.g., `embedder.api_key`) returns 400
  - Patch with invalid provider value returns 400
  - Patch with `max_tokens: 99999` returns 400
  - Failed write rolls back from backup (simulate filesystem error)
  - Backup retention: 6 patches → 5 backups retained, oldest pruned

---

## Task 3 — `useUpdateConfig` mutation hook

### Why
The UI components need a clean call surface for the mutation. TanStack Query handles loading/error states and cache invalidation when the mutation succeeds.

### Contract

```ts
// src/dashboard-ui/hooks/useUpdateConfig.ts

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPatch } from "../lib/api.js";

export interface ConfigPatchBody {
  embedder?: {
    provider?: "voyage" | "openai" | "ollama";
    model?: string;
    options?: Record<string, unknown>;
  };
  llm?: {
    provider?: "openrouter" | "ollama";
    model?: string;
    max_tokens?: number;
    temperature?: number;
    options?: Record<string, unknown>;
  };
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConfigPatchBody) => apiPatch("/config", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}
```

`apiPatch` is new; add to `src/dashboard-ui/lib/api.ts` mirroring `apiGet`:

```ts
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(response.status, error.error || error.message || response.statusText);
  }
  return response.json() as Promise<T>;
}
```

### Files

- Modify: `src/dashboard-ui/lib/api.ts` — add `apiPatch`
- New: `src/dashboard-ui/hooks/useUpdateConfig.ts`
- New: `src/dashboard-ui/hooks/useProvidersCatalog.ts` (GET-only TanStack hook for `/api/providers`)
- Tests: `test/dashboard-ui/hooks/use-update-config.test.tsx` — mock the fetch, assert mutation invalidates the config + providers queries on success

---

## Task 4 — `EmbedderConfigCard` and `LLMConfigCard` components

### Why
Two parallel cards on the Settings page. Each has its own edit/save lifecycle so the operator can change one without committing the other. Each renders provider dropdown, model dropdown, optional tuning fields, and the read-only env-var status display.

### Contract

Component shape:

```tsx
// src/dashboard-ui/components/EmbedderConfigCard.tsx

export function EmbedderConfigCard() {
  const config = useConfig();
  const providers = useProvidersCatalog();
  const mutation = useUpdateConfig();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ provider: string; model: string }>({ ... });

  // Read mode: show current provider + model + env var status, "Edit" button
  // Edit mode: show provider dropdown, model dropdown (filtered by selected provider),
  //           Save + Cancel buttons. Status of env var for the selected provider is
  //           shown but is read-only (can't change keys via UI)

  // On Save: call mutation.mutate(draft). On success: setEditing(false), toast.
  // On error: show inline error, stay in edit mode.

  // ...
}
```

Read mode rendering:

```
┌── Embedder ─────────────────────────────────────────────┐
│  Provider: voyage                                  [Edit]│
│  Model:    voyage-4-large (2048-dim)                     │
│  Key:      VOYAGE_API_KEY [REDACTED — set]              │
└──────────────────────────────────────────────────────────┘
```

Edit mode rendering:

```
┌── Embedder ─────────────────────────────────────────────┐
│  Provider:  [voyage           ▾]                         │
│  Model:     [voyage-4-large   ▾]                         │
│  Key:       VOYAGE_API_KEY [REDACTED — set]              │
│             To change: edit /root/memory-system/env/     │
│             voyage.env on the VPS                        │
│                                                          │
│              [Cancel]            [Save Changes]          │
└──────────────────────────────────────────────────────────┘
```

LLM card is structurally similar but adds max_tokens and temperature inputs (number inputs with range hints — max_tokens 1-32000, temperature 0-2 step 0.1).

The model dropdown is **filtered by the currently-selected provider** in the draft. When the operator switches provider in the dropdown, model auto-defaults to the new provider's default. The user can override.

For Ollama, model is a free-text input with a placeholder showing common choices (`llama3.2`, `nomic-embed-text` for embeddings) since Ollama users may have custom-pulled models.

Toast notification on save success:

> Config saved. Dashboard will pick up changes on next request. *Note: switching embedder provider requires `memory provider reindex-embeddings --apply` to migrate existing vectors.*

That migration warning only appears when `embedder.provider` actually changed (not when only the model within a provider changed — that may or may not change dim; the dashboard handles dim mismatch detection separately).

### Files

- New: `src/dashboard-ui/components/EmbedderConfigCard.tsx`
- New: `src/dashboard-ui/components/LLMConfigCard.tsx`
- New: shared utility for status pill rendering: `src/dashboard-ui/components/ConfigStatusPill.tsx`
- Modify: `src/dashboard-ui/routes/settings.tsx` — render the two new cards above the existing read-only blocks
- Tests: `test/dashboard-ui/components/embedder-config-card.test.tsx`, `test/dashboard-ui/components/llm-config-card.test.tsx`

---

## Task 5 — Settings page integration + retention warning

### Why
The two cards land on the existing Settings page, which keeps its current read-only display for everything else (retention policy, embedding-store stats, privacy allowlist). Just adding the new editable cards at the top.

### Contract

`src/dashboard-ui/routes/settings.tsx` structure:

```
Settings

┌── Embedder ─────────────────┐    ┌── LLM ─────────────────────┐
│   <EmbedderConfigCard />    │    │   <LLMConfigCard />        │
└─────────────────────────────┘    └────────────────────────────┘

[Existing read-only sections unchanged below: Retention, Embedding,
 Privacy, Editing settings note, Voyage API key note]
```

Update the "Editing settings" note copy from "Phase 4 dashboard is read-only..." to:

> Provider settings (embedder + LLM) can now be edited directly via the cards above. Other config fields remain read-only. To edit retention, privacy, or other fields, open `~/.memory/config.yaml` on your creator machine; changes sync to the VPS within ~5 seconds via the auto-push hook.

### Files

- Modify: `src/dashboard-ui/routes/settings.tsx`
- Tests: `test/dashboard-ui/routes/settings.test.tsx` — render the page with a fixture config; assert both new cards appear; assert read-only sections still appear

---

## Execution order

1. **Task 1** (providers catalog endpoint) — foundation; UI components depend on this
2. **Task 2** (PATCH endpoint + safelist) — security-critical; lands separately so it can be reviewed in isolation
3. **Task 3** (mutation hook) — wires backend → UI
4. **Task 4** (config cards) — the visible payoff
5. **Task 5** (settings page integration) — final composition

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                  # full suite (909 currently passing)
npx vitest run test/dashboard                         # backend focus
npx vitest run test/dashboard-ui                      # UI focus
npm run build
npm run build:ui

# Deploy SPA + server bundle (both change):
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify:
# 1. Visit /memory/settings — confirm Embedder + LLM cards appear in read mode
# 2. Click Edit on Embedder card — confirm provider dropdown shows voyage/openai/ollama,
#    model dropdown updates when provider changes
# 3. Click Save with no actual changes — confirm 200 response
# 4. curl PATCH with unsafelisted field:
#    curl -X PATCH https://srv1317946.../memory/api/config \
#         -H 'Content-Type: application/json' \
#         -d '{"embedder": {"api_key": "test"}}'
#    Expected: 400 with clear error
# 5. Check ~/.memory/.config-backups/ on VPS — confirm backup files exist
```

---

## Acceptance checklist

- [ ] `GET /api/providers` returns embedders + llms catalogs with envVarStatus per provider
- [ ] envVarStatus reports presence/absence; never reveals the env var value
- [ ] OpenRouter catalog is a curated list of 10-20 models, not the full provider catalog
- [ ] `PATCH /api/config` accepts safelisted fields under `embedder.*` and `llm.*` only
- [ ] Unsafelisted fields rejected with 400 + clear error including the offending path
- [ ] Invalid provider values rejected with 400
- [ ] `max_tokens` outside 1..32000 rejected
- [ ] `temperature` outside 0..2 rejected
- [ ] Atomic write — failed write leaves original config intact
- [ ] Backup written to `~/.memory/.config-backups/{timestamp}.yaml` before each successful patch
- [ ] Backup retention: oldest pruned when count > 5
- [ ] Same-origin check: cross-origin PATCH rejected with 403
- [ ] `useUpdateConfig` invalidates `config` and `providers` query keys on success
- [ ] `EmbedderConfigCard` renders provider dropdown, model dropdown, env-var status
- [ ] Model dropdown filters by selected provider; auto-defaults on provider change
- [ ] `LLMConfigCard` includes max_tokens and temperature inputs
- [ ] Toast on save success includes the reindex warning when embedder provider changed
- [ ] Settings page renders both new cards above existing read-only sections
- [ ] "Editing settings" note copy updated
- [ ] All 909+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No API keys accepted via API or UI under any code path
- [ ] No changes to CLI (`memory provider` keeps working)
- [ ] No auth/CSRF added (single-user Tailscale-only model holds)

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

After this brief, the 4.3 sequence closes. Phase 4.3.D+ are consumer briefs that USE the LLM infrastructure:

1. **Phase 4.3.D — Auto-thread-proposing** — first consumer. Cluster raw observations + propose thread drafts via LLM. Closes the `narrative-thread-coverage` gap honestly
2. **Phase 4.3.E — Procedural extraction** — second consumer. Detect repeated successful workflows; propose procedural memory pages
3. **Phase 4.3.F — Query intent classifier** — third consumer. Adaptive retrieval mode per query class

Out of scope for any 4.3.x brief, deferred further:

- **Settings UI editability for OTHER config fields** (retention policy, privacy allowlist, etc.) — same pattern as this brief, easy to extend, but those fields rarely change so the editability ROI is lower. Defer until evidence shows demand
- **In-UI key management** — accepting keys via the UI is hard-rejected. The right ergonomics improvement is a setup wizard that walks the operator through writing the env file; that's a separate workflow brief
- **CSRF tokens + auth** — needed when there's a second human or when the dashboard is exposed beyond Tailscale. Defer
- **Live preview** of how changes would affect the dashboard (e.g., "if you switch to ollama, search latency will be X"). Speculative; defer
- **Diff view** before save showing what's about to change. Nice-to-have; defer
- **Roll back to backup** UI surface — backups exist on disk; surfacing them in the UI is a future enhancement
