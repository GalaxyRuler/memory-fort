# Codex Implementation Brief — Procedural Extraction (Phase 4.3.E)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Second consumer of the LLM infrastructure built in Phase 4.3.B. Follows the propose → operator-review → promote pattern established by Phase 4.3.D (auto-thread-proposing).

The session itself produces concrete examples of procedural memory worth capturing:

- **Deploy dashboard to VPS** — scp server bundle, scp SPA, ssh systemctl restart, curl /api/health
- **Reclassify consolidation edges** — memory consolidate --apply --force, commit vault, push to VPS, restart dashboard
- **Backfill missing frontmatter field** — fix writers, add CLI backfill command, add verify check, run --apply, commit
- **Install package on VPS for dashboard runtime** — cd /root/memory-system/services && npm install X (the openai-missing fix)

These patterns recur across multiple sessions. Currently they live only as scattered Bash commands inside raw observations and as ad-hoc lessons. After this brief lands, the operator can run `memory procedure propose --apply` to surface them as draft `wiki/procedures/<slug>.md` pages with preconditions, steps, verification, and failure cases.

Two-stage gating mirrors Phase 4.3.D exactly:
- LLM drafts → `wiki/procedures-proposed/<slug>.md` with `lifecycle: proposed`, `source: auto-procedural-extract`
- Operator runs `memory procedure promote <slug>` to move to canonical `wiki/procedures/<slug>.md` with `lifecycle: consolidated`, `source: auto-procedural-extract-validated`

Cost is bounded the same way: ~$0.001 per proposal × default `--max-proposals 10` ≈ $0.01 per run. Free with OpenRouter free-tier models.

---

## Scope guard

You will:

- Add a new domain directory `wiki/procedures/` (canonical) and `wiki/procedures-proposed/` (drafts). Path-based cognitive-type inference: both classify as `cognitive_type: procedural`
- Add deterministic detection at `src/consolidate/procedure-detect.ts` — extract command-line signatures from raw-observation bodies, cluster by sequence similarity, filter to clusters from ≥2 distinct sessions with ≥1 successful outcome. Pure function, no LLM, no I/O beyond reading the corpus
- Add LLM proposing at `src/llm/procedure-propose.ts` — for a given cluster, prompt the configured LLM to draft a procedural memory page with preconditions/steps/verification/failure-cases. Goes through `chatWithAudit({ consumer: "auto-procedural-extract" })`
- Add orchestrator at `src/cli/commands/procedure.ts` — `memory procedure propose --plan/--apply [--days N] [--max-proposals K]`, plus `memory procedure promote <slug>` and `memory procedure reject <slug>`
- Mirror the safety properties from Phase 4.3.D exactly:
  - All drafts write to `wiki/procedures-proposed/`, never `wiki/procedures/`
  - `lifecycle: proposed`, `source: auto-procedural-extract` on drafts
  - `lifecycle: consolidated`, `source: auto-procedural-extract-validated` on promoted
  - Honor `MEMORY_LLM_DISABLED=true` kill switch
  - Cost cap via `--max-proposals K`
  - Slug collisions resolved with `-2`, `-3` suffixes
  - Run audit log to `wiki/.audit/procedure-propose-{ts}.md`
- Add `templates/wiki/procedures/.gitkeep` and `templates/wiki/procedures-proposed/.gitkeep`
- Update `templates/schema.md` to document the procedural domain + auto-extract workflow
- Tests for detection (fixtures with known command patterns), prompt parser, orchestrator (plan vs apply, slug collisions, kill switch), promote/reject

You will **not**:

- Write proposed procedures directly to `wiki/procedures/`. The operator review gate is non-negotiable
- Add a new graph-health metric for procedural coverage. Keep this brief focused; metric can be a Phase 4.3.G follow-up if procedures become load-bearing
- Add a dashboard UI for proposal review. CLI-only operator workflow same as 4.3.D
- Auto-schedule the propose command. Operator triggers manually
- Process more than `--max-proposals K` clusters per run. Cost discipline
- Touch the curation orchestrators (`memory compile`, `memory lint`, `memory page`)
- Touch the threads pipeline from Phase 4.3.D. Procedures and threads are orthogonal consumers
- Migrate existing `wiki/lessons/*.md` content into `wiki/procedures/`. Lessons stay lessons; procedures are a new layer. If an operator wants to promote a lesson to a procedure, that's a manual move
- Detect procedures from a SINGLE raw observation. Min 2 sessions for cross-session pattern signal (procedures are by definition reusable; one-off solutions are lessons, not procedures)

