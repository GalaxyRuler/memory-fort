# Codex Implementation Brief — Query Intent Classifier (Phase 4.3.F)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Third and likely last LLM consumer brief. Closes the original retrieval-research recommendation: **classify queries into intent buckets so retrieval can adapt mode and stream weights per intent**.

The motivating gap, from the research synthesis (`docs/ROADMAP.md` Phase 3 future-work and the Constellation Graph notes):

> The default retrieval pipeline does the same thing for every query. A "what did we decide about X" query benefits from boosting `decision`-type pages, recency, and provenance — whereas "how do I deploy X" benefits from boosting `procedural` pages and verification-validated content. Today both run identical 6-stream RRF with no per-intent tuning.

This brief adds a small, cheap LLM call that classifies each query into one of seven intent buckets, and routes the retrieval pipeline through intent-specific stream weights. Falls back to the current uniform weights when the LLM is disabled or returns an unparseable response — strict additive layer.

Differs from 4.3.D and 4.3.E in three important ways:
1. **No propose/promote workflow** — query intent is per-request, not a persisted artifact
2. **Lots of calls** — hundreds per session vs ~10 per propose run. Cost discipline shifts from "small batch" to "tiny prompt + cheap model"
3. **Latency-sensitive** — search is interactive; LLM call adds latency. Heuristic-first detection avoids LLM calls for obvious cases

After this lands, the operator's experience is: same search box, but results re-rank smarter based on what the query is asking for. Telemetry surfaces in `memory provider audit-summary` so the operator can see classifier usage and accuracy.

---

## Scope guard

You will:

- Add an intent classifier at `src/retrieval/query-intent.ts` — defines the seven intent buckets, runs a heuristic-first detector, and falls through to an LLM call only when the heuristic is ambiguous
- Define stream-weight presets per intent at `src/retrieval/intent-weights.ts` — maps `IntentLabel` to a `StreamWeights` object that scales the existing 6 streams (BM25, vector, exact, graph BFS, spreading activation, metadata)
- Integrate into `src/retrieval/search.ts` — accept an optional `intent?: IntentLabel` parameter; if absent, classify; apply weights when RRF fuses
- Audit every LLM classification via `chatWithAudit({ consumer: "query-intent-classify" })` so operators can review usage
- Add a verify check `retrieval.intent-classifier-health` reporting classifier hit rate, LLM-call rate, and recent error rate
- Add a small CLI surface `memory provider test-classifier "<query>"` that runs a single classification and prints the result + latency + cost estimate
- Honor `MEMORY_LLM_DISABLED=true` — when disabled, every query takes the uniform-weight path (no LLM calls, no errors)
- Tests covering: each intent bucket has a representative example that classifies correctly; heuristic catches obvious cases without LLM; LLM fallback path; weight application changes ranking on a fixture; kill switch falls through cleanly; cost cap respected

You will **not**:

- Persist intent labels as memory entries. Intent is per-request transient state. Audit log entries are the only persistence
- Add a UI surface for intent selection. The classifier runs automatically. Operators who want to override can pass `?intent=decision` as a URL param on `/api/search` (additive query param; existing callers unaffected)
- Re-architect the RRF fusion. Stream weights are scalar multipliers on the existing stream scores before RRF reciprocal-rank computation — minimum-invasive integration
- Add machine learning training on intent. Heuristic + LLM classification is the model; no labeled-data pipeline
- Process queries that the heuristic decides are unambiguous through the LLM. Heuristic-first detection is the cost discipline mechanism
- Add a separate intent provider abstraction. The classifier uses the same `LLMProvider` from Phase 4.3.B
- Implement streaming responses. Classification is a synchronous request-response pattern
- Add intent to graph-health metrics. Classification quality belongs in the new verify check, not the cohesion dashboard

If query classification turns out to materially change the retrieval results for the existing test fixtures (i.e., breaks existing search tests), **stop and ask** before changing fixture expectations. Either the new behavior is correct (update fixtures with a documented rationale) or the integration is wrong (back out and reconsider). Don't quietly update fixtures to match the new code

---

## Repo orientation (verified before brief)

