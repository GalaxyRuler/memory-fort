# Codex Implementation Brief — Overview Redesign + Dashboard UX Fixes (Phase 4.3.K)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Operator-driven UX audit of the dashboard at `http://127.0.0.1:4410/memory/` (and srv1317946 via Tailscale). Audit was conducted 2026-05-28 against the live vault running the freshly-shipped Phase 4.3.G/H/I/J code (1001 tests, build clean). Findings drive a focused redesign of the overview page plus a set of UX fixes uncovered along the way.

### Headline finding

The overview page is **2,380 px tall** and the Graph Health section alone is **1,319 px** — **55% of the entire page** — even though every other section combined fits inside one screen. The user reported it as "cramped"; the data shows it's literally dominating real-estate.

Vertical breakdown of `/memory/`:

| Section | Top px | Block height px | % of page |
|---|---|---|---|
| Header / hero | 0 | 292 | 12% |
| **GRAPH HEALTH** | 292 | **1,319** | **55%** |
| RECENT ACTIVITY FEED | 1611 | 16 | 0.7% (header only — content missing or empty) |
| QUICK STATS | 1627 | 350 | 15% |
| NEEDS ATTENTION | 1977 | 176 | 7% |
| RECENTLY UPDATED PAGES | 2153 | 226 | 9% |

Root cause of the Graph Health bloat (inspected via DevTools):

- Container is `<div class="grid gap-2">` with **13 children** — `grid` is declared with **no `grid-cols-*`** so it falls back to 1 column on every breakpoint
- Each tile contains four short lines (title, big number, threshold legend, one-sentence description) — content fits trivially in ~90 px tall × ~360 px wide
- Other grids on the page already do this correctly: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` (the Quick Stats block) renders 4 tiles in a 131 px tall row

The fix is straightforward at the markup level. The opportunity is to also rethink whether 13 diagnostic metrics should live above-the-fold at all.

### Secondary findings (worth bundling)

While auditing, several other UX issues surfaced that share a single deploy cycle with the redesign:

1. **Stuck error pill in nav.** The sidebar's bottom status pill reads `error 1d ago` (red, `border-status-red/30 bg-status-red/20`) on every route. It's not interactive — no click target, no tooltip, no link to the error log. It's been "1d ago" the entire audit session, meaning whatever failed yesterday is never auto-clearing
2. **Every page has the same `<h1>Memory Fort</h1>`.** A second `<h1>` appears on routes like Settings (`<h1>Settings</h1>`). Two H1s per page is an accessibility violation and confuses screen readers
3. **Settings page renders duplicate sections.** Visible `<h2>` headings include **both** `Embedder` and `Embedding`, **both** `LLM` and `Llm`. Looks like the YAML config keys are being rendered as fallback section headers in addition to the curated section cards from Phase 4.3.C
4. **Settings page has zero `<input>` elements.** Despite Phase 4.3.C shipping editable provider config cards, `document.querySelectorAll('input,select,textarea')` returns empty. Either the cards use non-native widgets (custom dropdowns rendered as buttons) without an underlying form control, or the editability never actually wired up the inputs on the rendered page
5. **Long list pages have no pagination.** Page heights: `/raw` = **51,972 px**, `/activity` = **7,212 px**, `/sessions` = **3,692 px**, `/audit` = **3,734 px**. No virtualization, no page-size selector. Rendering 1,162 raw observation cards in one DOM tree is slow and unbrowsable
6. **Wiki page has no category grouping.** `/wiki` shows 50 pages as a flat list with zero `<h2>` headings. The vault already groups them by category (`decisions/`, `projects/`, `lessons/`, etc.); the UI flattens them
7. **`Recent activity feed` empty state is invisible.** The header renders but the section body collapses to 16 px — likely there's no observation in whatever filter window the homepage uses, but no empty-state UI shows. Looks broken

---

## Scope guard

You will:

### Task 1 — Overview redesign (the headline fix)

**Replace the single-column Graph Health stack with a collapsible summary + responsive grid.** Two states:

- **Collapsed (default).** A single horizontal status bar: `Graph health: 10/13 passing · 2 warn · 1 fail` with status-colored chevron. Takes ~80 px tall, full width. Clicking expands the section
- **Expanded.** A responsive grid `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3` rendering all 13 metric cards. Tiles keep the existing status-color border treatment (`border-status-red/30`, `border-status-amber/30`, `border-status-green/30`). At xl this gives 4 rows × 4 cols max — section height drops from 1,319 px to ~360 px

**Storage:** persist expansion preference in `localStorage` under `mf:overview:graph-health-expanded`. Default `false` (collapsed). Operators who like the always-expanded view can toggle once

**File:** find the overview page route — likely `src/dashboard-ui/routes/index.tsx` or a component referenced from it. Search for the existing `grid gap-2` parent of the 13 graph-health children

**Tests:** existing render tests for the overview must continue to pass; new test for collapse-by-default, click-to-expand, localStorage persistence

### Task 2 — Move long-tail health detail off the overview

Even when expanded, **13 metrics is a lot for the homepage**. Add a dedicated `/memory/health` route (or extend `/memory/maintenance` if appropriate — check existing structure) that hosts the full graph health page with extended descriptions and historical trends. The overview's expand-then-grid mode shows the live values; the new route hosts the deeper drill-down

Acceptance: clicking any tile from the expanded overview grid navigates to the corresponding section of `/memory/health` (or `/maintenance#graph-health`). Operators who want deep-diagnostic mode have a clear destination