If the LLM response is malformed or unparseable, **drop that proposal and continue** rather than failing the whole batch. Same contract as Phase 4.3.D — silent skip + audit log captures the failure

---

## Repo orientation (verified before brief)

- `src/consolidate/thread-cluster.ts` (Phase 4.3.D) — reference pattern for deterministic clustering. Mirror its structure but with different similarity signal (command sequence vs entity overlap)
- `src/llm/thread-propose.ts` (Phase 4.3.D) — reference pattern for LLM prompt + parse. Mirror but different prompt content
- `src/cli/commands/thread.ts` (Phase 4.3.D) — reference pattern for propose/promote/reject orchestrator + CLI dispatch. Mirror almost exactly with different paths
- `src/retrieval/corpus.ts:284` — path-based cognitive-type inference. Phase 4.0 added `wiki/prospective/`, 4.2 added `wiki/threads/`, 4.3.D added `wiki/threads-proposed/`. Add `wiki/procedures/` and `wiki/procedures-proposed/` → `cognitive_type: procedural` (same pattern)
- `src/storage/paths.ts` — add `proceduresDir(vaultRoot)` and `proceduresProposedDir(vaultRoot)` helpers
- `src/cli/commands/init.ts` — currently creates `wiki/threads/`, `wiki/threads-proposed/`, `wiki/prospective/`. Extend to also create `wiki/procedures/` and `wiki/procedures-proposed/`
- `templates/schema.md` — document the new domain in the same style as Narrative threads + Auto-thread proposing sections

---

## Task 1 — Deterministic procedure detection

### Why
Detection picks the candidate clusters; the LLM then judges whether each cluster is actually a procedure worth capturing. Deterministic detection means same input → same clusters (reproducibility).

### Contract

```ts
// src/consolidate/procedure-detect.ts

export interface RawObservationRef {
  relPath: string;
  created: string;
  session: string | null;
  source: string;
  title: string;
  body: string;          // full body (we parse commands from it)
}

export interface CommandSignature {
  commands: string[];    // ordered command names extracted from Bash blocks
  hasErrorIndicators: boolean;
}

export interface ProcedureCluster {
  observations: RawObservationRef[];
  signature: string[];          // representative command sequence
  distinctSessions: number;
  cohesionScore: number;        // 0..1, mean pairwise signature similarity
  hasSuccessfulOutcome: boolean; // at least one obs without error indicators
}

export function extractCommandSignature(body: string): CommandSignature;

export function detectProcedureClusters(
  observations: RawObservationRef[],
  opts: {
    minClusterSize?: number;      // default 3
    minDistinctSessions?: number;  // default 2
    minSignatureLength?: number;   // default 3 (clusters need at least 3-command sequences)
    minJaccard?: number;            // default 0.4
  } = {},
): ProcedureCluster[];
```

### Detection algorithm

`extractCommandSignature(body)`:
- Parse the body looking for fenced code blocks (` ```bash`, ` ```sh`, ` ```powershell`, ` ``` ` plain), inline `$ <cmd>` lines, and structured tool-call entries in claude-code/codex raw format
- Extract the **first token** of each command line as the command name (e.g., `scp`, `ssh`, `npm`, `git`, `node`, `curl`)
- Filter out trivial commands (`cd`, `ls`, `cat`, `echo`, `pwd`)
- Return the ordered sequence of remaining command names
- Set `hasErrorIndicators` if body contains case-insensitive matches for: `^error`, `^fatal`, `^FAIL`, `exit code [1-9]`, `Traceback`, `npm ERR!`, `command failed`

`detectProcedureClusters(observations)`:
1. For each observation, compute `extractCommandSignature(body)`
2. Filter out observations whose signature has fewer than `minSignatureLength` commands
3. Cluster by Jaccard similarity over command-name sets (≥ `minJaccard`)
4. For each cluster, compute:
   - `distinctSessions` = count of unique session ids
   - `hasSuccessfulOutcome` = any obs in cluster has `!hasErrorIndicators`
5. Filter to clusters with:
   - `observations.length >= minClusterSize`
   - `distinctSessions >= minDistinctSessions`
   - `hasSuccessfulOutcome` true (at least one observation succeeded)
6. Sort by `cohesionScore * distinctSessions` descending — high-signal clusters first

### Files

- New: `src/consolidate/procedure-detect.ts`
- New: `test/consolidate/procedure-detect.test.ts` — at minimum:
  - 3 obs with `[scp, ssh, curl]` from different sessions → one cluster
  - 3 obs with same signature from one session → no cluster (distinctSessions < 2)
  - 3 obs with similar but not Jaccard-passing signatures → no cluster
  - All-error cluster (no successful outcome) → filtered out
  - Mega-cluster (>30 obs) → still one cluster; LLM cost is bounded by `--max-proposals`, not cluster size