- `src/retrieval/search.ts` — main retrieval pipeline; calls into all 6 streams + RRF + rerank. Integration point is right before `rrfFuse()` — apply weights to stream score arrays
- `src/retrieval/rrf.ts` — RRF fusion implementation; accepts per-stream weighted rankings. Verify it supports a weight multiplier; if not, extend
- `src/llm/audit.ts` — `chatWithAudit({ consumer })` wrapper from Phase 4.3.B; reuse with `consumer: "query-intent-classify"`
- `src/cli/commands/verify/registry.ts` — `ALL_CHECKS` array; append the new `retrieval.intent-classifier-health` check
- `src/cli/commands/provider.ts` — existing CLI surface for provider-related commands; extend with `test-classifier`
- `src/dashboard/server.ts` — `/api/search` route handler; extend to accept optional `?intent=` query param that bypasses classification

---

## Task 1 — Intent definitions + heuristic detection

### Why
Heuristic detection runs first and catches obvious cases without an LLM call. This is the cost-discipline mechanism: tiny prompt models are cheap (~$0.0001 per call) but at hundreds of calls per session the bill adds up; heuristic-first cuts ~70% of those calls.

### Contract

Seven intent buckets:

```ts
// src/retrieval/query-intent.ts

export type IntentLabel =
  | "decision"           // "what did we decide about X", "why X over Y"
  | "procedure"           // "how do I X", "steps to X"
  | "episodic"           // "what happened on date X", "when did X"
  | "preference"          // "what does the user prefer about X"
  | "current-truth"       // "what is the current state of X"
  | "code-context"        // "show me code for X", "where is X implemented"
  | "open-ended";          // catch-all for queries that don't fit above

export interface IntentClassification {
  label: IntentLabel;
  confidence: number;         // 0..1
  method: "heuristic" | "llm" | "fallback";
  latencyMs: number;
  tokensUsed?: number;
}

export function classifyQueryHeuristic(query: string): IntentClassification | null;
// Returns non-null when the heuristic is confident (>= 0.7). Null otherwise.

export async function classifyQuery(opts: {
  query: string;
  llm?: LLMProvider;
  vaultRoot: string;
}): Promise<IntentClassification>;
// Tries heuristic first. If heuristic returns null AND llm is provided AND
// MEMORY_LLM_DISABLED !== true, falls through to LLM. Otherwise returns
// { label: "open-ended", confidence: 0.5, method: "fallback" }.
```

### Heuristic rules (evaluated in order)

| Pattern | Intent | Confidence |
|---|---|---|
| `^how (do|can|to|should) (i|we|you)` | `procedure` | 0.85 |
| `^what.* (decide|decision|chose|chosen|chose)` | `decision` | 0.85 |
| `^why (did|do|does|is).+ (instead|over|rather than)` | `decision` | 0.80 |
| `^when (did|does)` or contains a date | `episodic` | 0.80 |
| `(prefer|preference|like)` after subject `user|i` | `preference` | 0.75 |
| `(currently|right now|today|now).*(is|are|status)` | `current-truth` | 0.75 |
| `(show me|where is|find).+(code|implementation|function|file)` | `code-context` | 0.80 |
| `(error|exception|traceback|crash|fail)` | `procedure` | 0.70 |

Confidence threshold for "heuristic accepted": ≥ 0.7. Below that, return null (forces LLM path).

### Files

- New: `src/retrieval/query-intent.ts`
- New: `test/retrieval/query-intent.test.ts` — assert each heuristic rule fires on a representative query; assert ambiguous queries return null; case-insensitive matching

---

## Task 2 — LLM classification fallback

### Why
For queries the heuristic can't classify (typically short queries or ambiguous phrasing), call the configured LLM with a tiny prompt. Cheap models work well — Qwen 7B Free and gpt-4o-mini both classify correctly in this kind of single-label task.

### Contract

Extend `classifyQuery` from Task 1 to call LLM when heuristic returns null:

```ts
async function classifyQueryViaLLM(query: string, llm: LLMProvider, vaultRoot: string): Promise<IntentClassification>;

const SYSTEM_PROMPT = `Classify the user's query into exactly one of these intent buckets:
- decision: asking what was decided, why one option was chosen over another
- procedure: asking how to do something, what steps to take
- episodic: asking about specific past events or when something happened
- preference: asking about user/operator preferences
- current-truth: asking the current state of something
- code-context: asking about code, implementations, or files
- open-ended: anything that doesn't fit the above

