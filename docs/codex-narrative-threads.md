# Codex Implementation Brief — Narrative Threads

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Phase 4.2 of the Memory Fort roadmap. Adds **narrative threads** as a first-class memory shape and closes the `graph.narrative-thread-coverage` n/a slot that's been parked since Phase 2 shipped the cohesion dashboard.

A narrative thread is a wiki page that aggregates episodes, decisions, and lessons that belong to one coherent stretch of work. The session we just spent has produced a clear example: Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 each had multiple briefs, dozens of commits, and several decision pages — all conceptually one thread of "Memory Fort architectural maturity." Right now that thread lives only in `docs/ROADMAP.md` and git commit history. After this brief lands, it can live as `wiki/threads/memory-fort-architectural-maturity.md` with structured relations to the underlying episodes and decisions.

This is intentionally minimal — schema, path inference, the missing metric, and a template seed. Hand-authoring threads is the only operator workflow in this brief. CLI surface, thread-aware retrieval, dashboard panel, automatic thread proposing from episode clustering — all explicit future work.

---

## Scope guard

You will:

- Add `wiki/threads/*.md` recognition to the corpus loader's path-based cognitive-type inference. Threads classify as `cognitive_type: episodic` by path (they describe a sequence of past events), unless explicit frontmatter overrides
- Add a new optional `time_range: { start, end }` field to the frontmatter schema. Used by threads to declare their bounded time period; reusable by any other memory kind in the future
- Implement the `graph.narrative-thread-coverage` metric in `src/dashboard/graph-health.ts` — currently returns `status: "n/a"`. Replace with real computation: `% of raw observations referenced by at least one wiki/threads/*.md page`
- Update `templates/schema.md` to document threads (the new directory, the `time_range` field, the linking pattern using existing `relations` from Brief A)
- Add `templates/wiki/threads/.gitkeep` so `memory init` creates the directory
- Tests for: path-based cognitive type inference catches `wiki/threads/foo.md`; `time_range` parses correctly; the new metric returns real values

You will **not**:

- Add a new cognitive type. Threads use `episodic` (existing) — they're a domain category, not a new cognitive shape
- Add new edge types beyond what Brief A already documented. Threads link to episodes/decisions/lessons via the existing `relations` block (`mentions`, `derived_from`, etc)
- Add a `memory thread` CLI subcommand (`create`/`append`/`close`). Deferred
- Add automatic thread proposing from raw-observation clustering. Deferred (Phase 4.3 candidate)
- Add a Threads dashboard panel or `/memory/threads` SPA route. Deferred until evidence shows hand-grep is insufficient
- Add thread-aware retrieval scoring (boost active threads, demote closed). Deferred
- Touch the existing `prospective` cognitive type from Phase 4.0
- Change Phase 4.1's UI fixes or any consolidation/typed-edge work

If a thread's relation to its referenced episodes needs a NEW edge type not already in the brief-A taxonomy (e.g., `bounds` or `aggregates`), **stop and ask** before introducing it. The default assumption: use `mentions` (catch-all) or `derived_from` (when the thread is a synthesis of those episodes).

---

## Repo orientation

- `src/retrieval/corpus.ts:284` (approximate) — `applyCognitiveTypeInference()`. Phase 4.0 added the `wiki/prospective/` branch; this brief adds an analogous `wiki/threads/` branch
- `src/storage/frontmatter.ts` — `Frontmatter` interface. Add optional `time_range?: { start: string; end?: string | null }`
- `src/dashboard/graph-health.ts:metricNarrativeThreadCoverage` — returns the n/a stub today (`{ status: "n/a", detail: "pending narrative threads in Phase 4" }`). Replace with real computation
- `templates/schema.md` — canonical schema doc; new "Narrative threads" section
- `templates/wiki/` — currently has `prospective/.gitkeep` from Phase 4.0; mirror for threads
- Cognitive-type test patterns: `test/retrieval/cognitive-type-inference.test.ts` already covers prospective; extend for threads

---

## Task 1 — Path inference + `time_range` frontmatter

### Why
Threads need to be recognized by the corpus loader before any downstream consumer (the metric, retrieval, future dashboard panels) can find them.

### Contract

**Path inference** in `src/retrieval/corpus.ts`:

```ts
// applyCognitiveTypeInference (or wherever path-based inference lives)
// Order matters: explicit frontmatter wins over path inference
if (explicitCognitiveType) return explicitCognitiveType;
if (relPath.startsWith("wiki/prospective/")) return "prospective"; // Phase 4.0
if (relPath.startsWith("wiki/threads/")) return "episodic";        // NEW
// ... existing rules
```

Threads are `episodic` because they describe sequences of past events. The path-based inference makes this automatic; an operator can override with explicit `cognitive_type: episodic` (or anything else) in frontmatter if they want.

**Frontmatter shape** in `src/storage/frontmatter.ts`:

```ts
export interface Frontmatter {
  // ... all existing fields from Brief A/B/3.x/4.0
  time_range?: { start: string; end?: string | null };
}
```