---

## Task 2 — LLM procedure proposing

### Why
For each candidate cluster, prompt the LLM to draft a procedural memory page. The procedural shape is more structured than threads — preconditions, steps, verification, failure cases — so the prompt is correspondingly more directed.

### Contract

```ts
// src/llm/procedure-propose.ts

export interface ProcedureProposal {
  title: string;                          // 10-80 chars; imperative form ("Deploy dashboard...")
  summary: string;                         // 1-2 sentences explaining what the procedure does
  preconditions: string[];                 // required state before running
  steps: Array<{ command?: string; description: string }>;
  verification: string[];                  // how to confirm success
  failureCases: Array<{ condition: string; remedy: string }>;
  tags: string[];                          // domain tags inferred from cluster
  proposedSlug: string;                     // kebab-case from title
}

export async function proposeProcedure(opts: {
  llm: LLMProvider;
  vaultRoot: string;
  cluster: ProcedureCluster;
}): Promise<ProcedureProposal | null>;
```

Returns `null` on malformed response or `skip: <reason>` directive. Audit entry written via `chatWithAudit({ consumer: "auto-procedural-extract" })` for both success and failure.

### Prompt template

```ts
const SYSTEM_PROMPT = `You extract procedural memory pages for Memory Fort. A procedure is a reusable workflow — preconditions, ordered steps, verification, and failure cases — extracted from raw observations where the operator did the same thing successfully across multiple sessions.

Your input is a cluster of raw observations sharing a command-line pattern. Your job: write the procedure page in YAML.

Output exactly this shape, no code fences, no commentary:

title: <imperative form, 10-80 chars>
summary: |
  <1-2 sentences explaining what this procedure accomplishes>
preconditions:
  - <required state before running>
steps:
  - description: <human-readable step>
    command: <shell command if applicable>
verification:
  - <how to confirm the step worked>
failure_cases:
  - condition: <what could go wrong>
    remedy: <how to recover>
tags:
  - <inferred domain tag>
proposed_slug: <kebab-case>

If the cluster doesn't represent a coherent reusable procedure, output: "skip: <reason>" instead. Examples of skip-worthy clusters:
- One-off exploratory work that wouldn't be repeated
- Sessions that happened to share commands by coincidence
- Failed attempts where the actual procedure is unclear`;

const userPrompt = (cluster: ProcedureCluster) => `Command signature: ${cluster.signature.join(", ")}
Cluster size: ${cluster.observations.length} observations across ${cluster.distinctSessions} distinct sessions

Observations:
${cluster.observations.map((obs, i) =>
  `[${i + 1}] ${obs.created} (${obs.source}) — ${obs.title}\n${obs.body.slice(0, 1200)}`,
).join("\n\n")}`;
```

The 1200-char per-observation cap keeps prompt size bounded. With 5 observations × 1200 chars = 6KB user content; well within any model's context.

### Files

- New: `src/llm/procedure-propose.ts`
- New: `test/llm/procedure-propose.test.ts` — mock LLM provider; assert prompt shape (system message includes the YAML template, user message includes cluster summary + per-obs blocks); valid response parses correctly; malformed → null; `skip:` → null

---

## Task 3 — Orchestrator + writer

### Why
Glue clustering + proposing + writing. Mirrors Phase 4.3.D's `src/cli/commands/thread.ts` almost exactly with different paths and field names.

### Contract

```ts
// src/cli/commands/procedure.ts

export interface ProcedureProposeRunOptions {
  vaultRoot: string;
  days?: number;             // default 30
  maxProposals?: number;     // default 10
  apply?: boolean;           // default false (plan)
}

export interface ProcedureProposeRunResult {
  scanned: number;
  clustered: number;
  proposed: number;
  written: number;
  skipped: Array<{ clusterIndex: number; reason: string }>;
  proposals: Array<{ slug: string; title: string; relPath: string; observationCount: number; sessionCount: number }>;
  auditLogPath: string;
}

export async function runProcedurePropose(opts: ProcedureProposeRunOptions): Promise<ProcedureProposeRunResult>;
export async function runProcedurePromote(opts: { vaultRoot: string; slug: string }): Promise<{ from: string; to: string }>;
export async function runProcedureReject(opts: { vaultRoot: string; slug: string }): Promise<{ deleted: string }>;
```

