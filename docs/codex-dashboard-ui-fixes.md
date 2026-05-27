# Codex Implementation Brief — Dashboard UI Fixes

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

A full live-dashboard audit (every nav route browsed against the VPS deploy, every API endpoint cross-referenced against its consumer) surfaced four real UI bugs. None are backend issues — every API endpoint returns 200 with valid JSON. All four bugs are in how the SPA renders or addresses that data.

The four bugs (each with exact file:line):

1. **`/crystals` shows 0 crystals while the vault has 4** — `src/dashboard-ui/components/CrystalsPage.tsx:11` reads `wiki.data?.byCategory.crystal` (singular) but `/api/wiki` returns the category as `crystals` (plural). One-character key mismatch
2. **Overview "Recently Updated Pages" cards show phantom defaults** — `src/dashboard-ui/routes/index.tsx:87-89` falls back to `confidence: 0.75, inboundCount: 0, outboundCount: 0` when a page isn't in the wiki-scoped graph feed. The recent-list is dominated by audit logs and crystals (which are orphans → not in graph) so every visible card shows the same defaults
3. **`/compile` renders decorative mockup nodes** — `src/dashboard-ui/components/CompilePage.tsx:53` hardcodes `["node_38a1", "node_9b4f", "node_2c7e"]` as if they were real data. UI mockup leftovers
4. **Sessions show uniform timestamps** — `src/dashboard-ui/components/SessionTile.tsx:68` displays `file.mtime` (file modification time) instead of capture time. After today's bulk `consolidate --apply --force` reclassification, every session file's mtime is one of two values, so every session card shows the same "06:44 PM" or "06:04 PM"

After this lands and deploys, all 14 nav routes display honest data.

---

## Scope guard

You will:

- Fix the one-character category-key bug in `CrystalsPage.tsx`
- Either skip phantom-data fields on Overview's Recently Updated cards when the source data lacks them, OR re-sort the list to prefer graph-connected pages. **Choose the simpler option (skipping the badges when data is unavailable)** unless test fixtures suggest otherwise
- Remove the hardcoded mockup nodes from `CompilePage.tsx` and either render real data (if available) or remove the visual element entirely
- Replace `file.mtime` with an actual session-capture timestamp in `SessionTile.tsx`. Two options: (a) extract from the UUIDv7 in the filename via the existing `parseSessionIdFromFilename` helper plus a tiny `decodeUuidV7Time()` utility, OR (b) drop the time display entirely (the date is already shown elsewhere in the tile). **Prefer (a)** because the data is genuinely available; only fall back to (b) if the parse is unreliable across the actual file corpus
- Add tests for each fix that pin the new behavior
- No changes to backend endpoints — these are UI-only

You will **not**:

