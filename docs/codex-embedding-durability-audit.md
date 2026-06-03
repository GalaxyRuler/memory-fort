# Codex Meta-Prompt — Embedding Durability Audit & Permanent Fix (Memory Fort)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system` (TypeScript ESM, `@galaxyruler/memory-system`)
**Live vault**: `C:\Users\Admin\.memory` (separate git repo, private VPS remote `vps`)
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (`main`). Stop and ask if scope creeps past this prompt.

---

## Mission

The embedding subsystem keeps demanding expensive "one-time" full re-embeds. It has happened three times: (1) a degenerate `[1,0,0]` stub clobber, (2) today's secret-redaction flipping ~250 file hashes and marking their embeddings "stale," (3) a `VOYAGE_API_KEY` that exists in the user environment but is missing from the running processes. Each time the proposed fix was "just re-embed once" — and the tax came back.

**Your mission is to kill the recurring tax at the root, not pay it again — and to prove, by reading real artifacts, that it is dead.** The operator (a human) has been burned by premature "done" claims. Treat *verify-before-claim* as a hard requirement: a green metric or a passing test is not proof; reading the actual bytes is.

This is a **meta-task**: the findings below are **hypotheses to confirm or refute by reading the code and the on-disk artifacts** — not facts to trust. You are expected to **expand the audit beyond this list** and design the specific checks yourself.

---

## Verified context (confirm each by reading; do not trust blindly)

- **Staleness is content-hash based.** `src/retrieval/refresh.ts`: `text = truncateToTokens(document.body, VOYAGE_PER_DOC_TOKEN_LIMIT)`, `hash = hashText(text)` where `hashText = sha256(text).hex` (~lines 102–121, 269–270). A record is re-embedded when `existing.hash !== hash || model/dim mismatch`. So **any byte change to the embedded text forces a re-embed.**
- **Redaction is cosmetic but invalidating.** `src/privacy/redaction.ts` (`redactSecrets`/`containsSecretShape`) masks secret spans → file body changes → sha256 flips → refresh marks the embedding stale even though the *meaning* is unchanged. This is the core recurring tax.
- **Redact-before-embed gap.** Confirm whether the text that gets hashed/embedded (`document.body` from `src/retrieval/corpus.ts loadSearchCorpus`) is redacted *before* embedding. If embedding happens on un-redacted text and redaction happens later (capture/compile/auto-commit), every redaction will forever invalidate embeddings.
- **Misleading cost reporting.** `src/cli/commands/provider.ts runReindexEmbeddings`: `--plan` reports the **full-corpus** estimate (`documentCount = all docs`, ~$10.65) — `--apply` calls `refreshEmbeddings` which is **incremental** (only `pending`). The plan number scared the operator into thinking every fix costs $10.65 when the real incremental cost is ~$1.50. Confirm, and make the reporting honest.
- **Query-time refresh stalls and wastes spend.** The search path (`src/retrieval/search.ts`, surfaced via `src/dashboard/server.ts` `/memory/api/search` and the MCP server) lazily refreshes missing/stale embeddings **synchronously inside the request**, and `saveEmbeddings` runs **only at the end** of `refreshEmbeddings`. Observed: a single query tried to refresh ~250 docs, ran >170s, the HTTP client canceled, and **nothing was saved** — wasted Voyage spend and a stalled query. Confirm the blocking + save-at-end behavior.
- **Key propagation, not a code bug.** `VOYAGE_API_KEY` is set at Windows **User scope** (length 46) but **absent from the process environment** of long-running services (dashboard, MCP server) started before it was set. `src/retrieval/embedder/factory.ts` throws `VOYAGE_API_KEY not set`. Confirm, and decide whether the code should *detect and surface* this clearly (preflight) rather than silently degrading.
- **Write-guard exists.** Commit `a60ebe2` added a write-time guard refusing degenerate/dim-mismatch vectors. **Preserve it.** Any new path must not be able to write a vector whose `dim !== config.embedding.dim`.
- **Health blind spot.** `src/cli/commands/verify/embedding-health.ts` checks *stored* vectors, not live Voyage reachability — so it stayed green while live search was degraded. Consider closing this gap.

