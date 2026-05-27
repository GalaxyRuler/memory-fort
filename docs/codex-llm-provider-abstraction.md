# Codex Implementation Brief — LLM Provider Abstraction (Phase 4.3.B)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Second of three briefs in the Phase 4.3 sequence that delivers UI provider switching:

- ✓ **4.3.A — Embedder providers** (shipped, commits `46dc6e6..f0bda77`)
- **4.3.B — LLM providers (this brief)** — add `LLMProvider` interface, OpenRouter + Ollama implementations, config-driven factory, audit log foundation, CLI verification surface. **Zero in-production consumers** — this brief is purely infrastructure
- **4.3.C — Settings UI editability** (next) — surfaces both embedder and LLM provider selection in the dashboard

The critical scope rule: **the curation orchestrators stay as prompt-printers, untouched**. `memory compile`, `memory lint`, `memory page` continue to assemble prompts and print them to stdout. The LLM in the user's active session does the reasoning. This brief does NOT change that.

What this brief DOES enable is **autonomous LLM consumers** — features that need to reason without a live user session driving them. Phase 4.3.D (auto-thread-proposing) is the first concrete consumer; 4.3.E (procedural extraction) and beyond follow. Each consumer brief adds its own scope, cost budget, and approval gate.

After this brief ships, the operator has an LLM client they can configure and test, but nothing in the system uses it in production yet. That's deliberate — separating "the infrastructure exists" from "things make LLM calls" makes the cost story controllable.

---

## Scope guard

You will:

- Define an `LLMProvider` interface in `src/llm/types.ts` capturing the chat-completion contract every LLM provider must satisfy
- Add two implementations:
  - `src/llm/openrouter.ts` — uses OpenRouter via the OpenAI SDK with `baseURL: "https://openrouter.ai/api/v1"`. Single API key (`OPENROUTER_API_KEY`); routes to ~100 models via OpenRouter-prefixed model ids (e.g., `anthropic/claude-3.5-sonnet`, `openai/gpt-4o-mini`, `qwen/qwen-2.5-7b-instruct:free`)
  - `src/llm/ollama.ts` — local Ollama HTTP API at `/api/chat`. No key. Default model `llama3.2`. Different shape from embeddings endpoint
- Extend `~/.memory/config.yaml` with an optional `llm` section (same pattern as `embedder:` from 4.3.A). When absent, no LLM is configured — consumer features that try to use the LLM throw a clear error
- New factory `src/llm/factory.ts:createLLMFromConfig(config, env)` returns the right `LLMProvider` instance based on config + env. API keys env-var-only per the existing security model
- New audit-log infrastructure: `src/llm/audit.ts` writes every LLM call to `~/.memory/wiki/.audit/llm-{YYYY-MM-DD}.md`. Hashes prompt + response; never logs raw content (privacy). Each consumer feature MUST go through the audit writer
- New kill switch: env var `MEMORY_LLM_DISABLED=true` makes the factory throw `LLMDisabledError` on creation. All consumer features must surface this as "LLM is disabled" rather than retrying. Default is enabled
- Extend `memory provider` CLI from 4.3.A with three new subcommands:
  - `memory provider list-llms` — same shape as `list-embedders`
  - `memory provider test-llm [--provider ...]` — runs a tiny "say hi" prompt
  - `memory provider audit-summary [--days N]` — reads recent audit logs and reports calls per consumer, total tokens, estimated cost
- Tests for each implementation (mock SDK/HTTP); tests for the factory; tests for the audit writer; tests for kill switch behavior

You will **not**:

