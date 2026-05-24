# Phase 4 Slice 15 Stitch Audit

Audit scope:
- `src/dashboard-ui/components/CompilePage.tsx`
- `src/dashboard-ui/components/ConflictsPage.tsx`
- `src/dashboard-ui/components/MaintenancePage.tsx`

Reference Stitch files:
- `docs/design/iteration-2/compile_llm_curation_memory/code.html`
- `docs/design/iteration-2/conflict_resolution_memory/code.html`
- `docs/design/iteration-2/maintenance_dashboard_memory/code.html`

## Compile

Stitch renders:
- Focused full-screen compile canvas with no app header/sidebar chrome (`code.html:137-224`).
- Static source nodes plus a central new decision node (`code.html:150`, `code.html:167-168`).
- Compiler log with running state (`code.html:194-196`).
- Confidence metric and `Commit to Graph` CTA (`code.html:209-219`).

Current component renders:
- App-route header, read-only helper copy, and disabled `Run compile` CTAs (`CompilePage.tsx:177`, `CompilePage.tsx:156`, `CompilePage.tsx:191`).
- Source node preview and central digest status (`CompilePage.tsx:53`, `CompilePage.tsx:84-87`).
- Compiler log panel and pages-compiled metric (`CompilePage.tsx:116`, `CompilePage.tsx:140`).
- Empty-state card when no run is recorded (`CompilePage.tsx:235`).

Differences:
- We render read-only CLI helper copy and disabled run controls that Stitch does not show. Decision: defer. This follows Slice 15 read-only requirements and avoids backend writes.
- Stitch shows confidence and `Commit to Graph`; we omit both. Decision: defer. The backend state contract exposes compile status and last run fields, not confidence or commit actions.
- Visual hierarchy is close for the central graph and log panel, but Stitch has animated SVG connectors and a more focused canvas. Decision: defer. That is a larger visualization pass, not a one-property nudge.

Fix-now items:
- None.

## Conflicts

Stitch renders:
- Minimal HUD header with active count (`code.html:150-151`).
- Two side-by-side panels with highlighted contradiction snippets (`code.html:172`, `code.html:219`).
- Center reason card with `Merge (Draft New)`, `Deprecate Old`, and `Keep as Alternatives` actions (`code.html:188-203`).
- Background graph line showing the contradiction relationship (`code.html:138-145`).

Current component renders:
- Conflict header, active count, and read-only helper copy (`ConflictsPage.tsx:141-144`).
- Side-by-side conflict panels and center action card (`ConflictsPage.tsx:113-127`).
- Reason label and the Stitch action set, plus disabled `Keep A` and `Keep B` CTAs (`ConflictsPage.tsx:8`, `ConflictsPage.tsx:74-95`).
- No-conflicts empty state (`ConflictsPage.tsx:156`).

Differences:
- We render `Keep A` and `Keep B`; Stitch does not. Decision: defer. Slice 15 explicitly asks for disabled Keep A/B CTAs.
- Stitch includes a close icon and suppressed navigation HUD. Decision: defer. The SPA uses normal route chrome for dashboard consistency.
- Stitch includes a background contradiction graph. Decision: defer. This is a larger decorative visualization and not necessary for read-only conflict review.

Fix-now items:
- None.

## Maintenance

Stitch renders:
- Maintenance header with `Filter` and `Run Scan` controls (`code.html:245-255`).
- Metric cards for Orphaned Nodes, Low Confidence, and Stale > 6mo (`code.html:268-298`).
- Three dense table sections with section menus (`code.html:310-507`).
- Orphan and stale section icons represent node/state concepts (`code.html:313`, `code.html:463`).

Current component renders:
- Same header, filter, and run scan controls in disabled read-only mode (`MaintenancePage.tsx:212-225`).
- Metric cards and three section panels (`MaintenancePage.tsx:234-249`).
- Unified row layout with always-visible disabled row actions and disabled bulk actions (`MaintenancePage.tsx:96-142`).
- Section menu icon per section (`MaintenancePage.tsx:252`).

Differences:
- We render disabled bulk actions; Stitch only shows section menus and hover row actions. Decision: defer. Slice 15 calls for disabled bulk-action shells.
- We use live page path, updated date, and confidence columns for all buckets instead of Stitch's per-bucket mock columns. Decision: defer. The live loader returns one shared summary shape.
- Initial orphan and stale icons were action-oriented rather than Stitch-like entity/state icons. Decision: fix now.

Fix-now items:
- [x] `MaintenancePage.tsx:167` uses `Network` for Orphaned Nodes instead of the row-link action icon.
- [x] `MaintenancePage.tsx:197` uses `Clock` for Stale Knowledge instead of the archive action icon.
