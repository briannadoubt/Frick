# Accessibility Contract

Status: Contract baseline for FR-101 (Design system accessibility hardening).

This document is the accessibility contract for the Frick design system. It
describes the guarantees the design tokens and `@fricken/design-web` components
make, and the mechanisms that enforce them. The contract is intentionally
cross-platform in intent (the contrast core and icon-name contract are
platform-agnostic); the enforced surface today is the TypeScript/web design
system. Native packages (`design-swift`, Android `design`) consume the same
regenerated tokens, so the contrast fixes flow to every platform.

The contract has five parts: **icon names**, **keyboard navigation + focus**,
**screen-reader labels**, **color contrast**, and **reduced motion**.

## 1. Icon names

`@fricken/design-web` exports a frozen, documented set of icon names:

```ts
import { frickIconNames, isFrickIconName, type FrickIconName } from "@fricken/design-web";
```

- `frickIconNames` is the canonical, ordered list of contract names.
- `FrickIconName` is the union type derived from it.
- `isFrickIconName(x)` is a runtime guard.

**Guarantees.**

- Every name in `frickIconNames` resolves to a glyph in **both** icon packs —
  the platform-native pack (lucide on web) and the brand-owned `frick` fallback
  pack — so switching `iconPack` at runtime never yields a missing glyph.
- Names are **append-only**: a name is never renamed or removed without a
  breaking-change major bump. New icons may be added.
- Decorative icons rendered by `FrickIconGlyph` carry `aria-hidden="true"` and
  `focusable="false"`; an icon that conveys meaning on its own (e.g. an
  icon-only button) must be given an accessible name by its container (see §3).

Enforced by `packages/design-web/src/a11y.test.tsx` (duplicate-free list, both
packs complete, guard behavior).

## 2. Keyboard navigation + focus

- Every interactive control is a native interactive element (`<button>`,
  `<input>`, `<textarea>`, `<a>`) or carries an appropriate `role` + `tabindex`,
  so it is reachable and operable by keyboard with no extra work.
- A single, consistent **focus indicator** is applied via `:focus-visible` using
  the `--frick-focus-ring-width` / `--frick-focus-ring-offset` /
  `--frick-focus-ring-color` tokens. It is keyboard-only: the UA default outline
  is suppressed for pointer focus (`:focus:not(:focus-visible)`), satisfying
  WCAG 2.4.7 (Focus Visible).
- The composer submits on `Enter` (Shift/modifier+Enter inserts a newline), and
  exposes the textarea with an `aria-label`.
- `MessageList` is focusable (`role="log"`, `tabIndex={0}`) so keyboard users can
  scroll the transcript.

Enforced by `packages/design-web/src/a11y.test.tsx` (CSS ships the ring +
suppression) and the component role/label tests.

## 3. Screen-reader labels (accessible names + roles)

Interactive and graphical components expose a role and an accessible name:

| Component | Role / element | Accessible name |
| --- | --- | --- |
| `IconButton` | `<button>` | required `label` → `aria-label` + `title` |
| `Composer` | `<textarea>` + `IconButton` | `placeholder` → `aria-label`; `actionLabel` on send |
| `WorkspaceShell` nav | `<nav>` | `aria-label="Workspace destinations"`; selected item `aria-current="page"` |
| `SegmentedControl` | `<button>` per option | `aria-pressed` reflects the active value |
| `PresenceDot` | `role="img"` | `label` (defaults to status) |
| `ProgressRing` | `role="progressbar"` | `aria-label` + `aria-valuemin/max/now` |
| `Toast` / `ErrorMessage` | `role="status"` / `role="alert"` | live-region announcement |
| charts (`LineChart`, …) | `role="img"` | required `label` |