- Add any consumer of the LLM provider. No auto-thread-proposing, no procedural extraction, no query intent classifier, no automatic anything. Those are separate briefs (4.3.D and beyond). The infrastructure exists; nothing uses it in production until a consumer brief explicitly ships
- Touch the curation orchestrators (`memory compile`, `memory lint`, `memory page`). The pure-orchestrator decision in `wiki/decisions/2026-05-22-curation-orchestrator-not-llm.md` is load-bearing for those commands and stays as-is
- Add Settings UI editability. That's 4.3.C
- Add streaming responses. The interface is request-response only for now. Streaming is a future-work item if a consumer demonstrably needs it
- Add Anthropic, OpenAI direct, or other providers beyond OpenRouter + Ollama. OpenRouter is the gateway to most providers anyway; users who specifically want Anthropic direct (e.g., for prompt caching) can be added in a focused follow-up
- Add token-counting utilities beyond what providers return. If a provider doesn't return `tokensUsed`, the audit log records the call without token counts; cost estimates degrade to "unknown" for that entry
- Bypass the kill switch in any code path. Every consumer goes through the factory; the factory is the single point of enforcement

If a consumer feature gets added to this brief by mistake (e.g., "let's just add a small auto-classifier while we're here"), **stop and ask** before shipping. Foundation-only is the entire design point

---

## Repo orientation (verified before brief)

- `src/retrieval/embedder/` — Phase 4.3.A established the pattern. Mirror its shape for `src/llm/`: `types.ts`, `factory.ts`, one file per provider, parallel test directory structure
- `src/cli/commands/provider.ts` — Phase 4.3.A's subcommand orchestrator. Extend with `list-llms` / `test-llm` / `audit-summary` rather than creating a sibling
- `src/storage/config.ts` — Phase 4.3.A added `embedder:` parsing. Add `llm:` parsing in the same place
- `src/storage/paths.ts` — exposes `~/.memory/wiki/.audit/` resolution (used by consolidate and other audit writers). Reuse for the new LLM audit log
- `templates/config.yaml` — Phase 4.3.A added an `embedder:` section. Add a commented `llm:` section so `memory init` produces both
- `package.json` — `openai` already installed (Phase 4.3.A Task 3). OpenRouter uses the same SDK with a different `baseURL`. No new dependencies needed

---

## Task 1 — `LLMProvider` interface + types

### Why
Establish the contract before any implementation. Lets every provider conform to the same shape and lets consumers (future briefs) target the interface rather than a specific provider.

### Contract

```ts
// src/llm/types.ts

export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type LLMFinishReason = "stop" | "length" | "filter" | "error" | "other";

export interface LLMTokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface LLMResponse {
  content: string;
  model: string;                     // identifier the provider returned (for audit)
  tokensUsed?: LLMTokenUsage;        // optional; not all providers report
  finishReason: LLMFinishReason;
  rawProviderName: string;           // "openrouter" | "ollama" | etc.
}

export interface LLMProvider {
  readonly providerName: string;
  readonly modelName: string;
  chat(req: LLMRequest): Promise<LLMResponse>;
}

export class LLMDisabledError extends Error {
  constructor(message = "LLM provider is disabled via MEMORY_LLM_DISABLED") {
    super(message);
    this.name = "LLMDisabledError";
  }
}

export class LLMConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMConfigError";
  }
}
```

### Files

- New: `src/llm/types.ts`
- Tests: none for types alone — covered via downstream implementations

---

## Task 2 — `OpenRouterLLM` implementation

### Why
OpenRouter is the practical gateway to ~100 LLM models with a single API key. Anthropic, OpenAI, Google, Meta, Mistral, Qwen — all reachable via one SDK call. Free-tier models exist (Qwen, some Llama variants) so the operator can test the path without paying.

### Contract

