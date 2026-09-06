---
version: alpha
name: Showroom Warm
description: HomeStyle's design language — a bone-and-warm-ink interface system built to disappear behind the furniture it shows. Warm near-black on a bone canvas, a ladder of barely-there warm-neutral tints instead of shadows, stadium-pill controls, 24px card geometry, iOS-style 30% squircle icon tiles, and the Saans typeface at unusual variable weights (652 display, 456 text, 300 light). One walnut accent is reserved for commercial signals; every other color on screen belongs to the rooms being shown. Structurally this is the Mobbin analysis it grew out of — the geometry, type ladder, spacing and component specs are inherited unchanged, and only the palette moved off neutral.

colors:
  primary: "#1c1917"
  on-primary: "#fbfaf7"
  ink: "#1c1917"
  ink-soft: "#2e2926"
  text-muted: "#6f665e"
  text-faint: "#a89e93"
  canvas: "#fbfaf7"
  canvas-soft: "#f2efe9"
  field: "#efebe4"
  hairline-soft: "#efebe4"
  hairline: "#e3ddd3"
  accent: "#8a5a3c"

typography:
  display:
    fontFamily: Saans
    fontSize: 80px
    fontWeight: 652
    lineHeight: 1
    letterSpacing: 0
  heading-1:
    fontFamily: Saans
    fontSize: 56px
    fontWeight: 652
    lineHeight: 1
    letterSpacing: 0
  heading-2:
    fontFamily: Saans
    fontSize: 44px
    fontWeight: 652
    lineHeight: 1.13
    letterSpacing: 0
  heading-3:
    fontFamily: Saans
    fontSize: 32px
    fontWeight: 652
    lineHeight: 1.13
    letterSpacing: 0
  heading-4:
    fontFamily: Saans
    fontSize: 24px
    fontWeight: 652
    lineHeight: 1.25
    letterSpacing: 0
  title:
    fontFamily: Saans
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0
  body-lg:
    fontFamily: Saans
    fontSize: 20px
    fontWeight: 300
    lineHeight: 1.38
    letterSpacing: 0
  body:
    fontFamily: Saans
    fontSize: 16px
    fontWeight: 456
    lineHeight: 1.38
    letterSpacing: 0
  body-sm:
    fontFamily: Saans
    fontSize: 14px
    fontWeight: 456
    lineHeight: 1.43
    letterSpacing: 0
  link:
    fontFamily: Saans
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.38
    letterSpacing: 0
  label:
    fontFamily: Saans
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: 0
  caption:
    fontFamily: Saans
    fontSize: 12px
    fontWeight: 456
    lineHeight: 1.33
    letterSpacing: 0

rounded:
  none: 0px
  sm: 16px
  md: 24px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 80px
  section-lg: 120px

