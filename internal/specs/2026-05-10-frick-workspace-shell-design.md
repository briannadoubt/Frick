# Frick Workspace Shell Design

## Purpose

Frick needs a reusable navigation foundation that scales beyond a single chat screen. The shell must let apps share one navigation language while rendering with each platform's preferred navigation paradigm.

The shell is not a chat component. It is a cross-platform workspace primitive that apps can use for chat, files, calls, admin tools, settings, or future modules.

## Core Navigation Language

Frick defines semantic slots, not identical chrome:

- **Destination**: A top-level app mode such as Chat, Files, Calls, Admin, or Settings.
- **Collection**: A destination-local list such as threads, folders, rooms, projects, or call history.
- **Content**: The primary work surface for the current destination and collection selection.
- **Inspector**: Contextual details and actions for the current content, such as members, metadata, permissions, or activity.
- **Commands**: Create, search, reload, sign out, profile, and other transient actions.

The API should make these concepts explicit so every app has the same structure even when the rendered navigation changes by platform, device, or window size.

## Platform Mapping

### Apple Platforms

SwiftUI should use `TabView` with `.tabViewStyle(.sidebarAdaptable)` as the top-level shell. On compact iPhone layouts, destinations appear as bottom tabs. On iPad and Mac-sized layouts, those destinations adapt into the platform sidebar.

The first Frick shell implementation must not use a root `NavigationSplitView`. Destination content can own its own nested navigation in a later module-specific component, but the workspace shell's Apple mapping is `TabView` plus `.sidebarAdaptable`.

Inspector content should use SwiftUI's `.inspector(isPresented:content:)` pattern. On compact devices, the system presents it as a sheet-like surface; on larger layouts, it becomes a side inspector.

### Android

Android should use Material 3 adaptive navigation. The shell maps Frick destinations into `NavigationSuiteScaffold` items. Compact phones use a bottom navigation bar; expanded windows, tablets, and foldables use a navigation rail or drawer according to Material guidance.

Destination-local collection/content patterns use Material adaptive panes when the destination needs simultaneous list/detail presentation. Inspector content presents as a bottom sheet on compact layouts and as a supporting pane on expanded layouts.

### Web

Web should render the same semantic shell with responsive CSS:

- Compact: bottom destination bar, destination content as the main surface, collection and inspector as drawer/sheet surfaces.
- Desktop: app rail, collection sidebar, content pane, optional inspector pane.

The DOM order must remain accessible: destination navigation first, then collection navigation, then main content, then inspector. Keyboard navigation and ARIA labels are part of the component contract.

## Component API Shape

Each component library should expose a workspace shell and supporting navigation items.

Suggested cross-platform concepts:

- `FrickWorkspaceDestination`: id, label, semantic icon, enabled state, optional badge.
- `selectedDestination`: app-owned selection state.
- `collection`: destination-owned sidebar or list content.
- `content`: primary screen content.
- `inspector`: optional contextual content.
- `isInspectorPresented`: app-owned inspector visibility state.
- `commands`: platform-rendered command actions.

Web example:

```tsx
<WorkspaceShell
  destinations={destinations}
  selectedDestination={selectedDestination}
  onDestinationChange={setSelectedDestination}
  collection={<ThreadList />}
  inspector={<ThreadInspector />}
  inspectorOpen={inspectorOpen}
  onInspectorOpenChange={setInspectorOpen}
  header={<ChatHeader />}
  footer={<Composer />}
>
  <ChatThread />
</WorkspaceShell>
```

SwiftUI example:

```swift
FrickWorkspaceShell(
    destinations: destinations,
    selection: $selectedDestination,
    inspectorPresented: $inspectorPresented
) { destination in
    ChatWorkspace()
} inspector: {
    ThreadInspector()
}
```

Android example:

```kotlin
FrickWorkspaceShell(
    destinations = destinations,
    selectedDestination = selectedDestination,
    onDestinationSelected = { selectedDestination = it },
    inspectorVisible = inspectorVisible,
    onInspectorVisibleChange = { inspectorVisible = it },
    collection = { ThreadList() },
    inspector = { ThreadInspector() },
) {
    ChatThread()
}
```

The exact generic signatures can vary by platform, but the semantic slots should remain stable.

## Demo App Cutover

The current Foundation chat demo should become a Chat destination inside the workspace shell.

Initial destinations:

- Chat: enabled and selected by default.
- Files: visible placeholder.
- Calls: visible placeholder.
- Admin: visible placeholder.

The current thread creation/list should move into the collection area. The message list remains content. The composer becomes the pinned footer/action area. User/session/status/member details move out of the main message flow and into header or inspector content.

This should reduce the piled-up single-column UX while creating a reusable pattern for future apps.

## Implementation Notes

- Keep the design-system component names platform-native but semantically aligned.
- Do not force pixel parity across platforms.
- Do not put all navigation concerns in app demo views; reusable shell primitives belong in `packages/design-web`, `packages/design-swift`, and `apps/android/design`.
- Keep disabled placeholder destinations honest: visible but not interactive, or interactive with a simple placeholder screen.
- The shell should remain usable when no inspector is supplied.

## Testing

Web:

- Unit test the shell renders destinations, selected state, collection, content, inspector, header, and footer.
- Browser-test desktop and compact layouts after integration.

Swift:

- Build the design package and iOS app.
- Add light tests for destination model behavior if the Swift package exposes pure data helpers.
- Verify iPhone compact presentation uses bottom tabs and the inspector is sheet-like.
- Verify the first implementation does not wrap the Apple shell in `NavigationSplitView`.

Android:

- Build the design module and app with warnings as errors.
- Unit test destination model behavior where practical.
- Verify emulator compact presentation uses bottom navigation and the chat screen remains usable.

Cross-platform:

- All three demos should show the same destinations, thread collection, selected chat content, inspector affordance, and sign-in/sign-out behavior.