Reply with exactly the bucket name, lowercase, on a single line, no explanation, no quotes. If the query is ambiguous, output: open-ended.`;

const userMessage = (query: string) => `Query: ${query}`;
```

Response parsing:
1. Trim whitespace
2. Lowercase
3. Match against the 7 valid labels
4. If not a match, return `open-ended` with confidence 0.5

Cost target: <$0.0001 per classification with gpt-4o-mini. Even 1000 classifications per session = $0.10.

### Files

- Modify: `src/retrieval/query-intent.ts` (add the LLM fallback)
- Modify: `test/retrieval/query-intent.test.ts` — mock LLM provider; assert correct routing, parsing, error fallback to `open-ended`, kill switch falls through cleanly

---

## Task 3 — Per-intent stream weights + RRF integration

### Why
Once we know the intent, apply weighted multipliers to the stream score arrays before RRF fusion. This is the only place the classifier output actually changes behavior.

### Contract

```ts
// src/retrieval/intent-weights.ts

export interface StreamWeights {
  bm25: number;
  vector: number;
  exact: number;
  graphBfs: number;
  spreadingActivation: number;
  metadata: number;
}

export const INTENT_WEIGHTS: Record<IntentLabel, StreamWeights> = {
  "decision": {
    bm25: 0.8, vector: 1.0, exact: 1.0,
    graphBfs: 1.3,                    // boost connected decisions
    spreadingActivation: 1.1,
    metadata: 1.4,                    // boost recency + validation
  },
  "procedure": {
    bm25: 0.7, vector: 1.0, exact: 0.9,
    graphBfs: 1.0,
    spreadingActivation: 0.8,         // procedures are direct, not associative
    metadata: 1.3,                    // boost validated procedures
  },
  "episodic": {
    bm25: 1.2,                        // raw observations are text-heavy
    vector: 1.0, exact: 0.8,
    graphBfs: 0.7,                    // less graph traversal for past events
    spreadingActivation: 0.7,
    metadata: 1.1,                    // recency matters for episodic
  },
  "preference": {
    bm25: 0.9, vector: 1.1, exact: 1.0,
    graphBfs: 0.6,                    // preferences are usually self-contained
    spreadingActivation: 0.6,
    metadata: 1.5,                    // strong validation weighting
  },
  "current-truth": {
    bm25: 0.9, vector: 1.0, exact: 1.0,
    graphBfs: 1.0,
    spreadingActivation: 0.7,
    metadata: 1.6,                    // strongly demote stale; boost canonical
  },
  "code-context": {
    bm25: 1.4,                        // code is keyword-heavy
    vector: 0.9, exact: 1.3,           // exact symbol matching matters
    graphBfs: 1.0,
    spreadingActivation: 0.6,
    metadata: 0.8,
  },
  "open-ended": {
    bm25: 1.0, vector: 1.0, exact: 1.0,
    graphBfs: 1.0, spreadingActivation: 1.0, metadata: 1.0,
  },                                     // uniform — equivalent to today
};
```

### RRF integration

In `src/retrieval/search.ts`, before `rrfFuse([...])`:

```ts
const classification = opts.intent
  ? { label: opts.intent, confidence: 1.0, method: "explicit" as const, latencyMs: 0 }
  : await classifyQuery({ query: opts.query, llm: opts.llmProvider, vaultRoot: opts.vaultRoot });

const weights = INTENT_WEIGHTS[classification.label];

const fused = rrfFuse([
  { source: "bm25", items: toRankedItems(bm25), weight: weights.bm25 },
  { source: "vector", items: toRankedItems(vector), weight: weights.vector },
  // ... etc
]);
```

Extend `rrfFuse` to accept per-stream `weight: number` (default 1.0). When weighted, each stream contributes `weight * (1 / (k + rank))` to the fused score instead of just `1 / (k + rank)`.

Add the classification to the existing `SearchResponse.timings` object: `intentClassification: classification`. Surfaces in `/api/search` response so the UI can display "intent: decision" tag on results.

### Files