### Task 3 — Make the stuck error pill actionable

The `error 1d ago` pill in the bottom-left of the sidebar (`mt-auto px-2 > span.border-status-red/30`) is informational dead weight today. Three changes:

- Wrap the pill in `<a href="/memory/audit?filter=error">` (or wherever the failure source is — inspect `~/.memory/errors.log` for the actual content)
- Add a `title` / `aria-label` attribute with the error summary text
- If the underlying error log has no entries in the last 24 hours, the pill should render in green / dim with text `healthy` instead of staying red forever. Read from the same data source the existing pill uses; just gate the color/text on log-recency

If the pill state source is opaque, **stop and ask** — but the audit log already exists and the existing route `/memory/audit` already renders log entries

### Task 4 — Fix Settings page double-rendering + missing inputs

Two distinct bugs:

- **Duplicate headings**: `Embedder` + `Embedding`, `LLM` + `Llm` both render as `<h2>`. The curated config cards from Phase 4.3.C are correct; the lowercased-key fallback rendering is the bug. Find the settings route and gate the YAML-key-rendering fallback so it doesn't fire for any section that has a dedicated card
- **Missing `<input>` elements**: editable config cards from 4.3.C should render at least one `<input>` or `<select>` per field. Inspect `src/dashboard-ui/components/EmbedderConfigCard.tsx` and `LLMConfigCard.tsx` — if they're using `<button>` toggles or read-only displays, wire up actual editable controls

Also: **only one `<h1>` per page**. The current pattern of `<h1>Memory Fort</h1>` in the sidebar plus `<h1>Settings</h1>` in the route violates a11y. Demote the sidebar `Memory Fort` brand to a `<div>` or `<p>` with appropriate `aria-label`, keep the route-level `<h1>` as the page title

### Task 5 — Pagination on long-list routes

`/raw` (52k px), `/activity` (7k), `/sessions` (3.7k), `/audit` (3.7k) all render unbounded lists. Add cursor-style pagination:

- Page size 50 (configurable via URL `?per=N`)
- "Load more" button at the bottom of each list (cursor-based, not page-index — easier with timestamp data)
- Or use `react-window` virtual scrolling if the team prefers — either works. **Stop and ask** if you want to add a dependency
- Routes affected: `src/dashboard-ui/routes/{raw,activity,sessions,audit}.tsx` (or wherever the lists render)

Acceptance: each long-list route's initial DOM size drops to ≤2,000 px tall. Loading more works correctly

### Task 6 — Wiki page category grouping

`/wiki` should render pages grouped by category with `<h2>` headers (`Decisions`, `Projects`, `Lessons`, `References`, `Tools`, `People`, `Threads`, `Procedures`, `Crystals`). Within each group, pages stay in their current sort order. Empty categories don't render

Existing layout from `wiki.index.tsx` likely fetches all pages and renders flat — swap to a `groupBy(category)` reduce before render

### Task 7 — Recent Activity empty state

Currently the section header renders but the body collapses to 16 px when there's no data. Add an empty state component (the codebase already has `EmptyState.tsx`) showing something like: `No recent activity. Capture a session to populate this feed.` with a link to docs or the `/memory/activity` route

### Task 8 — Docs

- Update `docs/ROADMAP.md` with Phase 4.3.K shipped 2026-05-28 — note that A through J shipped the propose pipeline, K is the UX cleanup
- Brief mention in `templates/schema.md` if there's a section documenting the dashboard structure

You will **not**:

- Redesign the navigation, search, or any route not listed above. The sidebar nav, search box, and command palette are out of scope
- Change the color palette, typography, or design tokens. Existing Tailwind setup stays
- Add charts, sparklines, or time-series visualizations on the overview. The 13 metric cards already show current values; trends belong on `/health`
- Touch the graph viz at `/memory/graph` — that's its own beast and the visual is intentional
- Reorder the sidebar links or add new top-level routes besides `/memory/health` from Task 2
- Change any API endpoints. This is a UI-only brief; server routes are stable from Phase 4.3.G/H/I/J
- Add a settings-page light/dark theme toggle. The dashboard is dark-only by design
- Modify Phase 4.3.J work (auto-promote inbox) — that brief is independent and may land before or after this one
- Add analytics, telemetry, or any third-party scripts
- Touch dashboard auth or the same-origin posture from Phase 4.3.C

