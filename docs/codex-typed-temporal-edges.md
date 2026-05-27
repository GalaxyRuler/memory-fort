# Codex Implementation Brief — Typed Temporal Edges

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

`templates/schema.md` (lines 92–108) documents **nine relation types** as the Memory Fort edge ontology: `uses`, `depends_on`, `supersedes`, `contradicts`, `caused_by`, `fixed_by`, `derived_from`, `mentioned_in`, `linked`. The implementation has been behind the schema since day one:

- `src/retrieval/corpus.ts:436–446` — `readRelations()` parses `relations:` blocks but **silently filters non-string entries via `filter(isString)` (line 445)**. Any structured per-edge metadata is dropped.
- `src/consolidate/runner.ts:145–159` — `writeObservationMentions()` writes only `relations.mentions: [path, path]` (untyped, no metadata).
- `src/dashboard-ui/components/GalacticCanvas.tsx:398–464` — `drawEdge()` renders every edge identically (per-cognitive-type styling only, not per-relation-type).
- The result is a graph where every edge means "related somehow" — the consolidation work that just shipped (commits `33cf417..9e8916a`, 1285 edges) is all of one type.

This brief catches the implementation up to the schema **and** adds temporal validity to each edge — `valid_from`, `valid_to`, `superseded_by`. After this lands:

- Frontmatter can carry typed edges with per-edge metadata, written as a string shorthand or an object form
- The graph API exposes edge type and temporal fields
- The galactic canvas renders typed edges with distinct visual treatment (color and stroke), and edges with `valid_to` set render as faded historical links
- Existing untyped `relations.mentions: [path]` arrays continue to parse and render exactly as today — the new schema is a strict superset

---

## Scope guard

You will:

- Extend `readRelations()` (and its return type) to accept both bare-string entries and object-shaped entries with `target`, `confidence`, `valid_from`, `valid_to`, `superseded_by`, `source` fields
- Keep the same return-shape key (`relations: Record<string, RelationEdge[]>`) but change the value type from `string[]` to `RelationEdge[]`
- Update `writeObservationMentions()` (or add a sibling `writeRelations()`) so it serializes the rich shape when given object entries, and continues emitting bare-string entries when given strings
- Update `templates/schema.md` to document the rich shape and mark the nine typed edges as supported (remove "aspirational" framing)
- Extend the `/api/graph` feed loader so each edge in the response carries `type`, `validFrom`, `validTo`, `supersededBy` fields
- Add per-edge-type visual treatment to `drawEdge()` in `GalacticCanvas.tsx`. Edges with `validTo` set render faded
- Tests covering: bare-string parse, object-shape parse, mixed-shape parse, roundtrip parse→write→parse, schema-doc example parses

You will **not**:

- Change the consolidation runner's writing logic — `writeObservationMentions()` keeps writing untyped `mentions:` for now. Typed-edge **proposing** from consolidation matches is a follow-up brief
- Migrate or rewrite any of the 1085 raw observations with existing `relations.mentions` data
- Touch retrieval scoring (BM25, vector, exact, graph BFS, spreading activation, metadata) — pure read/write/render
- Change the cognitive-type/domain-shape graph styling that's already there — typed-edge styling is **added alongside** the existing per-node styling
- Add a SQLite index, ledger, or any secondary storage — markdown stays canonical
- Add new confidence fields beyond the existing per-edge `confidence: number` (the confidence-vector expansion is a separate brief)
- Add lifecycle states (`disputed`, `dormant`, etc.) — separate brief

