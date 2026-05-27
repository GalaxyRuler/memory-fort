# Codex Implementation Brief — Prospective Memory Foundation

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Phase 4.0 of the Memory Fort roadmap. The first new memory kind beyond the original four cognitive types (core / semantic / episodic / procedural).

Today the system has nowhere to put **pending commitments**. The session itself has been producing them constantly:

- "Tighten classifier rule 4 if entropy stays warn for 30 days" (Phase 3.4 future work)
- "Investigate 145 archive wiki pages" (Phase 3.0 finding)
- "Configurable EXEMPT_HUB_PATTERNS once a second by-design anchor appears" (Phase 3.3 future work)
- "Lexical matcher tightening when retrieval noise becomes load-bearing" (Phase 3.3 future work)
- "Confidence-field writer fix if confidence-coverage warn becomes load-bearing" (Phase 3.4 surfaced)

These live in commit messages and brief future-work sections — invisible to the dashboard, ungrep-able by retrieval, untracked through lifecycle. The proposal is to introduce `prospective` as a cognitive type that captures "future commitment with optional due date and triggers."

Prospective memory differs from the other four kinds:

| Kind | Time orientation | Example |
|---|---|---|
| `core` | timeless | "I prefer Voyage embeddings over Cohere" |
| `semantic` | present-stable | "Memory Fort uses RRF k=60 fusion" |
| `episodic` | past | "On 2026-05-22 we shipped Phase 0" |
| `procedural` | present-reusable | "How to deploy the dashboard: scp + ssh restart" |
| `prospective` (new) | future-intended | "By 2026-07-01, tighten classifier rule 4 if entropy warn persists" |

After this lands, prospective memories live at `wiki/prospective/*.md`, are searchable like any other wiki page, surface through a new `prospective.overdue` verify check when past their due date, and use the existing `lifecycle` field (from Brief B) for status tracking (`proposed` = pending, `consolidated` = done, `archived` = expired/cancelled). No new lifecycle states added.

This brief is intentionally minimal. CLI surface (`memory prospective list/add/complete`), automatic detection from raw observations, calendar integration, and prospective-aware retrieval are all explicit future work.

---

## Scope guard

You will:

- Add `"prospective"` to the `CognitiveType` enum in `src/retrieval/corpus.ts`
- Update the cognitive-type inference logic so wiki pages under `wiki/prospective/*.md` automatically classify as `cognitive_type: prospective`
- Define three new frontmatter fields specific to prospective memories: `due`, `triggers`, `expires`. Wire them through the frontmatter parser
- Reuse the existing `lifecycle` field from Brief B for status:
  - `lifecycle: proposed` = pending (default for new prospective memories)
  - `lifecycle: consolidated` = done (the commitment was acted upon)
  - `lifecycle: archived` = cancelled or expired
- Add `prospective.overdue` verify check: fails if any `prospective` page has `lifecycle: proposed` and a `due` date in the past
- Register the check in `ALL_CHECKS` alongside `freshness.staleness`, `frontmatter.source`, and `graph.cohesion`
- Update `templates/schema.md` to document the new cognitive type, the new directory, the three new fields, and the lifecycle semantics
- Update `templates/wiki/prospective/.gitkeep` or seed a single example prospective memory so the directory structure exists in the template
- Add tests covering: parser handles the new fields, cognitive-type inference catches the new directory, verify check distinguishes overdue from due-soon from done

You will **not**:

- Add a `memory prospective` CLI subcommand surface (`list`/`add`/`complete`/`expire`). Deferred to a future brief
- Add automatic detection of prospective patterns in raw observations ("TODO:", "I should follow up", etc). Deferred
- Add a Prospective dashboard panel. Defer until there's evidence the verify check + grep workflow is insufficient
- Add prospective-aware retrieval scoring (boost upcoming dues, demote completed). Deferred
- Add new lifecycle states. Reuse `proposed | consolidated | archived` from Brief B
- Add new edge types for prospective memories. Same edge taxonomy as everything else
- Touch the consolidation pipeline. Prospective memories are user-authored, not consolidated from raw observations
- Add a `prospective` value to the domain category axis (projects/decisions/lessons/etc). Prospective is a cognitive type, not a domain. A prospective memory can be ABOUT a project, decision, lesson, etc; it goes under `wiki/prospective/` regardless