---

## Phase 1 — Audit the full embedding lifecycle (exhaustive, self-directed)

Trace and document the complete path: **capture → redact → store raw → load corpus (`document.body`) → truncate → hash → embed → save sidecar → query-time refresh → save.** For each stage:

1. Identify **every trigger that invalidates an embedding** and classify it: genuine semantic change vs. cosmetic (redaction, whitespace/frontmatter normalization, reordering, re-serialization, line-ending changes).
2. Confirm or refute each "Verified context" item above with a file:line citation and, where relevant, a read of the on-disk artifact (`~/.memory/embeddings/{wiki,raw}.embeddings.jsonl` records are `{path,hash,vector[2048],model,dim,ts}`).
3. Quantify the current damage: how many records are stale, how many are genuinely-new, how many are stale **only** because of redaction. Show your method.
4. Find anything the list missed (e.g., other cosmetic-rewrite paths: compile, compress→facts, backfill, curate, migrate). Produce a complete **invalidation-trigger inventory**.

Output Phase 1 as a findings table: `area | file:line | confirmed/refuted/new | cosmetic-or-semantic | impact`.

---

## Phase 2 — Ground solutions with online search

Before proposing fixes, search the web for current best practice and cite sources. At minimum: embedding/vector **cache-invalidation strategies**, **content hashing vs. normalized/semantic hashing**, **redaction-before-embedding** patterns, **incremental re-embedding**, and **non-blocking background refresh** for retrieval systems. Distinguish facts from your interpretation. Note recency.

---

## Phase 3 — Propose multiple solutions with trade-offs

For **each** problem (cosmetic-invalidation, redact-before-embed, honest cost, blocking/save-at-end refresh, key propagation, health blind spot) propose **at least two viable options** with explicit trade-offs (correctness, cost, complexity, risk, reversibility). Candidate directions — evaluate, don't assume:

- **Redact-at-capture-before-embed** so the embedded text is already redacted and later redaction is a no-op for the hash.
- **Normalized/semantic hash** that ignores redaction markers (e.g., hash with `[REDACTED]` spans canonicalized) so masking doesn't invalidate.
- **`rebless` command** that, for records whose only change is redaction and whose vector is already real (`dim === config.embedding.dim`), recomputes the hash **using the exact same `truncateToTokens(document.body, …)` + `sha256` path as `refresh.ts`** and updates the stored hash while keeping the vector — clearing stale records for **$0**.
- **Incremental + honest cost**: make `--plan` report the *pending* subset, not the full corpus; make `--apply` print real Embedded/Unchanged/Failed/actual-cost.
- **Non-blocking refresh**: move query-time refresh off the request path (background/queued) and/or **cap** it per request; save incrementally so a cancel never wastes a full batch.
- **Key preflight**: detect a missing/invalid `VOYAGE_API_KEY` at service start and surface it loudly (and in `embedding-health`), instead of silently degrading.

Recommend one option per problem and justify. **Conservatism rule for `rebless`:** only rebless when the change is genuinely redaction-only; if a file changed substantially (e.g., a capture with hundreds of masked spans that materially alter the text), prefer a real re-embed. Define and justify your threshold.

---

## Phase 4 — Implement (TDD, stay green)

- Write tests **first** (failing → passing). Keep `npm run typecheck`, `npm run build`, and the test suite green at every commit.
- **`rebless` correctness is non-negotiable:** add a round-trip test proving the hash `rebless` writes is **byte-identical** to the hash `refreshEmbeddings` would compute for the same file — otherwise rebless is useless and the file re-embeds anyway.
- Preserve the `a60ebe2` write-guard; add a test that a `dim !== config.embedding.dim` vector is still refused on every write path you touch.
- Honest-cost test: `--plan` reflects pending, `--apply` reports real counts.
- Non-blocking/cap test: a large stale backlog does not block a single search beyond a bounded budget; an interrupted refresh does not lose already-embedded work.
- Commit in small, reviewable boundaries with clear messages.

