# Codex Implementation Brief — Auto-Thread-Proposing (Phase 4.3.D)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

First consumer of the LLM infrastructure built in Phase 4.3.B. Closes the `graph.narrative-thread-coverage` gap honestly (currently 3.3% from 4 hand-authored threads) by clustering raw observations and proposing draft threads via LLM.

The flow:
1. **Cluster** raw observations by topic (entity overlap) + temporal proximity, deterministically (no LLM)
2. **Propose** — for each cluster, call the configured LLM to draft a thread (title, summary, key decisions/lessons, open questions)
3. **Audit + Write** — proposed thread lands at `wiki/threads-proposed/<slug>.md` with `lifecycle: proposed` and `source: auto-thread-propose`. Never `wiki/threads/` directly
4. **Review** — operator examines drafts, edits if needed, runs `memory thread promote <slug>` to move from proposed to canonical

Two-stage gating ensures the coverage metric stays honest:
- `wiki/threads-proposed/*.md` does NOT count toward `narrative-thread-coverage` (Phase 4.2's metric)
- Only `wiki/threads/*.md` (promoted by operator) counts

This preserves the rule from `wiki/decisions/2026-05-22-curation-orchestrator-not-llm.md` in spirit: the LLM proposes; the operator validates. The system never auto-canonicalizes LLM output.

Cost is bounded: ~$0.001 per proposal with gpt-4o-mini, default `--max-proposals 10`, so ~$0.01 per run. Free-tier OpenRouter models (Qwen, Llama variants) cost $0. Operator chooses cadence (weekly / on-demand).

---

## Scope guard

You will:

- Add deterministic clustering at `src/consolidate/thread-cluster.ts` — group raw observations by entity overlap (Jaccard similarity > 0.5) + temporal proximity (within 7-day window). Min cluster size 3, max 30. Pure function, no LLM, no I/O beyond reading the corpus
- Add LLM proposing at `src/llm/thread-propose.ts` — for a given cluster, build a prompt + parse the YAML response into a structured `ThreadProposal` object. Goes through `chatWithAudit()` from Phase 4.3.B so every call is audited
- Add the orchestrator at `src/cli/commands/thread.ts` — `memory thread propose --plan/--apply [--days N] [--max-proposals K]`, plus `memory thread promote <slug>` and `memory thread reject <slug>`
- All proposed threads write to `wiki/threads-proposed/*.md` with `lifecycle: proposed`, `source: auto-thread-propose`, and `confidence: { extraction: 0.7, source: 0.5, validation: "unvalidated", freshness: <today>, conflict: null }`. The promoted thread (post-operator-review) lives at `wiki/threads/<slug>.md` with `lifecycle: consolidated` and `source: auto-thread-propose-validated`
- Path inference in `src/retrieval/corpus.ts` extends to recognize `wiki/threads-proposed/*.md` as `cognitive_type: episodic` (same as `wiki/threads/`), so the dashboard renders them
- `graph.narrative-thread-coverage` metric (Phase 4.2) MUST exclude `wiki/threads-proposed/*.md` from its numerator. Only the canonical `wiki/threads/*.md` counts. **This is the critical invariant** — verify the metric reads from the right path
- Add `templates/wiki/threads-proposed/.gitkeep` so `memory init` creates the directory
- Update `templates/schema.md` to document the propose → promote workflow
- Audit log entries from `chatWithAudit()` use `consumer: "auto-thread-propose"` so the audit-summary CLI reports them properly
- Honor `MEMORY_LLM_DISABLED=true` — propose command refuses with clear error pointing at the kill switch
- Tests for: clustering (fixtures with known overlap patterns), prompt parser (well-formed and malformed LLM responses), promote/reject CLI, metric still excludes proposed threads, dry-run vs apply

You will **not**:

- Write proposed threads directly to `wiki/threads/`. The operator review gate is non-negotiable
- Modify any existing wiki content (decisions, lessons, references). Auto-propose only writes NEW files under `threads-proposed/`
- Auto-promote based on confidence score. Even a high-confidence LLM proposal stays in `threads-proposed/` until the operator promotes
- Add a dashboard UI for proposal review in this brief. CLI-only operator workflow (`ls wiki/threads-proposed/`, edit, `memory thread promote`). Dashboard UI is a future-work brief
- Add a verify check `threads.proposal-queue-size`. Operator queue management is a future enhancement
- Process more than `--max-proposals K` clusters per run. Cost discipline
- Touch the curation orchestrators (`memory compile`, `memory lint`, `memory page`). They stay as prompt-printers
- Auto-schedule the propose command. Operator triggers manually for now; scheduled runs are future-work
- Embed in the consolidation pipeline. `memory consolidate` stays focused on raw → wiki linking; thread proposing is a separate command

If the LLM response is malformed or unparseable, **drop that proposal and continue** rather than failing the whole batch. Log the failure to the audit entry. Don't ask Codex about parse-error handling — silent skip + audit log is the contract

---

## Repo orientation (verified before brief)

- `src/consolidate/runner.ts` — pattern for orchestrators that walk the corpus, propose changes, write audit log. Mirror its structure (plan vs apply modes)
- `src/llm/types.ts` + `src/llm/factory.ts` + `src/llm/audit.ts` — Phase 4.3.B infrastructure. `chatWithAudit()` is the wrapper to use; never call `llm.chat()` directly
- `src/retrieval/corpus.ts:284` (approximate) — path-based cognitive-type inference. Add `wiki/threads-proposed/` branch
- `src/dashboard/graph-health.ts:metricNarrativeThreadCoverage` — Phase 4.2's metric. Verify it filters out `threads-proposed/` from the thread set. If it doesn't, fix it as part of Task 4
- `src/storage/paths.ts` — path resolution; add `THREADS_PROPOSED_DIR` constant
- `templates/wiki/threads/` — existing template seed; mirror for `threads-proposed/`
- `~/.memory/config.yaml` — must have an `llm:` section configured for propose to work. The propose command surfaces a clear error if missing

---

## Task 1 — Deterministic thread clustering

### Why
Clustering is the cheap, reproducible part. No LLM involved. Pure function over the corpus: same input → same clusters. This makes the proposal step the only stochastic step.

### Contract

```ts
// src/consolidate/thread-cluster.ts

export interface RawObservationRef {
  relPath: string;
  created: string;           // ISO date
  entities: string[];        // paths referenced via relations (mentions, derived_from, etc.)
  source: string;            // "claude-code" | "codex" | "agentmemory" | ...
  title: string;
  snippet: string;           // first 500 chars of body
}

export interface ThreadCluster {
  observations: RawObservationRef[];
  sharedEntities: string[];   // entities present in >=50% of obs
  timeRange: { start: string; end: string };
  cohesionScore: number;      // 0..1, higher = more focused cluster
}

export function clusterRawObservations(
  observations: RawObservationRef[],
  opts: {
    minClusterSize?: number;   // default 3
    maxClusterSize?: number;   // default 30
    timeWindowDays?: number;    // default 7
    minJaccard?: number;        // default 0.5
  } = {},
): ThreadCluster[];
```

Algorithm:

1. Sort observations chronologically
2. For each observation, compute its entity set
3. Start with each observation as a singleton cluster
4. Merge adjacent (in time) clusters where Jaccard similarity of entity sets ≥ `minJaccard` AND time gap ≤ `timeWindowDays`
5. Iterate until stable
6. Filter to clusters with size in `[minClusterSize, maxClusterSize]`
7. For each, compute `sharedEntities` (entities in ≥50% of obs) and `cohesionScore` (mean Jaccard of all observation pairs)
8. Sort clusters by `cohesionScore * size` descending — high-leverage clusters first

Edge cases:
- Observations with zero entities (no relations) → never cluster (cluster requires shared entities)
- Single observation per day for entity X → still a cluster if it's part of a longer arc; the merge step handles this
- Mega-clusters (>30 obs sharing many entities) → split into time-bounded sub-clusters of max 30

### Files

- New: `src/consolidate/thread-cluster.ts`
- New: `test/consolidate/thread-cluster.test.ts` — at minimum:
  - 3 obs sharing 2 entities within 3 days → one cluster
  - 3 obs sharing entities but >7 days apart → no cluster
  - 2 obs sharing entities → no cluster (below min)
  - 50 obs sharing entities → split into 2 clusters (max 30 each)
  - Singleton observations → no cluster
  - cohesionScore monotonic with shared-entity ratio

---

## Task 2 — LLM thread proposing

### Why
For each cluster, ask the LLM to draft a thread title + summary + key decisions/lessons. Pure I/O wrapper around `chatWithAudit()`.

### Contract

```ts
// src/llm/thread-propose.ts

export interface ThreadProposal {
  title: string;                  // 10-80 chars
  summary: string;                 // 2-3 sentences
  keyDecisions: string[];          // observed wiki/decisions/* relPaths or descriptions
  keyLessons: string[];            // observed wiki/lessons/* relPaths or descriptions
  openQuestions: string[];
  proposedSlug: string;             // kebab-case from title
}

export interface ThreadProposeOptions {
  llm: LLMProvider;
  vaultRoot: string;
  cluster: ThreadCluster;
}

export async function proposeThread(
  opts: ThreadProposeOptions,
): Promise<ThreadProposal | null>;
```

Returns `null` when the LLM response is malformed or empty — never throws on parse error. Audit entry is written regardless (success or failure).

Prompt template (system + user messages):

```ts
const SYSTEM_PROMPT = `You draft narrative thread pages for Memory Fort, a personal agent-memory system. A thread aggregates raw observations from a coherent stretch of work — usually 3-30 sessions sharing entities and a time window.

Your job: given a cluster of observations, write the front-matter fields of a thread page in YAML.

Output exactly this shape, no code fences, no commentary:

title: <10-80 chars, no quotes>
summary: |
  <2-3 sentences explaining what arc this represents>
key_decisions:
  - <wiki/decisions/path-or-description>
key_lessons:
  - <wiki/lessons/path-or-description>
open_questions:
  - <unresolved question>
proposed_slug: <kebab-case>

If the cluster doesn't represent a coherent arc, output: "skip: <reason>" instead. The orchestrator will drop that cluster.`;

const userPrompt = (cluster: ThreadCluster) => `Cluster: ${cluster.observations.length} observations
Time range: ${cluster.timeRange.start} to ${cluster.timeRange.end}
Shared entities: ${cluster.sharedEntities.join(", ")}

Observations:
${cluster.observations.map((obs, i) =>
  `[${i + 1}] ${obs.created} (${obs.source}) — ${obs.title}\n${obs.snippet}`,
).join("\n\n")}`;
```

Response parsing:

1. Try to parse as YAML
2. Check required fields (`title`, `summary`, `proposed_slug`)
3. Sanitize: title length 10-80 chars, slug matches `/^[a-z0-9-]+$/`, arrays not too long
4. If response starts with `skip:`, return `null`
5. If parse fails, return `null` (audit log will capture the failure)

### Files

- New: `src/llm/thread-propose.ts`
- New: `test/llm/thread-propose.test.ts` — mock the LLM provider; assert prompt shape; assert valid response parses correctly; malformed response → null; "skip:" response → null

---

## Task 3 — Orchestrator + thread writer

### Why
Glue the clustering + proposing + writing together. Single command flow: load corpus → cluster → for each top-K cluster, propose via LLM → write proposal file → return summary.

### Contract

```ts
// src/cli/commands/thread.ts

export interface ThreadProposeRunOptions {
  vaultRoot: string;
  days?: number;             // default 30
  maxProposals?: number;     // default 10
  minClusterSize?: number;   // default 3
  apply?: boolean;            // default false (plan)
}

export interface ThreadProposeRunResult {
  scanned: number;
  clustered: number;
  proposed: number;
  written: number;            // 0 in plan mode; same as proposed in apply mode
  skipped: Array<{ clusterIndex: number; reason: string }>;
  proposals: Array<{
    slug: string;
    title: string;
    relPath: string;           // wiki/threads-proposed/<slug>.md
    observationCount: number;
  }>;
  auditLogPath: string;
}

export async function runThreadPropose(
  opts: ThreadProposeRunOptions,
): Promise<ThreadProposeRunResult>;
```

Flow:
1. Load corpus (raw observations only); filter to last N days
2. Build `RawObservationRef[]` (extract entities from `relations`)
3. `clusterRawObservations(refs)` → clusters sorted by cohesion × size desc
4. Take top `maxProposals` clusters
5. For each cluster:
   a. Refuse if `MEMORY_LLM_DISABLED=true` (factory throws; bubble up)
   b. Call `proposeThread({ llm, vaultRoot, cluster })`
   c. If null, record skip; continue
   d. If valid, build the thread file content (frontmatter + body) and (apply mode) atomic-write to `wiki/threads-proposed/<slug>.md`
6. Write audit log to `wiki/.audit/thread-propose-{ts}.md` with full summary
7. Return `ThreadProposeRunResult`

Thread file shape (auto-written):

```yaml
---
title: <from LLM>
cognitive_type: episodic
source: auto-thread-propose
lifecycle: proposed
status: active
confidence:
  extraction: 0.7
  source: 0.5
  validation: unvalidated
  freshness: "2026-05-28"
  conflict: null
created: "2026-05-28"
updated: "2026-05-28"
time_range:
  start: <cluster.timeRange.start>
  end: <cluster.timeRange.end>
tags:
  - auto-proposed
  - thread-draft
relations:
  mentions:
    - <each cluster observation relPath>
  derived_from:
    - <each sharedEntity if it's a wiki page>
---

# <title>

<summary from LLM>

## Key decisions

- <each from LLM>

## Key lessons

- <each from LLM>

## Open questions

- <each from LLM>

---

**Auto-generated proposal — `memory thread propose` on <date>.**
To promote: `memory thread promote <slug>`. To reject: `memory thread reject <slug>`.
This draft will not be counted toward `graph.narrative-thread-coverage` until promoted.
```

Slug collision handling: if `wiki/threads-proposed/<slug>.md` already exists, suffix with `-2`, `-3`, etc.

Promote + reject:

```ts
export async function runThreadPromote(opts: {
  vaultRoot: string;
  slug: string;
}): Promise<{ from: string; to: string }>;
// Reads wiki/threads-proposed/<slug>.md, updates frontmatter
// (lifecycle: consolidated, source: auto-thread-propose-validated),
// atomic-writes to wiki/threads/<slug>.md, deletes the proposed file

export async function runThreadReject(opts: {
  vaultRoot: string;
  slug: string;
}): Promise<{ deleted: string }>;
// Deletes wiki/threads-proposed/<slug>.md
```

### Files

- New: `src/cli/commands/thread.ts`
- Modify: `src/storage/paths.ts` — add `threadsProposedDir(vaultRoot)` helper
- Modify: `src/retrieval/corpus.ts` — extend cognitive-type inference to recognize `wiki/threads-proposed/*.md` as `episodic`
- Modify: `src/dashboard/graph-health.ts` — `metricNarrativeThreadCoverage` must filter the thread set to `relPath.startsWith("wiki/threads/")` and explicitly exclude `wiki/threads-proposed/`. **This is the critical invariant** — verify the existing filter behavior; if it accidentally includes the proposed dir, fix it
- New: `test/cli/commands/thread.test.ts` — assert plan vs apply, slug collision handling, audit log written, kill switch honored, promote and reject

---

## Task 4 — CLI registration

### Why
Plumb the new subcommands into the `memory` CLI.

### Contract

```
memory thread propose --plan       # default
memory thread propose --apply
memory thread propose --days 60 --max-proposals 5 --apply
memory thread promote <slug>
memory thread reject <slug>
```

Help text mentions:
- Reads `llm:` section from `~/.memory/config.yaml` — error if absent
- Honors `MEMORY_LLM_DISABLED=true` kill switch
- Drafts land in `wiki/threads-proposed/`; never `wiki/threads/`
- Each run costs ~$0.001 per proposal × maxProposals on gpt-4o-mini

### Files

- Modify: `src/cli.ts` — register `memory thread` subcommand group
- Modify: `src/cli/commands/thread.ts` — wire up arg parsing and subcommand dispatch
- Tests covered in Task 3

---

## Task 5 — Docs + template seed

### Why
Schema doc + template directory + roadmap update.

### Contract

`templates/wiki/threads-proposed/.gitkeep` — seed so `memory init` creates the directory.

Append to `templates/schema.md` (Narrative threads section):

```markdown
## Auto-thread proposing

`memory thread propose` clusters raw observations and asks the configured LLM
to draft thread pages. Drafts land at `wiki/threads-proposed/<slug>.md` with
`lifecycle: proposed` and `source: auto-thread-propose`. They are NOT counted
toward `graph.narrative-thread-coverage` until the operator validates them.

### Operator workflow

1. `memory thread propose --apply` (default: weekly cadence)
2. `ls ~/.memory/wiki/threads-proposed/` — review drafts
3. Edit any drafts that need adjustment (open in your editor of choice)
4. `memory thread promote <slug>` — moves to `wiki/threads/`, updates
   `lifecycle: consolidated`, `source: auto-thread-propose-validated`
5. OR `memory thread reject <slug>` — deletes the draft

The promoted thread counts toward `narrative-thread-coverage` like any
hand-authored thread.

### Cost

~$0.001 per proposal with `openai/gpt-4o-mini` via OpenRouter.
Default `--max-proposals 10` per run. Free with OpenRouter free-tier
models (`qwen/qwen-2.5-7b-instruct:free`).
```

Update `docs/ROADMAP.md` Phase 4.3 section to mark 4.3.D shipped.

### Files

- New: `templates/wiki/threads-proposed/.gitkeep`
- Modify: `templates/schema.md`
- Modify: `docs/ROADMAP.md`

---

## Execution order

1. **Task 1** (clustering) — pure function; foundation; lowest risk
2. **Task 2** (LLM propose) — wraps `chatWithAudit()`; depends on Task 1's types but not implementation
3. **Task 3** (orchestrator + writer + metric fix) — wires it together; touches the metric to enforce the proposed-exclusion invariant
4. **Task 4** (CLI) — small wiring task
5. **Task 5** (docs + template) — pure documentation

Each task = one commit. Run `npx vitest run --no-file-parallelism --testTimeout=10000` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism --testTimeout=10000     # full suite (924 currently passing)
npx vitest run test/consolidate/thread-cluster test/llm/thread-propose test/cli/commands/thread
npm run build
npm run build:ui

# Operator preflight before running propose:
memory provider list-llms                                     # confirm an LLM is configured
memory provider test-llm                                      # confirm credentials work
ls ~/.memory/wiki/threads-proposed/                           # confirm directory exists

# Dry run:
memory thread propose --plan --days 30 --max-proposals 5

# Apply:
memory thread propose --apply --days 30 --max-proposals 5
ls ~/.memory/wiki/threads-proposed/                           # see new drafts
git -C ~/.memory diff wiki/threads-proposed/                  # review
# Edit drafts that need adjustment in any editor

# Promote the good ones:
memory thread promote my-arc-slug
memory thread promote another-arc

# Reject the bad ones:
memory thread reject bad-cluster-slug

# Verify metric reflects only promoted threads:
curl -s https://srv1317946.tail6916d8.ts.net/memory/api/graph-health | \
  jq '.metrics[] | select(.id=="graph.narrative-thread-coverage")'

# Deploy (dashboard server reads from synced vault; no server bundle change required
# for this brief — all changes are CLI-side. Unless the graph-health filter fix in
# Task 3 changes server.ts output, scp the dashboard bundle just in case.)
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
ssh root@srv1317946 "systemctl restart memory-dashboard"
```

---

## Acceptance checklist

- [ ] `clusterRawObservations` is a pure function with no I/O
- [ ] Singleton observations never cluster
- [ ] Cluster splits when temporal gap > timeWindowDays
- [ ] Cluster size respects [minClusterSize, maxClusterSize]
- [ ] `proposeThread` returns null on malformed LLM response (never throws)
- [ ] `proposeThread` returns null on `skip:` LLM response
- [ ] Audit log entry written for every LLM call (success or failure) via `chatWithAudit`
- [ ] `memory thread propose --plan` writes nothing; `--apply` writes to `wiki/threads-proposed/`
- [ ] Proposed thread file has `lifecycle: proposed`, `source: auto-thread-propose`
- [ ] Proposed threads NEVER write to `wiki/threads/`
- [ ] Slug collisions handled with `-2`, `-3`, etc. suffixes
- [ ] `memory thread promote <slug>` moves file from proposed → threads, updates lifecycle and source
- [ ] `memory thread reject <slug>` deletes the proposed file
- [ ] `graph.narrative-thread-coverage` metric EXCLUDES `wiki/threads-proposed/*.md` from its thread set
- [ ] `MEMORY_LLM_DISABLED=true` causes propose command to surface a clear error
- [ ] Audit log to `wiki/.audit/thread-propose-{ts}.md` summarizes the run
- [ ] `templates/wiki/threads-proposed/.gitkeep` seed exists
- [ ] `templates/schema.md` documents the propose → promote workflow
- [ ] All 924+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No changes to curation orchestrators (`memory compile/lint/page`)
- [ ] No dashboard UI for proposal review (CLI-only operator workflow)
- [ ] No auto-scheduling of propose command

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

Belong in separate briefs:

1. **Proposal review UI on the dashboard** — `/memory/threads-proposed` SPA route showing drafts with promote/reject buttons; same workflow as the CLI but visual. Defer until evidence shows the CLI workflow is annoying enough to warrant the UI surface area
2. **Scheduled propose runs** — Windows Task Scheduler / systemd timer entry that runs `memory thread propose --apply` weekly. Same scheduling infrastructure as the existing scheduled verify (`memory verify --schedule install`); easy to extend
3. **Embedding-based clustering** — current Jaccard similarity over entity sets misses semantically-related observations that don't share explicit relations. Voyage embeddings already exist (Phase 0); a future brief could augment the clustering signal. Defer until measurement shows the Jaccard-only signal is leaving meaningful clusters on the table
4. **Cross-cluster theme detection** — find threads that should themselves be aggregated (a meta-thread that spans multiple sub-threads). Defer until many threads accumulate
5. **Proposal quality feedback loop** — track which proposals get promoted vs rejected, surface aggregate accept rate in `memory provider audit-summary`. Useful for tuning prompts and choosing models. Defer until ≥50 proposals exist
6. **Phase 4.3.E — Procedural extraction** — second consumer of LLM infrastructure. Detect "we did X, then Y, then Z, and it worked" patterns across raw observations; propose procedural memory pages. Same propose → promote workflow; different prompt and clustering signal
7. **Phase 4.3.F — Query intent classifier** — third consumer. Classify queries into intent buckets for adaptive retrieval. Tiny prompt per query; cheap models work
