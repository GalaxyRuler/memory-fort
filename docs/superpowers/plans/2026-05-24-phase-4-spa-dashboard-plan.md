# Phase 4 SPA Dashboard — Implementation Plan

**Spec reference:** Stitch designs committed under `docs/design/`.
**Phase 3 tag:** `v0.3.0-phase3` (commit `12cbc1d`).
**Date:** 2026-05-24.
**Scope:** Replace the current server-rendered HTML dashboard at `/memory/` with a full SPA built against the locked Stitch designs. The SPA consumes the same Phase 3 backend JSON APIs, adds narrow read endpoints where the designs need richer data, preserves Tailscale-only access, and becomes the user's daily-driver UI for memory browse, search, graph exploration, and operational health.

This phase starts after Phase 3 proved the backend, sync, dashboard service, MCP search, CLI search, and Voyage fallback paths. Phase 4 is deliberately frontend-heavy: keep backend changes additive and small, keep the vault read-only from the SPA unless a slice explicitly scopes a write path, and compare every screen against the Stitch contract.

---

## Goals

- Every screen in the Stitch design contract is buildable and reachable from the SPA.
- Cinematic graph view works end-to-end with real `/api/wiki` data via `react-force-graph-3d`.
- Existing Phase 3 backend endpoints are consumed: `/api/status`, `/api/wiki`, `/api/raw`, `/api/log`, `/api/search`.
- New endpoints are added only where needed: `/api/page/:path`, `/api/timeline`, `/api/activity`, `/api/graph`, `/api/sync-state`.
- Mobile responsive layouts work at 390x844 portrait.
- Dark mode only.
- Material Design 3 lavender and the purple-to-blue gradient identity coexist per the Stitch design system.
- Global command palette is available through `Cmd/Ctrl+K`.
- Keyboard navigation works throughout: `J`, `K`, `Enter`, `Esc`, `/`, and `Cmd/Ctrl+K`.
- Existing Phase 1, Phase 2, and Phase 3 tests keep passing.
- The SPA has its own focused test suite.
- The SPA deploys through the existing VPS dashboard service.
- No external CDN calls are required at runtime.
- The graph view remains useful on mid-range hardware through progressive degradation.

## Acceptance Criteria

- Opening `https://srv1317946.tail6916d8.ts.net/memory/` loads the SPA, not the current server-rendered pages.
- Every navigation route in the sidebar reaches a functional screen.
- Graph view renders with bloom, glass-blur HUDs, and real corpus data.
- `/api/search` returns results with score breakdowns rendered as horizontal bars per the Stitch design.
- Compile, conflict resolution, and maintenance flows are usable, with read-only mode acceptable when write backends are not yet ready.
- The primary 26-screen visual contract matches Stitch within reasonable tolerance for fonts, spacing, colors, and layout structure.
- All 8 mobile layouts render correctly at 390x844 portrait.
- No regression in existing Phase 1, Phase 2, and Phase 3 tests.
- SPA tests cover component rendering and key user flows.
- The build emits `dist/dashboard-ui/` independently from Node server bundles.
- The dashboard service serves SPA assets and `/api/*` routes from the same Tailscale-only origin.
- Deep links refresh correctly through HTML5 history fallback.
- Empty, loading, degraded, and error states are visible and styled.
- Reduce-motion preferences disable nonessential graph and panel animations.
- The command palette can search, navigate, and preview results without losing keyboard focus.

## Out of Scope

- Light mode.
- Auth screens.
- Public internet access.
- Multi-user or sharing features.
- Inline wiki editing.
- Replacing filesystem and git-based editing workflows.
- Real-time updates beyond initial load.
- WebSocket push or polling loops for Phase 4.
- F21 search-quality threshold configurability.
- Onboarding wizards or first-run experiences.
- Team administration.
- Vector database changes.
- Changing Voyage model choices.
- Replacing the Phase 3 `/api/search` backend.

## Architecture

### Frontend Stack

- React 19 with TypeScript.
- Vite for development and UI bundle build.
- Tailwind CSS with config matching Stitch tokens exactly.
- TanStack Router for type-safe SPA routing.
- TanStack Query for API fetching, caching, and loading states.
- `react-force-graph-3d` for the cinematic graph.
- `three.js` plus scoped post-processing for bloom.
- Lucide React for line icons.
- `cmdk` for the command palette.
- Inter and JetBrains Mono self-hosted from the built UI bundle.

### Build Output