Flow follows Phase 4.3.D's thread orchestrator step-for-step, with:
- `clusterRawObservations` replaced by `detectProcedureClusters`
- `proposeThread` replaced by `proposeProcedure`
- `wiki/threads-proposed/` replaced by `wiki/procedures-proposed/`
- `wiki/threads/` replaced by `wiki/procedures/`
- `auto-thread-propose` replaced by `auto-procedural-extract`

### Proposed file shape

```yaml
---
title: <from LLM>
cognitive_type: procedural
source: auto-procedural-extract
lifecycle: proposed
status: active
confidence:
  extraction: 0.7
  source: 0.6
  validation: unvalidated
  freshness: "2026-05-28"
  conflict: null
created: "2026-05-28"
updated: "2026-05-28"
tags:
  - <from LLM>
  - auto-proposed
  - procedure-draft
relations:
  derived_from:
    - <each cluster observation relPath>
---

# <title>

<summary>

## Preconditions
- <each>

## Steps
1. <description>
   ```bash
   <command if applicable>
   ```

## Verification
- <each>

## Failure cases
- **<condition>**: <remedy>

---

**Auto-generated proposal — `memory procedure propose` on <date>.**
To promote: `memory procedure promote <slug>`. To reject: `memory procedure reject <slug>`.
```

### Files

- New: `src/cli/commands/procedure.ts`
- Modify: `src/storage/paths.ts` — `proceduresDir(vaultRoot)`, `proceduresProposedDir(vaultRoot)` helpers
- Modify: `src/retrieval/corpus.ts` — path-based cognitive-type inference recognizes `wiki/procedures/*.md` and `wiki/procedures-proposed/*.md` as `procedural`
- Modify: `src/cli/commands/init.ts` — `memory init` creates the new directories
- Tests: `test/cli/commands/procedure.test.ts` — plan vs apply, slug collisions, audit log, kill switch honored, promote/reject

---

## Task 4 — CLI registration

### Why
Plumb the new subcommands into the `memory` CLI. Mirror Phase 4.3.D's thread registration.

### Contract

```
memory procedure propose --plan       # default
memory procedure propose --apply
memory procedure propose --days 60 --max-proposals 5 --apply
memory procedure promote <slug>
memory procedure reject <slug>
```

Help text mentions:
- Reads `llm:` section from `~/.memory/config.yaml` — error if absent
- Honors `MEMORY_LLM_DISABLED=true` kill switch
- Drafts land in `wiki/procedures-proposed/`; never `wiki/procedures/`
- ~$0.001 per proposal on gpt-4o-mini × maxProposals
- Min 2 distinct sessions per cluster (procedures are by definition reusable)

### Files

- Modify: `src/cli.ts` — register `memory procedure` subcommand group

---

## Task 5 — Docs + template seeds

### Why
Schema doc + template directories + roadmap update. Tighter than Phase 4.3.D's docs section because the pattern is now established.

### Contract

`templates/wiki/procedures/.gitkeep` and `templates/wiki/procedures-proposed/.gitkeep` — seeds so `memory init` creates the directories.

Append to `templates/schema.md`:

```markdown
## Procedural memory (cognitive type)

Procedural memories live at `wiki/procedures/<slug>.md` with `cognitive_type: procedural`. A procedure is a reusable workflow — preconditions, ordered steps, verification, and failure cases — that the operator runs more than once.

### Schema additions

| Section | Type | Required | Meaning |
|---|---|---|---|
| Preconditions | bulleted list | yes | Required state before running |
| Steps | numbered list, optional fenced commands | yes | Ordered actions |
| Verification | bulleted list | yes | How to confirm success |
| Failure cases | definition list (condition → remedy) | optional | Recovery paths for known failure modes |

All other Brief A/B fields apply normally.

### Auto-extract proposing

`memory procedure propose` detects clusters of raw observations sharing command-line signatures across multiple sessions and asks the configured LLM to draft procedure pages. Drafts land at `wiki/procedures-proposed/<slug>.md` with `lifecycle: proposed` and `source: auto-procedural-extract`. The operator validates and promotes via `memory procedure promote <slug>`.

Same propose → review → promote workflow as auto-thread-proposing. Cost ~$0.001 per proposal on `openai/gpt-4o-mini`, default `--max-proposals 10`. Free with `qwen/qwen-2.5-7b-instruct:free`.

Detection requires ≥3 observations from ≥2 distinct sessions with a successful outcome. One-off solutions are lessons, not procedures.
```

Update `docs/ROADMAP.md` to mark Phase 4.3.E shipped. Phase 4.3.F (query intent classifier) is the next consumer.

### Files

