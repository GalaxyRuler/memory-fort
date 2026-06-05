# Prompt for ChatGPT 5.5 Pro — Galactic Graph: Visual-Encoding Logic Assessment

> Paste everything below the line into ChatGPT 5.5 Pro. It is self-contained: every formula, constant, and mapping is transcribed verbatim from the implementation (`src/dashboard-ui/lib/galactic/*` and `src/dashboard-ui/components/GalacticCanvas.tsx`). Ask for rigorous, adversarial reasoning — find where the encoding lies, misleads, or wastes signal. Not validation.

---

You are a data-visualization and information-design critic with a background in graph drawing, visual semiotics (Bertin / Munzner / Cleveland-McGill), and perceptual encoding. I am going to give you the **complete logic of a "galactic" graph visualization** for a personal agent-memory system. It renders memory nodes as planets, grouped into solar systems, grouped into galaxies, connected by typed edges, animated by a hand-written "physics" layer. The physics is **not a force simulation** — it is a set of pure functions that deterministically map memory *metadata* to *spatial and visual parameters*. I want you to assess whether that mapping is **logically sound, perceptually honest, and legible**, then refine or correct it.

Judge it as an information display, not as art. The core question: **does each visual channel carry the data the viewer will think it carries, or does it imply structure that isn't in the data?**

## 1. What the data is (the drivers)

Each node is a memory page with this metadata available to the renderer:

- `cognitiveType` ∈ {`core`, `semantic`, `episodic`, `procedural`} — the memory class.
- `type` (domain) — the wiki category: `projects`, `issues`, `decisions`, `lessons`, `references`, `tools`, plus `crystal` (a synthesized-insight kind).
- `kind` ∈ {`wiki`, `raw`, `crystal`}.
- `inboundCount`, `outboundCount` — in/out edge degree.
- `confidence` ∈ [0,1] or null.
- `path` — unique id (used as a deterministic random seed).

Edges carry: `kind` (`relation` | `wikilink`), `type`/`relationType` (the typed relation), `validFrom`, `validTo` (null = still valid), `weight` (derived, see below).

**There is no physics simulation, no force-directed layout, no collision.** Every position is a closed-form function of metadata + elapsed time. "Physics" here is a metaphor: mass, gravity, orbit, and lensing are all *encodings*, not dynamics.

## 2. The three-level spatial hierarchy

**Galaxies = cognitive type.** The 4 cognitive types become 4 galaxies placed on a ring of radius `GALAXY_RADIUS = 900` around the world origin:

```
angle_galaxy(i) = (i / 4) * 2π − π/2      // i = index in [core, semantic, episodic, procedural]
galaxy.cx = cos(angle) * 900
galaxy.cy = sin(angle) * 900
```

Each galaxy spins at a fixed rate by type:

```
core:       speed 0.00015   color #f0f6fc (near-white)
semantic:   speed 0.00030   color #58a6ff (blue)
episodic:   speed 0.00075   color #f59e0b (amber)   ← fastest
procedural: speed 0.00050   color #3fb950 (green)
```

**Solar systems = domain (wiki type).** Within a galaxy, each domain present becomes a "system" orbiting the galaxy core at `SYSTEM_RADIUS = 220`, at a **globally fixed angle per domain**:

```
DOMAIN_ORDER = [projects, issues, decisions, lessons, references, tools, crystals]   // 7 domains
angle_system(domain) = (indexOf(domain) / 7) * 2π
system.cx = galaxy.cx + cos(angle) * 220
system.cy = galaxy.cy + sin(angle) * 220
```

Because the angle is keyed only to the domain index, **the same domain sits at the same clock position in every galaxy** (e.g. `projects` is always at angle 0).

**Planets = individual memory nodes**, orbiting their system center (see physics below).

**Domain collapse (important).** The system has ~9 wiki node types but only 7 domain shapes. The mapping is:

```
crystal kind/type           → crystals
type ∈ DOMAIN_ORDER         → itself
kind == "raw"               → lessons
everything else             → references     // threads, procedures, people, prospective, decisions w/o type, etc.
```

So several distinct node types (threads, procedures, people, prospective) are all drawn as the **references** shape, and all raw episodic captures are drawn as **lessons**.

## 3. Domain shapes (the planet renderers)

Each domain has a bespoke hand-drawn planet so the type is recognizable by silhouette/texture, not just hue:

| Domain | Color | Shape logic |
|---|---|---|
| `projects` | green `#4ade80` | A **star/sun**: bright core + corona gradient + 3 satellites orbiting at `localAngle*2 + i·120°`. Reads as a luminous hub. |
| `decisions` / `issues` | pink `#f472b6` | **Banded gas giant** (5 horizontal bands). If `confidence < 0.75`, a golden "storm" ellipse is drawn — *low confidence = visible storm*. |
| `lessons` | violet `#a78bfa` | **Planet + 1 orbiting moon** at `localAngle*4`, with a drawn orbit ring. |
| `references` | blue `#60a5fa` | **Ringed planet** (Saturn-like ellipse rings) + blue bands. |
| `tools` | amber `#fbbf24` | **8-sided polygon** (octagon), machined look. |
| `crystals` | cyan `#22d3ee` | **6-sided faceted gem** with internal facet lines + strong glow. |