The UI build emits `dist/dashboard-ui/`.

This directory is separate from:

- `dist/dashboard/server.mjs`
- `dist/retrieval/*.mjs`
- `dist/hooks/*.mjs`
- `dist/cli.mjs`

The Vite build must not disturb the existing tsdown build unless a slice explicitly wires a root `npm run build` to run both pipelines.

### Deployment

Extend the Phase 3 `memory-dashboard.service` deployment path so the Node dashboard server serves static assets from `dist/dashboard-ui/` at `/memory/`.

The existing JSON backend keeps serving `/api/*`.

The current server-rendered HTML routes are replaced by the SPA history fallback:

- `/memory/`
- `/memory/wiki/`
- `/memory/wiki/projects/memory-system`
- `/memory/raw/`
- `/memory/log`
- `/memory/search`
- `/memory/graph`

Unknown SPA paths should return the SPA shell; unknown API paths should keep returning JSON or HTML 404 as appropriate for API vs non-API.

### Backend Additions Needed

- `GET /api/page/:path`
- `GET /api/timeline?from=&to=&zoom=`
- `GET /api/activity?cursor=&limit=`
- `GET /api/graph?scope=&hops=`
- `GET /api/sync-state`
- `GET /api/config`
- Optional later: `POST /api/compile`
- Optional later: `GET /api/conflicts`
- Optional later: `GET /api/maintenance`

### Data Ownership

The SPA reads the synced VPS vault through the dashboard API.

The SPA does not write wiki files in Phase 4.

Operational write actions can be represented as disabled, read-only, or "requires CLI" affordances until a slice explicitly adds a safe backend action.

### Stack Rationale: React + Vite

React and Vite are chosen because Stitch exports React-compatible Tailwind HTML. This avoids a translation step and lets implementation focus on data integration, routing, keyboard behavior, and visual fidelity.

### Stack Rationale: TanStack Router and Query

TanStack Router gives typed route params for wiki paths, raw session paths, graph modes, and search query state. TanStack Query centralizes loading, caching, refetching, stale data, retry behavior, and degraded API responses.

### Stack Rationale: react-force-graph-3d

`react-force-graph-3d` ships physics, camera controls, node rendering, link particles, and interaction hooks. Vanilla three.js would be more flexible but would roughly double graph implementation effort. Sigma and Cytoscape are better for 2D analytical graphs than the cinematic 3D contract Stitch produced.

## File Structure

Create the frontend under:

- `src/dashboard-ui/main.tsx`
- `src/dashboard-ui/app.tsx`
- `src/dashboard-ui/routes/`
- `src/dashboard-ui/components/`
- `src/dashboard-ui/features/`
- `src/dashboard-ui/lib/api.ts`
- `src/dashboard-ui/lib/query.ts`
- `src/dashboard-ui/lib/keyboard.ts`
- `src/dashboard-ui/styles.css`
- `src/dashboard-ui/test/`

Keep dashboard server changes in:

- `src/dashboard/server.ts`
- `src/dashboard/loaders.ts`
- `src/dashboard/render.ts` only if legacy rendering needs a compatibility fallback

Keep deployment changes in:

- `templates/scripts/dashboard.mjs`
- `templates/systemd/memory-dashboard.service`
- `src/cli/commands/install-vps.ts`

Keep design references in:

- `docs/design/`
- `docs/design/README.md`

## Design Contract Rules

- Use `docs/design/iteration-1/memory_technical_os/DESIGN.md` as the canonical token source.
- Use `docs/design/iteration-2/design_system_tokens_memory.md` as the compact reference.
- Use export-fixed screens in `iteration-3/` whenever an original and fixed version both exist.
- Do not invent a new UI pattern when Stitch already produced a screen.
- If implementation must diverge, include a side-by-side note in the slice report.
- Dark mode only.
- No decorative orbs outside the graph design language.
- Cards have 8px radius unless the design uses a larger modal or overlay radius.
- Text must fit at desktop and 390x844 mobile.
- Icons come from Lucide unless Stitch clearly implies a custom graph glyph.

## Step-by-Step Slices

### Slice 0 — Claude Desktop MCP Install