components:
  nav-pill:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"

  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.link}"
    rounded: "{rounded.full}"
    padding: "0px {spacing.md}"

  button-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.full}"

  button-pill-soft:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"

  text-input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"

  text-input-focused:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    borderColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"

  badge-popular:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-primary}"

  badge-overlay:
    backgroundColor: "rgba(115, 115, 115, 0.56)"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"

  pricing-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline-soft}"
    rounded: "{rounded.md}"

  pricing-card-featured:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"

  segmented-control:
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.full}"

  segmented-control-active:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"

  testimonial-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline-soft}"
    rounded: "{rounded.sm}"

  faq-row:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"

  app-icon-squircle:
    cornerRadius: "30%"

  brand-chip:
    textColor: "{colors.ink}"
    typography: "{typography.heading-3}"

  portrait-tile:
    rounded: "{rounded.md}"
    textColor: "{colors.on-primary}"

  award-lockup:
    textColor: "{colors.ink}"
    typography: "{typography.heading-3}"

  compare-table:
    rowBorder: "{colors.canvas-soft}"
    highlightBackground: "{colors.canvas-soft}"
    textColor: "{colors.ink}"

  footer:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"

  # ─── Examples (illustrative) — kit-mirror surfaces referencing brand primitives ───
  ex-pricing-tier:
    description: "Default Pricing tier card. Re-uses feature-card chrome with brand canvas-soft surface."
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-pricing-tier-featured:
    description: "Featured/highlighted tier — polarity-flipped surface (dark fill + light text in light mode, light fill + dark text in dark mode)."
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-product-selector:
    description: "What's Included summary card — re-purposed for SaaS / B2B verticals (NOT a literal product gallery)."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-cart-drawer:
    description: "Subscription summary — re-purposed for SaaS / B2B (line items per add-on, not literal cart)."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
    item-divider: "{colors.hairline}"
  ex-app-shell-row:
    description: "Sidebar nav row inside the App Shell example. Active state uses brand primary as the indicator."
    backgroundColor: "{colors.canvas}"
    activeIndicator: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xs} {spacing.md}"
  ex-data-table-cell:
    description: "Default data-table th + td chrome. Header uses mono-caps eyebrow typography; body uses body-sm."
    headerBackground: "{colors.canvas-soft}"
    headerTypography: "{typography.caption}"
    bodyTypography: "{typography.body-sm}"
    cellPadding: "{spacing.sm} {spacing.md}"
    rowBorder: "{colors.hairline}"
  ex-auth-form-card:
    description: "Sign-in / sign-up card. Re-uses feature-card chrome with text-input primitives inside."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-modal-card:
    description: "Modal dialog surface — same chrome as feature-card with elevated shadow."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-empty-state-card:
    description: "Empty-state illustration frame."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.md}"
    padding: "{spacing.xxl}"
    captionTypography: "{typography.body}"
  ex-toast:
    description: "Toast notification surface — feature-card shape + medium shadow."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
    typography: "{typography.body-sm}"

---


## Overview

