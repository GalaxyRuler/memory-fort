# Codex Implementation Brief — Port the Galactic Graph into Memory Fort

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Replace the existing 3D force-directed graph at the dashboard's `/graph` route with the **galactic visualization** prototyped at `docs/galactic-graph-prototype.html`. That prototype is the canonical visual + interaction spec — load it locally to see what we're shipping (`python -m http.server 8765` from `docs/`, then `http://localhost:8765/galactic-graph-prototype.html`).

The galactic view replaces — does not coexist with — the current `GraphCanvas.tsx` / `GraphPage.tsx`. The legacy 3D force-graph and its `react-force-graph-3d` dependency go away.

## Why

The current 3D force-directed graph is generic, hard to read, and doesn't reflect Memory Fort's data taxonomy. The galactic view encodes the **two-axis taxonomy** (cognitive type × domain category) directly into spatial structure and visual identity, and turns physics into data — heavier nodes (more inbound) get pulled toward galactic anchors, confidence drives glow, edge weight drives gravitational lensing intensity. The user has approved the prototype design and asked for it to be the real graph.

---

## Scope guard

You will:
- Add a `cognitive_type` field to page frontmatter (inferred where missing) and surface it through `/api/graph`
- Build a new `GalacticCanvas` React component using 2D canvas (no Three.js)
- Build a new `GalacticHUD` overlay (legend, zoom indicator, inspector, help)
- Build a new `MemoryModal` for viewing raw memory bodies
- Replace `/graph` route with the new component
- Remove the legacy 3D code (`GraphCanvas.tsx`, `react-force-graph-3d` dep)
- Port the prototype's physics, planet shapes, and interactions faithfully

You will **not**:
- Touch the dashboard layout shell, sidebar, top bar, or any other route
- Modify the existing Memory Fort palette / glass / bracket utilities (use them)
- Change the search pipeline, conflict detection, or pruning code from prior session
- Introduce new dependencies beyond what's already in `package.json` (remove `react-force-graph-3d` and `three`)
- Add commit hooks, deploy scripts, or auth flows

If the prototype demands something not covered here, **stop and ask**.

---

## Prerequisites verified at start of brief

These exist in the current codebase (confirm before starting):

- `src/dashboard-ui/components/GraphCanvas.tsx` — current 3D implementation (deleted)
- `src/dashboard-ui/components/GraphPage.tsx` — current `/graph` route component (rewritten)
- `src/dashboard-ui/routes/graph.tsx` — file-based route (kept; component swap)
- `src/dashboard-ui/hooks/useGraph.ts` — returns `{ nodes, edges, unresolvedTargets }` from `/api/graph?scope=wiki`
- `src/dashboard/loaders.ts` — backend graph response builder
- `src/retrieval/corpus.ts` — `SearchDocument` type (extended for `cognitive_type`)
- `docs/galactic-graph-prototype.html` — the canonical visual spec

---

## Task 1 — Cognitive type as a first-class field

### Why
The galactic view groups pages into four galaxies by **cognitive type** (`core | semantic | episodic | procedural`). The current data model has only domain category. Add cognitive type as either explicit frontmatter or inferred at corpus-load time.

### Contract

- **Frontmatter key**: `cognitive_type`, optional. Values: `core | semantic | episodic | procedural`.
- **Inference fallback** when missing (apply during corpus load in `src/retrieval/corpus.ts`):
  - Source `crystal` OR category `crystals` → `semantic`
  - Source `claude-code | codex | antigravity` AND located under `wiki/raw/` → `episodic`
  - Category `tools` OR `lessons` → `procedural`
  - Category `projects` AND `status === "active"` AND `inboundCount >= 5` → `core`
  - Category `decisions` AND `status === "active"` AND `created` within last 14 days → `episodic`
  - Default → `semantic`
- **API exposure**: `GraphNode` returned from `/api/graph` gains a `cognitiveType` field.
- **No breaking changes** to existing search, conflicts, or maintenance code — `cognitive_type` is additive metadata.

### Files

- `src/retrieval/corpus.ts` — extend `SearchDocument` with `cognitiveType: 'core'|'semantic'|'episodic'|'procedural'`. Add `inferCognitiveType()` helper. Set during page ingest.
- `src/dashboard/loaders.ts` — include `cognitiveType` in `GraphNode` response shape.
- `src/dashboard-ui/hooks/useGraph.ts` — type extension only.
- New: `test/retrieval/cognitive-type-inference.test.ts` — covers each branch of the inference fallback plus one explicit-frontmatter case.

---

## Task 2 — `GalacticCanvas` component

### Why
Renders the galactic visualization. Owns the animation loop, camera, and all per-frame drawing.

### Contract