- Goal: add `memory install claude-desktop` command that writes the memory MCP entry into Claude Desktop's config (`~/AppData/Roaming/Claude/claude_desktop_config.json` on Windows; equivalent paths on macOS/Linux).
- Mirror only the MCP-config merge behavior from Antigravity. Do not mirror Antigravity's live-hook plugin behavior; Claude Desktop remains MCP-only.
- Preserve any existing `mcpServers` entries.
- Files: `src/cli/commands/install/claude-desktop.ts`.
- Files: `src/storage/paths.ts` to add helper if missing.
- Files: `src/cli/commands/install.ts` to wire the new platform.
- Files: `test/cli/commands/install-claude-desktop.test.ts`.
- Files: `docs/install-claude-desktop.md`.
- Acceptance: command writes correct MCP config to the resolved path.
- Acceptance: command preserves other `mcpServers` entries.
- Acceptance: command is idempotent.
- Tests use `MEMORY_CLAUDE_DESKTOP_DIR` env override, mirroring `MEMORY_CLAUDE_DIR` and `MEMORY_ANTIGRAVITY_DIR`.
- Add exactly 4 tests.
- Closes the gap that all four user surfaces now have memory integration: Claude Code, Codex desktop/CLI, Antigravity desktop, and Claude Desktop.

### Slice 2.5 — Backend JSON Adapter Endpoints (Frontload)

- Goal: ship all six new JSON adapter endpoints in one focused slice before any SPA frontend slice needs them.
- Resolve the cross-slice backend dependency identified in the Phase 4 plan grill round.
- Frontend slices 3, 6, 8, and 10 previously referenced backend endpoints scheduled for later slices.
- All endpoints are read-only.
- Add `GET /api/page/:relpath`.
- `/api/page/:relpath` is the JSON variant of the existing HTML page-detail route and reuses `loadPageDetail` from `src/dashboard/loaders.ts`.
- Add `GET /api/activity?cursor=&limit=`.
- `/api/activity` returns a structured event stream merging git log, sync log, and compile log, similar to existing `/api/log` but typed.
- Add `GET /api/timeline?from=&to=&zoom=`.
- `/api/timeline` returns lane-bucketed events from the same source as `/api/activity`.
- Add `GET /api/graph?scope=&hops=`.
- `/api/graph` wraps `buildGraph` and `expandGraph` from `src/retrieval/graph.ts` and returns nodes plus edges.
- Add `GET /api/sync-state`.
- `/api/sync-state` reads `~/.memory/.sync-state.json` or the VPS-side equivalent and returns JSON.
- Add `GET /api/config`.
- `/api/config` parses the user's `~/.memory/config.yaml` and returns JSON with `voyage.api_key` redacted.
- Files: `src/dashboard/server.ts` for new routes.
- Files: `src/dashboard/loaders.ts` for new loaders if needed.
- Files: `test/dashboard/server.test.ts` for endpoint coverage.
- Acceptance: exactly 10 tests.
- Acceptance: about 1 happy-path and 1 error-path test per endpoint, plus a redaction test for `/api/config`.
- Acceptance: all endpoints return valid JSON.
- Acceptance: existing dashboard routes remain unchanged.
- Slice 11 becomes redundant after Slice 2.5 ships; keep Slice 11 only for graph-specific enhancements if needed.

### Slice 1 — SPA Scaffold + Design System Tokens

- Install React 19, Vite, TypeScript, Tailwind CSS, TanStack Router, TanStack Query, Lucide React, `cmdk`, `three`, and `react-force-graph-3d`.
- Add `src/dashboard-ui/` entrypoint.
- Add `vite.dashboard.config.ts`.
- Add `tailwind.dashboard.config.ts`.
- Match Stitch tokens from `docs/design/iteration-1/memory_technical_os/DESIGN.md`.
- Add entity colors and graph bloom colors.
- Add self-hosted Inter and JetBrains Mono assets.
- Build base components: `GlassPanel`, `EntityIcon`, `StatusPill`, `Card`, `Button`, `Input`.
- Add `npm run dev:ui`.
- Add `npm run build:ui`.
- Emit `dist/dashboard-ui/`.
- Add 8-10 component tests.
- Commit after focused UI build and tests pass.

### Slice 2 — App Shell + Routing

- Build persistent sidebar with 11 nav items.
- Add sync-state indicator at the bottom of the sidebar.
- Add top bar with breadcrumb and command-palette trigger.
- Add route tree for the 13 primary screens.
- Add active route highlighting with purple-to-blue border-left treatment.
- Add mobile bottom nav with 5 icons below 768px.
- Add route-level error boundary.
- Add route-level loading shell.
- Tests cover route matching.
- Tests cover active navigation state.
- Tests cover mobile bottom-nav visibility.
- Commit after focused route tests pass.