```ts
// src/llm/openrouter.ts

import OpenAI from "openai";   // existing dependency from 4.3.A
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from "./types.js";

export interface OpenRouterLLMOptions {
  apiKey: string;
  model?: string;                  // default "openai/gpt-4o-mini"
  baseURL?: string;                // default "https://openrouter.ai/api/v1"
  defaultMaxTokens?: number;       // default 4096
  defaultTemperature?: number;     // default 0.2
}

export function createOpenRouterLLM(opts: OpenRouterLLMOptions): LLMProvider {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL ?? "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/GalaxyRuler/memory-fort",
      "X-Title": "Memory Fort",
    },
  });
  const model = opts.model ?? "openai/gpt-4o-mini";
  const defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  const defaultTemperature = opts.defaultTemperature ?? 0.2;

  return {
    providerName: "openrouter",
    modelName: model,
    async chat(req: LLMRequest): Promise<LLMResponse> {
      const response = await client.chat.completions.create({
        model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? defaultMaxTokens,
        temperature: req.temperature ?? defaultTemperature,
      }, { signal: req.signal });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error("OpenRouter returned no choices");
      }
      return {
        content: choice.message.content ?? "",
        model: response.model,
        tokensUsed: response.usage
          ? {
              prompt: response.usage.prompt_tokens,
              completion: response.usage.completion_tokens,
              total: response.usage.total_tokens,
            }
          : undefined,
        finishReason: mapFinishReason(choice.finish_reason),
        rawProviderName: "openrouter",
      };
    },
  };
}

function mapFinishReason(reason: string | null | undefined): LLMFinishReason {
  switch (reason) {
    case "stop": return "stop";
    case "length": return "length";
    case "content_filter": return "filter";
    case null:
    case undefined:
      return "other";
    default:
      return "other";
  }
}
```

The `HTTP-Referer` and `X-Title` headers are OpenRouter's optional attribution headers — recommended so OpenRouter's leaderboard shows Memory Fort as a user. Free to do; provides nicer service if usage scales.

### Files

- New: `src/llm/openrouter.ts`
- New: `test/llm/openrouter.test.ts` — mock the SDK; assert request shape, response parsing, error surfaces. Cover at minimum: happy path, no-choices error, content_filter finish reason, signal-based abort

---

## Task 3 — `OllamaLLM` implementation

### Why
Local-first fallback. No API key, runs on the operator's machine, fully offline-capable. Same provider story as the embedder: the user can evaluate LLM-driven features before committing to cloud costs.

### Contract

```ts
// src/llm/ollama.ts

import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from "./types.js";

export interface OllamaLLMOptions {
  host?: string;             // default "http://localhost:11434"
  model?: string;             // default "llama3.2"
  defaultMaxTokens?: number;   // default 4096
  defaultTemperature?: number; // default 0.2
}

export function createOllamaLLM(opts: OllamaLLMOptions = {}): LLMProvider {
  const host = opts.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = opts.model ?? "llama3.2";
  // ... rest mirrors the OpenRouter shape but POSTs to {host}/api/chat
}
```

Ollama's `/api/chat` payload:
```json
{
  "model": "llama3.2",
  "messages": [{"role": "user", "content": "..."}],
  "stream": false,
  "options": { "temperature": 0.2, "num_predict": 4096 }
}
```

Response shape (non-streaming):
```json
{
  "model": "llama3.2",
  "message": { "role": "assistant", "content": "..." },
  "done": true,
  "done_reason": "stop",
  "prompt_eval_count": 12,
  "eval_count": 87
}
```

Map `done_reason` to `finishReason`: "stop" → "stop", "length" → "length", others → "other".

Token counts: `prompt_eval_count` → `prompt`, `eval_count` → `completion`.

Connection failures surface as `LLMConfigError("OLLAMA_HOST unreachable: <host>")` with the underlying error preserved.

### Files

- New: `src/llm/ollama.ts`
- New: `test/llm/ollama.test.ts` — mock the HTTP layer; assert proper request body shape, response parsing, error surfaces

---

## Task 4 — Config schema, factory, audit log, kill switch

### Why
Three coupled pieces that belong together:
- **Config + factory**: same pattern as Phase 4.3.A's embedder factory
- **Audit log**: every LLM call writes a structured entry — required infrastructure for consumer briefs, cheaper to add now than after consumers exist
- **Kill switch**: enforced at factory level so no consumer can bypass

### Config schema

```yaml
# ~/.memory/config.yaml
embedder:
  provider: voyage
  model: voyage-4-large

llm:
  provider: openrouter        # openrouter | ollama
  model: openai/gpt-4o-mini   # provider-specific model id
  max_tokens: 4096            # optional default
  temperature: 0.2            # optional default
  options: {}                 # provider-specific tuning
```