Shape encodes domain; the only *data-driven* shape variation is the decisions "storm" at confidence < 0.75.

## 4. Physics as data drivers (the closed-form encodings)

All of the following are pure functions. `elapsedMs` is wall-clock since mount.

**Mass = degree → gravity toward the galaxy core.** Inbound degree becomes "mass", which pulls a node's effective center *away from its own solar system and toward the galaxy core*, and tightens its orbit:

```
mass        = min(1, max(0, inboundCount) / 16)
massPull:   pull = clamp(mass,0,1) * 0.5
            center.x = system.cx*(1−pull) + galaxy.cx*pull      // lerp system→galaxy by pull
            center.y = system.cy*(1−pull) + galaxy.cy*pull
orbitR      = localOrbitR * (1 − mass*0.2)                      // heavier → tighter orbit
localOrbitR = 80 * (1.05 − mass*0.55 + (siblingIndex % 3)*0.14)
```

So a high-degree node drifts up to **halfway** from its domain system toward the galaxy center (pull caps at 0.5 when mass=1). A node's domain identity (its angular position) literally **weakens as it becomes more connected** — it migrates inward toward the shared core.

**Size = degree (sublinear).**

```
size = 3 + max(0, inboundCount)^0.7 * 2.7
```

**Confidence = glow.**

```
conf       = clamp(confidence ?? 0.55, 0, 1)
glowRadius = max(8, planetRadius * 1.9 * (0.4 + conf*0.9))
glowOpacity= 0.08 + conf^1.6 * 0.4
```

Null confidence defaults to 0.55. Note degree (size) and confidence (glow halo) both inflate the node's drawn footprint.

**Orbital motion (deterministic).** Initial angle is an FNV-1a hash of the node `path` → reproducible placement. Each frame:

```
seed       = FNV1a(path) normalized to [0,1) * 2π
localSpeed = 0.00035 + FNV1a(path, salt2) * 0.0006
galaxy.spin= galaxy.spinSpeed * elapsedMs
localAngle = seed + elapsedMs*localSpeed + galaxy.spin*0.4
node.x     = pulledCenter.x + cos(localAngle) * orbitR
node.y     = pulledCenter.y + sin(localAngle) * orbitR
```

**Edge weight = mutual degree.**

```
edgeWeight = 0.4 + min(sourceInbound, targetInbound) / 14
```

This weight drives line width, opacity, animated-particle count, and flow speed.

**Edge curvature = gravitational lensing (within-galaxy only).** Within a galaxy, edges bow toward the galaxy core; the warp grows with edge weight and shrinks with distance from the core:

```
warp     = (160 + weight*180) / (dist_midpoint_to_core/100 + 1)
controlX = midX + (dx/dist)*warp     // dx,dy point from edge midpoint to galaxy core
controlY = midY + (dy/dist)*warp
// rendered as a quadratic Bézier through this control point
```

**Cross-galaxy edges** are drawn nearly straight (tiny 40px bow toward world origin), in bright cyan `#a5f3fc` with a glow shadow, and **sorted to render on top** of everything. Rationale in the code: cross-galaxy edges "are the most informative — they prove the whole graph is one organism." In the live data **~94% of all edges are cross-galaxy.**

**Edge type = stroke treatment.** Typed relations get color/dash/arrowhead; untyped edges fall back to a domain-gradient (within-galaxy) or cyan glow (cross-galaxy):

```
contradicts  → red  (252,165,165), dash [6,4], no arrow
supersedes   → gray (156,163,175), solid,      arrowhead
derived_from → indigo(165,180,252),dash [2,3], no arrow
uses         → yellow(253,224,71), solid,      no arrow
depends_on   → yellow(253,224,71), solid,      no arrow   // same as uses
caused_by    → violet(196,181,253),solid,      no arrow
fixed_by     → violet(196,181,253),solid,      no arrow   // same as caused_by
(untyped, cross-galaxy) → cyan glow
(untyped, within-galaxy)→ gradient between the two endpoints' domain colors
```

**Historical edges** (`validTo` set) render at `opacity * 0.4` — faded, not removed.

**Animated flow particles** travel each edge to imply direction/activity:

```
count    = round(weight * 2.2)        // (3 if the edge is highlighted)
flowRate = 0.00018 + weight*0.00035
// particle positions are points along the quadratic Bézier at parameter t
```

## 5. Level-of-detail (zoom) logic

Camera scale maps to 3 LOD levels and gates what's drawn:

```
zoomLevelForScale: scale ≤ 0.28 → 0 (galaxy view)
                   scale ≤ 0.85 → 1 (system view)
                   else         → 2 (planet view)

accretion sand swarm:  drawn only when scale ≤ 0.9      (90 particles/galaxy, decorative)
system backdrops:      drawn only when scale > 0.3
system labels:         drawn only when 0.6 < scale < 1.6
galaxy labels:         drawn only when scale ≤ 0.45
planet titles:         drawn only when scale > 1.1
cross-galaxy edges:    line-width & opacity floors RAISED at level 0 so they punch through halos
```