If the redesign turns out to require changes to the underlying `/api/health` response shape (e.g., to support a summary view), **stop and ask** — the API extension is a separate brief

---

## Repo orientation

- `src/dashboard-ui/routes/index.tsx` — overview page entry. The graph health grid lives here or in a component it renders. Look for the `grid gap-2` parent with 13 children
- `src/dashboard-ui/components/GraphHealthCard.tsx` (or similar) — individual tile component. The status-colored border + content shape is what to preserve
- `src/dashboard-ui/components/EmptyState.tsx` — reuse for Task 7
- `src/dashboard-ui/routes/settings.tsx` — duplicate-section bug source
- `src/dashboard-ui/components/EmbedderConfigCard.tsx` / `LLMConfigCard.tsx` — Phase 4.3.C cards needing the input wiring fix
- `src/dashboard-ui/routes/wiki.index.tsx` — flat-list grouping fix
- `src/dashboard-ui/layouts/` or root component — sidebar's status pill lives somewhere in here
- `src/dashboard-ui/routes/{raw,activity,sessions,audit}.tsx` — pagination targets
- `src/dashboard-ui/routeTree.gen.ts` — auto-regenerates when adding `/health` route

---

## Acceptance contract

1. After this lands, `http://127.0.0.1:4410/memory/` total `document.documentElement.scrollHeight` is **≤ 1,200 px** by default (collapsed graph health), and **≤ 1,500 px** when graph health is expanded at 1440px viewport width
2. Graph Health collapsed mode shows a single-line status summary with correct passing/warn/fail counts derived from the same data source the current cards use
3. Graph Health expanded mode renders all 13 metric cards in a responsive grid (1/2/3/4 cols at xs/sm/lg/xl)
4. Expansion preference persists across reloads via localStorage
5. New `/memory/health` (or `/memory/maintenance#graph-health`) route surfaces the deep drill-down
6. Sidebar status pill is a link, has an `aria-label`, and renders green/healthy when error log has no entries in the last 24 hours
7. Each route has **exactly one `<h1>`**. The sidebar "Memory Fort" brand is no longer an `<h1>`
8. Settings page renders no duplicate sections. Only the curated cards from Phase 4.3.C appear. Each editable card has at least one `<input>` or `<select>` element
9. `/raw`, `/activity`, `/sessions`, `/audit` initial DOM height ≤ 2,000 px, with Load More working correctly
10. `/wiki` groups pages by category under `<h2>` headers
11. Recent Activity empty state renders a useful message instead of collapsing to a 16 px header
12. All existing tests pass. New tests cover: graph health collapse/expand, localStorage persistence, error-pill empty-state, pagination
13. `npm run build` and `npm run build:ui` both pass
14. `git diff --check` clean

---

## Verification commands

Operator runs after the brief lands:

```powershell
cd C:\CodexProjects\memory-system

# Build + run local dashboard
npm run build
npm run build:ui

# Open the dashboard
code "C:\Users\Admin\.memory"  # or whatever launches it locally
# In a separate terminal: start the dashboard if not already up

# Navigate to http://127.0.0.1:4410/memory/ and verify:
# - Graph health is collapsed by default
# - Page fits in one scroll on a 1440px screen
# - Click any health summary chevron to expand the grid
# - Click each fixed route (settings, wiki, raw, activity) and verify acceptance items
```

---

## Commit boundaries

Suggested chunking (8 commits, one per task above):

- Task 1: `feat: collapsible graph health summary + responsive grid (Phase 4.3.K Task 1)`
- Task 2: `feat: /memory/health drill-down route (Phase 4.3.K Task 2)`
- Task 3: `fix: actionable + auto-healing sidebar status pill (Phase 4.3.K Task 3)`
- Task 4: `fix: settings page duplicate sections + missing inputs + h1 hierarchy (Phase 4.3.K Task 4)`
- Task 5: `feat: cursor pagination on raw/activity/sessions/audit (Phase 4.3.K Task 5)`
- Task 6: `feat: category grouping on wiki index (Phase 4.3.K Task 6)`
- Task 7: `fix: recent activity empty state (Phase 4.3.K Task 7)`
- Task 8: `docs: phase 4.3.K UX cleanup shipped (Phase 4.3.K Task 8)`

---

## Out-of-scope follow-ups

Tracked separately, do not bundle:

- Cost-tracking fix for gpt-4o-mini ($0.0000 — stale pricing table). Cosmetic
- Prose-quality improvements on auto-generated threads (the bullet content is still generic). Separate prompt-engineering work
- Inbox UI for Phase 4.3.J (auto-promote workflow) — distinct brief, may land before or after this one
- Audit-log rotation (`.audit/llm-*.md` grows forever)
- Per-user dashboard theming. Dark-only is fine
- Graph viz redesign (`/memory/graph`). Out of scope; the canvas-based visual is intentional and works
