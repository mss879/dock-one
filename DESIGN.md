# DESIGN.md — Dock One Solutions storefront

> Phone numbers, domain and product data are placeholders. Everything brand-specific lives in
> `src/data/site.ts` and `src/data/products.ts`.

## 1. Identity

- **Product:** online electronics store based in Sri Lanka. Categories (for now): laptops, storage
  devices, keyboards, mice.
- **Audience:** Sri Lankan shoppers comparing against local competitors — prices in LKR, island-wide
  delivery, cash on delivery, official warranty are the trust cues that matter.
- **Single job of the homepage:** get a shopper from a deal or category into the basket.

## 2. Direction — "commerce layout, cyber-brutalist surface"

Three references, three different jobs:

| Reference | What we take from it |
|---|---|
| 1 — mainstream electronics store | **Layout contract.** Section order and density: utility bar → header with search/profile/wishlist/basket → hero slider → categories → promo banner bento → featured collections → flash deals with countdown → new arrivals with feature tile → dark best-seller strip → trust row → info band → testimonial / newsletter / stats → dark footer. |
| 2 — CYBR_ cyber brutalism | **Surface.** Off-white paper, hairline rules, container side rails, `/01` section indices, crosshair `+` marks, mono labels, condensed black display type, black buttons with violet arrow, violet + acid-lime accents, HUD read-outs (SYS.TIME, coordinates, status bar), chamfered corners, hatch fills. |
| 3 — "NEW Arrivals" pop-out cards | **Category cards.** Photographic stage inside the card, product cut-out breaking out of the top edge, lifts on hover. |

Rules of the mix: brutalist decoration never costs shopping clarity — prices, names, and the add-to-basket
control stay conventional and obvious. HUD details are `aria-hidden` and never carry information.

## 3. Colour tokens (`src/app/globals.css` → `@theme`)

| Token | Value | Use |
|---|---|---|
| `paper` | `#f3f3f1` | page background |
| `surface` | `#ffffff` | cards, inputs |
| `surface-2` | `#e9e9e6` | wells, image backplates |
| `ink` | `#0b0b0c` | text, primary buttons, strong rules |
| `ink-2` | `#3a3a40` | secondary text |
| `mute` | `#63636b` | tertiary text (≥ 4.5:1 on paper) |
| `line` | `#d8d8d4` | hairlines |
| `violet` | `#6d3bff` | primary accent, fills (white text 5.6:1) |
| `violet-ink` | `#4f22d9` | violet text on light backgrounds |
| `violet-soft` | `#ebe5ff` | tinted panels |
| `lime` | `#d4ff3a` | signal accent: discounts, status, highlights — always with `ink` text |
| `lime-soft` | `#f0ffc0` | tinted panels |
| `night` / `night-2` / `night-line` / `night-mute` | `#0b0b0c` / `#151517` / `#2b2b30` / `#a1a1aa` | dark sections |

No reds. Discounts are lime-on-ink, "new" is violet. One accent per element.

## 4. Typography

| Role | Font | Notes |
|---|---|---|
| Display | **Anton** | uppercase, `leading-[0.92]`, hero + section statements + rank numerals |
| UI / body | **Space Grotesk** | product names, paragraphs, inputs |
| Label / data | **JetBrains Mono** | nav, buttons, section indices, prices, HUD; uppercase, `tracking-[0.08em]`, 11–13px |

Scale: hero `clamp(3rem, 7.2vw, 6.5rem)` · statement `clamp(2rem, 4vw, 3.5rem)` · card title 14/20 ·
body 15/24 · label 11–12. Prices are mono + `tabular-nums`.

## 5. Shape, spacing, grid

- Radius **0**. Emphasis shapes use a chamfer (`clip-chamfer`, 14–20px) — top-right + bottom-left.
- 1px hairlines everywhere; hover promotes `line` → `ink`. No soft shadows on UI; only product
  cut-outs get a `drop-shadow` to sell the pop-out depth.
- Container `max-w-[1360px]`, gutters 16 / 24 / 32px, with full-height side rails at `xl`.
- Section rhythm 56px mobile / 88px desktop. 8px base spacing.

## 6. Primitives and states

| Primitive | Default | Hover / focus | Active | Disabled |
|---|---|---|---|---|
| `Button` primary | ink fill, paper text, violet arrow block | arrow block → lime, arrow nudges ↗ | translate-y 1px | 40% opacity, no pointer |
| `Button` accent | violet fill, white text | ink fill | — | — |
| `Button` ghost | text + `[ ]` brackets | brackets spread, text violet-ink | — | — |
| `IconButton` | 40–44px square, hairline | ink border | ink fill | — |
| `ProductCard` | surface, hairline | ink border, image scales 1.05, crosshair appears | — | — |
| `AddToCart` | violet square 40px, basket icon | ink fill | lime flash + check for 1.2s | — |
| `WishlistButton` | outline heart | violet-ink | filled violet (pressed, `aria-pressed`) | — |
| `QuantityStepper` | − value + in hairline box | cell ink fill | — | − disabled at 1, + at 10 |
| `CategoryPopout` | stage + cut-out overflowing top | cut-out lifts 14px + scales 1.05, stage zooms | — | — |
| `Sheet` (basket, menu) | native `<dialog>`, slides from edge, ink backdrop 60% | Esc / backdrop closes, focus trapped by UA | — | — |
| `Toast` | ink bar bottom-right, lime index | — | auto-dismiss 3.5s | — |
| Inputs | surface, hairline, mono placeholder | ink border + violet focus ring 2px | — | — |

Empty states: basket (wireframe art + "BASKET_EMPTY" + CTA). Missing imagery: CAD-style wireframe art per
category (`Wireframe`), so a missing generation never breaks layout.

Focus: `outline: 2px solid violet; outline-offset: 2px` on everything interactive. Targets ≥ 40px
(44px on touch-critical controls).

## 7. Motion

CSS only, transform/opacity/filter only. Easing `cubic-bezier(0.2, 0, 0, 1)`; 150ms (colour), 300ms
(sheet, lifts), 500ms (pop-out). Hero autoplay is driven by the progress bar animation (7s) and pauses on
hover/focus. `prefers-reduced-motion`: no autoplay, no ticker, no lifts.

## 8. Imagery

Generated with Higgsfield (`z_image`, 0.15 credits each) via `scripts/images/`. Art direction: graphite /
silver hardware, violet screen light, acid-lime details; studio cut-outs on transparent; stages are empty
brutalist sets (night-violet, concrete, lime, violet voxel). Heroes/promos keep the left half empty for live
HTML copy — no text is ever baked into an image.
