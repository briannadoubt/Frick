# @fricken/react

React provider and hooks on top of [`@fricken/core`](../core).

## Install

```sh
pnpm add @fricken/react @fricken/core @fricken/protocol react
```

## Usage

```tsx
import { FrickProvider, useObjects, useStream, useSyncStatus } from "@fricken/react";

function App() {
  return (
    <FrickProvider endpoint="ws://127.0.0.1:4099/_frick/sync">
      <Items />
    </FrickProvider>
  );
}

function Items() {
  const items = useObjects("Item");
  return <pre>{JSON.stringify(items, null, 2)}</pre>;
}
```

## Hooks

- `useFrick()` / `useFrickHttpEndpoint()` / `useFrickSession()`
- `useObjects(type)` / `useObject(type, id)`
- `useStream(stream, key)`
- `useProjection(name)` / `useProjectionRows(name)`
- `usePresence(name, key)` / `useSetPresence(name, key)`
- `useSignalChannel(name, key)` / `useSendSignal(name, key)`
- `useAppend(stream, key)`
- `useTrackAnalyticsEvent()`
- `useSyncStatus()`
- `useOptionalEndpoint(path)` for app-owned HTTP helper routes on the same Frick origin
- `useInbox(userId)` remains as a legacy optional-endpoint wrapper for apps that still expose `/inbox`; the framework server no longer ships a built-in inbox route.

## Analytics

`<FrickProvider>` records route analytics after a session is available. The
default payload includes only `path` and document `title`; pass
`autoAnalytics={false}` to disable it or an options object to customize event
names and route properties. `useTrackAnalyticsEvent()` posts explicit
authenticated product events through the same `/analytics/events` route.

## License

See repository root.