If a real conflict surfaces between the proposed schema (`due`, `triggers`, `expires` as siblings of `lifecycle`) and the existing Brief A/B frontmatter shape, **stop and ask** before introducing nested structures or alternative field names.

---

## Repo orientation

- `src/retrieval/corpus.ts:23` — `CognitiveType` type definition. Currently `"core" | "semantic" | "episodic" | "procedural"`
- `src/retrieval/corpus.ts:382-388` — `readCognitiveType()` whitelist parser. Add `"prospective"`
- `src/retrieval/corpus.ts:278` — `applyCognitiveTypeInference()` or similar function that derives cognitive type from path/frontmatter. The Phase 0 agentmemory-as-semantic rule lives somewhere near here
- `src/storage/frontmatter.ts` — `Frontmatter` interface. Add `due?: string | null`, `triggers?: string[]`, `expires?: string | null`
- `src/cli/commands/verify/freshness.ts` — reference pattern for date-based verify checks. The new `prospective.overdue` check mirrors its shape
- `src/cli/commands/verify/registry.ts` — `ALL_CHECKS` array; append `prospectiveOverdueCheck`
- `templates/schema.md` — canonical schema doc. Add prospective section
- `templates/wiki/` — wiki template directory; mirror creates `wiki/prospective/` on `memory init`

---

## Task 1 — Extend `CognitiveType` and inference

### Why
The cognitive type enum is the foundational classification. Until `prospective` exists as a valid value, the parser and graph layers can't recognize prospective memories at all.

### Contract

```ts
// src/retrieval/corpus.ts

export type CognitiveType =
  | "core"
  | "semantic"
  | "episodic"
  | "procedural"
  | "prospective";  // NEW

function readCognitiveType(value: unknown): CognitiveType | null {
  if (
    value === "core" ||
    value === "semantic" ||
    value === "episodic" ||
    value === "procedural" ||
    value === "prospective"  // NEW
  ) {
    return value;
  }
  return null;
}
```

Inference rule (in the inference function that maps paths to cognitive types):

```ts
// Order matters: explicit frontmatter wins over path inference
if (frontmatter.cognitive_type === "prospective") return "prospective";
if (relPath.startsWith("wiki/prospective/")) return "prospective";
// ... existing rules (agentmemory-as-semantic, raw-as-episodic, etc.)
```

### Files

- Modify: `src/retrieval/corpus.ts` — extend the type, the parser, the inference function
- Modify: `test/retrieval/corpus.test.ts` (or sibling) — assert wiki/prospective/foo.md → prospective; assert frontmatter override works
- Modify: `src/dashboard/loaders.ts` if it has type unions on cognitive type that need extending (verify before editing)

---

## Task 2 — Frontmatter fields for `due`, `triggers`, `expires`

### Why
Prospective memories need to express their commitment shape. Three fields, all optional, all backwards-compatible:

| Field | Type | Meaning | Example |
|---|---|---|---|
| `due` | ISO date or null | When the commitment becomes overdue | `2026-07-01` |
| `triggers` | array of strings | Conditions that activate the reminder; free-form for now | `["if-entropy-stays-warn-for-30-days"]` |
| `expires` | ISO date or null | When the commitment becomes irrelevant regardless of completion | `2026-12-31` |

All three fields are optional. A prospective memory with no `due` and no `expires` is an "open-ended" commitment — tracked but never overdue.

### Contract

```ts
// src/storage/frontmatter.ts

export interface Frontmatter {
  // ... all existing fields from Brief A/B/3.x
  due?: string | null;
  triggers?: string[];
  expires?: string | null;
}
```

Parser changes:
- Accept `due` as ISO date string or null; reject other types with a warning
- Accept `triggers` as string array; reject non-string entries with a warning (per-entry, not whole-array drop)
- Accept `expires` same as `due`

Writer changes:
- Serialize the three fields when present
- Skip when absent (no `due: null` lines unless explicitly set)

### Files

- Modify: `src/storage/frontmatter.ts` — type + parser + writer
- Modify: `test/storage/frontmatter.test.ts` (or sibling) — round-trip tests for the three new fields, malformed-value handling

---

