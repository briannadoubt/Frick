# @frick/design-web

React design primitives and workspace shell components for Frick web apps, built on tokens generated from [`@frick/design`](../design).

## Install

```sh
pnpm add @frick/design-web react
```

## What's in here

- Generated design tokens (`src/generated/`)
- Foundation components: buttons, cards, text fields, sparkline
- Data components for surface chrome
- The `WorkspaceShell` adaptive layout, `WorkspaceListItem`, `MessageList`, navigation primitives — used by the Frick demo web app

Components are unopinionated about routing and data — they're shape-only React primitives. Wire them to your app via [`@frick/react`](../react)'s hooks.

## License

See repository root.