If a backwards-compatibility ambiguity surfaces (e.g., an existing observation has `relations.mentions: [{ unusual_shape }]` that doesn't fit either the string or the object form), **stop and ask** before deciding the parse semantics.

---

## Repo orientation (verified before brief)

- `src/retrieval/corpus.ts:28, 436–446` — `readRelations()`. The line that drops object entries is the `filter(isString)` call at line 445. Type today: `Record<string, string[]>`.
- `src/storage/frontmatter.ts` — `parseFrontmatter` and `serializeFrontmatter`. The serializer is `js-yaml`-based; passing nested objects through Just Works as long as the inputs are plain objects (no class instances, no functions).
- `src/consolidate/runner.ts:145–159` — `writeObservationMentions()`. Constructs `relations: { mentions: string[] }` and atomic-writes via `serializeFrontmatter`. **Do not modify the consolidation auto-write logic in this brief** — only ensure the writer it depends on can produce the rich shape if called with rich input.
- `src/dashboard/server.ts:437–444` — `/api/graph` endpoint. Calls `loadGraphFeed(opts.vaultRoot, scope)`. The actual loader and edge serialization live in `src/dashboard/loaders.ts` (or sibling — verify before editing).
- `src/dashboard-ui/components/GalacticCanvas.tsx:398–464` — `drawEdge()`. Currently styles by `(sourceCognitiveType, targetCognitiveType)` and `weight`. Cross-galaxy edges already get cyan + glow; within-galaxy use domain gradients.
- `templates/schema.md:59–68, 92–108` — schema doc. Already lists the nine relation types and shows an example of typed-relation frontmatter. Treat this file as the canonical schema description and update it to match the new implementation.

---

## Task 1 — Extend `readRelations()` to typed edges with temporal fields

### Why
The parser is the bottleneck. Object entries are silently dropped today, so adding rich frontmatter has zero observable effect downstream. Fixing the parser first unlocks everything else.

### Contract

```ts
// src/retrieval/corpus.ts (or new src/retrieval/relations.ts if the file is large)

export interface RelationEdge {
  target: string;             // relPath; required
  confidence?: number;        // 0..1
  valid_from?: string;        // ISO date or datetime; defaults handled by caller
  valid_to?: string | null;   // ISO date or datetime; null/absent = currently valid
  superseded_by?: string;     // relPath of the edge target that replaced this one
  source?: {
    agent?: string;
    session_id?: string;
    captured_at?: string;
  };
}

export type RelationMap = Record<string, RelationEdge[]>;

export function readRelations(frontmatter: unknown): RelationMap;
```

Parsing rules:

- Top-level `relations:` block must be an object; anything else returns `{}`
- Each key is a relation type — accept **any string key** (the nine schema types and any user-defined one). No whitelist
- Each value must be an array
- Each array entry is one of:
  - **String** → parsed as `{ target: string }` (shorthand)
  - **Object** with at least a `target: string` field → parsed as-is, with unknown fields preserved on a `_extra` property for forward compatibility
- Entries that match neither shape (e.g., a bare number, an object without `target`) are **dropped with a console.warn**, not silently ignored. The warning must include the file path and the offending entry's index

### Files

- Modify: `src/retrieval/corpus.ts` — extend `readRelations()` per the contract; update the return type and every call site that expected `string[]` to handle `RelationEdge[]` (most callers want `edge.target`)
- New (optional): `src/retrieval/relations.ts` if the parsing logic is large enough to warrant its own module
- Tests: `test/retrieval/corpus-relations.test.ts` — at minimum:
  - Bare-string entry parses to `{ target }`
  - Object entry with all fields parses correctly
  - Mixed array of strings and objects parses correctly
  - Unknown relation-type key is preserved (no whitelist)
  - Entry without `target` triggers a warning and is dropped
  - Empty `relations:` returns `{}`
  - Missing `relations:` returns `{}`

---

## Task 2 — Extend the writer to emit rich edges

### Why
The parser change alone lets the system read rich edges that humans hand-write. To produce them programmatically (now or in future briefs) we need a writer that round-trips.

### Contract

Add a sibling function `writeRelations(relations: RelationMap)` that the existing `writeObservationMentions()` can delegate to. The writer must:

- Serialize a string-shorthand entry as a YAML string (`- wiki/foo.md`) when the input edge has only `target` and no other fields set
- Serialize a rich entry as a YAML object (`- target: wiki/foo.md\n  valid_from: 2026-05-22\n  confidence: 0.85`) when any non-`target` field is set
- Preserve key order: schema-defined types first (`mentions, supports, contradicts, supersedes, derived_from, uses, depends_on, caused_by, fixed_by, mentioned_in, linked`), then any user-defined keys alphabetically
- Within each relation array, sort by `confidence` descending if present, else preserve insertion order

`writeObservationMentions()` keeps its current external signature and behavior. Internally it builds a `RelationMap` and calls `writeRelations()`. **Output for existing call sites stays byte-identical** to today (string shorthand for entries with only `target`).

### Files

- Modify: `src/consolidate/runner.ts:145–159` — refactor `writeObservationMentions()` to delegate to `writeRelations()`
- New: helper module if `writeRelations()` is too large to live inside runner.ts
- Tests: `test/consolidate/runner-relations.test.ts` — at minimum:
  - Writing `{ mentions: [{ target: "wiki/a.md" }, { target: "wiki/b.md" }] }` produces byte-identical output to today's `writeObservationMentions(["wiki/a.md", "wiki/b.md"])`
  - Writing a rich edge with `valid_from` produces the object YAML form
  - Roundtrip: write → read → assert structural equality
  - Sort order respects schema-type-first, then alphabetical

---

## Task 3 — Update `templates/schema.md`

### Why
The schema doc described the typed-edge ontology before the parser supported it. Now that the parser does, the doc needs to drop the aspirational framing and add the temporal fields.

### Contract

Update `templates/schema.md:59–68, 92–108` to:

- Document the nine relation types as **supported, not aspirational**
- Add the temporal fields (`valid_from`, `valid_to`, `superseded_by`) to the schema spec with prose explaining each
- Add a "Source" subsection documenting the optional per-edge `source.{agent, session_id, captured_at}` fields
- Show two example frontmatter blocks: one all string-shorthand, one mixing string and object forms
- Add a short backwards-compatibility note: bare-string entries are equivalent to `{ target: "..." }` and continue to be the default for the consolidation pipeline's auto-writes

### Files

- Modify: `templates/schema.md`
- Tests: none (markdown doc)

---

## Task 4 — Expose typed/temporal edge fields in `/api/graph`

### Why
The dashboard graph SPA reads `/api/graph`. If the API doesn't surface edge type and temporal fields, the canvas can't render them.

### Contract

Locate the graph-feed loader called by `src/dashboard/server.ts:437–444` (likely `src/dashboard/loaders.ts` or sibling — verify before editing). Each edge in the response gains four fields:

```ts
interface GraphEdge {
  source: string;          // existing
  target: string;          // existing
  weight: number;          // existing
  // ↓ new
  type: string;            // the relation-type key (e.g., "mentions", "supports")
  validFrom?: string;      // ISO date if present
  validTo?: string | null; // null/absent = currently valid
  supersededBy?: string;   // relPath if present
}
```

If a node has multiple edges to the same target with different types, **emit one edge per type** (don't collapse them). The canvas will render parallel edges with their own styles.

For edges without explicit `valid_from`, default to the source document's `created` date in the API response (do **not** mutate the underlying file). For edges without explicit `valid_to`, omit the field or set null.

### Files

- Modify: `src/dashboard/loaders.ts` (verify path) — extend graph-feed serialization
- Modify: shared types if there's a `src/dashboard-ui/hooks/useGraph.ts` or similar with a `GraphEdge` interface
- Tests: `test/dashboard/loaders-graph.test.ts` — assert the new fields are present, parallel edges to the same target with different types both appear

---

## Task 5 — Per-edge-type rendering in `GalacticCanvas`

### Why
Distinct visual treatment per edge type is the user-visible payoff of this brief. A graph where `contradicts` looks different from `supports` makes epistemic structure visible.

### Contract

Extend `drawEdge()` in `src/dashboard-ui/components/GalacticCanvas.tsx:398–464`. Add a switch on `edge.type` that adjusts stroke color and dash pattern. Suggested treatment (operator can tune later):

| Type | Stroke | Dash |
|---|---|---|
| `mentions` (default / unknown type) | current cyan | solid |
| `supports` | green `rgba(110, 231, 183, …)` | solid |
| `contradicts` | red `rgba(252, 165, 165, …)` | dashed `[6, 4]` |
| `supersedes` | grey `rgba(156, 163, 175, …)` | solid with arrowhead |
| `derived_from` | faint blue `rgba(165, 180, 252, …)` | dotted `[2, 3]` |
| `uses` / `depends_on` | amber `rgba(253, 224, 71, …)` | solid |
| `caused_by` / `fixed_by` | violet `rgba(196, 181, 253, …)` | solid |
| `mentioned_in` / `linked` | current cyan | solid (treated like `mentions`) |

For edges with `validTo` set (i.e., historical), apply 40% opacity multiplier to the chosen stroke and skip the glow effect. Cross-galaxy edges keep their existing glow only when currently valid.

Existing cross-galaxy treatment (cyan + glow) applies as a **fallback** when the edge type is unknown or `mentions`. Typed edges win over the cross-galaxy fallback.

Add the same treatment to the Legend component (`src/dashboard-ui/components/galactic/Legend.tsx`) — a new "Edge Types" section listing each type with its swatch. The existing physics-driven legend rows stay.

### Files

- Modify: `src/dashboard-ui/components/GalacticCanvas.tsx` — extend `drawEdge()`
- Modify: `src/dashboard-ui/components/galactic/Legend.tsx` — add "Edge Types" section
- Tests: `test/dashboard-ui/components/galactic-legend.test.tsx` — assert the new section renders the expected edge-type rows. Canvas rendering itself stays untested (canvas is too painful to assert pixel-for-pixel; rely on the parsing/API tests for correctness)

---

## Execution order

1. **Task 1** (parser) — foundation; everything depends on this
2. **Task 2** (writer) — roundtrip; small diff once Task 1 lands
3. **Task 3** (schema doc) — pure documentation; can land alongside Task 2
4. **Task 4** (API) — exposes the data to the SPA
5. **Task 5** (rendering + legend) — user-visible payoff

Each task = one commit. Run `npx vitest run` between every commit. Final full-suite gate after Task 5 must pass before deploy.

---

## Build / test / deploy

```
npx vitest run                                            # full suite (758 currently passing)
npx vitest run test/retrieval test/consolidate            # parser + writer focus
npx vitest run test/dashboard                             # API + UI focus
npm run build
npm run build:ui

# Deploy to VPS:
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify live:
curl -s https://srv1317946.tail6916d8.ts.net/memory/api/graph | jq '.edges[0]'
# Should show: source, target, weight, type, validFrom (and possibly validTo, supersededBy)
```

---

## Acceptance checklist

- [ ] `readRelations()` parses bare-string entries identical to today's behavior (no regression on 1085 existing observations)
- [ ] `readRelations()` parses object-shape entries with `target`, `confidence`, `valid_from`, `valid_to`, `superseded_by`, `source`
- [ ] Mixed-shape arrays (some strings, some objects) parse correctly
- [ ] Unknown relation-type keys preserved (no whitelist)
- [ ] Object entries without `target` trigger `console.warn` with file path + index and are dropped
- [ ] `writeRelations()` round-trips: parse → write → parse → structural equality
- [ ] `writeObservationMentions()` output is byte-identical for string-only inputs (no regression in consolidation auto-writes)
- [ ] `/api/graph` edges include `type`, `validFrom`, `validTo`, `supersededBy` where applicable
- [ ] Parallel edges to the same target with different types appear separately in the API
- [ ] `GalacticCanvas.drawEdge()` styles by edge type per the suggested palette
- [ ] Edges with `validTo` set render at 40% opacity, no glow
- [ ] `Legend.tsx` shows an "Edge Types" section
- [ ] `templates/schema.md` documents the rich shape and temporal fields, marked as supported
- [ ] All 758+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No SQLite, no ledger, no schema migration of existing observations

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

Belong in separate briefs:

1. **Typed-edge proposing from the consolidation pipeline** — extend the BM25 + lexical matchers to classify each match into a probable relation type (e.g., raw → wiki link is `derived_from` from the wiki page's inbound view, `mentions` from the raw observation's outbound view). The current brief writes `mentions` for everything; the next brief upgrades the classifier.
2. **Confidence vector** — replace the scalar `confidence: number` with `{ extraction, source, validation, freshness, conflict }`. Drives a richer trust UI on the inspector.
3. **Lifecycle states on observations and pages** — `observed | linked | proposed | consolidated | canonical | stale | disputed | dormant | archived`. Gates retrieval injection.
4. **Reverse-relation backfill** — when an edge `A.mentions → B` is written, automatically materialize `B.mentioned_in ← A` in B's frontmatter (today this is computed on read; making it a persisted edge helps offline tooling and search).
5. **Contradiction dispute sets** — when `contradicts` edges accumulate, surface a "review this conflict" task in the dashboard.
6. **Temporal range queries** — `/api/graph?valid_at=2026-04-01` returns the graph as of a specific date. Edges with `validTo < date` or `validFrom > date` excluded.