### Slice 3 — Overview Screen

- Implement `/` overview route.
- Fetch `/api/status`.
- Fetch `/api/activity?limit=20`.
- Render 3-column desktop layout.
- Render stat cards with sparklines.
- Render "Needs Attention" rail.
- Render recent activity list.
- Add degraded API warning strip.
- Add mobile stacking behavior.
- Add 6 tests.
- Verify against `docs/design/iteration-2/overview_memory/screen.png`.
- Commit after focused tests pass.

### Slice 4 — Command Palette + Global Search Shortcut

- Add `cmdk` modal.
- Bind `Cmd/Ctrl+K` globally.
- Bind `/` to focus search when no text input is active.
- Connect palette query to `/api/search` with debounce.
- Add scope filter pills.
- Add result previews.
- Add keyboard navigation with arrow keys, `Enter`, and `Esc`.
- Add telemetry footer showing candidates, backend signals, and timing.
- Add 8 tests.
- Verify focus trapping and escape behavior.
- Commit after focused tests pass.

### Slice 5 — Dedicated Search Page

- Implement `/search`.
- Reuse search API client from palette.
- Add query string state for `q`, `scope`, `k`, `minScore`, and `noRerank`.
- Add entity-type facets.
- Add date range filter shell.
- Add status filter shell.
- Render result cards.
- Render score breakdown bars from `sources`.
- Render warning/degraded states.
- Add 5 tests.
- Verify against `docs/design/iteration-2/search_memory/screen.png`.
- Commit after focused tests pass.

### Slice 6 — Wiki Browse + Page Detail

- Implement `/wiki/`.
- Implement `/wiki/:category/:slug`.
- Add backend `GET /api/page/:path`.
- Return JSON shape matching `PageDetail` from `src/dashboard/loaders.ts`.
- Render category cards.
- Add sort and filter controls.
- Render page detail.
- Render right rail with TOC and related pages.
- Resolve wikilinks in body content.
- Preserve safe HTML escaping.
- Add 10 tests across server and UI.
- Verify against wiki browse and page-detail Stitch screens.
- Commit after tests pass.

### Slice 7 — Raw Browse + Session Detail

- Implement `/raw/`.
- Implement `/raw/:date/:filename`.
- Consume existing `/api/raw`.
- Consume existing raw-session endpoint.
- Render session transcript list.
- Add tool filter.
- Add date-range filter.
- Add has-curation filter.
- Add "Derived" indicator linking to wiki pages where available.
- Render raw body safely.
- Add 6 tests.
- Verify against raw desktop and mobile screens.
- Commit after focused tests pass.

### Slice 8 — Activity Feed + Timeline

- Implement `/activity`.
- Implement `/timeline`.
- Add backend `GET /api/activity?cursor=&limit=`.
- Add backend `GET /api/timeline?from=&to=&zoom=`.
- Normalize events from raw commits, wiki commits, sync events, and search/compile events when available.
- Render reverse-chronological feed.
- Render lane-based timeline chart.
- Add event velocity overlay.
- Add filters for source and event type.
- Add timeline zoom controls.
- Add 8 tests.
- Verify timeline haze and lane labels against known minor gaps.
- Commit after tests pass.

### Slice 9 — Sessions + Crystals + Audit

- Implement `/sessions`.
- Implement `/crystals`.
- Implement `/audit`.
- Render session tile grid.
- Add curation filter.
- Render crystal digest list.
- Render crystal detail view.
- Add rotating icosahedron icon treatment for crystals.
- Render audit stream with source and level filters.
- Reuse raw/log APIs where possible.
- Add 6 tests.
- Commit after focused tests pass.

### Slice 10 — Settings

- Implement `/settings`.
- Add backend `GET /api/config`.
- Read `~/.memory/config.yaml` through existing config reader.
- Render sectioned form.
- Add sticky save bar in disabled/read-only state unless write endpoint is scoped.
- Show current VPS host, search settings, and sync status.
- Add local validation display.
- Add mobile settings layout.
- Add 5 tests.
- Verify against desktop and mobile settings screens.
- Commit after tests pass.

### Slice 11 — Graph Backend Endpoint

