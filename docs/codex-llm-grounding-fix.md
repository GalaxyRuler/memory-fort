# Codex Implementation Brief — LLM Output Grounding Fix (Phase 4.3.G)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Critical fix for the auto-thread-propose (Phase 4.3.D) and auto-procedural-extract (Phase 4.3.E) pipelines. Live-vault testing surfaced a fundamental issue: **the LLM hallucinates wiki page references that don't exist in the vault**.

Concrete examples from the 2026-05-28 live run:

The Tauri thread draft (`wiki/threads-proposed/tauri-desktop-integration-and-web-preview.md`) included relations to:
- `wiki/decisions/tauri-icon-integration-path` — does not exist
- `wiki/decisions/use-absolute-paths-in-tests` — does not exist
- `wiki/lessons/tauri-cross-platform-line-ending-warnings` — does not exist
- `wiki/lessons/importance-of-temp-dir-isolation-for-test-stability` — does not exist

The procedure draft (`wiki/procedures-proposed/perform-daily-personal-skill-review.md`) invented:
- A command `run-automation daily-personal-skill-review` that doesn't exist as a real CLI
- A path `$CODEX_HOME/automations/daily-personal-skill-review/memory.md` that doesn't exist

Root cause: the LLM was instructed to output a `relations` block and a `command` field, so it produced one — by inventing plausible-sounding content. The current prompt doesn't constrain it to real paths or commands. Promoting any of these drafts would pollute the vault with broken wikilinks.

This brief makes both pipelines grounded:

1. **Constrain the prompt with real candidates.** Pre-extract the union of wiki pages referenced by the cluster's observations + (optionally) page paths whose titles match cluster entities. Pass this list to the LLM as the allowed reference set
2. **Post-process verification.** After the LLM returns, strip any `wiki/<category>/<slug>` reference whose target doesn't resolve to a real file on disk. Defense-in-depth even when the prompt also gets tightened
3. **Audit the strip rate.** Record in the audit log how many references were stripped per proposal. Operator can see when the LLM is over-generating

