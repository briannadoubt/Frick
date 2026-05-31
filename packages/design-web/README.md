# @frick/design-web

React design primitives and workspace shell components for Frick web apps, built on tokens generated from [`@frick/design`](../design).

## Install

```sh
pnpm add @frick/design-web react
```

## What's in here

- Generated design tokens (`src/generated/`)
- `FrickDesignProvider` + `useDesignContext` — the runtime design context
- Foundation components: buttons, cards, text fields, sparkline
- Data components for surface chrome
- The `WorkspaceShell` adaptive layout, `WorkspaceListItem`, `MessageList`, navigation primitives — used by the Frick demo web app

Components are unopinionated about routing and data — they're shape-only React primitives. Wire them to your app via [`@frick/react`](../react)'s hooks.

## Runtime design context

Wrap your app in `FrickDesignProvider` and switch any axis — `mode`, `density`, `brand`, `iconPack` — at runtime without a reload. The provider applies the matching `data-frick-*` attributes that select the generated token block in `tokens.css`, so every resolved color, metric, and component updates live.

```tsx
import { FrickDesignProvider } from "@frick/design-web";

<FrickDesignProvider mode="system" density="regular" brand="frick" iconPack="native">
  {children}
</FrickDesignProvider>;
```

Axes can be **controlled** (pass the prop) or **uncontrolled** (seed with `defaultMode` / `defaultDensity` / `defaultBrand` / `defaultIconPack` and switch via the setters on the context):

```tsx
import { useDesignContext } from "@frick/design-web";

function ThemeToggle() {
  const { mode, setMode } = useDesignContext();
  return <button onClick={() => setMode(mode === "dark" ? "light" : "dark")}>Toggle theme</button>;
}
```

`useDesignContext()` is the canonical accessor (`useFrickDesign()` is a back-compat alias). It exposes the active `mode` / `density` / `brand` / `iconPack`, the resolved `dataAttributes`, static `tokens` metadata, and the `setMode` / `setDensity` / `setBrand` / `setIconPack` / `setDesignContext` setters. Defaults are `light` / `regular` / `frick` / `native`, matching the generated `:root` token block.

## License

See repository root.