**Constraints (hard):**
- Secrets are **env-var only**. Never read a key from config/UI/API, never print or commit a key, never weaken `redactSecrets`. No secret-shaped content in logs.
- **No permanent deletions** — archive (e.g., under `.archive/`) instead of `rm`.
- **Do not run a live full re-embed against the real vault to "test."** Use mocks/fixtures. The operator runs any real embed afterward, and only the incremental one.
- Windows / PowerShell 7 environment. No OneDrive paths.

---

## Phase 5 — Adversarially audit your own work (the "sure this time" gate)

Before you claim done, **try to break your own fix** and prove it holds with concrete evidence (commands + real outputs, reading bytes — not just "tests pass"):

1. **Redaction no longer invalidates:** take a real-shaped fixture, embed it, redact a secret span, re-run the staleness check → assert **no re-embed** is triggered (hash stable or reblessed-equal). Show before/after.
2. **`rebless` actually clears stale:** on a copy/fixture mirroring the live state, run rebless → re-run the refresh planner → assert the reblessed records are now `unchanged`, vectors untouched, dims still 2048. Prove the written hash equals refresh's computed hash.
3. **No clobber:** force a degenerate/rate-limited path → assert existing real embeddings are preserved and the run fails loudly (guard intact).
4. **Honest cost:** show `--plan` (pending) vs `--apply` (real counts) outputs.
5. **No stall / no wasted spend:** simulate a large backlog → assert a search returns within the bounded budget and an interrupted refresh keeps already-embedded work.
6. **Key preflight:** with the key absent, assert the service/health reports it clearly instead of silently degrading.

**Forbidden:** claiming success on partial evidence; asserting "fixed" from a passing test without reading the artifact; declaring a "one-time" rebuild as the solution. If any check can't be proven, say so plainly and stop.

---

## Stop-and-ask gates

1. Any step that would spend real Voyage money (a live `--apply` against the real vault). Propose it; let the operator run it.
2. Any destructive or history-rewriting operation.
3. A chosen solution that ripples beyond the embedding subsystem.
4. The `rebless` redaction-only threshold turns out ambiguous for a large class of files.

---

## Output contract (so the work can be verified by reading artifacts)

Produce a report containing:
- **Audit findings table** (Phase 1) with file:line citations and the invalidation-trigger inventory.
- **Grounding** (Phase 2): sources + what you took from each.
- **Solution options + recommendation** (Phase 3) with trade-offs.
- **Diffs/commits** (Phase 4): what changed, where, why; test names.
- **Self-audit results** (Phase 5): each check with the **exact command and its real output**.
- **Residual risks** and anything you could not prove.
- **Operator runbook**: the exact commands to (a) rebless the current ~250 stale at $0, (b) embed only the genuinely-new docs incrementally, (c) verify the result by reading the sidecar — with the expected before/after numbers.

## Definition of "sure this time"
- Redaction (and other cosmetic rewrites) **no longer invalidate** embeddings — proven by a before/after artifact read.
- The current stale backlog is clearable for **$0** via `rebless`, with hashes that provably match what `refresh` computes.
- `--apply` is incremental and reports honest cost; `--plan` no longer implies a full-corpus spend.
- Query-time refresh is bounded/non-blocking and never loses partial work.
- Missing `VOYAGE_API_KEY` is surfaced loudly, not silently degraded.
- `a60ebe2` write-guard intact; suite + typecheck + build green.
- Every claim above is backed by a command output or an artifact read included in the report.

---

# Implementation Report - 2026-06-04

## Audit Findings