- New: `src/retrieval/intent-weights.ts`
- Modify: `src/retrieval/rrf.ts` — add optional `weight` per stream
- Modify: `src/retrieval/search.ts` — call `classifyQuery`, pass weights to `rrfFuse`
- Modify: `src/dashboard/server.ts` — accept optional `?intent=` query param on `/api/search`
- Modify: existing search tests — assert behavior is unchanged when `intent: "open-ended"` (uniform weights = today's behavior); add new tests asserting different intents produce different rankings on the same fixture
- New: `test/retrieval/intent-weights.test.ts` — assert all 7 intents have all 6 stream weights defined; assert `open-ended` weights are all 1.0

---

## Task 4 — Verify check + CLI test surface

### Why
Operators want to know classifier health: how often does the heuristic suffice? What's the LLM call rate? Any recent errors? The verify check surfaces this in `/api/health`. The CLI `test-classifier` lets operators verify routing on specific queries.

### Contract

New verify check:

```ts
// src/cli/commands/verify/intent-classifier.ts

export const intentClassifierHealthCheck: CheckDescriptor = {
  id: "retrieval.intent-classifier-health",
  label: "query intent classifier",
  roles: ["operator", "server"],
  run: async (ctx) => {
    // Read the last 7 days of llm-{date}.md audit logs
    // Filter rows with consumer = "query-intent-classify"
    // Compute: total calls, heuristic-rate, LLM-rate, error-rate
    // If error-rate > 10% over >= 20 calls: fail with details
    // If LLM-rate > 50% over >= 50 calls: warn (heuristic might need tuning)
    // Otherwise: pass with metric summary in detail
  },
};
```

Register in `ALL_CHECKS` after the existing checks.

New CLI subcommand:

```
memory provider test-classifier "<query>"

Example:
  $ memory provider test-classifier "what did we decide about embeddings"
  Query: what did we decide about embeddings
  Label: decision
  Confidence: 0.85
  Method: heuristic
  Latency: 0ms
  Cost: $0.00 (heuristic; no LLM call)
```

For LLM-classified queries, the output also shows `Tokens: in=X out=Y` and `Cost: $0.0001`.

### Files

- New: `src/cli/commands/verify/intent-classifier.ts`
- Modify: `src/cli/commands/verify/registry.ts` — register the new check
- Modify: `src/cli/commands/provider.ts` — add `test-classifier` subcommand
- New: `test/cli/commands/verify/intent-classifier.test.ts`
- New: `test/cli/commands/provider-classifier.test.ts`

---

## Task 5 — Docs + roadmap

### Why
Schema doesn't change (no new memory kinds), but the retrieval pipeline does. Document the intent system in the schema doc as a retrieval-policy section, not a memory-kind section.

### Contract

Append to `templates/schema.md`:

```markdown
## Retrieval intent classification

`memory consolidate` and the dashboard search both run queries through an
intent classifier before retrieval. Seven intent buckets:

| Intent | Meaning | Example query |
|---|---|---|
| decision | What was decided / why X over Y | "what did we decide about embeddings" |
| procedure | How to do something | "how do I deploy the dashboard" |
| episodic | What happened / when | "when did we add prospective memory" |
| preference | User/operator preferences | "what does the user prefer about Voyage" |
| current-truth | Current state of something | "what is the current vault size" |
| code-context | Code, implementations, files | "where is the consolidation runner" |
| open-ended | Catch-all | (anything not matching above) |

Heuristic-first classification handles ~70% of queries with no LLM call.
Remaining queries fall through to the configured LLM (~$0.0001 per call on
gpt-4o-mini). Each intent maps to per-stream weight multipliers applied
before RRF fusion. The `open-ended` weights are uniform (1.0 across all
streams), reproducing today's behavior.

Operators can override with `?intent=<bucket>` on `/api/search` URL query
or via the `memory provider test-classifier` CLI. The classifier honors
`MEMORY_LLM_DISABLED=true` — when disabled, every query takes the
`open-ended` path.
```

Update `docs/ROADMAP.md` to mark Phase 4.3.F shipped and close the Phase 4.3 sequence.

### Files

- Modify: `templates/schema.md`
- Modify: `docs/ROADMAP.md`

---

## Execution order

1. **Task 1** (heuristic) — pure function; foundation; no LLM
2. **Task 2** (LLM fallback) — adds LLM path; depends on Task 1
3. **Task 3** (weights + RRF integration) — the actual retrieval behavior change
4. **Task 4** (verify check + CLI) — operator-facing observability
5. **Task 5** (docs + roadmap)

Each task = one commit. Run `npx vitest run --no-file-parallelism --testTimeout=10000` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism --testTimeout=10000     # full suite (956 currently passing)
npx vitest run test/retrieval/query-intent test/retrieval/intent-weights
npm run build
npm run build:ui

# Operator smoke:
memory provider test-classifier "how do I deploy the dashboard"
memory provider test-classifier "what did we decide about voyage"
memory provider test-classifier "show me code for the consolidation runner"

# Deploy:
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify live classifier:
curl -s 'https://srv1317946.tail6916d8.ts.net/memory/api/search?q=how+do+I+deploy' | \
  jq '.timings.intentClassification'
# Expected: { label: "procedure", confidence: 0.85, method: "heuristic", ... }

# After ~50 classifications accumulate, check classifier health:
curl -s 'https://srv1317946.tail6916d8.ts.net/memory/api/health?deep=true' | \
  jq '.checks[] | select(.id=="retrieval.intent-classifier-health")'
```

---

## Acceptance checklist

- [ ] `IntentLabel` union has exactly 7 buckets
- [ ] `classifyQueryHeuristic` returns non-null for at least one representative example per bucket
- [ ] Ambiguous queries return null from the heuristic (falling through to LLM or fallback)
- [ ] `classifyQuery` returns `open-ended` with `method: "fallback"` when LLM is disabled and heuristic returns null
- [ ] LLM-classified queries logged via `chatWithAudit({ consumer: "query-intent-classify" })`
- [ ] Malformed LLM response falls back to `open-ended` (never throws)
- [ ] `INTENT_WEIGHTS` defines all 6 stream weights for all 7 intents
- [ ] `open-ended` weights are all 1.0 (preserves today's behavior)
- [ ] `rrfFuse` accepts optional `weight` per stream; default 1.0; behavior unchanged for unweighted callers
- [ ] `search.ts` calls `classifyQuery` and passes weights to `rrfFuse`
- [ ] `/api/search?intent=<bucket>` URL param overrides classification
- [ ] `SearchResponse.timings.intentClassification` is populated in responses
- [ ] `retrieval.intent-classifier-health` verify check appears in `/api/health?deep=true`
- [ ] Check fails when error rate >10% over ≥20 calls; warns when LLM rate >50%; otherwise pass
- [ ] `memory provider test-classifier "<query>"` runs single classification and reports label/confidence/method/latency/cost
- [ ] `MEMORY_LLM_DISABLED=true` causes every query to take the uniform `open-ended` path
- [ ] All 956+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No new memory kinds (intent is per-request transient state)
- [ ] No machine-learning training pipeline (heuristic + LLM is the model)
- [ ] No streaming responses (synchronous request-response)
- [ ] No UI surface for manual intent selection (URL param sufficient)

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (closes Phase 4.3)

After this brief lands, Phase 4.3 is fully closed. Possible Phase 4.4 candidates if they become load-bearing:

1. **Intent-classifier accuracy feedback loop** — track which classified intents lead to results the operator clicks vs ignores; surface accuracy per intent in `audit-summary`. Useful once classifier has 1000+ calls of history
2. **Per-intent prompt tuning** — current heuristic + simple LLM prompt may be good enough forever, but if a bucket's classification accuracy drops, the prompt for that bucket could be specialized
3. **Per-cognitive-type stream weights** — the current weights are global per intent. A more granular system would weight per (intent, target-cognitive-type) pair. Speculative until evidence shows the simpler version isn't enough
4. **Custom intent buckets via config** — let the operator define additional intents in config.yaml with their own heuristic rules and weights. Defer until evidence shows the 7 built-ins are too restrictive
5. **Reranker provider abstraction** — finally close the loop on Phase 4.3.A's rerank deferral. Voyage rerank stays Voyage-only today; abstracting it is the same pattern as embedder. Additive, low-risk, high-impact when an alternative reranker becomes attractive
6. **Phase 4.4 — Cognitive-type retrieval routing** — beyond just intent weights, the retrieval pipeline could fetch from cognitive-type-specific candidate pools (e.g., always include the top-3 `core` memories regardless of relevance). Speculative; only worth doing if the intent classifier alone leaves meaningful retrieval quality on the table
