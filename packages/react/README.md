# @frick/react

React provider and hooks on top of [`@frick/core`](../core).

## Install

```sh
pnpm add @frick/react @frick/core @frick/protocol react
```

## Usage

```tsx
import { FrickProvider, useObjects, useStream, useProjection, useSyncStatus } from "@frick/react";

function App() {
  return (
    <FrickProvider endpoint="ws://127.0.0.1:4099/_frick/sync">
      <Inbox />
    </FrickProvider>
  );
}

function Inbox() {
  const rows = useProjection<{ unreadCount: number }>("conversation-inbox");
  return <pre>{JSON.stringify(rows, null, 2)}</pre>;
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
- `useSyncStatus()`
- `useInbox(userId)` / `useOptionalEndpoint(path)`

## License

See repository root.