## Task 3 — `prospective.overdue` verify check

### Why
Prospective memories need at least one mechanism that surfaces stale commitments. The verify check is the lightest-weight option — appears in `/api/health`, the HealthBadge goes amber when something needs attention, no dashboard UI needed for the foundation brief.

### Contract

```ts
// src/cli/commands/verify/prospective-overdue.ts

export const prospectiveOverdueCheck: CheckDescriptor = {
  id: "prospective.overdue",
  label: "prospective memories not overdue",
  roles: ["operator", "server"],
  run: async (ctx) => {
    const corpus = await loadSearchCorpus({ vaultRoot: ctx.vaultRoot, scope: "wiki" });
    const prospective = corpus.documents.filter(
      (d) => d.cognitiveType === "prospective" && !d.relPath.startsWith("wiki/archive/"),
    );

    const now = ctx.now();
    const overdue = prospective.filter(
      (d) =>
        d.lifecycle === "proposed" &&
        d.frontmatter.due &&
        Date.parse(d.frontmatter.due) < now.getTime(),
    );

    if (overdue.length === 0) {
      return pass(
        "prospective.overdue",
        `${prospective.length} prospective memories, none overdue`,
      );
    }
    if (overdue.length <= 2) {
      return warn(
        "prospective.overdue",
        `${overdue.length} prospective memories overdue`,
        overdue.map((d) => d.relPath).join(", "),
      );
    }
    return fail(
      "prospective.overdue",
      `${overdue.length} prospective memories overdue`,
      `review ~/.memory/wiki/prospective/ and update lifecycle on completed items`,
      overdue.slice(0, 5).map((d) => d.relPath).join(", "),
    );
  },
};
```

Thresholds:
- 0 overdue → pass
- 1-2 overdue → warn
- 3+ overdue → fail (likely the operator stopped triaging)

### Files

- New: `src/cli/commands/verify/prospective-overdue.ts`
- Modify: `src/cli/commands/verify/registry.ts` — append to `ALL_CHECKS`
- Modify: `test/cli/commands/verify/registry.test.ts` — assert descriptor present
- New: `test/cli/commands/verify/prospective-overdue.test.ts` — pass when no prospectives exist; pass when all done; warn at 1 overdue; fail at 3+

---

## Task 4 — Schema doc + template seed

### Why
The schema doc is the canonical reference; future operators (and future-Codex-on-a-fresh-context) need to see what the new cognitive type means, what the three fields do, and what lifecycle states apply.

The template seed is so `memory init` creates the `wiki/prospective/` directory ready to use.

### Contract

Append to `templates/schema.md`:

```markdown
## Prospective memory (cognitive type)

Prospective memories represent **future-intended commitments**: things the
operator plans to do, conditions to act on, or reviews scheduled for a date.
They live at `wiki/prospective/*.md` and use `cognitive_type: prospective`.

### Schema

| Field | Type | Required | Meaning |
|---|---|---|---|
| `due` | ISO date or null | optional | When the commitment becomes overdue |
| `triggers` | string array | optional | Free-form conditions that activate the reminder |
| `expires` | ISO date or null | optional | When the commitment becomes irrelevant regardless of completion |

All other Brief A/B frontmatter fields apply normally (`source`, `confidence`,
`lifecycle`, relations, etc.). Prospective memories use the existing
`lifecycle` field for status:

- `lifecycle: proposed` — pending (default for new prospective memories)
- `lifecycle: consolidated` — done (the commitment was acted upon)
- `lifecycle: archived` — cancelled or expired

A prospective with no `due` and no `expires` is an open-ended commitment;
tracked but never overdue.

### Example

\`\`\`yaml
---
title: Tighten classifier rule 4 if entropy stays warn for 30 days
cognitive_type: prospective
source: claude-opus-session
lifecycle: proposed
due: "2026-07-01"
triggers:
  - if-edge-type-entropy-warn-30d
  - operator-decides
expires: "2026-12-31"
relations:
  mentions:
    - wiki/decisions/classifier-rule-4-ceiling.md
---

# Tighten classifier rule 4

Phase 3.4 dropped the confidence ceiling but live entropy only moved
from 0.62 to 0.62 (no observable change). If the warn persists past
2026-07-01, consider extending rule 4 to wiki/references/*.md targets
or adding a rule 6 for lexical matches against project pages.
\`\`\`

### Verify check

`prospective.overdue` runs in both operator and server roles. Fails if any
prospective memory has `lifecycle: proposed` and a `due` date in the past.
```

Template seed: create `templates/wiki/prospective/.gitkeep` (or a small README explaining the directory). On `memory init`, the directory is created in the operator's vault.

### Files

- Modify: `templates/schema.md`
- New: `templates/wiki/prospective/.gitkeep` (empty placeholder file)

---

## Execution order

1. **Task 1** (cognitive type extension) — foundation; everything else depends on the type being recognized
2. **Task 2** (frontmatter fields) — wires the data shape through the parser
3. **Task 3** (verify check) — operator-visible signal
4. **Task 4** (docs + template seed) — final polish

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                  # full suite (856 currently passing)
npx vitest run test/retrieval test/storage            # type + frontmatter focus
npx vitest run test/cli/commands/verify               # verify focus
npm run build
npm run build:ui

# Deploy:
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify:
curl -s 'https://srv1317946.tail6916d8.ts.net/memory/api/health?deep=true' | \
  jq '.checks[] | select(.id=="prospective.overdue")'
# Expected: status=pass with "0 prospective memories" (none authored yet)
```

Note: no operator vault step needed for this brief. Prospective memories are user-authored, not auto-generated. The operator will create them organically as future commitments arise.

---

## Acceptance checklist

- [ ] `CognitiveType` includes `"prospective"`
- [ ] `readCognitiveType()` accepts `"prospective"`
- [ ] Wiki pages under `wiki/prospective/*.md` infer `cognitive_type: prospective` automatically
- [ ] Explicit `cognitive_type: prospective` in frontmatter overrides path inference (and works for pages not under `wiki/prospective/`)
- [ ] Frontmatter parser accepts `due`, `triggers`, `expires` fields
- [ ] Round-trip: write a prospective frontmatter → read back → assert structural equality
- [ ] `prospective.overdue` verify check exists, registered in `ALL_CHECKS`, runs in both operator and server roles
- [ ] Check returns pass when zero prospective memories exist or none are overdue
- [ ] Check returns warn at 1-2 overdue, fail at 3+
- [ ] `templates/schema.md` documents the new cognitive type, fields, and lifecycle semantics
- [ ] `templates/wiki/prospective/.gitkeep` seed exists so `memory init` creates the directory
- [ ] All 856+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No new lifecycle states (reuses Brief B's lifecycle field)
- [ ] No new edge types
- [ ] No CLI subcommands added beyond what already exists
- [ ] No dashboard UI panel added
- [ ] No automatic detection in consolidation

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

These belong in separate Phase 4 briefs after the foundation lands:

1. **`memory prospective` CLI surface** — `list` (sort by due), `add` (interactive prompt or flags), `complete <relPath>` (set lifecycle to consolidated), `expire <relPath>` (set lifecycle to archived). Operator ergonomics
2. **Prospective dashboard panel** — Overview-page widget showing pending items sorted by due date. Click to expand details
3. **Automatic detection from raw observations** — consolidation-style pass that detects "TODO:", "follow up on", "I should X" patterns in raw observations and proposes prospective memories. High false-positive risk; needs user approval gate
4. **Prospective-aware retrieval** — boost retrievability of "what's due soon" queries; demote completed memories. Requires query intent classifier (deferred from Phase 3 research)
5. **Triggers as first-class objects** — the `triggers: []` array is free-form for now. A future brief could formalize trigger types (date-based, condition-based, event-based) and add evaluator logic
6. **Calendar integration** — export prospective dues as iCal feed for external calendar sync
7. **Event segmentation** — the original "Brief C" companion to prospective memory. Splits monolithic session captures into goal-scoped episodes. Independent enough to be its own brief; tackle when capture file sizes become unwieldy
8. **Narrative threads** — the n/a metric on `/api/graph-health`. Explicit thread records connecting episodes, decisions, and open questions over time. Separate Phase 4 brief
9. **Procedural extraction** — detect repeated successful workflows from raw observations and propose procedural memories with user approval. Largest Phase 4 lift; probably last in the phase