The canvas is a single React component that:
- Takes `nodes: GraphNode[]`, `edges: GraphEdge[]`, plus interaction callbacks
- Renders the cosmos via `requestAnimationFrame` on a `<canvas>` element
- Handles mouse: pan (drag), zoom (wheel toward cursor), select (click), hover (cursor → tooltip)
- Maintains internal state: camera (camX, camY, scale), hover/select id, animation time
- Lifts events: `onSelectNode(id)`, `onHoverNode(id|null)`

### Visual mechanics — read directly from `docs/galactic-graph-prototype.html`

The prototype is the spec. Port everything from the `<script>` block of that file, with these substitutions:

- Replace mock `memories` array with `props.nodes`. The 4-cognitive-galaxy layout, 6-domain-system clustering, planet placement, and physics formulas (mass-driven pull-to-galactic-core, confidence-driven glow, edge weight from min(endpoints' inbound) / 14, etc.) are unchanged.
- The five domain renderers (`drawDecisionPlanet`, `drawLessonPlanet`, `drawProjectPlanet`, `drawReferencePlanet`, `drawToolPlanet`, `drawCrystalPlanet`) port verbatim.
- The galactic core, accretion swarm, lensed edges with particle flow, system backdrops, and labels all port verbatim.
- The three zoom levels (galactic / solar / planetary) derived from scale work as in the prototype.

Animation speeds (already slowed in the prototype):
- Galaxy spins: `core 0.00015, semantic 0.0003, procedural 0.0005, episodic 0.00075`
- Planet local: `0.00035 + random() * 0.00060`
- Sand swarm: half its previous rate
- Edge particle flow: `0.00018 + weight * 0.00035`

### Files

- New: `src/dashboard-ui/components/GalacticCanvas.tsx` (target ~600–800 lines)
- New: `src/dashboard-ui/lib/galactic/layout.ts` — galaxy/system position math, mass/orbit calculations (pure functions, testable)
- New: `src/dashboard-ui/lib/galactic/planets.ts` — the six `draw*Planet` renderers (pure canvas-drawing functions)
- New: `src/dashboard-ui/lib/galactic/physics.ts` — `edgeLensing()`, `confidenceGlow()`, `massPull()` helpers
- New: `test/dashboard-ui/lib/galactic/layout.test.ts` — galaxy positions, system clustering, mass-based orbital radius
- New: `test/dashboard-ui/lib/galactic/physics.test.ts` — pull-toward-galaxy formula, edge warp factor, confidence glow opacity

### Use existing design tokens, not new ones

- `tailwind.config.ts` already has `entity-projects`, `entity-decisions`, etc. — use those for planet base colors via CSS variables (`getComputedStyle(...).getPropertyValue('--color-entity-decisions')`).
- The four cognitive colors don't exist as tokens yet. Add to `tailwind.config.ts` under `colors.cognitive`:
  - `core: "#f0f6fc"` (white)
  - `semantic: "#58a6ff"` (blue)
  - `episodic: "#f59e0b"` (amber)
  - `procedural: "#3fb950"` (green)
- The void background `#070811` and grain/scan-line layers stay as the dashboard's existing dark background — no new ambient FX layers in the live route (those were prototype-only).

---

## Task 3 — `GalacticHUD` overlay

### Why
The legend, zoom indicator, workspace rail (not needed for live route — single workspace), inspector panel, and help bar are positioned over the canvas. The prototype has all of these as glass-panel HUD elements.

### Contract

A single component that renders three overlays on top of the canvas:

1. **Zoom indicator** (top-center): three chips `GALACTIC | SOLAR SYSTEM | PLANETARY`, active one highlighted. Click to jump to that level.
2. **Legend** (top-right): two sections — cognitive galaxies (4 rows with color dots) and domain shapes (6 rows). Includes the physics legend rows (`orbit pull · inbound count`, `glow halo · confidence`, etc.).
3. **Help bar** (bottom-left): keyboard shortcuts row.
4. **Inspector panel** (bottom-right): shows the selected node — header with title + status pill, cog/cat pills, confidence bar, description, metadata grid (source / created / updated / inbound / outbound / id), tags, separated inbound/outbound relations, physics readout, "▸ Open Memory" button. The button opens the modal (Task 4).

Style: reuses existing `GlassPanel` with `hasBrackets={true}`. No new HUD primitives.

### Files

- New: `src/dashboard-ui/components/GalacticHUD.tsx`
- New: `src/dashboard-ui/components/galactic/Inspector.tsx`
- New: `src/dashboard-ui/components/galactic/Legend.tsx`
- New: `src/dashboard-ui/components/galactic/ZoomIndicator.tsx`
- New: `test/dashboard-ui/components/galactic-inspector.test.tsx` — populates inspector from a fixture node, asserts every section renders, asserts "Open Memory" button calls handler
- New: `test/dashboard-ui/components/galactic-legend.test.tsx`

---

## Task 4 — `MemoryModal` for viewing memory bodies

### Why
Click "Open Memory" on the inspector → modal opens showing the page's raw markdown with Rendered/Source tabs. Same UX as the prototype.

### Contract

Component:
- Props: `path: string`, `open: boolean`, `onClose: () => void`
- When opened, fetches `/api/page/${path}` (existing endpoint, no changes needed)
- Renders:
  - Header: path with `path-prefix` muted + `path-leaf` accent (the filename in amber)
  - Tabs: `Rendered | Source`
  - Body: markdown rendered to styled HTML, OR raw markdown with syntax-highlight overlay (YAML keys, headings, wikilinks)
- Closes on: Esc, click outside, × button

### Markdown rendering

Port the minimal renderer from the prototype (`renderMarkdown()` function). Same coverage: frontmatter block, h1/h2/h3, paragraphs, lists, blockquotes, code fences, inline code, bold/italic, tables, wikilinks `[[id]]`, regular links. Already tested in the prototype browser — port as-is into a `src/dashboard-ui/lib/markdown.ts` module.

Wikilinks resolve against the loaded graph data — if the link target exists, clicking it closes the modal, selects that node, and pans the camera. Lift this as a callback prop on the modal.

### Files

- New: `src/dashboard-ui/components/galactic/MemoryModal.tsx`
- New: `src/dashboard-ui/lib/markdown.ts` (the renderer + `highlightSource()`)
- New: `src/dashboard-ui/hooks/usePageBody.ts` — TanStack Query wrapper around `/api/page/${path}`
- New: `test/dashboard-ui/lib/markdown.test.ts` — frontmatter parsing, each renderer feature
- New: `test/dashboard-ui/components/memory-modal.test.tsx` — open/close, tab switching, wikilink click

---

## Task 5 — Swap the `/graph` route + remove legacy

### Why
The new components replace the current 3D implementation entirely.

### Contract

- Rename or rewrite `src/dashboard-ui/components/GraphPage.tsx` → keep the same export name `GraphPage` so the route file doesn't change. Inside, render `<GalacticCanvas>` + `<GalacticHUD>` + `<MemoryModal>` glued together with selection/hover/zoom state.
- Delete `src/dashboard-ui/components/GraphCanvas.tsx`
- Delete `test/dashboard-ui/components/graph-canvas.test.tsx`
- Remove `react-force-graph-3d` and `three` from `package.json` dependencies
- Update any imports of `GraphCanvas` to use the new code path
- The mobile-fallback view in `GraphPage` is preserved as-is

### Files

- `src/dashboard-ui/components/GraphPage.tsx` (rewritten)
- `src/dashboard-ui/components/GraphCanvas.tsx` (deleted)
- `test/dashboard-ui/components/graph-canvas.test.tsx` (deleted)
- `package.json` (deps trimmed)
- New: `test/dashboard-ui/components/galactic-graph-page.test.tsx` — smoke test that GraphPage renders without crashing on fixture data

---

## Execution order

1. **Task 1** (cognitive type) — data model first
2. **Task 2** (GalacticCanvas) — pure rendering, no UI chrome yet
3. **Task 3** (HUD) — wire up overlays
4. **Task 4** (modal) — memory viewer
5. **Task 5** (route swap + cleanup) — flip the switch, delete legacy

Each task gets one commit. Tests run between tasks. Land all six in sequence then build + deploy.

---

## Build / test / deploy

```
npx vitest run                          # full suite — keep 595+ green
npx vitest run test/dashboard-ui/lib/galactic   # canvas math
npm run build                           # everything
npm run build:ui                        # SPA + route tree
npm run memory -- install-vps           # ship to live
```

---

## Acceptance checklist

- [ ] `cognitive_type` field flows from frontmatter → corpus → `/api/graph` → galactic layout
- [ ] `/memory/graph` route renders the 4-galaxy galactic view (no Three.js)
- [ ] All six domain planet shapes render with their distinct identity (decisions = banded rocky, lessons = binary moons, projects = mini-systems, references = ringed gas giants, tools = metallic octagons, crystals = faceted hexagons)
- [ ] Pan, zoom, click-to-select, hover-tooltip all work
- [ ] Inspector shows description, metadata, tags, split inbound/outbound relations, physics readout, "Open Memory" button
- [ ] "Open Memory" opens a modal with Rendered/Source tabs against the real `/api/page/...` response
- [ ] Wikilinks `[[id]]` in rendered markdown jump-select and pan the camera
- [ ] All 595+ tests still green (new ones added for layout, physics, markdown, modal, inspector)
- [ ] `react-force-graph-3d` and `three` removed from `package.json` and `node_modules`
- [ ] Deployed at `https://srv1317946.tail6916d8.ts.net/memory/graph`
- [ ] No regressions in other routes, search, or compile pipeline
- [ ] No secrets committed, no OneDrive paths anywhere

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.
