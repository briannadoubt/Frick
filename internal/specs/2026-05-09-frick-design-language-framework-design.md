# Frick Design Language Framework

## Status

Approved design for a framework-level design language layer. This spec covers the design contract and first component surface area. It does not include an implementation plan.

## Goal

Frick should have a cross-platform native design framework, not three separately styled demo apps. A single canonical design definition should generate static artifacts for web, SwiftUI, and Android Compose so apps can use the same semantic tokens, icon names, component names, variants, and runtime theme settings while still rendering with native platform primitives.

The first proof point is a more playful, bubbly realtime communication surface, but the design layer must support broader product UI too: forms, layout, data display, date/time inputs, charts, feedback states, and operational surfaces.

## Core Decisions

- Use a typed canonical authoring system for agents and humans.
- Generate pure static artifacts for every runtime.
- Keep native component implementations per platform.
- Use semantic icon aliases with platform-native mappings and custom icon pack fallbacks.
- Use a 4-point base metric and derive all spacing, padding, radius, sizing, and component metrics through aliases.
- Support runtime-switchable mode, density, brand, and icon pack.
- Default density is `regular`; supported densities are `compact`, `regular`, and `comfortable`.

## Architecture

Use a token-first, native-implementation model.

```txt
packages/design
  src/frick.tokens.ts
  src/frick.icons.ts
  src/frick.components.ts
  dist/frick.design.json

packages/design-web
  React provider, hooks, CSS variables, token exports, components

packages/design-swift
  SwiftUI environment, generated tokens/icons/theme structs, components

apps/android/design
  Compose theme, generated tokens/icons/theme objects, components
```

The canonical `packages/design` package owns the typed token DSL, icon alias DSL, component role metadata, validation, normalized JSON output, and platform generators. Generated outputs are committed so Xcode and Gradle builds do not depend on TypeScript execution.

## Token Graph

The token system is a resolved graph, not a bag of constants. It supports primitives, semantic aliases, component aliases, runtime modes, density transforms, brand packs, and icon pack resolution.

Token families include scaled numeric metrics, color roles, gradients, typography, shadows, opacity, motion, z-order, and component defaults. Numeric metrics use the 4-point base unit unless a platform-native control requires an explicit exception. Exceptions must be named in the canonical config instead of hidden in component code.

Example shape:

```txt
primitive.unit = 4

primitive.space.1 = primitive.unit * 1
primitive.space.2 = primitive.unit * 2
primitive.space.3 = primitive.unit * 3
primitive.space.4 = primitive.unit * 4
primitive.space.5 = primitive.unit * 5
primitive.space.6 = primitive.unit * 6

semantic.spacing.extraSmall = primitive.space.1
semantic.spacing.small = primitive.space.2
semantic.spacing.medium = primitive.space.4
semantic.padding.extraSmall = semantic.spacing.extraSmall
semantic.color.surface.base = primitive.color.neutral.0
semantic.gradient.brand.hero = primitive.gradient.mintBlue
semantic.typography.body = primitive.font.body.md

density.compact.semantic.spacing.medium = primitive.space.3
density.regular.semantic.spacing.medium = primitive.space.4
density.comfortable.semantic.spacing.medium = primitive.space.5

component.chatBubble.paddingX = semantic.spacing.medium
component.chatBubble.radius = semantic.corner.bubble
component.textField.font = semantic.typography.body
component.button.primary.background = semantic.color.action.primary
```

The public rule is that app and framework UI code asks for meaning, not numbers. For example, `chatBubble.paddingX` resolves to `12`, `16`, or `20` depending on density, but consumers do not hard-code those numbers.

## Runtime Design Context

Every platform exposes one runtime design context:

```txt
mode: system | light | dark
density: compact | regular | comfortable
brand: frick | frickenChat | custom
iconPack: native | frick | custom
```

The context is runtime switchable. Apps can still choose fixed defaults, but changing the context should update resolved colors, metrics, icons, and component appearances without rebuilding or restarting the app.

Example APIs:

```tsx
<FrickDesignProvider mode="system" density="regular" brand="frick" iconPack="native">
  {children}
</FrickDesignProvider>
```

```swift
.environment(\.frickDesign, .init(
    mode: .system,
    density: .regular,
    brand: .frick,
    iconPack: .native
))
```

```kotlin
FrickDesignTheme(
    mode = FrickMode.System,
    density = FrickDensity.Regular,
    brand = FrickBrand.Frick,
    iconPack = FrickIconPack.Native,
)
```

## Icon Language

Icons are semantic aliases with platform mappings and fallback chains. Components and apps use semantic names only.

```txt
icon.action.send:
  web: lucide:Send
  ios: sf:paperplane.fill
  android: material:send
  fallback: frick:send

icon.status.live:
  web: lucide:RadioTower
  ios: sf:antenna.radiowaves.left.and.right
  android: material:wifi_tethering
  fallback: frick:status-live
```

Native platform icon sets are the default. Brand or product packs may override aliases or provide embedded vector assets. This keeps branding flexible while preserving a stable component interface.

## Component Principles

Components share names, roles, variants, sizes, slots, and state semantics across platforms. They do not share a rendering engine. Web components use React and web platform primitives. iOS components are SwiftUI-native. Android components are Compose-native.