Parsing rules:
- `time_range` must be an object with at least `start: <ISO date string>`. Anything else (string, number, array, missing start) is dropped with a warning
- `end` is optional. Null or absent means "open-ended thread, still active"
- The field is universal — any wiki page can declare a `time_range`, not just threads. Most won't

### Files

- Modify: `src/retrieval/corpus.ts` — extend the cognitive-type inference rule list
- Modify: `src/storage/frontmatter.ts` — add `time_range` to `Frontmatter` + parser
- Tests: `test/retrieval/cognitive-type-inference.test.ts` — assert `wiki/threads/foo.md` → episodic; explicit override works
- Tests: `test/storage/frontmatter-phase2.test.ts` (or sibling) — round-trip `time_range`; malformed values dropped with warning

---

## Task 2 — Implement `graph.narrative-thread-coverage` metric

### Why
The metric was stubbed `n/a` in Phase 2 because no thread structure existed. Now it does. Real coverage value lets the dashboard tell the operator whether they're maintaining narrative continuity.

### Contract

```ts
// src/dashboard/graph-health.ts

export function metricNarrativeThreadCoverage(input: GraphHealthInput): MetricResult {
  const threadPages = input.wikiPages.filter(
    (p) => p.relPath.startsWith("wiki/threads/") && !p.relPath.includes("/archive/"),
  );

  // Collect raw-observation paths referenced from any thread's relations block
  const referencedRawPaths = new Set<string>();
  for (const thread of threadPages) {
    for (const relations of Object.values(thread.relations ?? {})) {
      for (const edge of relations ?? []) {
        if (edge.target?.startsWith("raw/")) referencedRawPaths.add(edge.target);
      }
    }
  }

  const totalRaw = input.feed.nodes.filter((n) => n.kind === "raw").length;
  const coverage = totalRaw === 0 ? 100 : (referencedRawPaths.size / totalRaw) * 100;

  // If no threads exist yet, the metric stays n/a — operator hasn't started using
  // this layer. Once at least one thread exists, real coverage is reported
  if (threadPages.length === 0) {
    return {
      id: "graph.narrative-thread-coverage",
      label: "Narrative thread coverage",
      value: null,
      threshold: { rule: "n/a until first thread authored" },
      status: "n/a",
      detail: "no narrative threads in vault yet",
      topOffenders: [],
    };
  }

  const status: HealthStatus =
    coverage < 25 ? "fail" :
    coverage < 50 ? "warn" :
    "pass";

  return {
    id: "graph.narrative-thread-coverage",
    label: "Narrative thread coverage",
    value: coverage,
    unit: "%",
    threshold: { warn: 50, fail: 25 },
    status,
    detail: `${referencedRawPaths.size}/${totalRaw} raw observations referenced by ${threadPages.length} thread${threadPages.length === 1 ? "" : "s"} (${coverage.toFixed(1)}%)`,
    topOffenders: [],
  };
}
```

Thresholds rationale: with even one thread per major work-phase, we'd expect 30-60% raw-observation coverage on a project-heavy vault. Anything below 25% means threads are decorative; below 50% they're under-used.

The `topOffenders` array stays empty for now — surfacing "unreferenced episodes" requires a different shape than the existing offender types, and it's small-leverage at this stage. Defer.

### Files

- Modify: `src/dashboard/graph-health.ts` — replace the stub with real implementation
- Tests: `test/dashboard/graph-health.test.ts` — at minimum:
  - Zero threads → status `n/a`, value null
  - One thread referencing 60% of raw observations → status pass, value 60
  - One thread referencing 30% → status warn, value 30
  - One thread referencing 10% → status fail, value 10
  - Threads that reference non-`raw/` paths are ignored for the metric
  - Archived threads (`wiki/archive/threads/...` if any) are excluded

---

## Task 3 — Schema doc + template seed

### Why
The schema doc is the canonical reference for operators (and future-Codex-on-a-fresh-context) to understand what a thread is and how to write one. The template seed makes `memory init` create the directory.

### Contract

Append to `templates/schema.md`:

```markdown
## Narrative threads (domain category)

Narrative threads live at `wiki/threads/*.md` and aggregate the episodes,
decisions, lessons, and crystals that belong to one coherent stretch of work.
A thread is the answer to "what happened across this whole phase of the
project, and how did the pieces connect?"

### Cognitive type

By path inference, threads classify as `cognitive_type: episodic` — they
describe sequences of past events. An operator can override in frontmatter
if a particular thread is more semantic (a stable retrospective) or
procedural (a workflow that was established).

### Schema additions

| Field | Type | Required | Meaning |
|---|---|---|---|
| `time_range` | object `{ start: ISO date, end: ISO date or null }` | optional | The bounded time period the thread describes. `end: null` = thread still active |

All other Brief A/B fields apply normally. Threads link to their referenced
content via the existing `relations` block (Brief A typed edges).

### Example

\`\`\`yaml
---
title: Memory Fort architectural maturity (Phase 0 → 4)
cognitive_type: episodic
source: claude-opus-session
lifecycle: consolidated
created: "2026-05-22"
updated: "2026-05-27"
time_range:
  start: "2026-05-22"
  end: "2026-05-27"
relations:
  derived_from:
    - wiki/projects/memory-system.md
  mentions:
    - wiki/decisions/2026-05-22-curation-orchestrator-not-llm.md
    - wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md
    - wiki/decisions/2026-05-21-sentinel-marker-config-patches.md
    - raw/2026-05-22/codex-019e4bf7-d7b8-7150-a65e-c21631ba25b6.md
    - raw/2026-05-26/codex-019e5a9c-35c7-7792-99ed-85f524e3bc09.md
---

# Memory Fort architectural maturity

A long arc from operational stability through the cognitive-graph metrics
work. Five phases, each with multiple briefs, dozens of commits.

## Phase 0 — Operational stability + episodic consolidation
Health monitoring shipped...

## Phase 1 — Trust signals foundation
Confidence vector + lifecycle states...

[... rest of the narrative ...]
\`\`\`

### Verify check

`graph.narrative-thread-coverage` measures `% of raw observations referenced
by at least one wiki/threads/*.md page`. Returns `n/a` until at least one
thread exists. Then: pass ≥ 50%, warn 25-49%, fail < 25%.
```

Template seed: create `templates/wiki/threads/.gitkeep` so the directory exists on `memory init`.

### Files

- Modify: `templates/schema.md`
- New: `templates/wiki/threads/.gitkeep`

---

## Execution order

1. **Task 1** (path inference + frontmatter) — foundation; the metric depends on cognitive-type recognition + `time_range` parse
2. **Task 2** (metric implementation) — closes the n/a slot
3. **Task 3** (docs + template) — pure documentation; can land alongside Task 2

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                  # full suite (871 currently passing)
npx vitest run test/retrieval test/dashboard          # focus
npm run build
npm run build:ui

# Deploy SPA + server (server bundle changes because graph-health.ts updates):
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify:
curl -s https://srv1317946.tail6916d8.ts.net/memory/api/graph-health | \
  jq '.metrics[] | select(.id=="graph.narrative-thread-coverage")'
# Expected: status=n/a until first thread is authored. detail: "no narrative threads in vault yet"
```

After Codex ships and the operator hand-writes `~/.memory/wiki/threads/memory-fort-architectural-maturity.md` (using this session's commit history as source material) and pushes to VPS, the metric reports a real value. That's the operator step, not Codex's.

---

## Acceptance checklist

- [ ] `wiki/threads/*.md` pages infer `cognitive_type: episodic` by path
- [ ] Explicit `cognitive_type` in frontmatter still overrides path inference
- [ ] `Frontmatter.time_range` parses `{ start: ISO, end: ISO or null }`
- [ ] Malformed `time_range` (string, number, missing start) is dropped with a console warning
- [ ] `graph.narrative-thread-coverage` returns `n/a` when zero threads exist
- [ ] Returns real coverage when ≥1 thread exists; pass ≥50%, warn 25-49%, fail <25%
- [ ] Metric correctly excludes non-raw/ targets from the numerator
- [ ] Archived threads (anything under `wiki/archive/`) excluded
- [ ] `templates/schema.md` documents threads, the path, the cognitive type rule, the `time_range` field, the example
- [ ] `templates/wiki/threads/.gitkeep` seed exists
- [ ] All 871+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No new cognitive types (threads use existing `episodic`)
- [ ] No new edge types (threads use Brief A's `relations` block)
- [ ] No CLI subcommands, no dashboard UI panel, no retrieval changes

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

Belong in separate briefs. Listed in rough order of leverage:

1. **`memory thread` CLI surface** — `create`, `append <thread> <relPath>`, `close`, `list`. Saves the operator from hand-editing frontmatter relations arrays. Lightweight ergonomics
2. **Automatic thread proposing from raw-observation clustering** — Phase 4.3 candidate. Detect that a sequence of raw observations across multiple days references the same set of wiki decisions/lessons, propose a thread page with those connections pre-filled. Requires a clustering pass (BM25 + temporal proximity); the proposed thread is a draft until the operator promotes it
3. **Thread-aware retrieval scoring** — query intent "what is the status of project X" or "what happened during the retrieval refactor" boosts threads above the underlying episodes. Requires query-class detection (deferred from Phase 3 research)
4. **`/memory/threads` SPA route + Overview panel** — visualize active threads with their episode counts, durations, and open questions. Deferred until evidence shows hand-grep is insufficient
5. **Thread state machine** — `active` → `closed` → `archived` transitions with required fields per state (e.g., `closed` requires an `outcome` field). Useful once threads accumulate; over-engineered before that
6. **Event segmentation** — the original Brief C companion to prospective memory; splits monolithic session captures into goal-scoped episodes. Independent enough to be its own brief; tackle when capture file sizes become unwieldy
7. **Procedural extraction** — detect repeated successful workflows from raw observations and propose procedural memories with user approval. Largest Phase 4 lift; probably last in the phase