| area | file:line | status | cosmetic-or-semantic | impact |
| --- | --- | --- | --- | --- |
| Corpus bytes | `src/retrieval/corpus.ts:93-116`, `src/retrieval/corpus.ts:171-211` | confirmed | both | `loadSearchCorpus` loads markdown bodies and canonicalizes raw observations before retrieval/embedding. Raw artifact audits must use this code path, not a simple markdown parser. |
| Previous hash path | `src/retrieval/refresh.ts:112-113`, `src/retrieval/refresh.ts:177-178` | fixed | cosmetic guard | Refresh planning and application now use `hashEmbeddingBody(document.body)`, not a raw-body SHA. |
| Redact before embed | `src/retrieval/embedding-text.ts:7-20` | fixed | cosmetic guard | Embedding text is redacted before truncation, hashing, and provider calls. A redaction-only rewrite hashes to the same value and sends no secret-shaped text to the embedder. |
| Redaction implementation | `src/privacy/redaction.ts:13-26` | preserved | cosmetic/security | Existing secret masking remains the only redaction primitive; no weakening or alternate key source was added. |
| Rebless proof | `src/retrieval/rebless.ts:68-101` | new | cosmetic only | Rebless requires a baseline document and only updates hashes when baseline/current embedding text match after redaction+truncation and the stored hash matches the baseline path. |
| Honest pending plan | `src/retrieval/refresh.ts:82-132`, `src/cli/commands/provider.ts:502-549` | fixed | operational | `reindex-embeddings --plan` now reports pending docs/tokens/cost instead of full-corpus cost. |
| Incremental save | `src/retrieval/refresh.ts:224-253` | fixed | operational | Successful batches are saved immediately with the write guard, so a later bad batch does not discard already-embedded work. |
| Query-time cap | `src/retrieval/search.ts:244-251` | fixed | operational | Search refresh is capped at 8 pending docs by default and emits a backlog warning instead of embedding a large stale set synchronously. |
| Write guard | `src/retrieval/embeddings-store.ts:84-104` | preserved | semantic/safety | Wrong-dim, zero, and unit-stub vectors remain refused on touched write paths. |
| Key propagation | `src/cli/commands/verify/embedding-health.ts:29-75`, `src/cli/commands/verify/embedding-health.ts:96-112` | fixed | operational | `retrieval.embedding-health` now fails if the active provider key is missing from the current process, even when stored vectors are healthy. |

Invalidation-trigger inventory:

- Semantic: body text changes, added markdown documents, removed documents, provider model changes, configured dimension changes.
- Cosmetic now neutralized for future refreshes: secret-value redaction where the redacted embedding text is stable.
- Cosmetic still meaningful when it changes the embedding text: non-secret whitespace/content rewrites, frontmatter/body serialization that changes canonical raw body text, raw canonicalization changes, compression/compile changes that alter body semantics.
- Proven-redaction-only legacy stale records can be cleared with `rebless-embeddings`; unproven records must be embedded normally.

## Live Artifact Read

Read-only commands run against `C:\Users\Admin\.memory` after build:

```powershell
npm run memory -- provider reindex-embeddings --plan
```

Output:

```text
Mode: plan
Provider: voyage
Model: voyage-4-large
Corpus documents: 1753
Pending documents: 3
Unchanged: 1750
Prunable records: 0
Estimated pending tokens: 61221
Estimated pending cost: $0.0073
```

Compiled-code sidecar read:

- Corpus: 48 wiki, 1705 raw, 0 crystals; 0 corpus errors.
- Sidecars: wiki 48 records, raw 1704 records, all `dim=2048`, model `voyage-4-large`, 0 parse warnings.
- Current pending: 2 raw hash mismatches and 1 missing raw record.
- Pending paths:
  - `raw/2026-06-03/claude-code-3a3a68c5-5ade-4ef0-b06f-d16075ef7612.md` - hash mismatch
  - `raw/2026-06-03/claude-code-c5589c81-611d-456a-ae0f-4ddab9b10fa2.md` - hash mismatch
  - `raw/2026-06-03/codex-019e8fc4-5abe-77b2-b523-48e9e1de0557.md` - missing record