- Status: absorbed into Slice 2.5 once the backend JSON adapters ship.
- Repurpose this slice for graph-specific enhancements such as scope filtering, hops tuning, payload shaping, or performance diagnostics if Slice 2.5 leaves any graph work behind.
- Add `GET /api/graph?scope=&hops=`.
- Reuse `loadSearchCorpus`.
- Reuse `buildGraph`.
- Reuse `expandGraph` where requested.
- Return nodes with kind, title, status, confidence, tags, and updated.
- Return edges with kind and relation type.
- Include unresolved target counts for diagnostics.
- Add server-side path and query validation.
- Add 4 tests.
- Confirm existing dashboard routes still pass.
- Commit after focused server tests pass.

### Slice 12 — Graph View: FORCE, CLUSTERED, CONSTELLATION

- Implement `/graph`.
- Add `react-force-graph-3d` scene.
- Add scoped three.js bloom post-processing.
- Render emissive nodes by entity type.
- Render deep-space gradient background.
- Render starfield and subtle hex grid floor.
- Add glass-blur HUDs.
- Add top-left mode selector and filters.
- Add bottom-center telemetry.
- Add right-side detail panel.
- Add particle flow along edges.
- Implement FORCE mode.
- Implement CLUSTERED mode.
- Implement CONSTELLATION mode.
- Add click node, hover tooltip, and camera controls.
- Add 8 tests with three.js mocked where necessary.
- Commit after focused tests pass.

### Slice 13 — Graph View: ORBITAL + TIMELINE-FLOW + Transitions

- Implement ORBITAL mode with concentric rings around focal node.
- Soften empty orbital rings during implementation.
- Implement TIMELINE-FLOW mode with Z-axis time depth.
- Add haze recession missing from the Stitch export.
- Add lane labels for timeline flow.
- Add timeline scrubber.
- Add 1.5s ease-in-out mode transitions.
- Preserve reduced-motion behavior.
- Add 6 tests.
- Verify against export-fixed graph screens.
- Commit after focused tests pass.

### Slice 14 — Graph Search Highlight + Path Tracing

- Add graph search input in HUD.
- Highlight matching nodes.
- Fade non-matches to 15%.
- Make search-highlight background visible.
- Add right-click context menu.
- Add "Trace path to..." workflow shell.
- Compute path on the client for loaded graph.
- Render traced path with animated edge particles.
- Add 4 tests.
- Commit after focused tests pass.

### Slice 15 — Compile, Conflict Resolution, Maintenance Bonus Screens

- Implement `/compile`.
- Implement `/conflicts`.
- Implement `/maintenance`.
- Add read-only compile progress view first.
- Add backend compile trigger only if safe and scoped.
- Add conflict listing endpoint if conflict state exists.
- Add maintenance scan endpoint for orphan, low-confidence, and stale pages.
- Render side-by-side conflict panels.
- Render maintenance bulk-action shells in disabled mode if writes are deferred.
- Add 8 tests.
- Verify against Stitch bonus screens.
- Commit after tests pass.

### Slice 16 — Mobile Responsive Pass

- Audit every route at 390x844.
- Add bottom nav below 768px.
- Convert right rails into bottom sheets.
- Ensure graph degrades to 2D or simplified canvas on mobile.
- Verify all 8 mobile layouts from `iteration-3/`.
- Add mobile-specific tests.
- Add Playwright screenshots if the repo has browser test infrastructure by then.
- Fix text wrapping and overflow.
- Commit after mobile verification passes.

### Slice 17 — Polish: Keyboard Nav + A11y + States

- Add `J` and `K` navigation in lists.
- Add `Esc` dismiss behavior for modals, drawers, sheets, and graph panels.
- Add `Enter` activation for focused cards.
- Add shimmer skeletons.
- Add empty states.
- Add reduced-motion animation gates.
- Add ARIA labels for icon buttons.
- Add focus-visible styles.
- Add 6 tests.
- Run focused accessibility checks where tooling exists.
- Commit after tests pass.

### Slice 18 — VPS Deployment Integration

- Update `templates/scripts/dashboard.mjs` to serve SPA static assets.
- Update dashboard server static file handling.
- Preserve `/api/*` routes.
- Add history fallback for non-API paths.
- Update `templates/systemd/memory-dashboard.service` only if needed.
- Update `src/cli/commands/install-vps.ts` to upload `dist/dashboard-ui/`.
- Add 4 tests.
- Run `npm run build:ui`.
- Run `npm run build`.
- Deploy to VPS.
- Smoke `/memory/`, `/memory/search`, `/memory/graph`, and `/memory/api/status`.
- Commit after verification passes.

### Slice 19 — CHECKPOINT