**Rule:** an icon-only control must always receive a text label
(`IconButton`'s `label` is a required prop). Decorative-only glyphs stay
`aria-hidden`.

Enforced by `packages/design-web/src/a11y.test.tsx` and
`packages/design-web/src/components.test.tsx`.

## 4. Color contrast

`@fricken/design` ships a pure, dependency-free contrast core and a declarative
contract over the resolved tokens.

```ts
import {
  contrastRatio,
  relativeLuminance,
  parseHexColor,
  isHexColor,
  WCAG_CONTRAST,
  SEMANTIC_CONTRAST_PAIRS,
  checkContrastPairs,
} from "@fricken/design";
```

- `contrastRatio(a, b)` returns the WCAG 2.1 ratio (1–21) for two hex colors.
- `SEMANTIC_CONTRAST_PAIRS` declares which resolved semantic colors are meant to
  sit on top of one another (e.g. `color.text` on `color.page`, `color.danger`
  on `color.page`) and the minimum ratio each must meet.
- `checkContrastPairs(design.semantic)` evaluates all pairs and **throws** if a
  referenced slot is missing or not a solid hex color (gradients can't silently
  slip into a contrast slot).

**Guarantee.** Every pair in `SEMANTIC_CONTRAST_PAIRS` meets **WCAG AA**
(4.5:1 for text) across **all 12 resolved themes** — `{light, dark}` ×
`{compact, regular, comfortable}` × `{frick, frickenChat}`.

**Consequences baked into the tokens.** Status tones are *mode-aware*: a single
color can't clear 4.5:1 against both a light page and a near-black page, so dark
mode uses lighter `success`/`warning`/`danger`/`info` variants. The `frickenChat`
brand uses a darkened primary action color so white text clears AA on the fill,
and inherits the mode-aware mint chat bubble rather than a light blue bubble that
would be illegible with dark-mode (near-white) text.

**To add a legible-on-surface relationship**, add an entry to
`SEMANTIC_CONTRAST_PAIRS` — the suite then enforces it across every theme.

Enforced by `packages/design/tests/a11y.test.ts`. (The design-package style
validator in `validate.ts` independently checks the core text/action pairs at
generate time.)

## 5. Reduced motion

Any animated affordance respects the user's OS preference. `components.css`
includes:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Animations and transitions are *neutralized*, not removed — final layout and
state are unchanged, only the motion is gone (WCAG 2.3.3). The typing indicator's
bounce animation is disabled and falls back to a static muted state.

## 6. Dynamic Type / text scaling (native)

Native text honors the OS text-size preference (iOS Dynamic Type, Android
font-scale), satisfying WCAG 1.4.4 (Resize Text). The shared typography token
*values* (point sizes in the generated tokens) are unchanged; each platform
applies them through its scaling mechanism (FR-102).

**iOS (`design-swift`).** The generated `FrickTokens.Typography` fonts are built
with `Font.system(size:)`, which produces a **fixed** point size that does not
respond to Dynamic Type. `FrickTypography` therefore applies each role via a
relative text style (`Font.system(_:design:weight:)`) anchored to the OS Dynamic
Type ramp — heading → `.title` (rounded, bold), body → `.callout`, label →
`.footnote` (semibold), mono → `.footnote` (monospaced) — preserving each role's
design intent while scaling. `FrickButton` titles likewise map their control size
to a relative style (`.footnote`/`.callout`/`.body`). The raw fixed-size tokens
remain available as `FrickTypography.Fixed.*` for non-scaling needs.

**Android (`design`).** All typography tokens (`FrickTokens.typography.body`,
`.heading`, `.label`) are declared in scalable `sp` units, which Compose scales
by the OS `fontScale` automatically. No component or theme forces
`fontScale = 1f` or overrides `LocalDensity`, so text tracks the system setting.

Enforced by `packages/design-swift/Tests/FrickDesignTests/FrickDesignTests.swift`
(roles use scaling styles and differ from the fixed tokens) and
`apps/android/design/src/test/java/dev/frick/design/FrickDesignTest.kt`
(typography tokens are `sp`).

Enforced by `packages/design-web/src/a11y.test.tsx`.
