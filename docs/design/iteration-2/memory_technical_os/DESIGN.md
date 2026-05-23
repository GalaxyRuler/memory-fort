---
name: Memory Technical OS
colors:
  surface: '#14121b'
  surface-dim: '#14121b'
  surface-bright: '#3b3842'
  surface-container-lowest: '#0f0d16'
  surface-container-low: '#1d1a24'
  surface-container: '#211e28'
  surface-container-high: '#2b2832'
  surface-container-highest: '#36333d'
  on-surface: '#e7e0ed'
  on-surface-variant: '#cbc3d7'
  inverse-surface: '#e7e0ed'
  inverse-on-surface: '#322f39'
  outline: '#948ea0'
  outline-variant: '#494455'
  surface-tint: '#cebdff'
  primary: '#cebdff'
  on-primary: '#390093'
  primary-container: '#9c79ff'
  on-primary-container: '#310082'
  inverse-primary: '#6a3add'
  secondary: '#b2c5ff'
  on-secondary: '#002b73'
  secondary-container: '#004dbf'
  on-secondary-container: '#b7c8ff'
  tertiary: '#ffb873'
  on-tertiary: '#4b2800'
  tertiary-container: '#d07d1b'
  on-tertiary-container: '#412200'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e8ddff'
  primary-fixed-dim: '#cebdff'
  on-primary-fixed: '#21005d'
  on-primary-fixed-variant: '#5212c4'
  secondary-fixed: '#dae2ff'
  secondary-fixed-dim: '#b2c5ff'
  on-secondary-fixed: '#001848'
  on-secondary-fixed-variant: '#0040a2'
  tertiary-fixed: '#ffdcbf'
  tertiary-fixed-dim: '#ffb873'
  on-tertiary-fixed: '#2d1600'
  on-tertiary-fixed-variant: '#6a3b00'
  background: '#14121b'
  on-background: '#e7e0ed'
  surface-variant: '#36333d'
  project-blue: '#5b8bff'
  decision-purple: '#8b5fff'
  lesson-amber: '#fbbf24'
  reference-cyan: '#22d3ee'
  tool-emerald: '#34d399'
  person-pink: '#f472b6'
  crystal-gold: '#fcd34d'
  session-zinc: '#52525b'
  text-primary: '#ededed'
  text-secondary: rgba(237,237,237,0.7)
  text-muted: rgba(237,237,237,0.45)
  border-subtle: rgba(255,255,255,0.06)
  border-emphasis: rgba(255,255,255,0.12)
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.02em
  headline-sm:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  mono-base:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  sidebar-width: 220px
  container-max: 1200px
  gutter: 24px
  stack-gap: 12px
  inline-gap: 8px
---

## Brand & Style
The design system is centered on a **Technical Minimalist** aesthetic, tailored for a high-utility personal memory system. It evokes a sense of "digital sanctuary"—private, incredibly fast, and intellectually rigorous.

The style draws heavily from modern developer-centric interfaces (Linear, Vercel), utilizing a dark-mode-only environment to reduce cognitive load and emphasize content. The visual narrative is "Futuristic Utility," where the interface recedes to let user data shine, using precise borders, subtle translucency, and intentional "emissive" accents to guide the eye toward active entities.

## Colors
This design system operates exclusively in a deep dark mode. The palette is built on a "low-contrast-structure, high-contrast-content" model. 

- **The Core:** Neutral surfaces utilize hex values to ensure performance, while structural lines (borders) use low-opacity whites to blend naturally into the dark backgrounds.
- **Accents:** The primary brand identity is a linear gradient (Purple to Blue). 
- **Entity System:** Information is categorized via a specific spectrum of colors. These should be used sparingly—primarily for icons, status indicators, and subtle graph nodes—to prevent visual clutter.

## Typography
Typography is the backbone of this design system. We use **Inter** as a variable font to maintain a clean, humanist feel while allowing for precise weight adjustments.

- **Headlines:** Use tighter letter-spacing and semi-bold weights to create a "locked-in" professional appearance.
- **Body:** The 14px base is the standard for high-density information systems. 
- **Mono:** **JetBrains Mono** is reserved for metadata, file paths, telemetry, and code blocks. It signifies "system-generated" or "raw data" contexts.

## Layout & Spacing
The layout follows a **Hybrid-Fixed** model designed for focus. 

- **Sidebar:** A persistent 220px left-hand navigation allows for rapid context switching.
- **Main View:** A fixed-width central column (max 1200px) ensures readability for long-form thought and technical notes.
- **Grids:** Use a 4px base unit for all spacing. Standard components use 12px vertical gaps (stacking) and 8px horizontal gaps (inline).
- **Reflow:** On mobile, the sidebar collapses into a bottom navigation bar or a hamburger menu, and container margins shrink to 16px.

## Elevation & Depth
Depth is created through **Tonal Layering** and **Glassmorphism** rather than traditional heavy shadows.

- **Surface Levels:** `Background Base` is the lowest level. `Surface 1` is for the sidebar and secondary panels. `Surface 2` is for cards and floating elements.
- **Glass Effects:** Modals and top navigation bars use a backdrop blur (20px) with a semi-transparent dark background. This maintains a sense of "place" as content scrolls underneath.
- **Borders:** Subtle outlines (`border-subtle`) replace shadows for most components. 
- **Emissive Glow:** A unique "bloom" effect is used for graph nodes. This is a soft, tinted outer glow that corresponds to the entity color, suggesting the "energy" of a thought or memory.

## Shapes
The shape language is "Soft-Geometric." 

We utilize a varying radius scale to create a nesting hierarchy:
- **Inputs/Buttons:** 6px (Tight and precise).
- **Cards/Panels:** 8px (Standard container).
- **Modals/Large Overlays:** 12px (Distinct and prominent).
- **Search Pill:** Fully rounded (pill) to distinguish the ⌘K command bar from other inputs.

## Components
- **Buttons:** Primary buttons use the brand gradient. Secondary buttons use a `Surface 2` background with a `border-subtle`. Hover states trigger a 1px inset purple-blue glow at 20% opacity.
- **Command Bar (⌘K):** A pill-shaped search bar anchored at the top. It uses the glass-blur effect and contains a "⌘K" keyboard shortcut label in `mono-base`.
- **Entity Chips:** Small, high-contrast labels using the Entity Colors. They feature a tiny emissive dot (status dot) next to the text.
- **Inputs:** Minimalist with a 1px `border-subtle`. On focus, the border shifts to `border-emphasis` with a subtle glow.
- **Cards:** No shadows. Use `Surface 2` background and a 1px `border-subtle`.
- **Icons:** Use Lucide or Phosphor icons in "Regular" or "Light" weight. Always monochromatic (text-secondary) unless representing a specific Entity type.
- **Graph Nodes:** Small circles with a 2px emissive bloom in the respective entity color.