API keys env-var-only:
- `OPENROUTER_API_KEY` — OpenRouter
- `OLLAMA_HOST` — Ollama (no key; just URL, same as 4.3.A)

Kill switch:
- `MEMORY_LLM_DISABLED=true` — factory throws `LLMDisabledError`. Any consumer that catches and proceeds is buggy

### Factory contract

```ts
// src/llm/factory.ts

export interface LLMConfig {
  provider: "openrouter" | "ollama";
  model?: string;
  max_tokens?: number;
  temperature?: number;
  options?: Record<string, unknown>;
}

export function createLLMFromConfig(
  config: LLMConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider {
  if (env.MEMORY_LLM_DISABLED === "true") {
    throw new LLMDisabledError();
  }
  if (!config) {
    throw new LLMConfigError("no `llm:` section in ~/.memory/config.yaml");
  }
  switch (config.provider) {
    case "openrouter": {
      const apiKey = env.OPENROUTER_API_KEY;
      if (!apiKey) throw new LLMConfigError("OPENROUTER_API_KEY not set");
      return createOpenRouterLLM({
        apiKey,
        model: config.model,
        defaultMaxTokens: config.max_tokens,
        defaultTemperature: config.temperature,
      });
    }
    case "ollama":
      return createOllamaLLM({
        host: env.OLLAMA_HOST,
        model: config.model,
        defaultMaxTokens: config.max_tokens,
        defaultTemperature: config.temperature,
      });
    default:
      throw new LLMConfigError(`unknown llm provider: ${config.provider}`);
  }
}
```

### Audit log contract

```ts
// src/llm/audit.ts

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LLMRequest, LLMResponse } from "./types.js";

export interface LLMAuditEntry {
  ts: string;                    // ISO timestamp
  consumer: string;              // name of the calling feature (e.g., "auto-thread-propose")
  provider: string;
  model: string;
  promptHash: string;            // sha256 of concatenated message content
  responseHash: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  estimatedCostUSD?: number;     // when computable
  finishReason: string;
  error?: string;
}

export async function writeLLMAuditEntry(
  vaultRoot: string,
  entry: LLMAuditEntry,
): Promise<void> {
  const dateStr = entry.ts.slice(0, 10);  // YYYY-MM-DD
  const auditDir = join(vaultRoot, "wiki", ".audit");
  await mkdir(auditDir, { recursive: true });
  const auditPath = join(auditDir, `llm-${dateStr}.md`);
  // Append a row to a markdown table. If file doesn't exist, write header first.
  // ...
}

export function hashPrompt(messages: LLMRequest["messages"]): string {
  return createHash("sha256")
    .update(messages.map((m) => `${m.role}:${m.content}`).join("\n\n"))
    .digest("hex")
    .slice(0, 16);
}

export function hashResponse(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

Audit log format (markdown table appended to per-day files):

```markdown
# LLM audit log 2026-05-27

