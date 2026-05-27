# Codex Implementation Brief — Embedder Provider Abstraction (Phase 4.3.A)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

First of three briefs in the Phase 4.3 sequence that delivers the user-facing capability: **switch embedder and LLM providers from Settings UI, no code edit required**.

- **4.3.A (this brief)** — refactor the embedder surface behind a provider abstraction. Add 2-3 alternative implementations alongside the existing Voyage client. CLI-only configuration. No UI yet
- **4.3.B (next brief)** — add an LLMProvider abstraction with OpenRouter and Ollama implementations. Used initially only by new autonomous-LLM features (Phase 4.3.D auto-thread-proposing, etc.)
- **4.3.C (final brief)** — Settings UI gains edit capability for provider selection. Reads from both abstractions; writes go to `config.yaml` via a new `PATCH /api/config` endpoint that safelists non-secret fields

This brief tackles 4.3.A alone. After it lands, the operator can switch embedders by editing `~/.memory/config.yaml` (CLI workflow). 4.3.C lifts the same capability into the UI.

The Voyage client (`src/retrieval/voyage-client.ts`) stays as the default and as the production-deployed choice. The point isn't to replace Voyage — it's to make Voyage one of several supported choices.

---

## Scope guard

You will:

- Define an `Embedder` interface in `src/retrieval/embedder/types.ts` capturing the contract that every embedding provider must satisfy
- Refactor `src/retrieval/voyage-client.ts` into `src/retrieval/embedder/voyage.ts` implementing the interface. Keep all existing behavior; this is a code-organization move plus interface conformance, not a behavior change
- Add two new embedder implementations:
  - `src/retrieval/embedder/openai.ts` — uses OpenAI's `text-embedding-3-small` (1536-dim) and `text-embedding-3-large` (3072-dim) via the official OpenAI SDK
  - `src/retrieval/embedder/ollama.ts` — local Ollama HTTP API (no key, runs on the operator's machine); default model `nomic-embed-text` (768-dim)
- Extend `~/.memory/config.yaml` schema with an optional `embedder` section. When absent, defaults to current Voyage config (zero-config backwards-compat)
- New factory `src/retrieval/embedder/factory.ts:createEmbedderFromConfig(config, env)` returns the right `Embedder` instance based on config + env. Reads API keys from env vars per provider; never from config.yaml
- All retrieval consumers (`src/retrieval/refresh.ts`, search call sites) use the factory output. The existing `makeVoyageClient` export remains for backwards compatibility; it now delegates to the factory with `embedder.provider: voyage`
- New CLI command `memory provider list-embedders` lists available providers with their required env var names and current configuration. `memory provider test-embedder` runs a 1-call embedding test and reports dimension, latency, and any auth errors
- New CLI command `memory reindex-embeddings --plan` / `--apply` runs the full vault re-embed when the operator switches providers (different providers produce different-dim vectors that aren't interchangeable)
- Tests for each new embedder (mock the HTTP layer); tests for the factory; tests for config validation
- Update `docs/ROADMAP.md` to note this work as part of Phase 4.3 with B and C pending

You will **not**:

- Add an LLM SDK. That's Phase 4.3.B — separate brief, separate scope. This brief is embeddings-only
- Add Settings UI editability. That's Phase 4.3.C
- Accept API keys via config.yaml or the API. Keys remain env-var-only. The Settings UI displays the env var name and `[REDACTED]`; never the value
- Add Cohere, Mistral, HuggingFace, or other providers beyond the three listed. They're future-work; the brief is bounded to keep scope tight
- Change the embedding storage format (`~/.memory/embeddings/*.jsonl`). The dimension is recorded per-store in `embeddings.meta.json`; switching providers updates the meta and triggers a reindex
- Refactor the rerank pathway. Voyage's rerank is a separate concern; abstracting it is a future-work item, not part of this brief
- Touch the consolidation pipeline, the graph, or any wiki/raw frontmatter shape

If the OpenAI or Ollama implementation has an unexpected response shape that doesn't fit the proposed `Embedder.embed(texts) → { vectors, model, dim }` return type, **stop and ask** before mutating the interface to fit a single provider.

---

## Repo orientation (verified before brief)

- `src/retrieval/voyage-client.ts` — current sole embedder + reranker. Exports `makeVoyageClient({ apiKey })` returning `{ embed, rerank }`. Used by `src/retrieval/search.ts` and `src/dashboard/server.ts`
- `src/retrieval/refresh.ts:13` — `EmbedClient` interface (`embed(texts): Promise<{ vectors, model, dim }>`). This is **the shape** every embedder must implement. Lift to `src/retrieval/embedder/types.ts` and re-export so existing callers keep working
- `src/retrieval/refresh.ts:55-115` — embedding refresh logic uses `expectedDim` and bails out if `embedClient.embed()` returns a different dim than the stored meta. Switching providers must therefore go through `memory reindex-embeddings`, never silent
- `~/.memory/config.yaml` — current schema includes `embedding: { provider, model, dim }`. Section name aligns with the new `embedder:` section to avoid a rename, OR a renamed section reads from both for backwards compat (verify before editing)
- `src/storage/paths.ts` — `configPath()` resolves the config file location
- `src/cli.ts` — CLI command registration. Add `memory provider` subcommand group with `list-embedders`, `test-embedder`, `reindex-embeddings`

---

## Task 1 — `Embedder` interface + Voyage refactor

### Why
Lifting the interface out of `refresh.ts` makes the contract explicit and reusable. Refactoring Voyage to implement it (rather than being the only thing that exists) opens the door to alternatives without touching consumers.

### Contract

```ts
// src/retrieval/embedder/types.ts

export interface EmbedRequest {
  texts: string[];
  inputType?: "document" | "query";
  signal?: AbortSignal;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;          // identifier the provider returned (for audit log)
  dim: number;            // vector dimension, MUST match vectors[0].length
}

export interface Embedder {
  readonly providerName: string;   // "voyage" | "openai" | "ollama" | etc.
  readonly modelName: string;       // active model id (e.g. "voyage-4-large")
  readonly dim: number;             // expected dimension; never changes after construction
  embed(opts: EmbedRequest): Promise<EmbedResult>;
}

export interface EmbedderFactory {
  create(config: EmbedderConfig, env: NodeJS.ProcessEnv): Embedder;
}
```

Voyage refactor:

```ts
// src/retrieval/embedder/voyage.ts

export interface VoyageEmbedderOptions {
  apiKey: string;
  model?: string;          // default "voyage-4-large"
  // ... other Voyage-specific options
}

export function createVoyageEmbedder(opts: VoyageEmbedderOptions): Embedder {
  return {
    providerName: "voyage",
    modelName: opts.model ?? "voyage-4-large",
    dim: DIM_BY_MODEL[opts.model ?? "voyage-4-large"],
    embed: async ({ texts, inputType, signal }) => {
      // existing Voyage SDK calls
    },
  };
}

// Backwards-compat shim — existing callers of makeVoyageClient still work
export function makeVoyageClient(opts: { apiKey: string }) {
  const embedder = createVoyageEmbedder({ apiKey: opts.apiKey });
  return {
    embed: embedder.embed,
    rerank: /* existing rerank impl, untouched */,
  };
}
```

The rerank function stays on the Voyage-specific shim, not on `Embedder`. Rerank is a separate concern that should get its own interface in a future brief.

### Files

- New: `src/retrieval/embedder/types.ts` — interface definitions
- New: `src/retrieval/embedder/voyage.ts` — Voyage implementation
- Modify: `src/retrieval/voyage-client.ts` — re-export from `embedder/voyage.ts` for backwards compat OR delete and update all imports to the new location. **Prefer re-export** so the SearchSource-bug pattern doesn't recur (two locations defining the same surface)
- Modify: `src/retrieval/refresh.ts` — `EmbedClient` becomes a type alias for `Embedder` (or imports it directly)
- Tests: `test/retrieval/embedder/voyage.test.ts` — assert dim matches model, embed returns the right shape, errors surface cleanly

---

## Task 2 — `OllamaEmbedder` (local, no API key required)

### Why
Ollama is the natural local-first fallback. No paid API, runs on the operator's machine, offline-capable. Critical for users who can't or won't pay for cloud embeddings, or who want to evaluate the system before committing to Voyage costs.

### Contract

```ts
// src/retrieval/embedder/ollama.ts

export interface OllamaEmbedderOptions {
  host?: string;           // default "http://localhost:11434"
  model?: string;           // default "nomic-embed-text" (768-dim)
}

export function createOllamaEmbedder(opts: OllamaEmbedderOptions = {}): Embedder {
  const host = opts.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = opts.model ?? "nomic-embed-text";
  const dim = DIM_BY_OLLAMA_MODEL[model] ?? 768;
  return {
    providerName: "ollama",
    modelName: model,
    dim,
    embed: async ({ texts, signal }) => {
      // POST {host}/api/embeddings with { model, prompt: text }, one per call (Ollama
      // doesn't batch embeddings as of current API). Concatenate vectors.
      // Return { vectors, model, dim }
    },
  };
}

const DIM_BY_OLLAMA_MODEL: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
};
```

No API key. Connection failures surface as clear errors (`OLLAMA_HOST unreachable: <host>` with the underlying error).

### Files

- New: `src/retrieval/embedder/ollama.ts`
- New: `test/retrieval/embedder/ollama.test.ts` — mock the HTTP layer with msw or similar; assert proper request shape, batching, error surfaces

---

## Task 3 — `OpenAIEmbedder`

### Why
OpenAI is the second-most-requested cloud embedder. Same paid-API shape as Voyage but with a much larger user base — users likely already have an OpenAI API key.

### Contract

```ts
// src/retrieval/embedder/openai.ts

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string;           // default "text-embedding-3-small"
  baseURL?: string;          // for self-hosted compatible APIs (Azure OpenAI, etc.)
}

export function createOpenAIEmbedder(opts: OpenAIEmbedderOptions): Embedder {
  // Use the official `openai` SDK (npm install openai)
  // text-embedding-3-small -> 1536 dim, text-embedding-3-large -> 3072 dim
}
```

Add `openai` to package.json dependencies. If the user prefers to avoid a new dependency, an alternative is direct HTTP calls — but the official SDK is small and well-maintained. Document the dependency add in the brief commit message.

### Files

- New: `src/retrieval/embedder/openai.ts`
- Modify: `package.json` — add `openai` dependency
- New: `test/retrieval/embedder/openai.test.ts` — mock the SDK

---

## Task 4 — Config schema + factory

### Why
The factory is the seam between config and runtime. It resolves "config says voyage" into "instance of VoyageEmbedder with the env-supplied key." Centralizing this lets future briefs (4.3.B LLM, 4.3.C UI) plug in trivially.

### Contract

Extend `~/.memory/config.yaml` (write to `templates/config.yaml` so `memory init` produces the new shape):

```yaml
# Existing sections stay unchanged

embedder:
  provider: voyage          # voyage | openai | ollama
  model: voyage-4-large     # provider-specific model id
  options: {}               # provider-specific options (model-specific tuning)

# Backwards compat: if the older `embedding:` section is present and `embedder:` is
# absent, read the older one. New writes always go to `embedder:`.
```

API keys live in env vars per provider:
- `VOYAGE_API_KEY` — Voyage (already in use)
- `OPENAI_API_KEY` — OpenAI
- `OLLAMA_HOST` — Ollama host (no key; just the URL)

The factory:

```ts
// src/retrieval/embedder/factory.ts

export interface EmbedderConfig {
  provider: "voyage" | "openai" | "ollama";
  model?: string;
  options?: Record<string, unknown>;
}

export function createEmbedderFromConfig(
  config: EmbedderConfig,
  env: NodeJS.ProcessEnv = process.env,
): Embedder {
  switch (config.provider) {
    case "voyage": {
      const apiKey = env.VOYAGE_API_KEY;
      if (!apiKey) throw new EmbedderConfigError("VOYAGE_API_KEY not set");
      return createVoyageEmbedder({ apiKey, model: config.model });
    }
    case "openai": {
      const apiKey = env.OPENAI_API_KEY;
      if (!apiKey) throw new EmbedderConfigError("OPENAI_API_KEY not set");
      return createOpenAIEmbedder({ apiKey, model: config.model });
    }
    case "ollama":
      return createOllamaEmbedder({ host: env.OLLAMA_HOST, model: config.model });
    default:
      throw new EmbedderConfigError(`unknown embedder provider: ${config.provider}`);
  }
}
```

Update consumers in `src/dashboard/server.ts` and `src/retrieval/search.ts` to use the factory instead of hardcoded `makeVoyageClient`.

### Files

- New: `src/retrieval/embedder/factory.ts`
- Modify: `templates/config.yaml` — add `embedder:` section with `voyage` as default
- Modify: `src/storage/config.ts` (or wherever config loading lives) — parse the `embedder:` section
- Modify: `src/dashboard/server.ts` — instantiate via factory
- Modify: `src/retrieval/search.ts` consumers, if any — same change
- Tests: `test/retrieval/embedder/factory.test.ts` — each provider routes correctly; missing key surfaces clear error; unknown provider rejected; old `embedding:` section still works as fallback

---

## Task 5 — `memory provider` CLI subcommand

### Why
Without CLI verification surfaces, the operator has no way to test "did I configure Ollama correctly?" before pointing the dashboard at it.

### Contract

Three subcommands under `memory provider`:

```
memory provider list-embedders
# Lists supported providers with required env vars and current config status:
#   voyage   (VOYAGE_API_KEY)      [active, model=voyage-4-large, dim=2048]
#   openai   (OPENAI_API_KEY)      [available, key set]
#   ollama   (OLLAMA_HOST)         [available, host=http://localhost:11434]

memory provider test-embedder [--provider voyage|openai|ollama]
# Runs a 1-call embedding test against the chosen provider (or the active one if
# --provider omitted). Reports model, dimension, latency, and any error.
# Result:
#   Provider: voyage
#   Model: voyage-4-large
#   Dim: 2048
#   Latency: 412ms
#   Status: OK

memory provider reindex-embeddings --plan
memory provider reindex-embeddings --apply
# When the operator switches embedder providers, the existing JSONL embeddings are
# incompatible (different dim). This command re-embeds the full vault corpus
# against the currently-configured embedder. Writes a new embeddings.meta.json.
# --plan reports what would be re-embedded (file counts, estimated cost for paid
# providers, estimated time). --apply executes.
```

Cost-estimation hint for `--plan`: each provider should expose a `costPerKTokens` constant (Voyage docs put `voyage-4-large` at ~$0.12 / 1M tokens; OpenAI text-embedding-3-small at ~$0.02 / 1M). Multiply by estimated vault token count. Local providers (Ollama) report cost as `$0`.

### Files

- New: `src/cli/commands/provider.ts` — subcommand orchestrator
- New: `src/cli/commands/provider/list-embedders.ts`
- New: `src/cli/commands/provider/test-embedder.ts`
- New: `src/cli/commands/provider/reindex-embeddings.ts`
- Modify: `src/cli.ts` — register `provider` command group
- Tests: `test/cli/commands/provider/*.test.ts` — each subcommand

---

## Execution order

1. **Task 1** (interface + Voyage refactor) — foundation; zero behavior change; the new structure works with existing tests
2. **Task 2** (Ollama embedder) — independent; can land in any order after Task 1
3. **Task 3** (OpenAI embedder) — independent; same
4. **Task 4** (config + factory) — depends on Task 1 being in place. Wires the alternatives into actual usage
5. **Task 5** (CLI) — depends on Task 4. Adds the operator-facing surface

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                  # full suite (879 currently passing)
npx vitest run test/retrieval/embedder                # focus
npm run build
npm run build:ui

# Deploy: standard VPS path (no UI change in this brief, but the server bundle
# changes because retrieval consumers go through the factory now):
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify on operator machine:
memory provider list-embedders        # voyage active, openai/ollama available
memory provider test-embedder         # default (voyage); reports OK

# Optional: switch to Ollama locally to validate alternative path
# Edit ~/.memory/config.yaml: embedder.provider: ollama
# memory provider test-embedder       # should now hit Ollama
# memory provider reindex-embeddings --plan
```

VPS stays on Voyage. The operator can experiment locally with Ollama/OpenAI without affecting prod.

---

## Acceptance checklist

- [ ] `Embedder` interface defined and exported from `src/retrieval/embedder/types.ts`
- [ ] `createVoyageEmbedder` returns an `Embedder` and behaves identically to today's `makeVoyageClient` for embedding calls
- [ ] `makeVoyageClient` backwards-compat shim still works; existing import sites compile and pass tests without modification
- [ ] `createOllamaEmbedder` returns a working `Embedder` against a real local Ollama instance (or mocked in tests)
- [ ] `createOpenAIEmbedder` returns a working `Embedder`; uses the official `openai` SDK
- [ ] `createEmbedderFromConfig` routes each provider correctly; throws `EmbedderConfigError` with clear message when required env var missing
- [ ] `~/.memory/config.yaml` accepts an `embedder:` section; older `embedding:` section still works as fallback
- [ ] `templates/config.yaml` updated so `memory init` produces the new shape
- [ ] `memory provider list-embedders` lists three providers with env var names and current status
- [ ] `memory provider test-embedder` runs a 1-call embedding test; reports OK or clear error
- [ ] `memory provider reindex-embeddings --plan` reports file counts + estimated cost
- [ ] `memory provider reindex-embeddings --apply` re-embeds the full vault
- [ ] All 879+ existing tests still green; new tests added per task
- [ ] No API keys in config.yaml, in code, or in any committed artifact
- [ ] No new dependencies beyond `openai` (Ollama is fetch-based, no SDK needed)
- [ ] No UI changes (4.3.C)
- [ ] No LLM SDK (4.3.B)

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (immediate follow-ups)

These are not "deferred indefinitely" — they're the next two briefs in the Phase 4.3 sequence and should land right after 4.3.A:

1. **Phase 4.3.B — LLM provider abstraction** — `LLMProvider` interface, `OpenRouterLLM` (the main LLM SDK, gateway to ~100 models), `OllamaLLM` (local fallback). Used initially only by new autonomous-LLM features. Curation orchestrators (`memory compile`, `memory lint`, `memory page`) stay as prompt-printers; the LLM clients are for background features that need autonomous reasoning. See [[memory-fort-architectural-maturity]] decision context

2. **Phase 4.3.C — Settings UI editability** — new `PATCH /api/config` endpoint that safelists non-secret fields (provider names, model names, dimensions — never API keys); Settings page gains edit mode with provider selection forms; API key fields display `[REDACTED]` + env var name instructions, never accept input

3. **Phase 4.3.D — Auto-thread-proposing** — the first concrete consumer of the new LLM provider abstraction. Cluster raw observations by topic + temporal proximity + entity overlap; propose thread drafts via LLM; operator validates and promotes. Closes the `narrative-thread-coverage` gap from Phase 4.2 honestly (vs threshold recalibration)

Out of scope for any of 4.3.A/B/C/D, deferred further:

- **Rerank provider abstraction** — Voyage's rerank stays Voyage-only for now. Abstracting it is mechanically the same pattern as embedder but adds scope to each brief. Future
- **Cohere, Mistral, HuggingFace, etc. embedders** — additive; can land in single-task PRs once the interface is established
- **Per-page-kind embedder routing** — different embedders for raw vs wiki vs crystals. Useful when one provider excels at code (e.g., Voyage code-2) and another at prose. Far future
- **Embedding cache invalidation policy** — currently the meta dim is the gate; switching providers triggers full reindex. A smarter cache that keeps multiple embedding spaces is a much bigger lift; defer until a real use case demands it