- New: `templates/wiki/procedures/.gitkeep`
- New: `templates/wiki/procedures-proposed/.gitkeep`
- Modify: `templates/schema.md`
- Modify: `docs/ROADMAP.md`

---

## Execution order

1. **Task 1** (detection) — pure function; foundation
2. **Task 2** (LLM propose) — wraps `chatWithAudit()`
3. **Task 3** (orchestrator + writer) — wires it together; touches corpus.ts + paths.ts + init.ts
4. **Task 4** (CLI) — small wiring task
5. **Task 5** (docs + templates) — final composition

Each task = one commit. Run `npx vitest run --no-file-parallelism --testTimeout=10000` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism --testTimeout=10000     # full suite (940 currently passing)
npx vitest run test/consolidate/procedure-detect test/llm/procedure-propose test/cli/commands/procedure
npm run build
npm run build:ui

# Operator preflight:
memory provider list-llms                                     # confirm an LLM is configured
memory provider test-llm                                      # confirm credentials work
ls ~/.memory/wiki/procedures-proposed/                        # confirm directory exists

# Dry run:
memory procedure propose --plan --days 30 --max-proposals 5

# Apply:
memory procedure propose --apply --days 30 --max-proposals 5
ls ~/.memory/wiki/procedures-proposed/                        # see drafts
git -C ~/.memory diff wiki/procedures-proposed/               # review

# Edit drafts in your editor as needed

# Promote keepers / reject misses:
memory procedure promote deploy-dashboard-vps
memory procedure reject one-off-debug-session

# Deploy dashboard (no server-side behavior change in this brief but corpus.ts
# touched, so server bundle changes):
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
ssh root@srv1317946 "systemctl restart memory-dashboard"
```

---

## Acceptance checklist

- [ ] `extractCommandSignature` returns ordered command sequence from raw obs body
- [ ] Trivial commands (`cd`, `ls`, `cat`, `echo`, `pwd`) filtered out of signature
- [ ] `hasErrorIndicators` flag set on bodies containing error/fatal/FAIL/Traceback patterns
- [ ] `detectProcedureClusters` requires ≥3 observations, ≥2 distinct sessions, ≥1 successful outcome
- [ ] `proposeProcedure` returns null on malformed LLM response (never throws)
- [ ] `proposeProcedure` returns null on `skip:` response
- [ ] All proposed procedures write to `wiki/procedures-proposed/`, NEVER `wiki/procedures/`
- [ ] Proposed procedure file has `lifecycle: proposed`, `source: auto-procedural-extract`
- [ ] Promoted procedure file has `lifecycle: consolidated`, `source: auto-procedural-extract-validated`
- [ ] Slug collisions handled with `-2`, `-3` suffixes
- [ ] `MEMORY_LLM_DISABLED=true` causes propose command to surface clear error
- [ ] Audit log written via `chatWithAudit({ consumer: "auto-procedural-extract" })` for every LLM call
- [ ] Run audit log at `wiki/.audit/procedure-propose-{ts}.md`
- [ ] `wiki/procedures/*.md` and `wiki/procedures-proposed/*.md` infer `cognitive_type: procedural` by path
- [ ] `memory init` creates both directories
- [ ] `templates/schema.md` documents the procedural domain
- [ ] All 940+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No changes to curation orchestrators (`memory compile/lint/page`)
- [ ] No changes to thread pipeline from Phase 4.3.D
- [ ] No new graph-health metric (deferred to a follow-up if procedural coverage becomes load-bearing)
- [ ] No dashboard UI for proposal review (CLI-only)
- [ ] No auto-scheduling

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

Belong in separate briefs:

1. **`graph.procedural-coverage` metric** — count of canonical procedures; warn below N. Add to graph-health when there's evidence procedural memory matters for retrieval quality. Defer
2. **Procedure execution wrapper** — `memory procedure run <slug>` that reads the procedure page and walks the operator through the steps interactively. Speculative until enough procedures exist to demonstrate value
3. **Procedure dependency graph** — explicit `depends_on` edges between procedures (e.g., "deploy dashboard" depends on "build SPA"). Easier once 10+ procedures exist
4. **Procedure quality feedback** — track which auto-extracted procedures get promoted vs rejected; surface in `memory provider audit-summary`. Same pattern as 4.3.D's deferred feedback loop
5. **Phase 4.3.F — Query intent classifier** — third and likely last consumer of the LLM infrastructure for now. Classify "what did we decide vs how do we do X vs what's true now?" to adapt retrieval mode. Tiny prompts per query, cheap models work
6. **Reranker provider abstraction** — Voyage's rerank stays Voyage-only after Phase 4.3.A. Same pattern as embedder, additive when needed