- Change any API endpoint shape or query string
- Refactor `useWikiIndex`, `useGraph`, or `useRawIndex` hooks
- Touch the polling cadence (`useStatus`/`useSyncState`) — that's a separate polish item
- Add new dependencies for date parsing — Node has Date, and UUIDv7 decoding is a 4-line function (first 48 bits = Unix ms)
- Add UI redesigns beyond the minimum needed to remove phantom data
- Address the `/graph` page slow-load (3D canvas init is heavy; that's a perf concern, not a UI bug)
- Address the `/api/log` endpoint orphan (no SPA consumer; out of scope for fixing rendered routes)

If any fix requires touching the corresponding API endpoint to expose data the UI needs, **stop and ask** rather than expanding the brief.

---

## Repo orientation (verified before brief)

- `src/dashboard-ui/components/CrystalsPage.tsx:11` — `const crystals = wiki.data?.byCategory.crystal ?? [];` (the bug)
- `src/dashboard-ui/hooks/useWikiIndex.ts` — `WikiIndex.byCategory` keys are the literal subdirectory names under `wiki/` (so `crystals`, `decisions`, `lessons`, `projects`, `references`, `tools`, `.audit`)
- `src/dashboard-ui/routes/index.tsx:78-91` — `recentlyUpdated` array construction. Lines 87-89 hardcode the fallbacks
- `src/dashboard-ui/routes/index.tsx:316-331` — the conf bar rendering (`<div className="h-1 w-16 overflow-hidden rounded-full bg-surface-4">` etc.)
- `src/dashboard-ui/components/CompilePage.tsx:53` — `const nodes = ["node_38a1", "node_9b4f", "node_2c7e"];` and its consumers below
- `src/dashboard-ui/components/SessionTile.tsx:68` — `new Date(file.mtime).toLocaleTimeString(...)` — the wrong time source
- `src/dashboard-ui/hooks/useRawIndex.ts` and the `/api/raw` endpoint — `RawIndexFile` exposes `filename`, `mtime`, `sizeBytes`, but not session capture time directly; the timestamp lives encoded in the UUIDv7 in the filename for Codex sessions, or in frontmatter `observed_at` for claude-code sessions. Check what fields are available before extending

---

## Task 1 — Crystals category key fix

### Why
A typo costs the user visibility of all four crystals in the live vault.

### Contract

```ts
// src/dashboard-ui/components/CrystalsPage.tsx
- const crystals = wiki.data?.byCategory.crystal ?? [];
+ const crystals = wiki.data?.byCategory.crystals ?? [];
```

That's the entire code change. Verify the API key by inspecting `/api/wiki` against the live VPS or via the existing `useWikiIndex` integration test fixtures.

### Files

- Modify: `src/dashboard-ui/components/CrystalsPage.tsx` (line 11)
- Tests: `test/dashboard-ui/components/crystals-page.test.tsx` (new or extended) — assert that a fixture with 4 entries under `byCategory.crystals` renders 4 cards and the empty-state copy doesn't appear

---

## Task 2 — Overview Recently Updated phantom data

### Why
Every audit-log card shows `conf: 0.75` and `in:0 out:0` because the fallback path hides the fact that these pages have no graph data. The user sees identical badges across the whole horizontal scroll, which trains them to ignore the values.

### Contract

Two options, **prefer the first**:

**Option A (preferred): omit the badges when the data is unavailable.**

```ts
// src/dashboard-ui/routes/index.tsx around line 83
const recentlyUpdated = [...wikiEntries]
  .sort((a, b) => b.updated.localeCompare(a.updated))
  .slice(0, 6)
  .map((entry) => {
    const node = graph.data?.nodes.find((n) => n.path === entry.relPath);
    return {
      ...entry,
      confidence: node?.confidence ?? null,
      inboundCount: node?.inboundCount ?? null,
      outboundCount: node?.outboundCount ?? null,
    };
  });
```

In the JSX (around line 316), guard the conf bar and the in/out spans:

```tsx
{page.confidence !== null && (
  <div className="flex items-center gap-1.5 min-w-0">
    <span className="text-[9px] font-mono text-text-muted">conf:</span>
    {/* bar */}
  </div>
)}
{page.inboundCount !== null && (
  <span>in:{page.inboundCount} out:{page.outboundCount}</span>
)}
```

**Option B (fallback if A breaks tests): sort recent list to prefer graph-connected pages.**

Re-sort so pages with graph nodes come first when `updated` is roughly equal. But this changes which pages the user sees — less honest. Use only if Option A regresses something.

### Files

- Modify: `src/dashboard-ui/routes/index.tsx` (the `recentlyUpdated` construction + the card JSX)
- Tests: `test/dashboard-ui/routes/overview.test.tsx` (new or extended) — fixture with 2 graph-connected pages and 2 orphan audit logs; assert orphan cards don't render conf/in-out badges, connected pages do

---

## Task 3 — Compile page mockup cleanup

### Why
The compile page renders three decorative "node" tiles with fake names that look like real data to a new user. They've been there since some early UI mockup and never got removed.

### Contract

Remove the `nodes` constant at `CompilePage.tsx:53` and the JSX that renders it. If there's a real "nodes processed" surface that *should* go there, leave a `{/* TODO: real curation node list */}` comment and an `EmptyState` placeholder instead. Don't ship decorative mockup data.

Inspect the surrounding code to confirm the tiles aren't load-bearing for any layout — if removing them breaks the visual grid, replace with an empty-state component matching the rest of the page's style (see `MaintenancePage.tsx` for the empty-state pattern).

### Files

- Modify: `src/dashboard-ui/components/CompilePage.tsx`
- Tests: `test/dashboard-ui/components/compile-page.test.tsx` (new or extended) — assert no element with text matching `node_[0-9a-f]+` appears

---

## Task 4 — Sessions show real capture timestamp

### Why
Every session card showing "06:44 PM" trains the user to ignore the time field. The actual capture time is encoded in the UUIDv7 in the filename for Codex sessions (first 48 bits = Unix ms) and parseable from `parseSessionIdFromFilename`'s output.

### Contract

Add a small utility:

```ts
// src/dashboard-ui/lib/uuidv7.ts (or extend raw-helpers.ts)

// UUIDv7 layout: first 48 bits are unix_ts_ms (big-endian)
// Returns null for non-UUIDv7 ids (claude-code uses non-v7 ids — those fall through)
export function decodeUuidV7Time(id: string): Date | null {
  // accept ids of shape XXXXXXXX-XXXX-7XXX-XXXX-XXXXXXXXXXXX
  // (strip dashes, check version nibble at index 12 is "7")
  const hex = id.replace(/-/g, "");
  if (hex.length !== 32) return null;
  if (hex[12] !== "7") return null;  // version nibble
  const tsHex = hex.slice(0, 12);
  const ms = parseInt(tsHex, 16);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}
```

Update `SessionTile.tsx:68`:

```tsx
- <span>{new Date(file.mtime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
+ {(() => {
+   const captureTime = decodeUuidV7Time(sessionId);
+   if (captureTime) {
+     return <span>{captureTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>;
+   }
+   return null; // claude-code sessions don't have UUIDv7 ids; just hide the time
+ })()}
```

For claude-code sessions (which use non-v7 session ids), hide the time entirely. The date column shown elsewhere on the tile is sufficient.

### Files

- New: `src/dashboard-ui/lib/uuidv7.ts` (or extend `raw-helpers.ts`)
- Modify: `src/dashboard-ui/components/SessionTile.tsx`
- Tests: `test/dashboard-ui/lib/uuidv7.test.ts` — decode known UUIDv7 → expected ms; non-v7 input returns null
- Tests: `test/dashboard-ui/components/session-tile.test.tsx` — Codex session shows capture time; claude-code session has no time element

---

## Execution order

1. **Task 1** (Crystals one-line fix) — trivial; lands first as a confidence-builder
2. **Task 2** (Overview phantom data) — small JSX restructure
3. **Task 3** (Compile cleanup) — remove dead code
4. **Task 4** (Sessions time) — new utility + integration; biggest of the four but still small

Each task = one commit. Run `npx vitest run --no-file-parallelism` between every commit.

---

## Build / test / deploy

```
npx vitest run --no-file-parallelism                  # full suite (865 currently passing)
npx vitest run test/dashboard-ui                      # UI focus
npm run build
npm run build:ui

# Deploy SPA bundle (no server-side change needed):
scp -r dist/dashboard-ui/* root@srv1317946:/root/memory-system/dist/dashboard-ui/

# Force-refresh via browser (no service restart needed for SPA-only changes)
# Verify:
# - /memory/crystals shows 4 crystal cards
# - /memory/ "Recently Updated Pages" doesn't show conf badges or in/out on audit-log cards
# - /memory/compile no longer has node_38a1/9b4f/2c7e tiles
# - /memory/sessions shows different times across different Codex sessions
```

Note: server bundle does NOT need redeploy — these are all SPA-only changes. Only `dist/dashboard-ui/*` files change.

---

## Acceptance checklist

- [ ] `/memory/crystals` on the live VPS shows 4 crystal cards (not "No crystals yet")
- [ ] `/memory/` Overview "Recently Updated Pages" does not show `conf: 0.75` or `in:0 out:0` on cards backed by graph-disconnected pages
- [ ] Cards backed by graph-connected pages (decisions, lessons, projects) still show real confidence and in/out counts
- [ ] `/memory/compile` does not render `node_38a1`, `node_9b4f`, or `node_2c7e`
- [ ] `/memory/sessions` shows variable capture times across Codex sessions from different dates and hours
- [ ] Claude-code sessions on `/memory/sessions` don't show a time (or show a fallback like `--`)
- [ ] All 865+ existing tests still green; new tests added per task
- [ ] No new dependencies, no secrets, no OneDrive paths
- [ ] No backend changes
- [ ] No polling cadence changes

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope)

Surfaced by the live audit but deferred:

1. **`/api/status` and `/api/sync-state` polling spam** — fire on every route navigation (35+ times in 70 requests). Extend `staleTime` on those hooks to reduce churn. Pure polish
2. **`/api/log` orphan endpoint** — no SPA consumer; only reachable via the server-rendered `/log` HTML route. Either wire up to the Audit page or remove the endpoint. Defer until the Audit page needs more data sources
3. **`/graph` slow 3D canvas init** — heavy initial render. Worth a perf pass if user complaints surface. Probably under-prioritize for now
4. **Wiki page cards consistent confidence display** — same root cause as Task 2 but on the wiki index page. Defer until evidence shows it matters
5. **Phase 4 — richer memory kinds** — narrative threads, event segmentation, procedural extraction. These are the real next architectural moves once UI bugs are cleared