After this lands, the propose pipelines stop polluting the vault. Drafts contain only verified-real references. Summaries, open questions, and step descriptions remain LLM-generated (the LLM is creative there; we can't ground free-form text) but every structural reference is real.

Phase 4.3.D and 4.3.E ship with this gap by design — the brief I drafted didn't anticipate the hallucination scale. The fix lives in one brief that touches both consumers.

### External validation of the approach

The candidate-list + post-process design is not a guess; it matches the 2026 production consensus on hallucination prevention in structured-extraction pipelines:

- **Anchor-constrained generation (MDPI Computers 2026)** — for grounded knowledge-graph extraction, "discovered anchors are presented as a closed vocabulary and explicit grounding is required for each element. Hallucinations arise from the unconstrained generation space of LLMs; by establishing a closed vocabulary of text-grounded elements before extraction, the model's ability to fabricate information is fundamentally limited." That is exactly Task 2 below
- **Citation forcing + verification (ACL Findings 2025)** — best-of-N reranking with a faithfulness judge, plus mandatory citation back to the retrieved chunk. Task 3's post-process filter is the lightweight equivalent — citations that don't resolve get stripped
- **Agentmemory's gap** — GalaxyRuler/agentmemory (sibling project) validates only LLM output **shape** (Zod schema, XML structure, retry on parse failure). It does not validate that referenced entities exist. Memory Fort needs the extra layer that agentmemory skipped

The brief lands the layer that the research and the sibling project both lack: pre-extraction anchor injection + post-process existence check.

---

## Scope guard

You will:

- For thread proposing in `src/llm/thread-propose.ts`:
  - Pre-extract from `cluster.observations` the set of wiki page paths each observation references via `relations.*`. Build a candidate list of real wiki pages
  - Add a new section to the LLM prompt: `Existing wiki pages you may reference (do not invent paths beyond these): [list]`
  - Post-process the parsed `ThreadProposal`: filter `keyDecisions` and `keyLessons` to remove any entry that doesn't match either (a) the candidate list OR (b) an existing wiki page on disk
- For procedure proposing in `src/llm/procedure-propose.ts`:
  - Same candidate-list pre-extraction from cluster observations
  - Add a new section: `Existing wiki pages you may reference: [list]. Existing CLI commands available via `memory --help`: [list of memory subcommand names]`. (The memory CLI surface is bounded; pass the actual command names.)
  - Post-process the parsed `ProcedureProposal`: filter `steps[].command` to drop commands containing invented `memory <subcommand>` patterns where `<subcommand>` isn't real. Filter relations same as threads
- For the writer in both pipelines:
  - Before writing the draft file, run a final filesystem check on every `relations` entry. Drop entries whose target file doesn't exist
  - Track the strip rate per proposal: `originalReferenceCount`, `strippedReferenceCount`, `stripReasons[]`
  - Include the strip rate in the run audit log (`wiki/.audit/thread-propose-{ts}.md` / `procedure-propose-{ts}.md`)
- For the audit log entries written via `chatWithAudit`:
  - Add a new field `referencesStripped` to the audit entry (when applicable). Lets `memory provider audit-summary` show "hallucination rate" per consumer
- New tests for: candidate list extraction, prompt includes the candidate list, post-process drops invented references, strip rate tracked in audit log, real references survive both layers

You will **not**:

- Re-write the existing draft files in the vault. Operator decides per-draft whether to reject or wait-and-re-run after this lands. Live-vault re-audit (2026-05-28) showed the draft hallucination is mixed: the `perform-daily-personal-skill-review` procedure and `tauri-desktop-integration-and-web-preview` thread invent real-sounding content (commands, wiki paths) that doesn't exist. The iAqar bilingual-RTL drafts on the other hand summarize *real* PRs (`#19 Fix bilingual RTL audit findings`, `#20 Fix Pass 18 bilingual RTL regressions`) with real components (`apps/web/src/components/results/ComparisonTable.tsx`, `apps/web/src/i18n/{en,ar}.json`) — those drafts are real-but-imprecise (stale branch names in prose). The grounding fix targets the structural-reference layer where confabulation does material harm; prose imprecision is a separate, lower-priority concern
- Constrain free-form text fields (summary, open_questions, preconditions, step descriptions). The LLM is creative there and we have no factual ground truth to check against. Free-form text in proposals is ALREADY caveat-prefixed with "auto-generated proposal — operator validates"
- Add per-relation type validation beyond existence (e.g., "is this really a decision-type page"). The wiki page just has to exist; whether it semantically fits the relation type is operator judgment at promote time
- Change the propose → review → promote workflow. Two-stage gating remains the operator-validation backstop
- Touch Phase 4.3.F (query intent classifier) — that pipeline doesn't return structural references, so it doesn't have the hallucination surface
- Add a "verify before write" check that calls the LLM to self-correct. That's a second LLM call per proposal, doubling cost. The post-process filter + tightened prompt is sufficient

If the candidate-list approach turns out to over-constrain (legitimate cross-references to pages not in the cluster get filtered), **stop and ask** before loosening the filter. The fail-safe behavior is to over-strip; a thread with too few relations is honest, a thread with invented relations is harmful

---

## Repo orientation (verified before brief)

- `src/llm/thread-propose.ts` (Phase 4.3.D) — current prompt + parser. The change adds candidate-list extraction + post-process filter
- `src/llm/procedure-propose.ts` (Phase 4.3.E) — same shape, parallel changes
- `src/cli/commands/thread.ts` and `src/cli/commands/procedure.ts` — orchestrators that build cluster context + call propose. Pre-extraction lives here OR in the propose modules; cleaner in propose since they own the prompt
- `src/llm/audit.ts` (Phase 4.3.B) — `LLMAuditEntry` shape. Extend with optional `referencesStripped` field
- `src/cli/commands/provider.ts` (Phase 4.3.B) — `memory provider audit-summary`. If reference-stripping is tracked, surface stripped-rate per consumer in the summary
- `src/retrieval/corpus.ts` — `loadSearchCorpus` returns wiki documents with their paths. Reuse for the existence check (cheaper than per-file `fs.access`)

---

## Task 1 — Candidate-list extraction

### Why
The LLM needs to know what's real before it can avoid inventing. Pre-extract the candidate set from the cluster + the broader vault corpus.

### Contract

```ts
// src/llm/proposal-grounding.ts (new shared module)

export interface ProposalCandidates {
  wikiPagePaths: string[];          // sorted, unique, existing wiki paths
  candidateRationale: string;       // human-readable summary for the prompt
}

export async function extractProposalCandidates(opts: {
  vaultRoot: string;
  observations: Array<{ relPath: string; relations: Record<string, Array<{ target: string }>> }>;
}): Promise<ProposalCandidates>;
```

Extraction logic:

1. From each observation's `relations` (all types: mentions, derived_from, uses, etc.), collect every `target` whose path starts with `wiki/`
2. Deduplicate
3. Verify each path resolves to a real file (use the corpus index from `loadSearchCorpus` if it's already loaded; otherwise per-path `fs.access`)
4. Sort alphabetically for determinism
5. Return the verified list plus a one-line summary: `"<N> existing wiki pages referenced by this cluster"`

Cap the list at 50 entries to keep prompt size bounded. If the cluster references more, take the most frequently referenced (count occurrences in cluster observations, sort desc).

### Files

- New: `src/llm/proposal-grounding.ts`
- New: `test/llm/proposal-grounding.test.ts` — fixtures with known relation paths, assert real paths survive, invented paths are filtered, cap at 50

---

## Task 2 — Tighten prompts in thread + procedure propose

### Why
The candidate list isn't useful until the prompt tells the LLM to use it. Add a new section to both prompts.

### Contract

**Thread propose** addition:

```
[after existing system prompt content]

Existing wiki pages you may reference (do not invent paths beyond these):

{{candidateList}}

If you cannot find a fitting existing page for a key_decision or key_lesson,
leave the array empty rather than inventing one. Empty lists are honest;
invented references are harmful.
```

The orchestrator calls `extractProposalCandidates({ vaultRoot, observations: cluster.observations })` before building the prompt, then interpolates `candidateList` into the system message.

**Procedure propose** addition:

```
[after existing system prompt content]

Existing wiki pages you may reference (do not invent paths beyond these):

{{candidateList}}

Real memory CLI commands (use only these in step `command` fields):

{{memoryCliList}}

If a step's command isn't a real `memory` subcommand or an obvious POSIX
shell command (git, npm, ssh, scp, curl, cd, ls, cat), describe it in plain
prose without a `command` field. Inventing commands is harmful.
```

For `memoryCliList`, pass the actual list of memory subcommand names by introspecting the CLI definition or just hardcoding (the list is small: `consolidate`, `verify`, `provider`, `thread`, `procedure`, `connect`, `install`, `init`, `compile`, `lint`, `page`, `grep`, `log`, `sync`, etc.).

### Files

- Modify: `src/llm/thread-propose.ts` — accept `candidates` argument, interpolate into prompt
- Modify: `src/llm/procedure-propose.ts` — same + memory CLI list
- Modify: `src/cli/commands/thread.ts` — call `extractProposalCandidates` before each `proposeThread`
- Modify: `src/cli/commands/procedure.ts` — same
- Modify: existing tests in `test/llm/thread-propose.test.ts` and `test/llm/procedure-propose.test.ts` — assert prompt includes candidate list

---

## Task 3 — Post-process verification + strip-rate tracking

### Why
Even with a tightened prompt, the LLM can still invent. Post-process is the defense-in-depth layer that guarantees no broken-wikilink ships.

### Contract

In both `thread-propose.ts` and `procedure-propose.ts`:

```ts
// Pseudo-code; adapt to actual file shapes

import { existsSync } from "node:fs";
import { join } from "node:path";

interface FilterResult<T> {
  filtered: T[];
  stripped: T[];
}

function filterRelationsToReal(
  vaultRoot: string,
  relationPaths: string[],
): FilterResult<string> {
  const filtered: string[] = [];
  const stripped: string[] = [];
  for (const p of relationPaths) {
    if (p.startsWith("wiki/") && existsSync(join(vaultRoot, p)) && p.endsWith(".md")) {
      filtered.push(p);
    } else if (p.startsWith("raw/") && existsSync(join(vaultRoot, p))) {
      filtered.push(p);  // raw paths from cluster are already known-real
    } else {
      stripped.push(p);
    }
  }
  return { filtered, stripped };
}

// In proposeThread/proposeProcedure, after LLM returns:
const decisionsFilter = filterRelationsToReal(vaultRoot, proposal.keyDecisions);
const lessonsFilter = filterRelationsToReal(vaultRoot, proposal.keyLessons);

proposal.keyDecisions = decisionsFilter.filtered;
proposal.keyLessons = lessonsFilter.filtered;

const totalStripped = decisionsFilter.stripped.length + lessonsFilter.stripped.length;

// Extend audit entry
await writeLLMAuditEntry(vaultRoot, {
  // ... existing fields
  referencesStripped: totalStripped,
  strippedSamples: [...decisionsFilter.stripped, ...lessonsFilter.stripped].slice(0, 3),
});
```

The strip happens BEFORE writing the draft file, so the file never contains invented references. The audit entry records what was stripped (samples only — three is plenty for diagnostics).

For procedure proposals, also validate `steps[].command`:

```ts
const ALLOWED_COMMAND_PREFIXES = ["git ", "npm ", "ssh ", "scp ", "curl ", "cd ", "ls ", "cat ", "memory "];

function filterStepCommands(steps: ProcedureStep[]): ProcedureStep[] {
  return steps.map((step) => {
    if (!step.command) return step;
    const isAllowed = ALLOWED_COMMAND_PREFIXES.some((prefix) => step.command!.startsWith(prefix));
    if (!isAllowed) {
      return { ...step, command: undefined };  // drop the command, keep the description
    }
    return step;
  });
}
```

That filter is conservative — it preserves the step's description text (likely useful) while dropping any non-allowlist command (likely invented).

### Run-level audit

Update `runThreadPropose` and `runProcedurePropose` to track aggregate strip rate across all proposals in the run. Surface in the human-readable summary printed to stdout:

```
Proposals: 5
References stripped: 12 (avg 2.4 per proposal)
Drafts written: 5
```

The run audit log markdown gets a new line:

```markdown
references stripped: 12 (avg 2.4 per proposal)
```

### Files

- Modify: `src/llm/thread-propose.ts` — post-process filter
- Modify: `src/llm/procedure-propose.ts` — post-process filter + command allowlist
- Modify: `src/llm/audit.ts` — extend `LLMAuditEntry` with optional `referencesStripped`
- Modify: `src/cli/commands/thread.ts` and `src/cli/commands/procedure.ts` — aggregate the strip rate into the run summary
- Tests: extend the existing thread-propose and procedure-propose tests with fixtures where the mocked LLM returns invented references; assert they're stripped before the file is written

---

## Task 4 — Surface in `memory provider audit-summary`

### Why
Operators want to see "how often is the LLM hallucinating references?" at a glance. The audit summary is the place.

### Contract

Add to `memory provider audit-summary` output:

```
auto-thread-propose
  Calls: 15
  Tokens in/out: 22,500 / 4,800
  Total cost: $0.012
  References stripped: 38 (avg 2.5 per call)        ← NEW

auto-procedural-extract
  Calls: 6
  Tokens in/out: 7,200 / 1,400
  Total cost: $0.003
  References stripped: 11 (avg 1.8 per call)        ← NEW
```

Computed by reading the audit log files and summing `referencesStripped` per consumer over the requested window.

### Files

- Modify: `src/cli/commands/provider.ts` — extend `audit-summary` handler
- Tests: `test/cli/commands/provider-llm.test.ts` — extend with fixtures showing strip rate aggregation

---

## Task 5 — Docs + roadmap

### Why
Document the grounding rule so future LLM consumers (Phase 4.3.F query intent classifier, any others) follow the same pattern. Update roadmap with shipped status.

### Contract

Append a new section to `templates/schema.md` under "Auto-thread proposing":

```markdown
### LLM output grounding

Auto-propose pipelines must NOT invent references. Two layers:

1. The LLM prompt includes an explicit candidate list of existing wiki page
   paths derived from the cluster's observations. The LLM is instructed to
   reference only paths from this list, and to leave reference arrays empty
   rather than invent.

2. Post-process verification strips any `wiki/<category>/<slug>` reference
   whose target file doesn't resolve. Defense-in-depth even if the prompt
   layer fails.

The strip rate is tracked in the LLM audit log per call. `memory provider
audit-summary` surfaces the rate per consumer. A persistently high strip
rate (>3 per call sustained) is the signal that the prompt needs further
tuning or the model is unsuitable for the task.
```

Update `docs/ROADMAP.md` to mark Phase 4.3.G shipped. Phase 4.3.F (query intent classifier) is still queued and should follow the same grounding rule when it lands.

### Files

- Modify: `templates/schema.md`
- Modify: `docs/ROADMAP.md`

---

## Execution order

1. **Task 1** (candidate extraction) — pure function; foundation; shared by both consumers
2. **Task 2** (prompt updates) — wires candidates into both LLM calls
3. **Task 3** (post-process + strip-rate audit) — defense-in-depth; the load-bearing safety check
4. **Task 4** (audit-summary integration) — operator observability
5. **Task 5** (docs)

Each task = one commit. Run `npx vitest run --no-file-parallelism --testTimeout=10000` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism --testTimeout=10000     # full suite (956 currently passing)
npx vitest run test/llm test/cli/commands/thread test/cli/commands/procedure
npm run build
npm run build:ui

# After this lands, re-test the propose pipelines against the live vault:
node dist/cli.mjs thread propose --plan --days 30 --max-proposals 5
# Confirm proposals' relations are all real wiki paths now
# Then --apply if the plan output looks clean

node dist/cli.mjs procedure propose --plan --days 30 --max-proposals 5
# Same verification

# Watch the strip rate:
node dist/cli.mjs provider audit-summary --days 1

# Deploy (server bundle changes since audit.ts touched):
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
ssh root@srv1317946 "systemctl restart memory-dashboard"
```

---

## Acceptance checklist

- [ ] `extractProposalCandidates` returns only verified-real wiki page paths from cluster observations
- [ ] Candidate list capped at 50 entries; most-frequently-referenced wins when over cap
- [ ] Thread propose prompt includes the candidate list with explicit "do not invent" instruction
- [ ] Procedure propose prompt includes both candidate list AND `memory` CLI command list
- [ ] Post-process filter strips any `wiki/...` relation entry whose target doesn't exist on disk
- [ ] Post-process filter strips any procedure step `command` field that doesn't start with an allowlisted prefix (git/npm/ssh/scp/curl/cd/ls/cat/memory)
- [ ] `LLMAuditEntry` gains `referencesStripped` field
- [ ] Run audit log markdown includes "references stripped" line
- [ ] `memory provider audit-summary` includes references-stripped per consumer
- [ ] Drafts written to `wiki/threads-proposed/` and `wiki/procedures-proposed/` contain NO invented references after this brief lands
- [ ] All 956+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No changes to the propose -> review -> promote workflow
- [ ] No changes to free-form text fields (summary, open_questions, preconditions, step descriptions stay LLM-generated)
- [ ] Existing confabulated drafts in the vault are NOT rewritten (operator rejects them manually)

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

- **Semantic relation-type validation** — beyond "does the file exist," check that a decision-type relation actually points at a decision page. Skipped here because the wiki page's frontmatter `type:` field is the source of truth and validating against it adds complexity for marginal gain. Defer until evidence shows operators are promoting threads with wrongly-typed relations
- **Free-form text grounding** — the summary and open-questions fields stay LLM-generated. Hard-grounding free-form prose is an open research problem; the operator-review backstop is the right gating today
- **Self-correcting LLM verification** — a second LLM call that asks "given this proposal, identify any references that aren't grounded in the cluster observations." Doubles cost; current post-process filter is cheaper and just as effective for the structural-reference case
- **Embedding-based candidate expansion** — when the cluster doesn't reference a wiki page by relation but the page is semantically related, surface it as a candidate via Voyage embeddings. Speculative; defer until evidence shows the current candidate list is too narrow
- **Phase 4.3.F query intent classifier** — still queued. When it ships, apply the same grounding rule: tiny prompt, single-label output, no structural references to invent. Should be naturally immune to the hallucination class fixed in this brief