Components must consume generated tokens and icon aliases. Raw styling literals should be rejected where linting or review automation can reasonably enforce it.

Components should feel native on each platform while staying recognizably Frick through shared rhythm, density, color roles, icon meaning, typography roles, and component behavior.

## Phase 1 Component Set

### Foundation

- `FrickDesignProvider` and native theme context
- `FrickIcon`
- `FrickText`
- `FrickHeading`
- `FrickLabel`
- `FrickDivider`
- `FrickSpacer`

### Layout

- `FrickSurface`
- `FrickStack`
- `FrickInline`
- `FrickCluster`
- `FrickAppShell`
- `FrickToolbar`
- `FrickScrollArea`

### Controls

- `FrickButton`
- `FrickIconButton`
- `FrickTextField`
- `FrickTextArea` on web and multiline text input on native
- `FrickSegmentedControl`
- `FrickToggle`

### Feedback And State

- `FrickBadge`
- `FrickStatusChip`
- `FrickPresenceDot`
- `FrickProgressRing`
- `FrickToast` or transient banner equivalent
- `FrickErrorState`
- `FrickEmptyState`

### Identity

- `FrickAvatar`
- `FrickAvatarGroup`
- `FrickUserRow`

### Communication

- `FrickMessageList`
- `FrickChatBubble`
- `FrickComposer`
- `FrickTypingIndicator`
- `FrickReceipt`
- `FrickReactionRow`
- `FrickSignalPanel`
- `FrickCallButton`

### Data Display

- `FrickTable`
- `FrickDataGrid`
- `FrickColumn`
- `FrickCell`
- `FrickMetricCard`
- `FrickTimeline`

### Date And Time

- `FrickDatePicker`
- `FrickTimePicker`
- `FrickDateTimePicker`
- `FrickDateRangePicker`

### Charts

- `FrickChartSurface`
- `FrickLineChart`
- `FrickBarChart`
- `FrickAreaChart`
- `FrickPieChart`
- `FrickSparkline`

## Phase 1 Component Depth

Phase 1 components should be real and usable, but scoped. The design framework should prove shared APIs, native rendering, tokenized styling, runtime design context, and generated platform contracts.

Tables and grids should support semantic columns, cells, loading, empty, error, selection, simple sorting, and simple column sizing. They should not become a full enterprise grid engine yet.

Date and time pickers should map to platform-native controls when available. The shared API should cover labels, values, ranges, disabled state, validation/error display, and density-aware layout.

Charts should support simple data series, labels, empty/error/loading states, tokenized color palettes, and basic line, bar, area, pie, and sparkline visuals. They should not become a BI platform in Phase 1.

Communication components should deliver the bubbly chat surface: incoming and outgoing bubbles, avatars, presence, typing state, composer, receipts, reactions, and call/signal affordances. These are proving components for realtime products, not a declaration that Frick is only a chat framework.

## Validation

`pnpm design:check` validates the canonical config before generation.

Validation should catch:

- missing aliases
- circular aliases
- off-scale spacing, padding, radius, and size values
- invalid density overrides
- invalid runtime tuple references
- missing icon mappings
- unknown native icon names where validation is possible
- invalid color formats
- required contrast failures
- component variants without token-backed metrics
- component icon references that do not use semantic aliases
- raw styling literals in framework components where linting is practical

## Generation

`pnpm design:generate` writes:

- normalized `packages/design/dist/frick.design.json`
- web CSS variables
- web TypeScript token/icon/component metadata
- Swift token structs, icon aliases, and design context types
- Kotlin token objects, icon aliases, and design context types

Generated artifacts should be deterministic and committed. Platform package builds should fail if generated artifacts are stale.

## Testing

The first implementation should include:

- token resolver unit tests
- alias and density resolution tests
- icon mapping validation tests
- generated artifact snapshot tests
- web component render tests for provider, buttons, fields, surfaces, chat bubbles, tables, pickers, and charts
- Swift compile tests for generated tokens/icons and representative SwiftUI components
- Android compile tests for generated tokens/icons and representative Compose components
- demo app runtime checks confirming web, iOS, and Android consume the same semantic design layer

## Rollout

Phase 1 should:

- introduce the design packages and generator
- convert the web, iOS, and Android demo apps to generated tokens and shared semantic components
- make the current message UI bubbly with chat bubbles, anchored message lists, avatars, status chips, and native composers
- expose runtime controls for at least mode and density in the demo
- keep the data sync framework separate from the design framework while proving they fit together naturally

Phase 1 should not:

- publish external packages
- build a custom icon editor
- generate all behavioral component code
- implement every enterprise grid, chart, picker, or modal edge case
- replace platform-native UI idioms with a lowest-common-denominator renderer

## Success Criteria

- The same canonical design definition generates web, Swift, and Kotlin artifacts.
- Demo app UI code has almost no raw styling numbers.
- The same semantic component set exists across web, SwiftUI, and Compose.
- Runtime mode, density, brand, and icon pack resolution are part of the public design context.
- Icons are referenced semantically and resolved per platform.
- Web, iOS, and Android demos render a more fun, bubbly realtime UI while remaining native.
- The component library is broad enough for serious realtime products: communication UI, forms, layout, feedback, data display, date/time inputs, and charts.