HomeStyle sells rooms, and the interface that sells them is engineered to get out of the way. The system is near-monochrome and warm: warm near-black ink (`{colors.ink}` — #1c1917) on a bone canvas (`{colors.canvas}` — #fbfaf7), with structure carried by a ladder of barely-perceptible warm-neutral tints rather than by shadows or color. Furniture photography — teak, cane, brass, terracotta, handloom cotton — is the only saturated thing on any page. The chrome frames it the way a showroom's bone walls frame the pieces standing in front of them, which is the same reason a gallery is white: the room recedes so the object reads.

The geometry does the brand work that color refuses to do, and it is inherited wholesale. Every interactive element is a stadium pill (`{rounded.full}`): the floating navigation bar, every button, the segmented toggle, the overlay badges. Containers sit at a calm `{rounded.md}` (24px), media tiles at `{rounded.sm}` (16px), and icon tiles render as iOS-style squircles at 30% corner radius. Type is set in Saans at deliberately non-standard variable weights — a chunky 652 for every heading, a bookish 456 for text, an airy 300 for hero subtitles — which gives the near-monochrome pages a strong typographic voice without a single decorative flourish.

One color is allowed to interrupt: a walnut accent (`{colors.accent}` — #8a5a3c), used exclusively for commercial signals — the featured badge, a savings callout, the next-best-piece recommendation. Its scarcity is the point; when walnut appears, it is asking for a decision. It is drawn from the catalogue's own material palette rather than imported from outside it, so the one chromatic note in the chrome is a color the products already contain.

**Key Characteristics:**
- Bone-and-warm-ink palette — `{colors.ink}` on `{colors.canvas}`, zero brand chroma outside the single `{colors.accent}` walnut
- Stadium-pill interaction language: nav bar, buttons, toggles, and badges all at `{rounded.full}`
- Shadow-free elevation — hierarchy built from a neutral tint ladder (`{colors.canvas-soft}`, `{colors.field}`, `{colors.hairline}`) and 1px hairlines
- Saans at signature variable weights: 652 headings with tight 1.0–1.13 line-height, 456 body, 300 light subtitles
- iOS-style squircle icon tiles (30% radius) as a recurring visual motif across library counters and brand marquees
- Content supplies the color: furniture photography, material swatches and room scenes carry all visual richness
- Full-bleed near-black `{colors.ink}` footer with rounded top corners closes every page in polarity inversion

## Colors

Source pages: home, pricing, awards, signup.

### Brand & Accent
- **Warm Ink** (`{colors.primary}` — #1c1917): The brand color. Fills every primary CTA pill, the footer band, and all display typography. HomeStyle's identity is this warm near-black — the color of oiled dark wood rather than of printer's ink, softened off pure black to sit comfortably next to photography.
- **Walnut** (`{colors.accent}` — #8a5a3c): The only chromatic accent in the system. Reserved for commercial emphasis — featured badges, savings callouts, the next-best-piece recommendation. Never used decoratively, never used for CTAs.

### Surface
- **Canvas** (`{colors.canvas}` — #fbfaf7): Bone. Default page and card background across all pages. Off-white rather than white so that unbleached cotton, undyed cane and raw linen in the photography do not read as dirty against it.
- **Soft Canvas** (`{colors.canvas-soft}` — #f2efe9): Linen. The workhorse tint — a ~6% warm-ink wash over bone. Fills the floating nav pill, the featured card, accordion rows, soft utility pills, segmented-control tracks, and the highlighted comparison-table column.
- **Field** (`{colors.field}` — #efebe4): An ~8% warm-ink wash used as the fill for form inputs, giving fields presence without borders.
- **Soft Hairline** (`{colors.hairline-soft}` — #efebe4): 1px card outlines — the faintest possible edge, used on bone-on-bone cards.
- **Hairline** (`{colors.hairline}` — #e3ddd3): The stronger ~16% control border, used on outlined pill buttons and interactive chrome.

### Text
- **Ink** (`{colors.ink}` — #1c1917): Headings, body copy, and nav links.
- **Soft Ink** (`{colors.ink-soft}` — #2e2926): Slightly lifted dark used for secondary lockups and wordmarks.
- **Muted** (`{colors.text-muted}` — #6f665e): Secondary copy — supporting paragraphs, descriptions, counts, underlined inline links. Holds 5.4:1 on canvas, so it is legitimate body text and not decoration.
- **Faint** (`{colors.text-faint}` — #a89e93): Tertiary text — placeholders, de-emphasized footer links, fine print. Deliberately sub-AA at 2.5:1 and therefore never load-bearing — exactly the role its #adadad predecessor held.

### Semantic
- The marketing surfaces ship no dedicated success/warning/error palette; state communication stays within the warm-neutral ladder, with `{colors.accent}` as the sole positive-emphasis signal.
- The **CRM application** is the documented exception. Churn risk, KPI deltas and consent status genuinely need at-a-glance triage, so a desaturated warm trio survives there — **good** #2f6b4f, **warn** #8a5d14, **bad** #a33a22 — and is permitted **as text and dots only**. Never as fills, never as colored bands. Each clears 4.9:1 against both `{colors.canvas}` and `{colors.canvas-soft}`. See the header note in `app/globals.css`.

## Typography

### Font Family

**Saans** — a contemporary neo-grotesque used exclusively, across every page and every role. It is loaded as a variable font, and the brand's voice comes from where it sits on the weight axis: headings render at an unusual 652 (heavier than semibold, lighter than bold), running text at 456 (a hair over regular), and hero subtitles at a genuinely light 300. Fallback stack: system sans (`-apple-system, "Helvetica Neue", Arial, sans-serif`).

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display}` | 80px | 652 | 1.0 | 0 | Homepage hero statements and library counters |
| `{typography.heading-1}` | 56px | 652 | 1.0 | 0 | Page heroes ("Design like a Pro.", "The votes are in.") |
| `{typography.heading-2}` | 44px | 652 | 1.13 | 0 | Section headings on content pages |
| `{typography.heading-3}` | 32px | 652 | 1.13 | 0 | Card-level headlines, award winner names, auth headings |
| `{typography.heading-4}` | 24px | 652 | 1.25 | 0 | Sub-section headings, plan names |
| `{typography.title}` | 20px | 600 | 1.3 | 0 | Feature titles, emphasized rows |
| `{typography.body-lg}` | 20px | 300 | 1.38 | 0 | Hero subtitles and lead paragraphs — the light counterpoint to 652 headings |
| `{typography.body}` | 16px | 456 | 1.38 | 0 | Default body copy, testimonial quotes |
| `{typography.body-sm}` | 14px | 456 | 1.43 | 0 | Supporting copy, plan feature lists, legal text |
| `{typography.link}` | 16px | 600 | 1.38 | 0 | Nav links and button labels |
| `{typography.label}` | 12px | 600 | 1.33 | 0 | Badge and pill labels |
| `{typography.caption}` | 12px | 456 | 1.33 | 0 | Captions, metadata, form fine print |

### Principles

- **Weight contrast is the drama.** Pairing 652 headings against 300 light subtitles at the same scale step (e.g. 80px display over 20px light lead) creates hierarchy without color or ornament.
- **Tight leading up top.** Display and heading-1 sit at line-height 1.0; headings never breathe more than 1.25. Body text opens up to 1.38–1.43.
- **Zero letter-spacing everywhere.** The grotesque is trusted at its natural fit; no tracking adjustments at any size.
- **Sentence case with terminal periods.** Headlines read as declarative sentences: "Discover real-world design inspiration." — the period is part of the voice.

### Note on Font Substitutes

Saans is a commercial typeface. The closest widely-available substitutes are **Inter** (variable, supports the 300/450/650 weight positions via its variable axis) or **Hanken Grotesk**. When substituting, map weight 652 → 650 (or 700 at static weights), 456 → 450 (or 500), and keep line-heights as specified — Saans has a compact x-height, so substitutes may need line-height reduced by ~0.05.

## Layout

### Spacing System
- **Base unit**: 8px, with 4px half-steps for fine rhythm
- **Tokens**: `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.md}` 16px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px · `{spacing.section}` 80px · `{spacing.section-lg}` 120px
- Buttons are fixed-height pills padded horizontally at `{spacing.md}`; inputs pad `{spacing.sm} {spacing.md}`
- Universal rhythm constants: 28px and 80px vertical steps recur on every page; 120px separates major homepage acts

### Grid & Container
- Content rides a centered column: single-column centered lockups for heroes and award winners, a 2-up card grid for pricing plans, 3-up for portrait tiles, and a 4-column masonry for testimonials.
- The floating nav pill is detached from the viewport edge and horizontally centered, rather than a full-width bar — the page canvas visibly wraps around it.
- Marquee strips (brand logos, app screenshots) run full-bleed beyond the content column.

### Whitespace Philosophy

Whitespace is the primary grouping device. Sections are separated by `{spacing.section}` to `{spacing.section-lg}` of empty canvas with no divider rules; within cards, generous `{spacing.lg}` padding keeps content off the hairline edges. The homepage alternates dense collage moments (icon clouds, screenshot grids) with near-empty typographic interludes — compression and release.

### Responsive Strategy

#### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| 2xl | 1536px | Max content width engaged; marquees widen |
| xl | 1280px | Default desktop grid |
| lg | 1024px | Comparison table condenses; testimonial masonry drops to 3 columns |
| md | 840px / 768px | Pricing cards stack to 1-up; portrait grid drops to 2-up; nav links collapse |
| sm | 719px / 640px | Single-column layouts; display type scales down from 80px |
| xs | 600px | Minimum layout; auth split-panel drops its screenshot marquee |

#### Touch Targets
- Pill buttons and nav CTAs are fixed-height stadium shapes comfortably above the 44px minimum; form inputs pad to a similar height via `{spacing.sm} {spacing.md}`.
- The segmented billing toggle presents each option as a full pill target, not a small radio dot.

#### Collapsing Strategy
- The floating `nav-pill` persists on scroll and across breakpoints, tightening to logomark + CTA on narrow screens.
- Multi-column grids (pricing 2-up, portraits 3-up, testimonials 4-up) collapse column-by-column rather than reflowing horizontally.
- The signup page's two-panel split (form left, angled screenshot marquee right) drops the marquee panel entirely on narrow viewports, keeping the centered form column.

#### Image Behavior
- App screenshots and device mockups keep fixed aspect ratios and `{rounded.md}` corners at all sizes.
- Marquee strips overflow the viewport intentionally and animate horizontally; they crop rather than scale.
- Curator portraits stay square-ish tiles, lazily loaded, always grayscale.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0 | Flat on `{colors.canvas}` | Default — most of every page |
| 1 | `{colors.canvas-soft}` fill, no border | Nav pill, featured pricing card, FAQ rows, soft pills |
| 2 | 1px `{colors.hairline-soft}` outline on white | Pricing and testimonial cards |
| 3 | 1px inset ring | Comparison-table highlight column edge |
| Inverse | `{colors.ink}` fill, `{colors.on-primary}` text | Footer band, primary CTAs |

The system is essentially shadow-free: no drop shadows appear on any card, button, or nav element. Elevation is communicated by *fill difference* (white vs. 6–8% ink tints) and by hairlines, which keeps every surface print-flat and lets the screenshot content supply all depth cues. The one soft-shadow exception is the active segment of the segmented control, which lifts off its `{colors.canvas-soft}` track as a white pill.

### Decorative Depth
- **Glass monoliths** — the awards hero renders tall trophy pillars in a white-to-gray vertical gradient, reading as frosted glass against the `{colors.canvas-soft}` band; the page's only atmospheric gradient.
- **Photography as depth** — floating app-icon squircles, angled screenshot collages (signup's rotated marquee panel), and device mockups create parallax-like layering on a flat canvas.
- **Polarity inversion** — the `{colors.ink}` footer with `{rounded.md}` top corners acts as a heavy baseboard, giving each page a physical end-stop.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Full-bleed media strips and marquee images |
| `{rounded.sm}` | 16px | Inputs, video tiles, testimonial cards, FAQ rows |
| `{rounded.md}` | 24px | Content cards, device mockups, portrait tiles, footer top corners |
| `{rounded.full}` | 9999px | Every pill: nav, buttons, badges, toggles |

### Photography Geometry
- App screenshots render inside device-shaped frames at `{rounded.md}`.
- App icons use the signature 30% squircle radius (`app-icon-squircle`) — the iOS icon silhouette — at every size from 32px chips to 96px hero tiles.
- Curator portraits are near-square tiles at `{rounded.md}`, always black-and-white, with name captions overlaid in `{colors.on-primary}` on a `badge-overlay` scrim near the lower edge.
- Avatars in testimonial cards are small circles (`{rounded.full}`) with a tiny company logo badge overlapping the bottom-right corner.

## Components

### Buttons

**`button-primary`** — "Join for free", "Get started", "Continue", "View winners"
- Fill `{colors.primary}`, label `{colors.on-primary}` in `{typography.link}`, shape `{rounded.full}`, padding `0px {spacing.md}` on a fixed-height pill
- The single CTA style everywhere: nav, pricing cards, auth form, awards hero

**`button-outline`** — "Continue with Google", secondary "Get started"
- Fill `{colors.canvas}`, label `{colors.ink}`, 1px `{colors.hairline}` border, shape `{rounded.full}`
- The de-emphasized twin of the primary pill; used when two actions sit side by side or for third-party auth

**`button-pill-soft`** — "Explore ↗", "Mobbin ↗", "Read more"
- Fill `{colors.canvas-soft}`, label `{colors.ink}`, shape `{rounded.full}`
- Tertiary utility pill for outbound and in-page links; no border, relies on its tint fill

### Cards & Containers

**`pricing-card`** — default plan tier (Team)
- `{colors.canvas}` fill, 1px `{colors.hairline-soft}` outline, `{rounded.md}` corners
- Plan name in `{typography.heading-4}`, price figure large with stacked `{typography.caption}` qualifiers, feature list rows in `{typography.body-sm}` with `{colors.text-muted}` icons

**`pricing-card-featured`** — highlighted plan tier (Pro)
- `{colors.canvas-soft}` fill, borderless, `{rounded.md}` corners — emphasis by tint, not by outline or polarity flip
- Carries the `badge-popular` chip beside the plan name and a full-width `button-primary` CTA, while the default tier gets `button-outline`

**`testimonial-card`** — user quote tile
- `{colors.canvas}` fill, 1px `{colors.hairline-soft}` outline, `{rounded.sm}` corners
- Circular avatar with overlapping company mini-badge, name in `{typography.link}`, company in `{colors.text-muted}` `{typography.body-sm}`, quote in `{typography.body}`
- Laid out as a 4-column masonry of varying heights

**`faq-row`** — accordion item
- Full-width `{colors.canvas-soft}` bar, `{rounded.sm}` corners, question in `{typography.body}` with a trailing chevron; rows stack with `{spacing.sm}` gaps

**`portrait-tile`** — curator/juror grid cell
- Grayscale photograph at `{rounded.md}`, name + role caption overlaid at bottom center in `{colors.on-primary}`
- The strict desaturated treatment keeps the people grid inside the near-monochrome system

### Inputs & Forms

**`text-input`**
- `{colors.field}` fill, no border, `{colors.ink}` text with `{colors.text-faint}` placeholder, `{rounded.sm}` corners, padding `{spacing.sm} {spacing.md}`

**`text-input-focused`**
- Same chrome plus a 2px `{colors.ink}` ring — focus is signaled in ink, consistent with the near-monochrome system

### Navigation

**`nav-pill`** — Top Nav (Desktop)
- A floating, horizontally-centered stadium bar in `{colors.canvas-soft}`: logomark + wordmark left, text links ("Pricing", "Awards", "Log in") in `{typography.link}` right, capped by a `button-primary` CTA
- Detaches from the page edge with visible canvas above it; persists as a sticky element on scroll

**Top Nav (Mobile)**
- The pill tightens to logomark + CTA; links collapse behind the pill

**Sub-nav (Awards)**
- Minimal corner marks instead of a bar: logomark + section name top-left, a `button-pill-soft` "Mobbin ↗" return link top-right

### Signature Components

**`app-icon-squircle`** — the recurring 30%-radius icon tile; floats in loose clouds around library counters, lines up in "Other nominees" rows, and anchors `brand-chip` entries

**`brand-chip`** — marquee lockup of squircle icon + brand name in `{typography.heading-3}` ink; scrolls horizontally in full-bleed strips of recognizable products

**`badge-popular`** — compact `{colors.accent}` chip with `{colors.on-primary}` label marking the featured tier; the only walnut element on the page

**`badge-overlay`** — translucent gray pill (rgba(115, 115, 115, 0.56)) with `{colors.on-primary}` `{typography.label}` text, laid over photography and screenshots (category tags, portrait captions)

**`segmented-control`** + **`segmented-control-active`** — billing-period toggle: a `{colors.canvas-soft}` stadium track holding two pill options; the active option is a `{colors.canvas}` white pill, the inactive label sits in `{colors.text-muted}`

**`award-lockup`** — centered winner presentation: laurel-flanked category eyebrow in `{colors.text-muted}`, winner name in `{typography.heading-3}`, description in `{colors.text-muted}` `{typography.body}`, vote share in `{typography.body-sm}`, closed by a `button-pill-soft` "Explore ↗"

**`compare-table`** — the pricing comparison grid: feature rows divided by 1px `{colors.canvas-soft}` rules, the recommended plan's column washed in `{colors.canvas-soft}` with an inset ring edge

**`footer`** — full-width `{colors.ink}` band with `{rounded.md}` top corners: white wordmark at display scale, tagline in `{colors.text-faint}`, two columns of `{colors.text-faint}` links that read in `{colors.on-primary}` for emphasis rows

### Examples (illustrative)

> Kit-mirror demonstration surfaces. Each `ex-*` entry references brand-native primitives via token syntax so downstream consumers re-skin the same 10 surfaces consistently; none carries invented literal values.

**`ex-pricing-tier`** — Default Pricing tier card. Re-uses feature-card chrome with brand canvas-soft surface.
- Properties: `backgroundColor`, `textColor`, `borderColor`, `rounded`, `padding`

**`ex-pricing-tier-featured`** — Featured/highlighted tier — polarity-flipped surface (dark fill + light text in light mode, light fill + dark text in dark mode).
- Properties: `backgroundColor`, `textColor`, `rounded`, `padding`

**`ex-product-selector`** — What's Included summary card — re-purposed for SaaS / B2B verticals (NOT a literal product gallery).
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-cart-drawer`** — Subscription summary — re-purposed for SaaS / B2B (line items per add-on, not literal cart).
- Properties: `backgroundColor`, `rounded`, `padding`, `item-divider`

**`ex-app-shell-row`** — Sidebar nav row inside the App Shell example. Active state uses brand primary as the indicator.
- Properties: `backgroundColor`, `activeIndicator`, `rounded`, `padding`

**`ex-data-table-cell`** — Default data-table th + td chrome. Header uses mono-caps eyebrow typography; body uses body-sm.
- Properties: `headerBackground`, `headerTypography`, `bodyTypography`, `cellPadding`, `rowBorder`

**`ex-auth-form-card`** — Sign-in / sign-up card. Re-uses feature-card chrome with text-input primitives inside.
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-modal-card`** — Modal dialog surface — same chrome as feature-card with elevated shadow.
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-empty-state-card`** — Empty-state illustration frame.
- Properties: `backgroundColor`, `rounded`, `padding`, `captionTypography`

**`ex-toast`** — Toast notification surface — feature-card shape + medium shadow.
- Properties: `backgroundColor`, `rounded`, `padding`, `typography`


## Do's and Don'ts

### Do
- Keep the canvas `{colors.canvas}` bone and let imported content (furniture photography, material swatches, room scenes) supply all saturation.
- Use `{rounded.full}` for every interactive element — a rectangular button does not exist in this system.
- Build emphasis with the tint ladder: `{colors.canvas-soft}` fill for featured surfaces, `{colors.hairline-soft}` outlines for resting cards.
- Reserve `{colors.accent}` for commercial signals (featured badges, savings callouts, next-best-piece) — one or two walnut elements per page at most.
- Set every heading in Saans 652 with line-height 1.0–1.13 and end headline sentences with a period.
- Pair heavy 652 headings with 300-weight `{typography.body-lg}` subtitles for hierarchy without color.
- Render app icons as 30% squircles and portraits in grayscale to keep third-party imagery inside the system.
- Close pages with the inverse `{colors.ink}` footer, rounded at the top.

### Don't
- Don't add drop shadows — elevation is fills and hairlines only.
- Don't use `{colors.accent}` for CTAs; primary actions are always `{colors.primary}` ink pills.
- Don't introduce additional accent hues, gradients on UI chrome, or colored section bands.
- Don't outline the featured pricing tier — feature it with the `{colors.canvas-soft}` fill and `badge-popular` instead.
- Don't apply letter-spacing or all-caps styling; the type system runs at natural tracking in sentence case.
- Don't put borders on form fields at rest — inputs are `{colors.field}` tint fills; the border appears only as the 2px ink focus ring.
- Don't let full-color photography of people into the curator/juror grids; portraits are strictly black-and-white.
- Don't square off pill geometry at small sizes — badges, chips, and toggles stay stadium-shaped.