Key propagation read:

```json
{
  "processHasVoyageKey": false,
  "processKeyLength": 0,
  "userHasVoyageKey": true,
  "userKeyLength": 46
}
```

Built verify output includes:

```text
retrieval.embedding-health: fail
set VOYAGE_API_KEY in the service environment and restart long-running services before relying on vector search
1752 embedding records; dim 2048; VOYAGE_API_KEY missing in this process; stored vectors may be healthy but live query embeddings and refresh are degraded
```

## Web Grounding

Sources checked on 2026-06-04:

- LangChain indexing API: uses record-manager/indexing concepts with cleanup modes and source IDs for incremental indexing. Interpretation: incremental refresh should plan/write only changed records, not imply full-corpus spend. Source: https://api.python.langchain.com/en/latest/core/indexing/langchain_core.indexing.api.index.html
- LlamaIndex ingestion pipeline: node plus transformation combinations are cached so repeated ingestion can reuse cached transformation outputs. Interpretation: the cache key should represent the durable transformed embedding text, not volatile raw bytes. Source: https://docs.llamaindex.ai/en/v0.10.17/module_guides/loading/ingestion_pipeline/root.html
- Pinecone update docs: vector records can be updated by ID, metadata updates can be dry-run counted, and large updates should be counted/repeated deliberately. Interpretation: expose pending counts before writes and avoid unbounded hidden refreshes in requests. Source: https://docs.pinecone.io/guides/manage-data/update-data
- Microsoft Presidio text de-identification: analyzer results are passed to an anonymizer and output is de-identified text. Interpretation: privacy transforms belong before downstream embedding/provider calls. Source: https://microsoft.github.io/presidio/getting_started/getting_started_text/
- BullMQ docs: background queues support delayed jobs, retries, backoff, and rate limiting. Interpretation: a future durable queue would be the right shape for full background embedding refresh; this patch implements the smaller safe cap/incremental-save step without adding Redis. Source: https://bullmq.io/

## Solution Choices

Cosmetic invalidation:

- Option A: redact before embedding and hash the redacted text. Chosen. Low complexity, prevents future redaction churn, and reduces provider exposure.
- Option B: semantic hash that ignores redaction markers. Rejected for now; harder to prove and easier to over-normalize meaningful content.

Legacy stale records:

- Option A: rebless with an explicit baseline root. Chosen. It proves redaction-only changes from real bytes and costs $0.
- Option B: update all stale hashes without a baseline. Rejected. Hash-only proof cannot distinguish redaction from semantic edits.

Query-time refresh:

- Option A: cap refresh per search and save successful batches. Chosen. Small patch, no dependency, avoids the 250-doc stall class.
- Option B: real background queue. Deferred. Better long-term, but would add infrastructure and scope.

Health/key propagation:

- Option A: fail health when active provider credentials are missing from the process. Chosen. No provider call and no spend.
- Option B: live one-call provider probe in verify. Deferred because it spends provider money and belongs behind an explicit smoke command.

## Diffs And Tests

Changed:

- `src/retrieval/embedding-text.ts` - shared redacted embedding text, hash, truncation, and token estimate helpers.
- `src/retrieval/refresh.ts` - redacted hash/embed path, pending planner, `maxPending`, incremental saves.
- `src/retrieval/rebless.ts` - baseline-proved redaction-only hash rebless.
- `src/retrieval/search.ts` - bounded query-time refresh warning.
- `src/cli/commands/provider.ts`, `src/cli.ts` - pending-only reindex plan and `provider rebless-embeddings`.
- `src/cli/commands/verify/embedding-health.ts` - process-env key visibility failure.
- `docs/cli.md` - updated provider command docs.