| ts | consumer | provider | model | tokens_in | tokens_out | duration_ms | cost_usd | finish |
|---|---|---|---|---|---|---|---|---|
| 2026-05-27T22:14:03Z | auto-thread-propose | openrouter | openai/gpt-4o-mini | 1247 | 312 | 1840 | 0.00012 | stop |
| ... |
```

**Crucially: the prompt and response are NEVER written to the audit log in plaintext.** Only hashes (16 chars of sha256). This preserves privacy and prevents the audit log from blowing up in size. If a consumer needs to debug a specific call, they can correlate the hash with their own logs.

The audit writer is `await`-able — consumers should write the audit entry before returning the response. A wrapper utility makes this easy:

```ts
export async function chatWithAudit(opts: {
  llm: LLMProvider;
  vaultRoot: string;
  consumer: string;
  request: LLMRequest;
}): Promise<LLMResponse> {
  const started = Date.now();
  try {
    const response = await opts.llm.chat(opts.request);
    await writeLLMAuditEntry(opts.vaultRoot, {
      ts: new Date().toISOString(),
      consumer: opts.consumer,
      provider: opts.llm.providerName,
      model: opts.llm.modelName,
      promptHash: hashPrompt(opts.request.messages),
      responseHash: hashResponse(response.content),
      tokensIn: response.tokensUsed?.prompt ?? null,
      tokensOut: response.tokensUsed?.completion ?? null,
      durationMs: Date.now() - started,
      finishReason: response.finishReason,
    });
    return response;
  } catch (error) {
    await writeLLMAuditEntry(opts.vaultRoot, {
      ts: new Date().toISOString(),
      consumer: opts.consumer,
      provider: opts.llm.providerName,
      model: opts.llm.modelName,
      promptHash: hashPrompt(opts.request.messages),
      responseHash: "",
      tokensIn: null,
      tokensOut: null,
      durationMs: Date.now() - started,
      finishReason: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
```

Consumer briefs use `chatWithAudit()` instead of calling `llm.chat()` directly. The wrapper guarantees audit coverage.

### Files

- New: `src/llm/factory.ts`
- New: `src/llm/audit.ts`
- Modify: `src/storage/config.ts` — parse `llm:` section
- Modify: `templates/config.yaml` — add commented `llm:` section example
- New: `test/llm/factory.test.ts` — provider routing, missing-key errors, unknown provider rejection, kill switch
- New: `test/llm/audit.test.ts` — entry serialization, file creation, append behavior, hash determinism

---

## Task 5 — Extend `memory provider` CLI

### Why
Same operator-verification surface as Phase 4.3.A. Without a "test it" command, the operator has no way to confirm OpenRouter credentials work before pointing a consumer feature at them.

### Contract

Three new subcommands under the existing `memory provider`:

```
memory provider list-llms
# Lists supported LLM providers with required env var names and config status.
#   openrouter (OPENROUTER_API_KEY) [active, model=openai/gpt-4o-mini]
#   ollama     (OLLAMA_HOST)         [available, host=http://localhost:11434]

memory provider test-llm [--provider openrouter|ollama]
# Sends a single message ("Reply with exactly: pong"). Reports model returned,
# token usage, latency, and finish reason. Validates auth + connectivity.

memory provider audit-summary [--days N]
# Reads ~/.memory/wiki/.audit/llm-*.md for the last N days (default 7).
# Reports:
#   - Total calls per consumer
#   - Total tokens in/out per provider/model
#   - Total estimated cost (sum of cost_usd column, when present)
#   - Top 5 most-expensive consumers
# Pure read-only; never writes.
```

The `audit-summary` is useful even before any consumer exists — once Phase 4.3.D ships and consumers start firing, the operator wants a quick "how much have I spent" view.

### Files

- Modify: `src/cli/commands/provider.ts` — add three new subcommand handlers
- New: `test/cli/commands/provider-llm.test.ts` — focused tests for the LLM subcommands (mock the LLM provider; assert correct output formatting)

---

## Execution order

1. **Task 1** (types) — pure interface, foundation
2. **Task 2** (OpenRouter) — independent; can land in any order after Task 1
3. **Task 3** (Ollama) — independent
4. **Task 4** (config + factory + audit + kill switch) — wires everything together
5. **Task 5** (CLI) — operator-facing payoff

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                  # full suite (893 currently passing)
npx vitest run test/llm                               # focus
npm run build
npm run build:ui

# Deploy: dashboard server bundle changes because config loading + storage paths
# touched. SPA unchanged (no UI in this brief).
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs

# IMPORTANT: same pattern as Phase 4.3.A — the openai SDK is bundled as
# external, so any new server-side dependency must be installed on the VPS:
# (openai is already there from 4.3.A; no new deps in this brief but verify)
ssh root@srv1317946 "cd /root/memory-system/services && npm ls openai"

ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify on operator machine:
memory provider list-llms       # nothing active yet (no llm: section in config)
# Add `llm:` section to ~/.memory/config.yaml with provider: openrouter, model:
# openai/gpt-4o-mini. Set OPENROUTER_API_KEY in shell.
memory provider test-llm        # should return "pong" with token counts
memory provider audit-summary   # 1 call logged
```

VPS stays unconfigured (no LLM yet) — no consumer features depend on it. The operator opts in by configuring `llm:` in config.yaml when they want a consumer brief to start firing.

---

## Acceptance checklist

- [ ] `LLMProvider` interface, `LLMRequest`/`LLMResponse` types, `LLMDisabledError`, `LLMConfigError` exported from `src/llm/types.ts`
- [ ] `createOpenRouterLLM` returns a working `LLMProvider`; uses the existing `openai` SDK with OpenRouter baseURL; sends `HTTP-Referer` and `X-Title` headers
- [ ] `createOllamaLLM` returns a working `LLMProvider`; POSTs to `{host}/api/chat`; maps `done_reason` and token counts correctly
- [ ] `createLLMFromConfig` routes each provider correctly; throws `LLMConfigError` with clear message on missing key; throws `LLMDisabledError` when `MEMORY_LLM_DISABLED=true`
- [ ] `~/.memory/config.yaml` accepts an `llm:` section; when absent, `createLLMFromConfig` throws
- [ ] `templates/config.yaml` has a commented `llm:` section example so `memory init` produces it
- [ ] `writeLLMAuditEntry` appends to `~/.memory/wiki/.audit/llm-{YYYY-MM-DD}.md` as a markdown table row
- [ ] `chatWithAudit()` wrapper writes both success and error entries; never logs plaintext prompt/response
- [ ] `memory provider list-llms` shows OpenRouter and Ollama with current config status
- [ ] `memory provider test-llm` sends "Reply with exactly: pong" and reports model + tokens + latency
- [ ] `memory provider audit-summary` reads the last N days of audit logs and reports per-consumer totals
- [ ] All 893+ existing tests still green; new tests added per task
- [ ] No new dependencies (uses existing `openai` SDK for OpenRouter)
- [ ] No API keys in config.yaml, in code, or in any committed artifact
- [ ] No consumer features added (no auto-thread-propose, no classifier, nothing that fires an LLM call in normal operation)
- [ ] No changes to curation orchestrators (`memory compile/lint/page`)
- [ ] No UI changes (4.3.C territory)

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (immediate follow-ups)

These are the next briefs in the Phase 4.3 sequence and beyond:

1. **Phase 4.3.C — Settings UI editability** — `PATCH /api/config` endpoint safelisting non-secret fields (provider names, model names, max tokens — NEVER API keys); Settings page gains edit mode with provider selection forms for both embedder and LLM. The user-visible payoff that motivated this entire 4.3 sequence

2. **Phase 4.3.D — Auto-thread-proposing** — first consumer of the new LLM infrastructure. Cluster raw observations by topic + temporal proximity + entity overlap, propose thread drafts via an OpenRouter call (cheap model, ~$0.50-2 per scheduled scan). Operator validates and promotes. Closes the `narrative-thread-coverage` gap from Phase 4.2 honestly (vs threshold recalibration)

3. **Phase 4.3.E — Procedural extraction** — second consumer. Detect "we did X, then Y, then Z, and it worked" patterns across raw observations and propose procedural memory pages with user approval

4. **Phase 4.3.F — Query intent classifier** — third consumer. Classify "what did we decide vs how do we do X vs what's true now?" to adapt retrieval mode. Tiny prompts per query, cheap models work, hundreds of calls per session

Out of scope for any 4.3.x brief, deferred further:

- **Streaming responses** — the interface is request-response only. Streaming useful if a consumer needs to show output progressively (e.g., a chat UI). Future
- **Anthropic / OpenAI direct providers** — OpenRouter is the gateway. Direct providers add scope without unlocking new capability. Future-additive
- **Prompt caching** (Anthropic-specific) — would require a direct Anthropic client. Worth adding when a high-volume consumer demonstrates it'd save material cost
- **Tool/function calling** — the interface is text-in/text-out. Tool-calling support requires extending the request/response shape. Add when a consumer needs it
- **Multi-modal (image input)** — same; add when a consumer needs it
- **Streaming token cost telemetry** — currently audit log captures total. Per-token cost surfaces are a dashboard feature, not a foundation feature