- Dogfood every primary screen against the real corpus.
- Capture desktop screenshots.
- Capture mobile screenshots at 390x844.
- Measure overview load latency.
- Measure search latency.
- Measure graph load latency.
- Measure bundle size.
- Confirm CLI and MCP search still work.
- Confirm Tailscale-only access.
- Write checkpoint memo at `docs/superpowers/notes/2026-05-XX-phase-4-checkpoint.md`.
- Commit memo only.

### Slice 20 — Tag `v0.4.0-phase4`

- Confirm source tree clean.
- Confirm all tests pass.
- Confirm `npm run build` and `npm run build:ui` pass.
- Confirm VPS dashboard serves the SPA.
- Confirm Phase 4 checkpoint memo exists.
- Create annotated tag `v0.4.0-phase4`.
- Do not push unless explicitly requested.

## Boundaries

- No external CDN dependencies.
- No light mode.
- Tailwind-only styling.
- No styled-components.
- No Emotion.
- No vanilla CSS modules unless Vite requires a root stylesheet for Tailwind.
- Three.js usage stays isolated to graph view.
- No global 3D state.
- Backend endpoint changes are minimal and additive.
- Extend existing loaders rather than refactoring the dashboard backend broadly.
- Existing Phase 1, Phase 2, and Phase 3 tests must continue passing throughout.
- One commit per slice unless verification surfaces a bug requiring a follow-up commit.
- New dependencies must be justified in the slice report.
- Secrets stay on the VPS.
- No Voyage credentials in the SPA.
- No public dashboard exposure.

## Risks

- React 19 and Tailwind integration may require a separate Vite pipeline alongside tsdown.
- Vite output must coexist with current Node service packaging.
- `react-force-graph-3d` may pin a three.js version that conflicts with custom shader examples.
- Three.js mocks can make tests brittle if implementation couples too tightly to runtime objects.
- Self-hosted fonts add about 200 KB to the SPA bundle.
- Cinematic graph performance may degrade on mid-range hardware.
- Mobile graph interaction may need a 2D fallback to remain usable.
- Backend activity and timeline models may reveal missing event metadata.
- Existing dashboard loaders may need small JSON-shape additions.
- HTML5 history fallback must not swallow `/api/*` 404s.
- Keyboard shortcuts can conflict with browser defaults if not scoped carefully.

## Resolved Before Slice 1

- Tech stack: React, Vite, Tailwind, TanStack Router, TanStack Query, `react-force-graph-3d`.
- Color system: MD3 lavender `#cebdff` for primary controls.
- Identity gradient: `#8b5fff` to `#5b8bff`.
- Mobile breakpoint: 768px.
- Mobile target viewport: 390x844 portrait.
- All 8 mobile layouts produced.
- Design contract committed under `docs/design/`.
- Four cosmetic gaps accepted for inline implementation correction.
- Phase 3 backend is tagged at `v0.3.0-phase3`.
- `/api/search` is the shared CLI, MCP, and dashboard search backend.
- Slice 0 added: Claude Desktop MCP install command closes the fourth user surface gap and mirrors the Antigravity pattern.
- Slice 2.5 added: backend JSON adapter endpoints are frontloaded, resolving the cross-slice backend dependency surfaced in the grill round and removing Slice 11 redundancy.

## Notes for Implementers

Phase 3 retrospective lessons apply.

Use explicit numbered test cases.

Keep format-template fidelity high.

Report deviations honestly.

Do not invent UI patterns beyond what Stitch produced.

If a screen is not in `docs/design/`, ask before designing it.

Implementation reports should include side-by-side comparisons when visuals diverge.

Use export-fixed screens over earlier exports when both exist.

Treat graph polish as product behavior, not decoration.

Keep operational surfaces quiet and dense.

Prefer readable, repeated local components over premature abstraction.

Each slice should leave the app runnable.

Each slice should leave the VPS deploy path no worse than it started.

Each slice should document any backend shape changes.

Keep search and graph failures graceful.

Preserve Phase 3's fallback behavior when Voyage is unavailable.

Do not allow UI work to weaken Tailscale-only access.

## Verification Expectations

- Focused test command first.
- Broader test command when the slice touches shared code.
- `npm run build:ui` after UI changes.
- `npm run build` after server, CLI, install, or shared TypeScript changes.
- Browser screenshot verification for major screens.
- Mobile viewport screenshot verification for mobile slices.
- VPS smoke for deployment slices.
- No completion claim without fresh command output.
