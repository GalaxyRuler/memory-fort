# Memory Dashboard Stitch Design Contract

**Source:** Google Stitch exports, May 24 2026.

This directory locks the Phase 4 visual contract for the full SPA dashboard. The exports are committed as source-of-truth design evidence, not runtime assets. Implementers should compare SPA screens against these PNGs and use the accompanying `code.html` files as layout references.

## Iterations

- `iteration-1/` — first full-screen contract pass, exported as `stitch_memory_dashboard (2).zip` (17 screens).
- `iteration-2/` — desktop refinement pass, exported as `stitch_memory_dashboard (1).zip` (16 screen outputs plus compact token notes).
- `iteration-3/` — final export-fix pass, exported as `stitch_memory_dashboard (3).zip` (9 screen directories plus design notes).

The unsuffixed `stitch_memory_dashboard.zip` archive was verified during pre-flight but not committed because the committed three-iteration contract uses the later matching exports above. The unsuffixed archive duplicates the desktop pass except for one star-chart PNG and lacks the compact token note.

## Design System

The dashboard uses a dark-only Material Design 3 base with a custom technical operating-system layer:

- Primary MD3 lavender: `#cebdff`
- Identity gradient: `#8b5fff` to `#5b8bff`
- Deep surfaces: `#14121b`, `#1d1a24`, `#211e28`
- Entity colors: projects blue, decisions purple, lessons amber, references cyan, tools emerald, people pink, crystals gold, raw/session zinc
- Typography: Inter for UI, JetBrains Mono for paths, telemetry, and raw content
- Effects: glass blur panels, subtle borders, emissive graph-node bloom

The canonical token source is `iteration-1/memory_technical_os/DESIGN.md`. `iteration-2/design_system_tokens_memory.md` is a compact extraction and should be treated as supporting reference.

## Screen Status

| Screen | Final reference | Status | Notes |
|---|---|---|---|
| Overview dashboard | `iteration-2/overview_memory/` | ship-ready | Desktop overview shell and stat cards. |
| Search results | `iteration-2/search_memory/` | ship-ready | Dedicated search page with ranking metadata. |
| Wiki browse | `iteration-2/wiki_memory/` | ship-ready | Desktop wiki index and category browsing. |
| Wiki page detail | `iteration-2/decision_voyage_ai_for_embeddings_memory/` | ship-ready | Representative page-detail contract. |
| Raw observations | `iteration-3/raw_observations_export_fixed/` | ship-ready | Export-fixed version supersedes earlier raw screen. |
| Activity feed | `iteration-2/activity_feed_memory/` | ship-ready | Timeline-adjacent activity stream. |
| Timeline | `iteration-3/timeline_export_fixed/` | minor-gap | Ship layout; implementation should add haze recession. |
| Sessions | `iteration-2/sessions_memory/` | ship-ready | Session tiles and curation state. |
| Crystals | `iteration-2/crystals_memory/` | ship-ready | Digest/crystal browse surface. |
| Audit log | `iteration-2/audit_log_memory/` | ship-ready | Unified operational log stream. |
| Settings | `iteration-2/settings_memory/` | ship-ready | Dark settings form contract. |
| Compile / curation | `iteration-2/compile_llm_curation_memory/` | ship-ready | Compile flow can be read-only initially. |
| Conflict resolution | `iteration-2/conflict_resolution_memory/` | ship-ready | Side-by-side resolution workflow. |
| Maintenance dashboard | `iteration-2/maintenance_dashboard_memory/` | ship-ready | Orphan/stale/low-confidence maintenance view. |
| Knowledge graph overview | `iteration-2/knowledge_graph_personal_star_chart_memory/` | ship-ready | Cinematic graph identity reference. |
| Knowledge graph utility | `iteration-2/knowledge_graph_utility_memory/` | ship-ready | Utility/dashboard graph controls. |
| Graph FORCE mode | `iteration-3/knowledge_graph_force_export_fixed/` | ship-ready | Export-fixed force layout. |
| Graph CLUSTERED mode | `iteration-1/knowledge_graph_clustered_memory/` | ship-ready | Clustered layout reference. |
| Graph CONSTELLATION mode | `iteration-3/knowledge_graph_constellation_export_fixed/` | ship-ready | Export-fixed constellation layout. |
| Graph ORBITAL mode | `iteration-3/knowledge_graph_orbital_export_fixed/` | minor-gap | Empty rings should be softened during implementation. |
| Graph TIMELINE-FLOW mode | `iteration-3/knowledge_graph_timeline_flow_export_fixed/` | minor-gap | Add haze recession and lane labels in implementation. |
| Graph hover state | `iteration-1/knowledge_graph_hover_memory/` | ship-ready | Tooltip/detail interaction reference. |
| Graph search highlight | `iteration-3/knowledge_graph_search_highlight_export_fixed/` | minor-gap | Highlight background should be made visible. |
| Mobile overview | `iteration-1/overview_memory_mobile/` | ship-ready | 390x844 portrait contract. |
| Mobile wiki browse | `iteration-1/wiki_browse_memory_mobile/` | ship-ready | Bottom-nav mobile browse contract. |
| Mobile wiki page | `iteration-3/wiki_page_memory_mobile_export_fixed/` | ship-ready | Export-fixed page detail. |
| Mobile graph | `iteration-3/knowledge_graph_memory_mobile_export_fixed/` | ship-ready | Graph mobile contract. |
| Mobile search | `iteration-1/search_memory_mobile/` | ship-ready | Mobile search contract. |
| Mobile raw sessions | `iteration-1/raw_sessions_memory_mobile/` | ship-ready | Mobile raw/session list. |
| Mobile activity feed | `iteration-1/activity_feed_memory_mobile/` | ship-ready | Mobile activity stream. |
| Mobile settings | `iteration-1/settings_memory_mobile/` | ship-ready | Mobile settings contract. |

## Minor Cosmetic Gaps

These four gaps are accepted in the design contract and should resolve inline during implementation:

- Orbital graph empty rings need softer treatment.
- Timeline-flow lacks strong haze recession.
- Search-highlight background is too subtle in the export.
- Timeline lane labels need final clarity.

## Implementation Plan

The Phase 4 implementation plan is `../superpowers/plans/2026-05-24-phase-4-spa-dashboard-plan.md`.
