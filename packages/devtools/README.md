# `@fricken/devtools`

An embeddable React panel for inspecting a running Frick app in development. Mount it inside a `<FrickProvider>` tree and you get a floating console that surfaces connection status, the mutation queue, and the live `/_frick/inspect/devtools/events` feed (HTTP requests, sync frames, push deliveries, jobs).

```tsx
import { FrickProvider } from "@fricken/react";
import { FrickDevtools } from "@fricken/devtools";

function App() {
  return (
    <FrickProvider client={client}>
      <Routes />
      <FrickDevtools enabled={import.meta.env.DEV} />
    </FrickProvider>
  );
}
```

## Props

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Set to `false` in production builds to render nothing. |
| `pollIntervalMs` | `number` | `2000` | How often the event feed re-polls. |
| `fetchImpl` | `typeof fetch` | `globalThis.fetch` | Tests inject a stub. |
| `initialKindFilter` | `string` | `""` | Pre-fills the kind-substring filter. |
| `placement` | `"bottom-right" \| "bottom-left" \| "top-right" \| "top-left"` | `"bottom-right"` | Corner of the viewport. |

## Authentication

The panel uses the `FrickClient.sessionToken` from the surrounding provider so admin-scoped feeds work for an authenticated operator. If you're not logged in as an admin, the server returns 404 — open dev-login first.

## Production considerations

The component ships unminified React markup and re-fetches every two seconds. Always gate it behind a `import.meta.env.DEV` check (or equivalent for your bundler) so it never ships to end users.