Preset scales for the HUD zoom chips: level 0 → 0.18, level 1 → 0.55, level 2 → 1.4.

---

## Your assessment — reason rigorously about each

1. **Channel honesty.** Go encoding-by-encoding (galaxy=cognitiveType, system-angle=domain, planet-shape=domain, planet-size=degree, glow=confidence, mass-pull=degree, lensing=weight, particle-flow=weight, cyan=cross-galaxy). For each, state what *structure the viewer will infer* vs *what the data actually says*. Where does the encoding imply a relationship that isn't there (false pattern), or hide one that is (lost signal)? Be specific about perceptual pop-out and pre-attentive channels.

2. **The mass→gravity migration.** A node's angular position encodes its domain, but high inbound degree pulls it up to halfway toward the galaxy core — so **degree and domain are encoded in the same spatial channel and fight each other.** A highly-connected `lessons` node ends up positionally ambiguous between "lessons" and "core." Is this a defensible "important things rise to the center" metaphor, or a channel collision that destroys the legibility of both variables? What's the correct fix — separate the channels, or is conflation acceptable here?

3. **Domain collapse.** Threads, procedures, people, and prospective nodes are all rendered as the `references` shape; all raw episodic captures render as `lessons`. So the silhouette channel is **lossy and miscategorizing** — a procedure looks like a reference, a raw capture looks like a curated lesson. How bad is this? Does it make the display actively misleading, and what's the minimal change (more shapes? a "muddled/other" shape? a kind-modifier overlay?) that restores honesty without 12 bespoke renderers.

4. **Cross-galaxy dominance.** 94% of edges cross galaxies and are rendered as bright cyan on-top filaments, while within-galaxy edges get subtle gradients. The stated rationale is "cross-galaxy edges prove the graph is one organism." But if 94% are cross-galaxy, does highlighting them convey *anything* (everything is highlighted → nothing is), and does it mean the **galaxy partition (cognitiveType) is a poor clustering** for this data — i.e., the chosen grouping variable doesn't actually cluster the edges? Should the primary grouping be something other than cognitiveType?

5. **Determinism vs. force layout.** Positions are closed-form (hash-seeded orbits + metadata), not relaxed by a force simulation. Upside: stable, reproducible, no jitter, cheap. Downside: **adjacency is never reflected in proximity** — two heavily-linked nodes can sit in opposite galaxies and the layout never pulls them together. For a *graph* visualization, is abandoning "connected ⇒ near" a fatal flaw or an acceptable trade for a metaphor-driven, category-first display? When (if ever) is a non-force graph layout the right call?

6. **Redundant & colliding visual channels.** `uses`/`depends_on` share a color; `caused_by`/`fixed_by` share a color — so 7 typed relations collapse to ~5 distinguishable strokes. Planet size (degree) and confidence glow both enlarge a node's footprint, conflating two variables in apparent magnitude. Audit every channel for redundancy and collision. Which distinctions are perceptually lost, and which are wastefully duplicated?

7. **Animation as information vs. noise.** Galaxies spin, planets orbit, particles flow along edges, sand swarms accrete. None of the motion is driven by *change in the data* — it's ambient. Particle *count/speed* encodes edge weight (a real variable) but constant motion may read as "live/changing" when nothing is. Does the animation carry information proportional to its salience, or is it decorative motion that violates the "ink/motion should encode data" principle? What motion, if any, should be kept?

8. **Confidence defaulting & the storm.** Null confidence silently becomes 0.55 (a mid glow), and only `decisions` show a confidence "storm" (at <0.75). So missing confidence is indistinguishable from medium confidence, and the one data-driven shape feature exists for only one domain. Is defaulting-to-0.55 a defensible nan-handling choice or a lie? Should "unknown" have its own visual?

9. **Edge cases / latent bugs.** (a) `cognitiveType` can in principle be `prospective`, but only 4 galaxies exist (core/semantic/episodic/procedural) — a prospective node would index an undefined galaxy. (b) `siblingIndex % 3` for orbit radius means only 3 distinct orbit shells regardless of how many nodes share a system → heavy overplotting in large systems. (c) glow footprint + size both scale the node, so a high-degree high-confidence node may visually swamp neighbors. Flag any other latent correctness or scalability problems you see in the formulas as given.

10. **Highest-leverage fixes.** Rank the top 5 changes by (gain in legibility/honesty ÷ implementation cost), holding the constraints: single-canvas 2D, no physics engine, must stay performant at thousands of nodes, the "space" metaphor is a deliberate product choice and should survive. Tell me what to **stop drawing** as well as what to add. For each, name the specific formula/constant to change.

Deliver: (a) a blunt verdict — is this a legitimate information display or a pretty metaphor that misrepresents the graph; (b) the specific encoding flaws ranked by how badly they mislead; (c) which visual channels to keep, kill, or re-map; (d) the top-5 leverage fixes with the exact constants/formulas to change. Where current data-viz or graph-drawing literature sharpens the argument (e.g. why "connected⇒near" matters, motion perception, categorical vs. ordinal channel choice), cite it.