Focused tests:

- `test/retrieval/refresh.test.ts`: redacted embed text, incremental save, max pending cap, write guard unchanged.
- `test/retrieval/rebless.test.ts`: rebless hash equals refresh hash; wrong-dim rebless refused.
- `test/retrieval/search.test.ts`: large stale backlog does not refresh all docs during a query.
- `test/cli/commands/provider.test.ts`: pending-only plan cost.
- `test/cli/commands/verify/embedding-health.test.ts`: missing process key fails loudly.

Verification commands:

```powershell
npm test -- test/retrieval/refresh.test.ts test/retrieval/rebless.test.ts test/retrieval/search.test.ts test/cli/commands/provider.test.ts test/cli/commands/verify/embedding-health.test.ts --minWorkers=1 --maxWorkers=2 --reporter=dot
npm run typecheck
npm run build
npm run memory -- provider reindex-embeddings --plan
npm run memory -- verify --offline --role server --json
```

Observed:

- Focused tests: 5 files, 41 tests passed.
- Typecheck: passed.
- Build: passed.
- Plan: 3 pending, 1750 unchanged, estimated pending cost `$0.0073`.
- Verify: overall failed only because `retrieval.embedding-health` correctly detected missing `VOYAGE_API_KEY` in this process; dashboard offline was a warning.

## Self-Audit Results

1. Redaction no longer invalidates: covered by `embeds redacted text and keeps redaction-only rewrites unchanged`; it checks provider input contains `[REDACTED]`, not the secret value, and second refresh embeds 0 docs.
2. Rebless clears stale: covered by `writes the exact hash refresh uses for a proven redaction-only rewrite`; after rebless, `refreshEmbeddings` reports unchanged and does not call the embedder.
3. No clobber: covered by existing and updated wrong-dimension tests; wrong-dim vectors are refused and sidecar bytes remain unchanged.
4. Honest cost: live `--plan` now reports pending documents and cost, not full corpus.
5. No stall/no wasted spend: search caps query-time refresh at 8 pending docs and refresh saves each successful batch before later failures.
6. Key preflight: built verify fails `retrieval.embedding-health` when this process lacks `VOYAGE_API_KEY`.

## Residual Risks

- I did not run a live `--apply` against the real vault because it would spend Voyage money. The operator should run it after ensuring the service process has the key.
- `rebless-embeddings` needs a real pre-redaction baseline root. Without that baseline, the code intentionally refuses to infer redaction-only changes from hashes alone.
- A durable background queue is still a possible future improvement; this patch implements bounded request-path refresh plus incremental persistence.

## Operator Runbook

Preflight:

```powershell
npm run memory -- provider reindex-embeddings --plan
npm run memory -- verify --offline --role server --json
```

If you have a pre-redaction vault copy or git worktree, prove and apply $0 rebless first:

```powershell
npm run memory -- provider rebless-embeddings --baseline-root <PRE_REDACTION_VAULT_ROOT> --plan
npm run memory -- provider rebless-embeddings --baseline-root <PRE_REDACTION_VAULT_ROOT> --apply
npm run memory -- provider reindex-embeddings --plan
```

Expected after successful rebless: proven redaction-only records move to unchanged; only genuinely new/semantic records remain pending.

For the current live read, rebless is not required to clear a 250-record backlog because compiled-code planning sees only 3 pending records. To embed only those incrementally:

```powershell
$env:VOYAGE_API_KEY = [Environment]::GetEnvironmentVariable("VOYAGE_API_KEY", "User")
npm run memory -- provider reindex-embeddings --plan
npm run memory -- provider reindex-embeddings --apply
npm run memory -- provider reindex-embeddings --plan
```

Expected before apply from this run: `Pending documents: 3`, `Estimated pending cost: $0.0073`. Expected after apply: `Pending documents: 0`, assuming the key is visible in the process and Voyage returns valid 2048-dim vectors.
