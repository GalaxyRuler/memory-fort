# Phase 4 Slice 16 Mobile Audit

Viewport target: 390x844. SPA remains read-only.

## Mock Inventory

`docs/design/iteration-3/` currently contains these top-level exports:

- `knowledge_graph_constellation_export_fixed`
- `knowledge_graph_force_export_fixed`
- `knowledge_graph_memory_mobile_export_fixed`
- `knowledge_graph_orbital_export_fixed`
- `knowledge_graph_search_highlight_export_fixed`
- `knowledge_graph_timeline_flow_export_fixed`
- `memory_technical_os`
- `raw_observations_export_fixed`
- `timeline_export_fixed`
- `wiki_page_memory_mobile_export_fixed`

The slice text says 8 mobile mock files; the directory currently has 9 `screen.png` exports plus one design-token doc. I audited all 9 screenshot exports.

## Mock Comparison

- `knowledge_graph_memory_mobile_export_fixed`: deviation: Slice 16 intentionally replaces mobile WebGL with a grouped graph list fallback, so the graph canvas/detail-card mock is deferred to a future lightweight mobile graph.
- `wiki_page_memory_mobile_export_fixed`: matches: single-column article, compact top bar, bottom nav, wrapped title/body, and secondary page tools moved behind mobile sheet buttons.
- `raw_observations_export_fixed`: deviation: current `/raw` keeps the shipped chronological session-browser model instead of the mock's transcript preview/about layout; rows are stacked cards on mobile.
- `timeline_export_fixed`: matches: timeline remains a full-width data view with compact controls; deviation: current SVG scales to viewport instead of the mock's wide horizontal lane surface.
- `knowledge_graph_force_export_fixed`: matches desktop graph mode; mobile route intentionally shows the fallback list instead of loading the 3D canvas.
- `knowledge_graph_constellation_export_fixed`: matches desktop graph mode; mobile route intentionally shows the fallback list instead of loading the 3D canvas.
- `knowledge_graph_orbital_export_fixed`: matches desktop graph mode; mobile route intentionally shows the fallback list instead of loading the 3D canvas.
- `knowledge_graph_timeline_flow_export_fixed`: matches desktop graph mode; mobile route intentionally shows the fallback list instead of loading the 3D canvas and scrubber.
- `knowledge_graph_search_highlight_export_fixed`: matches desktop graph search/highlight behavior; mobile route intentionally shows the fallback list without graph search controls.

## Route Audit

- `/`: matches. Overview spacing collapses to 16px gutters, stat/activity cards wrap, and shell uses bottom nav below `md`.
- `/search`: matches. Filters stack above results; score breakdown moves behind a mobile bottom sheet.
- `/wiki`: matches. Category rail stacks above wiki cards and card text wraps.
- `/wiki/$category/$slug`: matches. Article is single-column; TOC and relations open in `BottomSheet`.
- `/raw`: matches. Filters stack and sessions render as stacked touch-friendly rows.
- `/raw/$date/$filename`: matches. Header metadata wraps and markdown is constrained to the viewport.
- `/graph`: deviation: mobile and touch-only devices receive the grouped list fallback instead of WebGL, per Slice 16 performance guidance.
- `/timeline`: matches. Header controls wrap and SVG chart scales inside the viewport.
- `/activity`: matches. Filters stack and event rows wrap without horizontal overflow.
- `/sessions`: matches. Tile grid collapses to one column and keeps 44px tap targets.
- `/crystals`: matches. Cards collapse to one column and empty state stays centered.
- `/audit`: matches. Log rows collapse to stacked cards instead of a table-like horizontal row.
- `/settings`: matches. Settings fields stack label/value pairs on small screens.
- `/compile`: matches. Controls and history cards stack with wrapped path text.
- `/conflicts`: matches. Conflict cards and action buttons stack without horizontal overflow.
- `/maintenance`: matches. Maintenance cards and log text wrap inside the viewport.

## Deferred

- Playwright screenshots are deferred to Slice 19 because `package.json` does not include Playwright.
- Mobile WebGL and mobile graph interaction parity are deferred. `react-force-graph-2d` is not installed, and Slice 16 explicitly forbids adding it.
