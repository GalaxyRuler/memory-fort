# Codex Implementation Brief — Confidence Vector + Lifecycle States

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Memory Fort currently models trust as **one number** (`confidence: 0.8`) and **one tri-state** (`status: active | archived | superseded`). That collapses several distinct questions into single fields:

- "How sure was the extractor when it parsed this?" vs "How reliable is the source?" vs "Has anyone validated it?" — all stuffed into one `confidence` scalar
- "Is this page visible?" vs "Where is this page in its lifecycle?" — stuffed into one `status` enum

The result: the system can't distinguish a freshly-captured unvalidated observation from a user-validated stable claim. Both might land at `confidence: 0.7`, and the retrieval pipeline treats them identically. The curation check at `src/curation/checks.ts:280-289` already feels this — its only lever is "promote to ≥ 0.5 or mark archived."

This brief introduces:

1. A **confidence vector** that splits the scalar into five named fields (`extraction`, `source`, `validation`, `freshness`, `conflict`) while staying backwards-compatible with the scalar form
2. A **new `lifecycle` field** orthogonal to `status` — `status` keeps its current meaning (visibility), `lifecycle` tracks where the memory is in its journey (`observed → proposed → consolidated → canonical → stale → disputed → dormant → archived`)
3. **Retrieval scoring updates** in `src/retrieval/metadata-score.ts` to use the new fields (deboost challenged/stale/disputed; boost user-validated/canonical)
4. **Inspector rendering updates** in `GraphDetailPanel.tsx` to show the vector and lifecycle as distinct surfaces with trust badges
5. A **staleness verify check** that counts canonical pages whose freshness is past 90 days

After this lands:

- Existing pages with `confidence: 0.85` and `status: active` continue to work identically — the scalar form is a valid alias for `{ extraction: 0.85 }` and the absence of `lifecycle` means "treat as it always has been"
- New pages can carry rich trust signals that the dashboard and retrieval pipeline actually consult
- The HealthBadge gains a staleness signal so canonical-but-rotting memories surface before they cause harm

---

## Scope guard

You will:

- Extend the `Frontmatter` type at `src/storage/frontmatter.ts:13-14` so `confidence` accepts a number OR a `ConfidenceVector` object, and add a new optional `lifecycle` field with nine values
- Add a `getConfidenceScore(frontmatter): number` helper that returns a single 0..1 scalar from either shape (for downstream consumers that just want one number)
- Add a `getValidationState(frontmatter)` and `getLifecycle(frontmatter)` helper for the new fields
- Update **every** consumer of `frontmatter.confidence` and `frontmatter.status` listed in the repo orientation section so they handle both shapes via the helpers
- Extend `factorForStatus()` and `scoreByMetadata()` at `src/retrieval/metadata-score.ts:38-80` to consult `lifecycle` and `validation` alongside `status`
- Update `GraphDetailPanel.tsx` (lines 108-111, 171-174) to render the full vector when present, with validation badges and freshness as relative time
- Update `templates/schema.md` to document the rich shape and new lifecycle states; bump `schema_version` to `1.2`
- Add a new verify check `freshness.staleness` that runs in both `operator` and `server` roles

You will **not**:

- Rewrite or migrate any existing wiki page or raw observation — backwards-compat is mandatory
- Change the `status` enum (still `active | archived | superseded`). The new lifecycle states go on the new `lifecycle` field, not on `status`
- Touch the consolidation runner's writing logic — it keeps writing scalar `confidence: 0.x` on edges. Vector confidence on observations themselves comes from user/UI/future briefs, not from consolidation auto-writes
- Change the glow halo physics in `GalacticCanvas.tsx:595` — it continues to read a scalar via `getConfidenceScore()`. The visual stays exactly as today
- Add a SQLite index, ledger, or any secondary storage — markdown stays canonical
- Add new MCP tool operations beyond the existing surface — the MCP server uses `getConfidenceScore()` and `getLifecycle()` like every other consumer
- Touch the per-edge `confidence` on `RelationEdge` (Brief A's work) — that stays a scalar per edge

If a consumer of `frontmatter.confidence` is ambiguous (e.g., a CLI tool that prints "confidence" as a single number — does it print the vector or the score?), default to **printing the score via the helper** and add a `--verbose` mode in a future brief if richer output is needed. Stop and ask only if a consumer's correct behavior is genuinely unclear.

---

## Repo orientation (verified before brief)

### Where `confidence` is read today (15 sites)

- `src/storage/frontmatter.ts:14, 122-125` — type def + validation (scalar 0..1 enforced today)
- `src/retrieval/corpus.ts:199` — read into `SearchDocument.confidence`
- `src/retrieval/metadata-score.ts:51-54` — used in `confidenceFactor`
- `src/curation/checks.ts:282, 440` — low-confidence flagging
- `src/dashboard-ui/components/GraphDetailPanel.tsx:108-111, 171-174` — inspector rendering (`.toFixed(2)`)
- `src/dashboard-ui/components/GalacticCanvas.tsx:595` — `confidenceGlow(node.confidence, radius)` — DO NOT change behavior, only the data path through the helper
- `src/compile/canonicalize.ts:62` — default by source type if missing
- `src/cli/commands/page.ts:189-191` — printed in page dump
- `src/dashboard/render.ts:164` — HTML rendering
- `src/dashboard/loaders.ts:799, 861, 1144` — used in low-confidence flagging (< 0.6)
- `src/hooks/session-start-helpers.ts:64-65` — gates injection
- `src/consolidate/runner.ts:131, 141` — per-edge confidence (Brief A's work; do NOT touch)
- `src/mcp/server.ts:53` — MCP tool input
- `src/cli/commands/log.ts:28-49` — CLI flag validation
- `src/hooks/raw-file.ts:82` — frontmatter serialization for raw observations

### Where `status` is read today (12 sites)

- `src/storage/frontmatter.ts:13, 33` — type def + `KNOWN_STATUS = ["active", "archived", "superseded"]`
- `src/retrieval/corpus.ts:197, 278` — read into `SearchDocument.status`; defaults to `"active"`
- `src/retrieval/metadata-score.ts:45-50, 76-80` — `factorForStatus()` deboosts archived
- `src/curation/checks.ts:255-256, 280-281, 406, 438` — multiple gates on status
- `src/mcp/server.ts:167, 173` — MCP search filter
- `src/dashboard-ui/components/GraphDetailPanel.tsx` (verify line — likely near confidence)
- `src/dashboard/render.ts:163` — HTML
- `src/cli/commands/page.ts:189` — CLI page dump
- `src/dashboard/loaders.ts:1141` — node serialization
- `src/migration/map-agentmemory.ts:267, 307, 348` — sets `status: "active"` on imports

### Embeddings store has its own `archived: boolean`

- `src/retrieval/embeddings-store.ts:14, 98-105, 165-166` — orthogonal to frontmatter `status`; do not touch
- `src/retrieval/refresh.ts:139-140` — prunes embeddings for archived pages

---

## Task 1 — Types + helpers + schema doc

### Why
The whole brief rests on the type definitions and a handful of helper functions. Land them first; everything else delegates to the helpers.

### Contract

```ts
// src/storage/frontmatter.ts

export type ValidationState =
  | "unvalidated"   // default for fresh captures
  | "auto"          // passed an automated check (e.g., schema validator)
  | "user"          // user-validated (highest trust)
  | "challenged"    // someone raised a counter-claim; not yet resolved
  | "revoked";      // explicitly invalidated

export type LifecycleStage =
  | "observed"      // raw observation, no curation yet
  | "linked"        // raw observation that consolidation has tied to wiki pages
  | "proposed"      // candidate wiki page or claim awaiting validation
  | "consolidated"  // promoted but not yet user-validated
  | "canonical"     // user-validated stable memory
  | "stale"         // canonical but past freshness window
  | "disputed"      // has unresolved contradicting evidence
  | "dormant"       // not retrieved for a long time; deboost
  | "archived";     // explicitly retired

export interface ConfidenceVector {
  extraction?: number;       // 0..1 — how sure parsing was
  source?: number;           // 0..1 — how reliable the originator is
  validation?: ValidationState;
  freshness?: string;        // ISO date — last reviewed
  conflict?: string | null;  // relPath of conflicting page or null
}

export interface Frontmatter {
  // ...existing fields preserved...
  confidence?: number | ConfidenceVector;  // CHANGED — accepts both
  status?: "active" | "archived" | "superseded";  // UNCHANGED
  lifecycle?: LifecycleStage;  // NEW — optional, no default forced on existing files
}
```

```ts
// src/storage/confidence.ts (NEW)

/**
 * Returns a single 0..1 score from a confidence value, regardless of shape.
 * - number → returned as-is (clamped to 0..1)
 * - vector with `extraction` → returns `extraction`
 * - vector without `extraction` → falls back to averaging present numeric fields, or 0 if none
 * - undefined → returns the second argument (default), else 0
 */
export function getConfidenceScore(
  confidence: number | ConfidenceVector | undefined,
  defaultScore?: number,
): number;

/**
 * Returns the validation state, defaulting to "unvalidated" if the field is missing
 * or the confidence value is a scalar.
 */
export function getValidationState(
  confidence: number | ConfidenceVector | undefined,
): ValidationState;

/**
 * Returns the lifecycle stage, defaulting to a kind-aware value if missing:
 * - raw observation (path starts with `raw/`) → "observed"
 * - wiki page with confidence ≥ 0.6 → "canonical"
 * - everything else → "proposed"
 */
export function getLifecycle(
  frontmatter: Partial<Frontmatter>,
  relPath: string,
): LifecycleStage;
```

### Validation

`src/storage/frontmatter.ts:122-125` validates the scalar today. Extend the check:

- If `confidence` is a number → existing check (0..1)
- If `confidence` is an object → validate each numeric field (`extraction`, `source`) is 0..1 when present; `validation` is one of the known states; `freshness` is a parseable ISO date; `conflict` is a string or null
- If `confidence` is anything else → error
- If `lifecycle` is present → must be one of the nine states; otherwise error

### Schema doc

Update `templates/schema.md`:

- Bump `schema_version` to `1.2`
- Add a "Confidence vector" subsection with the five fields and prose explaining each
- Add a "Lifecycle stages" subsection listing the nine states with a one-line rationale per state
- Show two example frontmatter blocks: one scalar (legacy), one vector + lifecycle (new)
- Add a backwards-compat note: scalar `confidence` is shorthand for `{ extraction: value }`; missing `lifecycle` falls back to a sensible default per `getLifecycle()`

### Files

- Modify: `src/storage/frontmatter.ts` — type extensions + validator updates
- New: `src/storage/confidence.ts` — helpers
- Modify: `templates/schema.md`
- Tests: `test/storage/confidence.test.ts` — at minimum:
  - `getConfidenceScore(0.7)` → `0.7`
  - `getConfidenceScore({ extraction: 0.85 })` → `0.85`
  - `getConfidenceScore({ source: 0.9 })` (no extraction) → `0.9` (averages present fields)
  - `getConfidenceScore(undefined, 0.5)` → `0.5`
  - `getConfidenceScore(1.5)` → `1` (clamps)
  - `getValidationState({ validation: "user" })` → `"user"`
  - `getValidationState(0.8)` → `"unvalidated"`
  - `getLifecycle({}, "raw/2026-05-26/codex-foo.md")` → `"observed"`
  - `getLifecycle({ confidence: 0.8 }, "wiki/decisions/foo.md")` → `"canonical"`
  - `getLifecycle({ confidence: 0.3 }, "wiki/lessons/bar.md")` → `"proposed"`
- Tests: `test/storage/frontmatter.test.ts` — at minimum:
  - Scalar `confidence: 0.7` validates
  - Vector `confidence: { extraction: 0.7, validation: "user" }` validates
  - Vector with invalid `validation` state errors
  - Vector with out-of-range `source` errors
  - `lifecycle: "canonical"` validates; `lifecycle: "bogus"` errors

---

## Task 2 — Update every confidence consumer to use the helper

### Why
Once the type is `number | ConfidenceVector`, code like `node.confidence.toFixed(2)` blows up on the vector form. Every consumer must route through `getConfidenceScore()` (for code that wants a scalar) or read named fields directly (for code that needs structure).

### Contract

For each consumer site listed in the repo orientation section:

- If the code wants a single number for math/display → call `getConfidenceScore(frontmatter.confidence)`
- If the code wants to render the structure → call `getConfidenceScore()` for the headline score AND read `validation`/`freshness` separately for badges/labels (Task 4 territory; for now just keep the headline number working)
- Existing thresholds like `< 0.6` keep their literal value; they now run against the score, not the raw field

**Specific sites that change behavior:**

| File | Line(s) | Change |
|---|---|---|
| `src/retrieval/corpus.ts` | 199 | `confidence: getConfidenceScore(...)` for the `SearchDocument` field; also expose `confidenceFull: Frontmatter["confidence"]` on `SearchDocument` for downstream code that wants the structure |
| `src/retrieval/metadata-score.ts` | 51-54 | Use the score |
| `src/curation/checks.ts` | 282, 440 | Use the score in the `< X` comparisons |
| `src/dashboard-ui/components/GraphDetailPanel.tsx` | 108-111, 171-174 | Use the score for the existing `.toFixed(2)` line. Inspector restructure (showing the vector) is Task 4 |
| `src/dashboard-ui/components/GalacticCanvas.tsx` | 595 | Use the score in `confidenceGlow(score, radius)`; glow physics unchanged |
| `src/compile/canonicalize.ts` | 62 | Use score for the default-by-source fallback |
| `src/cli/commands/page.ts` | 189-191 | Print the score |
| `src/dashboard/render.ts` | 164 | Render the score |
| `src/dashboard/loaders.ts` | 799, 861, 1144 | Use the score in comparisons |
| `src/hooks/session-start-helpers.ts` | 64-65 | Use the score in injection gates |
| `src/mcp/server.ts` | 53 | MCP tool input — accept either shape; serialize whichever was passed |
| `src/cli/commands/log.ts` | 28-49 | CLI `--confidence` flag stays a single number (scalar input is the user-facing contract) |

The shape on the wire (frontmatter file) is preserved exactly as written — readers normalize on access, writers don't rewrite.

### Files

Modify each file listed above. Tests:

- `test/retrieval/metadata-score.test.ts` — assert vector-form input produces the same score as the equivalent scalar
- `test/dashboard/loaders.test.ts` — assert pages with vector `confidence` are flagged for low-confidence using the score
- `test/curation/checks.test.ts` — same assertion for the curation surface
- The dashboard UI tests (`test/dashboard-ui/components/*`) — assert the inspector renders the score for both scalar and vector input

---

## Task 3 — Lifecycle field + retrieval scoring

### Why
The new `lifecycle` field needs a consumer in retrieval scoring, otherwise it's metadata that nothing reads. Extending `factorForStatus()` is the right place — it already deboosts archived.

### Contract

Extend `src/retrieval/metadata-score.ts:38-80`:

```ts
function factorForStatusAndLifecycle(
  status: string,
  lifecycle: LifecycleStage,
  validation: ValidationState,
  factors: { archivedFactor: number; staleFactor: number; disputedFactor: number; dormantFactor: number },
): number;
```

Multipliers (composable — multiply all that apply):

| Field | Value | Multiplier (suggested) |
|---|---|---|
| `status` | `archived` | 0.0 (existing) |
| `status` | `superseded` | 0.1 (existing) |
| `lifecycle` | `canonical` | 1.0 (no effect) |
| `lifecycle` | `consolidated` | 0.9 (mild deboost — not yet validated) |
| `lifecycle` | `proposed` | 0.7 (moderate deboost) |
| `lifecycle` | `observed` | 0.85 (raw evidence, useful but not curated) |
| `lifecycle` | `linked` | 0.85 (same) |
| `lifecycle` | `stale` | 0.5 (significant deboost) |
| `lifecycle` | `disputed` | 0.3 (strong deboost) |
| `lifecycle` | `dormant` | 0.4 (strong deboost) |
| `lifecycle` | `archived` | 0.0 (matches status: archived) |
| `validation` | `user` | × 1.2 (boost, capped at 1.0 final score) |
| `validation` | `auto` | × 1.05 |
| `validation` | `challenged` | × 0.4 |
| `validation` | `revoked` | × 0.0 |
| `validation` | `unvalidated` | × 1.0 |

These multipliers compose with the existing `confidenceFactor` and `recencyFactor`. Bake them into the suggested defaults but expose as options on `scoreByMetadata()` so the operator can tune.

### Files

- Modify: `src/retrieval/metadata-score.ts`
- Tests: `test/retrieval/metadata-score.test.ts` — assert each lifecycle/validation combination produces the expected multiplier; assert legacy pages without `lifecycle` get no extra deboost (treated as 1.0)

---

## Task 4 — Inspector rendering

### Why
The inspector (`GraphDetailPanel.tsx`) is where the user sees trust signals. Today it shows one number; after this it shows the vector decomposed into named cells plus lifecycle and validation badges.

### Contract

Rework `GraphDetailPanel.tsx` lines 108-111 and 171-174:

```
┌── Trust ───────────────────────────────────┐
│  Score          0.85                       │
│  Validation     [USER]   ← colored badge   │
│  Source         user (1.0)                 │
│  Freshness      14d ago                    │
│  Lifecycle      [CANONICAL] ← badge        │
└────────────────────────────────────────────┘
```

For nodes with **scalar** `confidence` (legacy), render only the Score row and Lifecycle (auto-detected via `getLifecycle()`). Hide the other rows entirely — don't show "unknown" placeholders.

For nodes with **vector** `confidence`, render every field that's present.

Validation badge colors:
- `user` → green
- `auto` → blue
- `unvalidated` → grey
- `challenged` → amber
- `revoked` → red

Lifecycle badge colors (match the retrieval scoring intuition):
- `canonical` → green
- `consolidated` → teal
- `proposed` → blue
- `observed` / `linked` → grey
- `stale` → amber
- `disputed` → orange
- `dormant` → purple
- `archived` → red

Freshness rendering: relative time (`2d ago`, `3w ago`, `2mo ago`) using a small util. Hide if absent.

The existing `status` row stays where it is (it's orthogonal — `status: superseded` is still useful to see).

### Files

- Modify: `src/dashboard-ui/components/GraphDetailPanel.tsx`
- New (if needed): `src/dashboard-ui/lib/relative-time.ts` — simple `formatRelative(iso: string): string`
- New (if needed): `src/dashboard-ui/components/TrustBadge.tsx` — reusable colored chip
- Tests: `test/dashboard-ui/components/graph-detail-trust.test.tsx` — assert:
  - Scalar-confidence node renders one Score row + auto-detected Lifecycle
  - Vector-confidence node renders all five rows
  - Validation badge has the correct color class per state
  - Lifecycle badge has the correct color class per state
  - Missing freshness hides the row (no "unknown" text)

---

## Task 5 — Staleness verify check

### Why
Canonical memories rot silently — a decision page from 2024 may still say `lifecycle: canonical` while the underlying decision changed. A health check that counts stale canonicals turns this from invisible drift into a visible signal.

### Contract

New check at `src/cli/commands/verify/freshness.ts`:

```ts
export const freshnessStaleCheck: CheckDescriptor = {
  id: "freshness.staleness",
  label: "canonical memories are fresh",
  roles: ["operator", "server"],
  run: async (ctx) => {
    // For each canonical wiki page (lifecycle === "canonical" or
    // lifecycle absent + status === "active" + path starts with wiki/):
    //   - Compute age from confidence.freshness if vector, else fall back to frontmatter.updated
    //   - If age > 90 days, count as stale
    //
    // pass when stale count == 0 OR (stale ratio < 10% and stale count < 20)
    // warn when stale ratio in [10%, 30%] or stale count in [20, 100)
    // fail when stale ratio >= 30% or stale count >= 100
    //
    // detail: `${staleCount}/${canonicalCount} canonical memories are >90d stale`
    // suggestedFix: "run `memory log <page> --validate` to refresh, or set lifecycle: archived"
  },
};
```

Register the new descriptor in `src/cli/commands/verify/registry.ts`.

### Files

- New: `src/cli/commands/verify/freshness.ts`
- Modify: `src/cli/commands/verify/registry.ts` — add to `ALL_CHECKS`
- Tests: `test/cli/commands/verify/freshness.test.ts` — assert:
  - Vault with no canonicals returns pass
  - Vault with all-fresh canonicals returns pass
  - Vault with > 30% stale returns fail
  - Vault with 15% stale returns warn
  - Vault where pages have `confidence.freshness` set uses that field; pages without fall back to `updated`

---

## Execution order

1. **Task 1** (types + helpers + schema) — foundation
2. **Task 2** (consumer updates) — mechanical sweep across ~15 files
3. **Task 3** (lifecycle scoring) — wires the new field into retrieval
4. **Task 4** (inspector) — user-visible payoff
5. **Task 5** (staleness check) — health signal

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit (the suite has known parallelism flakes in `test/eval/longmemeval-integration.test.ts` and `test/cli/commands/install-vscode.test.ts` that are unrelated to this brief).

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                    # full suite (772 currently passing)
npx vitest run test/storage test/retrieval              # types + scoring focus
npx vitest run test/dashboard-ui                        # inspector focus
npm run build
npm run build:ui

# Deploy:
scp dist/dashboard/server.mjs root@srv1317946:/root/memory-system/services/dashboard-bundle.mjs
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/
ssh root@srv1317946 "systemctl restart memory-dashboard"

# Verify live:
curl -s "https://srv1317946.tail6916d8.ts.net/memory/api/health?deep=true" | jq '.checks[] | select(.id == "freshness.staleness")'
# Expected: a freshness.staleness entry with pass/warn/fail status
```

---

## Acceptance checklist

- [ ] `Frontmatter.confidence` accepts both `number` and `ConfidenceVector`
- [ ] `Frontmatter.lifecycle` is a new optional field accepting one of nine states
- [ ] `getConfidenceScore()` returns the right scalar from both shapes; clamps out-of-range; falls back to default when undefined
- [ ] `getValidationState()` and `getLifecycle()` return sensible defaults for missing fields
- [ ] Every existing consumer of `frontmatter.confidence` (15 sites) routes through `getConfidenceScore()` and continues to behave identically on scalar input
- [ ] Pages with vector `confidence` produce the same metadata score as the equivalent scalar (when only `extraction` is set)
- [ ] `factorForStatusAndLifecycle()` composes status, lifecycle, and validation into a single multiplier; legacy pages without `lifecycle` get a 1.0 multiplier (no regression)
- [ ] Inspector renders the vector decomposed when present, single score when scalar; badges have the correct color classes
- [ ] `freshness.staleness` check runs in both operator and server roles; passes on a fresh vault; warns on 15% stale; fails on 30%+ stale
- [ ] `templates/schema.md` documents both fields, bumped to `schema_version: 1.2`
- [ ] All 772+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] Consolidation runner's writing logic unchanged (no auto-write of vector form)
- [ ] Glow halo physics in `GalacticCanvas.tsx:595` unchanged

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

Belong in separate briefs:

1. **Lifecycle auto-transitions** — a nightly job that promotes `proposed → consolidated` after N days, `canonical → stale` past freshness, `canonical → dormant` if not retrieved for M days. Today the lifecycle is hand-set; the next brief automates it.
2. **Validation workflow in the dashboard** — a "Validate this memory" button on the inspector that flips `validation: user` and stamps `freshness: <today>`. Today validation is a frontmatter edit operation.
3. **Confidence vector from the MCP server** — let agents write the vector form (`source: 0.8, validation: "auto"`) instead of just a scalar. Today the MCP tool input accepts a scalar; the brief preserves that contract.
4. **Dispute set workflow** — when `confidence.conflict` points to another page, surface a "Resolve this conflict" review action in the dashboard. Today the field is read but not actionable.
5. **Prospective memory** — a new kind for pending obligations and deadlines. Brief C territory.
6. **Event segmentation** — split monolithic session files into goal-scoped episodes. Brief C territory.
