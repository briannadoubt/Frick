# Frick Workspace Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable cross-platform Frick workspace navigation shell and cut the web, iOS, and Android demos over to it.

**Architecture:** Frick defines semantic navigation concepts: top-level destinations, destination-local collection, primary content, inspector, header, footer, and commands. Each component library renders those semantics with platform-native navigation: responsive web chrome, SwiftUI `TabView` with `.sidebarAdaptable`, and Android Material 3 adaptive navigation. The demo apps become consumers of the component library shell instead of owning all layout structure themselves.

**Tech Stack:** React 19, TypeScript, CSS, SwiftUI iOS 18/macOS 15, Jetpack Compose Material 3, Material 3 adaptive navigation suite, Vitest, XCTest, Robolectric/JUnit, Xcode, Gradle.

---

## File Structure

- Modify `packages/design-web/src/components.tsx`: add `WorkspaceShell`, `WorkspaceDestination`, and small navigation helpers.
- Modify `packages/design-web/src/icons.tsx`: add semantic icon aliases needed by workspace destinations.
- Modify `packages/design-web/src/components.css`: add responsive shell, destination rail/bar, collection, inspector, header, content, and footer styles.
- Modify `packages/design-web/src/components.test.tsx`: add SSR tests for the workspace shell contract.
- Modify `packages/design-swift/Sources/FrickDesign/FoundationComponents.swift`: replace the old `FrickAppShell` `NavigationSplitView` wrapper with a new `FrickWorkspaceShell` based on `TabView(...).tabViewStyle(.sidebarAdaptable)` and `.inspector`.
- Modify `packages/design-swift/Tests/FrickDesignTests/FrickDesignTests.swift`: add pure API tests for workspace destinations and shell stored properties.
- Modify `apps/android/design/build.gradle.kts`: add Material 3 adaptive navigation suite.
- Create `apps/android/design/src/main/java/dev/frick/design/NavigationComponents.kt`: add `FrickWorkspaceDestination`, `FrickWorkspaceDefaults`, and `FrickWorkspaceShell`.
- Modify `apps/android/design/src/test/java/dev/frick/design/FrickDesignTest.kt`: add tests for destination defaults and adaptive pane breakpoint helper.
- Modify `apps/web/src/App.tsx`: move chat layout into `WorkspaceShell`, with threads as collection and signals/members/details as inspector.
- Modify `apps/web/src/styles.css`: remove now-duplicated grid shell rules and keep demo-specific chat sizing/polish.
- Modify `apps/ios/FrickDemo/ContentView.swift`: add destination state, use `FrickWorkspaceShell`, move threads to a collection subview, and move users/status into inspector/header affordances.
- Modify `apps/android/app/src/main/java/dev/frick/demo/MainActivity.kt`: add destination state, use `FrickWorkspaceShell`, keep chat as selected destination, and move users/status into inspector/supporting content.

## Task 1: Web Design-System Workspace Shell

**Files:**
- Modify: `packages/design-web/src/components.test.tsx`
- Modify: `packages/design-web/src/icons.tsx`
- Modify: `packages/design-web/src/components.tsx`
- Modify: `packages/design-web/src/components.css`

- [ ] **Step 1: Write the failing SSR test**

Add `WorkspaceShell` to the imports in `packages/design-web/src/components.test.tsx`:

```tsx
import {
  Badge,
  Button,
  ChatBubble,
  Composer,
  FrickDesignProvider,
  IconButton,
  PresenceDot,
  SegmentedControl,
  Stack,
  Text,
  TextField,
  WorkspaceShell,
  useFrickDesign,
} from "./index.js";
```

Add this test in the existing `describe` block:

```tsx
  test("renders workspace shell semantic navigation slots", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={[
          { id: "chat", label: "Chat", icon: "message" },
          { id: "files", label: "Files", icon: "paperclip", disabled: true, badge: "Soon" },
        ]}
        selectedDestination="chat"
        onDestinationChange={() => undefined}
        collection={<div>Threads collection</div>}
        header={<div>Header area</div>}
        footer={<div>Composer area</div>}
        inspector={<div>Inspector area</div>}
        inspectorOpen
      >
        <div>Primary chat content</div>
      </WorkspaceShell>,
    );

    expect(html).toContain("frick-workspace-shell");
    expect(html).toContain('aria-label="Workspace destinations"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Threads collection");
    expect(html).toContain("Primary chat content");
    expect(html).toContain("Inspector area");
    expect(html).toContain("Composer area");
    expect(html).toContain("Soon");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm exec vitest run packages/design-web/src/components.test.tsx
```

Expected: fail because `WorkspaceShell` is not exported.

- [ ] **Step 3: Extend web semantic icons**

Update `packages/design-web/src/icons.tsx` so workspace destinations have stable semantic icon names:

```tsx
import type { ComponentType, SVGProps } from "react";
import { LoaderCircle, MessageCircle, Paperclip, Radio, RefreshCw, Send, Settings, Video } from "lucide-react";

export type FrickIcon = ComponentType<SVGProps<SVGSVGElement>>;
export type FrickIconName = "send" | "reload" | "live" | "message" | "paperclip" | "video" | "settings";

export const icons = {
  action: {
    send: Send,
    reload: RefreshCw,
    settings: Settings,
  },
  status: {
    live: Radio,
    loading: LoaderCircle,
  },
  chat: {
    message: MessageCircle,
    attachment: Paperclip,
  },
  call: {
    video: Video,
  },
} as const;

export const semanticIcons: Record<FrickIconName, FrickIcon> = {
  send: icons.action.send,
  reload: icons.action.reload,
  live: icons.status.live,
  message: icons.chat.message,
  paperclip: icons.chat.attachment,
  video: icons.call.video,
  settings: icons.action.settings,
};
```

- [ ] **Step 4: Implement the React component**

Add these exports near the existing `AppShell` in `packages/design-web/src/components.tsx`:

```tsx
export interface WorkspaceDestination {
  id: string;
  label: ReactNode;
  icon?: FrickIconName;
  disabled?: boolean;
  badge?: ReactNode;
}

export interface WorkspaceShellProps extends HTMLAttributes<HTMLDivElement> {
  destinations: WorkspaceDestination[];
  selectedDestination: string;
  onDestinationChange?: (destinationId: string) => void;
  collection?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  inspector?: ReactNode;
  inspectorOpen?: boolean;
  onInspectorOpenChange?: (open: boolean) => void;
}

export function WorkspaceShell({
  destinations,
  selectedDestination,
  onDestinationChange,
  collection,
  header,
  footer,
  inspector,
  inspectorOpen = Boolean(inspector),
  onInspectorOpenChange,
  children,
  className,
  ...props
}: WorkspaceShellProps) {
  return (
    <div className={cx("frick-workspace-shell", className)} {...props}>
      <nav className="frick-workspace-shell__destinations" aria-label="Workspace destinations">
        {destinations.map((destination) => {
          const selected = destination.id === selectedDestination;
          return (
            <button
              aria-current={selected ? "page" : undefined}
              className="frick-workspace-shell__destination"
              data-selected={selected}
              disabled={destination.disabled}
              key={destination.id}
              onClick={() => onDestinationChange?.(destination.id)}
              type="button"
            >
              {destination.icon ? <FrickIconGlyph name={destination.icon} /> : null}
              <span>{destination.label}</span>
              {destination.badge ? <b>{destination.badge}</b> : null}
            </button>
          );
        })}
      </nav>

      <div className="frick-workspace-shell__body">
        {collection ? <aside className="frick-workspace-shell__collection">{collection}</aside> : null}
        <section className="frick-workspace-shell__content-shell">
          {header ? <header className="frick-workspace-shell__header">{header}</header> : null}
          <main className="frick-workspace-shell__content">{children}</main>
          {footer ? <footer className="frick-workspace-shell__footer">{footer}</footer> : null}
        </section>
        {inspector ? (
          <aside className="frick-workspace-shell__inspector" data-open={inspectorOpen}>
            <div className="frick-workspace-shell__inspector-actions">
              <button type="button" onClick={() => onInspectorOpenChange?.(false)}>
                Close
              </button>
            </div>
            {inspector}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add responsive shell CSS**

Add to `packages/design-web/src/components.css` after the existing `.frick-app-shell` block:

```css
.frick-workspace-shell {
  background: var(--frick-color-bg);
  color: var(--frick-color-fg);
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr);
  min-block-size: 100dvh;
}

.frick-workspace-shell__destinations {
  align-content: start;
  background: var(--frick-color-bg-raised);
  border-inline-end: var(--frick-border-width) solid var(--frick-color-border);
  display: grid;
  gap: var(--frick-space-2);
  padding: var(--frick-space-3);
}

.frick-workspace-shell__destination {
  align-items: center;
  background: transparent;
  border: var(--frick-border-width) solid transparent;
  border-radius: var(--frick-radius-md);
  color: var(--frick-color-fg-muted);
  cursor: pointer;
  display: grid;
  gap: var(--frick-space-1);
  justify-items: center;
  min-block-size: 4rem;
  padding: var(--frick-space-2);
}

.frick-workspace-shell__destination[data-selected="true"] {
  background: var(--frick-color-primary);
  color: var(--frick-color-primary-fg);
}

.frick-workspace-shell__destination:disabled {
  cursor: default;
  opacity: 0.48;
}

.frick-workspace-shell__destination b {
  font-size: var(--frick-font-size-xs);
}

.frick-workspace-shell__body {
  display: grid;
  grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr) minmax(16rem, 20rem);
  min-block-size: 100dvh;
  min-inline-size: 0;
}

.frick-workspace-shell__collection,
.frick-workspace-shell__header,
.frick-workspace-shell__footer,
.frick-workspace-shell__inspector {
  border-color: var(--frick-color-border);
}

.frick-workspace-shell__collection {
  border-inline-end: var(--frick-border-width) solid var(--frick-color-border);
  overflow: auto;
  padding: var(--frick-space-4);
}

.frick-workspace-shell__content-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-inline-size: 0;
}

.frick-workspace-shell__header,
.frick-workspace-shell__footer {
  padding: var(--frick-space-4);
}

.frick-workspace-shell__header {
  border-block-end: var(--frick-border-width) solid var(--frick-color-border);
}

.frick-workspace-shell__content {
  min-block-size: 0;
  overflow: hidden;
  padding: var(--frick-space-4);
}

.frick-workspace-shell__footer {
  border-block-start: var(--frick-border-width) solid var(--frick-color-border);
}

.frick-workspace-shell__inspector {
  border-inline-start: var(--frick-border-width) solid var(--frick-color-border);
  overflow: auto;
  padding: var(--frick-space-4);
}

.frick-workspace-shell__inspector-actions {
  display: none;
}

@media (max-width: 760px) {
  .frick-workspace-shell {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .frick-workspace-shell__destinations {
    align-content: center;
    border-block-start: var(--frick-border-width) solid var(--frick-color-border);
    border-inline-end: 0;
    display: grid;
    grid-row: 2;
    grid-template-columns: repeat(auto-fit, minmax(4rem, 1fr));
    padding: var(--frick-space-2);
  }

  .frick-workspace-shell__body {
    grid-template-columns: 1fr;
    grid-row: 1;
    min-block-size: 0;
  }

  .frick-workspace-shell__collection {
    border-block-end: var(--frick-border-width) solid var(--frick-color-border);
    border-inline-end: 0;
    max-block-size: 34dvh;
  }

  .frick-workspace-shell__inspector {
    background: var(--frick-color-bg-raised);
    border-radius: var(--frick-radius-md) var(--frick-radius-md) 0 0;
    border-inline-start: 0;
    box-shadow: var(--frick-shadow-raised);
    inset-block-end: 0;
    inset-inline: var(--frick-space-2);
    max-block-size: 70dvh;
    position: fixed;
    transform: translateY(110%);
    transition: transform var(--frick-duration-normal);
    z-index: 20;
  }

  .frick-workspace-shell__inspector[data-open="true"] {
    transform: translateY(0);
  }

  .frick-workspace-shell__inspector-actions {
    display: flex;
    justify-content: flex-end;
  }
}
```

- [ ] **Step 6: Run the web component test**

Run:

```bash
pnpm exec vitest run packages/design-web/src/components.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/design-web/src/icons.tsx packages/design-web/src/components.tsx packages/design-web/src/components.css packages/design-web/src/components.test.tsx
git commit -m "feat(web-design): add workspace shell"
```

## Task 2: SwiftUI Design-System Workspace Shell

**Files:**
- Modify: `packages/design-swift/Sources/FrickDesign/FoundationComponents.swift`
- Modify: `packages/design-swift/Tests/FrickDesignTests/FrickDesignTests.swift`

- [ ] **Step 1: Write failing Swift package tests**

Add to `packages/design-swift/Tests/FrickDesignTests/FrickDesignTests.swift`:

```swift
    func testWorkspaceDestinationStoresNavigationContract() {
        let destination = FrickWorkspaceDestination(id: "chat", title: "Chat", icon: .chatMessage, isEnabled: true, badge: "2")

        XCTAssertEqual(destination.id, "chat")
        XCTAssertEqual(destination.title, "Chat")
        XCTAssertEqual(destination.icon, .chatMessage)
        XCTAssertEqual(destination.isEnabled, true)
        XCTAssertEqual(destination.badge, "2")
    }

    func testWorkspaceShellStoresDestinationsAndSelection() {
        let destinations = [
            FrickWorkspaceDestination(id: "chat", title: "Chat", icon: .chatMessage),
            FrickWorkspaceDestination(id: "files", title: "Files", icon: .paperclip, isEnabled: false),
        ]
        let selection = Binding.constant("chat")
        let inspectorPresented = Binding.constant(true)
        let shell = FrickWorkspaceShell(
            destinations: destinations,
            selection: selection,
            inspectorPresented: inspectorPresented
        ) { destination in
            Text(destination.title)
        } inspector: {
            Text("Inspector")
        }

        XCTAssertEqual(shell.destinations.map(\.id), ["chat", "files"])
        XCTAssertEqual(shell.selection.wrappedValue, "chat")
        XCTAssertEqual(shell.inspectorPresented.wrappedValue, true)
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
swift test --package-path packages/design-swift
```

Expected: fail because `FrickWorkspaceDestination` and `FrickWorkspaceShell` do not exist.

- [ ] **Step 3: Implement the SwiftUI shell**

In `packages/design-swift/Sources/FrickDesign/FoundationComponents.swift`, replace the current `FrickAppShell` with:

```swift
public struct FrickWorkspaceDestination: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let icon: FrickIconName
    public let isEnabled: Bool
    public let badge: String?

    public init(id: String, title: String, icon: FrickIconName, isEnabled: Bool = true, badge: String? = nil) {
        self.id = id
        self.title = title
        self.icon = icon
        self.isEnabled = isEnabled
        self.badge = badge
    }
}

public struct FrickWorkspaceShell<Content: View, Inspector: View>: View {
    public let destinations: [FrickWorkspaceDestination]
    public let selection: Binding<String>
    public let inspectorPresented: Binding<Bool>
    private let content: (FrickWorkspaceDestination) -> Content
    private let inspector: () -> Inspector

    public init(
        destinations: [FrickWorkspaceDestination],
        selection: Binding<String>,
        inspectorPresented: Binding<Bool> = .constant(false),
        @ViewBuilder content: @escaping (FrickWorkspaceDestination) -> Content,
        @ViewBuilder inspector: @escaping () -> Inspector
    ) {
        self.destinations = destinations
        self.selection = selection
        self.inspectorPresented = inspectorPresented
        self.content = content
        self.inspector = inspector
    }

    public var body: some View {
        TabView(selection: selection) {
            ForEach(destinations) { destination in
                content(destination)
                    .tabItem {
                        Label(destination.title, systemImage: destination.icon.rawValue)
                    }
                    .tag(destination.id)
                    .disabled(!destination.isEnabled)
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .inspector(isPresented: inspectorPresented) {
            inspector()
        }
        .background(FrickPalette.background)
    }
}

```

- [ ] **Step 4: Run the Swift design tests**

Run:

```bash
swift test --package-path packages/design-swift
```

Expected: pass.

- [ ] **Step 5: Verify no root NavigationSplitView remains in the design shell**

Run:

```bash
rg -n "NavigationSplitView" packages/design-swift/Sources/FrickDesign
```

Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add packages/design-swift/Sources/FrickDesign/FoundationComponents.swift packages/design-swift/Tests/FrickDesignTests/FrickDesignTests.swift
git commit -m "feat(swift-design): add sidebar adaptable workspace shell"
```

## Task 3: Android Design-System Workspace Shell

**Files:**
- Modify: `apps/android/design/build.gradle.kts`
- Create: `apps/android/design/src/main/java/dev/frick/design/NavigationComponents.kt`
- Modify: `apps/android/design/src/test/java/dev/frick/design/FrickDesignTest.kt`

- [ ] **Step 1: Add failing Android design tests**

Add this import near the other imports in `apps/android/design/src/test/java/dev/frick/design/FrickDesignTest.kt`:

```kotlin
import dev.frick.design.generated.FrickIconName
```

Append these tests inside `public class FrickDesignTest`:

```kotlin
    @Test
    public fun workspaceDestinationStoresNavigationContract() {
        val destination = FrickWorkspaceDestination(
            id = "chat",
            label = "Chat",
            icon = FrickIconName.ChatMessage,
            enabled = true,
            badge = "2",
        )

        assertEquals("chat", destination.id)
        assertEquals("Chat", destination.label)
        assertEquals(FrickIconName.ChatMessage, destination.icon)
        assertEquals(true, destination.enabled)
        assertEquals("2", destination.badge)
    }

    @Test
    public fun workspaceDefaultsUseExpandedPanesOnlyForWideLayouts() {
        assertEquals(false, FrickWorkspaceDefaults.usesExpandedPanes(600.dp))
        assertEquals(true, FrickWorkspaceDefaults.usesExpandedPanes(840.dp))
        assertEquals(true, FrickWorkspaceDefaults.usesExpandedPanes(1200.dp))
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/android
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools \
PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH \
./gradlew :design:testDebugUnitTest
```

Expected: fail because `FrickWorkspaceDestination` and `FrickWorkspaceDefaults` do not exist.

- [ ] **Step 3: Add the adaptive navigation dependency**

In `apps/android/design/build.gradle.kts`, add:

```kotlin
    implementation("androidx.compose.material3:material3-adaptive-navigation-suite")
```

Place it near the existing Material 3 dependency.

- [ ] **Step 4: Implement Android navigation components**

Create `apps/android/design/src/main/java/dev/frick/design/NavigationComponents.kt`:

```kotlin
package dev.frick.design

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.frick.design.generated.FrickIconName

public data class FrickWorkspaceDestination(
    val id: String,
    val label: String,
    val icon: FrickIconName,
    val enabled: Boolean = true,
    val badge: String? = null,
)

public object FrickWorkspaceDefaults {
    public val expandedPaneBreakpoint: Dp = 840.dp

    public fun usesExpandedPanes(width: Dp): Boolean = width >= expandedPaneBreakpoint
}

@Composable
public fun FrickWorkspaceShell(
    destinations: List<FrickWorkspaceDestination>,
    selectedDestination: String,
    onDestinationSelected: (String) -> Unit,
    modifier: Modifier = Modifier,
    collection: @Composable () -> Unit = {},
    inspectorVisible: Boolean = false,
    inspector: @Composable () -> Unit = {},
    content: @Composable () -> Unit,
) {
    NavigationSuiteScaffold(
        modifier = modifier,
        navigationSuiteItems = {
            destinations.forEach { destination ->
                item(
                    selected = destination.id == selectedDestination,
                    enabled = destination.enabled,
                    onClick = { onDestinationSelected(destination.id) },
                    icon = { Text(destination.label.prefix(1).uppercased()) },
                    label = { Text(destination.label) },
                )
            }
        },
    ) {
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            if (FrickWorkspaceDefaults.usesExpandedPanes(maxWidth)) {
                Row(modifier = Modifier.fillMaxSize()) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(0.28f)
                            .padding(FrickDesign.spacing.md),
                    ) {
                        collection()
                    }
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .padding(FrickDesign.spacing.md),
                    ) {
                        content()
                    }
                    if (inspectorVisible) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth(0.24f)
                                .padding(FrickDesign.spacing.md),
                        ) {
                            inspector()
                        }
                    }
                }
            } else {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(FrickDesign.spacing.md),
                ) {
                    content()
                }
            }
        }
    }
}
```

If `FrickIconName.ChatMessage` does not match the generated enum case name, inspect `apps/android/design/src/main/java/dev/frick/design/generated/FrickTokens.kt` and use the generated chat icon case.

- [ ] **Step 5: Run Android design tests**

Run:

```bash
cd apps/android
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools \
PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH \
./gradlew :design:testDebugUnitTest
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/android/design/build.gradle.kts apps/android/design/src/main/java/dev/frick/design/NavigationComponents.kt apps/android/design/src/test/java/dev/frick/design/FrickDesignTest.kt
git commit -m "feat(android-design): add adaptive workspace shell"
```

## Task 4: Web Demo Cutover

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add the failing integration expectation**

Add a test to `apps/web/src/chat-foundation.test.ts` or a new `apps/web/src/workspace-shell.test.tsx` if React DOM server tests already run cleanly:

```tsx
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceShell } from "@frick/design-web";

describe("web workspace shell integration contract", () => {
  test("renders chat as a workspace destination with collection and inspector", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={[
          { id: "chat", label: "Chat", icon: "message" },
          { id: "files", label: "Files", icon: "paperclip", disabled: true },
        ]}
        selectedDestination="chat"
        collection={<div>Threads</div>}
        inspector={<div>Signals</div>}
      >
        <div>Messages</div>
      </WorkspaceShell>,
    );

    expect(html).toContain("Chat");
    expect(html).toContain("Threads");
    expect(html).toContain("Messages");
    expect(html).toContain("Signals");
  });
});
```

- [ ] **Step 2: Run the test**

Run:

```bash
pnpm exec vitest run apps/web/src/workspace-shell.test.tsx
```

Expected before Task 1 is complete: fail. Expected after Task 1: pass.

- [ ] **Step 3: Import the shell in the app**

Change the design import in `apps/web/src/App.tsx`:

```tsx
import { Avatar, ChatBubble, FrickDesignProvider, MessageList, WorkspaceShell } from "@frick/design-web";
```

Add destination state in `ChatWorkspace`:

```tsx
  const [selectedDestination, setSelectedDestination] = useState("chat");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const workspaceDestinations = useMemo(
    () => [
      { id: "chat", label: "Chat", icon: "message" as const },
      { id: "files", label: "Files", icon: "paperclip" as const, disabled: true, badge: "Soon" },
      { id: "calls", label: "Calls", icon: "video" as const, disabled: true, badge: "Soon" },
      { id: "admin", label: "Admin", icon: "settings" as const, disabled: true, badge: "Soon" },
    ],
    [],
  );
```

- [ ] **Step 4: Replace the signed-in JSX shell**

Replace the current `<main className="shell">...` return in `ChatWorkspace` with:

```tsx
  return (
    <WorkspaceShell
      className="chat-workspace-shell"
      destinations={workspaceDestinations}
      selectedDestination={selectedDestination}
      onDestinationChange={setSelectedDestination}
      collection={<ThreadsPanel />}
      header={<ChatHeader />}
      footer={<ChatComposer />}
      inspector={<ChatInspector />}
      inspectorOpen={inspectorOpen}
      onInspectorOpenChange={setInspectorOpen}
    >
      {selectedDestination === "chat" ? <ChatMessages /> : <PlaceholderDestination label={selectedDestination} />}
    </WorkspaceShell>
  );
```

Extract the existing topbar JSX into `ChatHeader`, the current threads/member sidebar into `ThreadsPanel`, the message panel body into `ChatMessages`, the composer form into `ChatComposer`, and the signals/member detail content into `ChatInspector`. Keep the extracted functions inside `ChatWorkspace` at first so they can close over existing state without a risky data-flow refactor.

- [ ] **Step 5: Add placeholder destination component**

Add near `Metric`:

```tsx
function PlaceholderDestination({ label }: { label: string }) {
  return (
    <section className="placeholder-destination">
      <h2>{label[0]?.toUpperCase()}{label.slice(1)}</h2>
      <p>This destination is wired into the Frick workspace shell and ready for a real module.</p>
    </section>
  );
}
```

- [ ] **Step 6: Adjust demo CSS**

In `apps/web/src/styles.css`, keep chat-specific classes like `.messages`, `.composer`, `.chat-bubble`, and `.thread-create`, but remove or de-emphasize the old `.workspace`, `.grid`, `.side-panel`, `.message-panel`, and `.call-panel` as layout owners. Add:

```css
.chat-workspace-shell {
  min-block-size: 100dvh;
}

.chat-workspace-shell .messages {
  block-size: 100%;
}

.placeholder-destination {
  align-content: center;
  display: grid;
  gap: 0.75rem;
  min-block-size: 100%;
  text-align: center;
}
```

- [ ] **Step 7: Run web checks**

Run:

```bash
pnpm typecheck
pnpm exec vitest run packages/design-web/src/components.test.tsx apps/web/src/workspace-shell.test.tsx
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/styles.css apps/web/src/workspace-shell.test.tsx
git commit -m "feat(web): use workspace shell navigation"
```

## Task 5: iOS Demo Cutover

**Files:**
- Modify: `apps/ios/FrickDemo/ContentView.swift`

- [ ] **Step 1: Add model state for workspace navigation**

In `FoundationModel`, add:

```swift
    @Published var selectedDestination = "chat"
    @Published var isInspectorPresented = false
```

Reset both in `logout()`:

```swift
        selectedDestination = "chat"
        isInspectorPresented = false
```

- [ ] **Step 2: Add destination definitions**

Near `defaultConversationId`, add:

```swift
private let workspaceDestinations = [
    FrickWorkspaceDestination(id: "chat", title: "Chat", icon: .chatMessage),
    FrickWorkspaceDestination(id: "files", title: "Files", icon: .paperclip, isEnabled: false, badge: "Soon"),
    FrickWorkspaceDestination(id: "calls", title: "Calls", icon: .callVideo, isEnabled: false, badge: "Soon"),
    FrickWorkspaceDestination(id: "admin", title: "Admin", icon: .settings, isEnabled: false, badge: "Soon"),
]
```

- [ ] **Step 3: Replace the signed-in root with `FrickWorkspaceShell`**

Change `ContentView.body` for the signed-in branch:

```swift
            } else {
                FrickWorkspaceShell(
                    destinations: workspaceDestinations,
                    selection: $model.selectedDestination,
                    inspectorPresented: $model.isInspectorPresented
                ) { destination in
                    if destination.id == "chat" {
                        ChatScene(model: model, bottomMessageAnchor: bottomMessageAnchor)
                    } else {
                        PlaceholderDestination(destination: destination)
                    }
                } inspector: {
                    ChatInspector(model: model)
                }
            }
```

- [ ] **Step 4: Move non-message details into inspector**

Create below `ChatScene`:

```swift
private struct ChatInspector: View {
    @ObservedObject var model: FoundationModel

    var body: some View {
        FrickStack(spacing: .lg) {
            FrickHeading("Thread Details")
            FrickLabel(LocalizedStringKey(model.status))
            FrickDivider()
            FrickLabel("Members")
            ForEach(model.users, id: \.id) { user in
                FrickUserRow(name: user.displayName, subtitle: "Synced user", isOnline: true)
            }
        }
        .padding()
    }
}
```

Remove the `Section("Users")` from `ChatScene` so the message surface is no longer a pile of everything.

- [ ] **Step 5: Add a toolbar inspector toggle**

In `ChatScene.toolbar`, add:

```swift
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    model.isInspectorPresented.toggle()
                } label: {
                    Image(systemName: "sidebar.right")
                }
                .accessibilityLabel("Thread details")
            }
```

- [ ] **Step 6: Add placeholder destinations**

Add:

```swift
private struct PlaceholderDestination: View {
    let destination: FrickWorkspaceDestination

    var body: some View {
        FrickStack(spacing: .md, alignment: .center) {
            FrickIcon(destination.icon, size: 28)
            FrickHeading(LocalizedStringKey(destination.title))
            FrickLabel("This workspace destination is ready for a real module.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
```

- [ ] **Step 7: Build iOS**

Run:

```bash
xcodebuild -project apps/ios/FrickDemo.xcodeproj -scheme FrickDemo -destination 'platform=iOS Simulator,name=iPhone 17' build -quiet
```

Expected: pass and no warnings.

- [ ] **Step 8: Verify the Apple shell is not `NavigationSplitView` based**

Run:

```bash
rg -n "NavigationSplitView" packages/design-swift apps/ios/FrickDemo
```

Expected: no matches for the new shell implementation. If a destination-specific nested navigation appears later, document why before committing.

- [ ] **Step 9: Commit**

```bash
git add apps/ios/FrickDemo/ContentView.swift
git commit -m "feat(ios): use sidebar adaptable workspace shell"
```

## Task 6: Android Demo Cutover

**Files:**
- Modify: `apps/android/app/src/main/java/dev/frick/demo/MainActivity.kt`

- [ ] **Step 1: Add destination state**

Add near existing state in `FrickDemo()`:

```kotlin
    var selectedDestination by remember { mutableStateOf("chat") }
    var inspectorVisible by remember { mutableStateOf(false) }
    val workspaceDestinations = remember {
        listOf(
            FrickWorkspaceDestination(id = "chat", label = "Chat", icon = FrickIconName.ChatMessage),
            FrickWorkspaceDestination(id = "files", label = "Files", icon = FrickIconName.ChatMessage, enabled = false, badge = "Soon"),
            FrickWorkspaceDestination(id = "calls", label = "Calls", icon = FrickIconName.CallVideo, enabled = false, badge = "Soon"),
            FrickWorkspaceDestination(id = "admin", label = "Admin", icon = FrickIconName.ActionReload, enabled = false, badge = "Soon"),
        )
    }
```

The Android generated icon enum currently has `ActionSend`, `ActionReload`, `StatusLive`, `ChatMessage`, and `CallVideo`. Use those cases until the shared icon language grows file/admin-specific aliases.

- [ ] **Step 2: Import shell APIs**

Add imports:

```kotlin
import dev.frick.design.FrickWorkspaceDestination
import dev.frick.design.FrickWorkspaceShell
import dev.frick.design.generated.FrickIconName
```

- [ ] **Step 3: Replace signed-in column layout**

Inside the `else` branch where `activeSession != null`, replace the sequential `Header`, `ThreadsPanel`, `UsersRow`, `MessagesList`, `Composer` block with:

```kotlin
            FrickWorkspaceShell(
                destinations = workspaceDestinations,
                selectedDestination = selectedDestination,
                onDestinationSelected = { destination ->
                    if (workspaceDestinations.firstOrNull { item -> item.id == destination }?.enabled == true) {
                        selectedDestination = destination
                    }
                },
                modifier = Modifier.weight(1f),
                collection = {
                    ThreadsPanel(
                        conversations = conversations,
                        selectedConversationId = selectedConversationId,
                        newThreadTitle = newThreadTitle,
                        threadError = threadError,
                        isCreatingThread = isCreatingThread,
                        onNewThreadTitleChange = {
                            newThreadTitle = it
                            threadError = null
                        },
                        onCreateThread = { scope.launch { createThread() } },
                        onSelectConversation = { conversationId ->
                            if (selectedConversationId != conversationId) {
                                selectedConversationId = conversationId
                                messages = emptyList()
                                draft = ""
                                threadError = null
                                status = "Loading"
                            }
                        },
                    )
                },
                inspectorVisible = inspectorVisible,
                inspector = {
                    ChatInspector(status = status, users = users)
                },
            ) {
                if (selectedDestination == "chat") {
                    ChatContent(
                        users = users,
                        messages = messages,
                        localUserId = activeSession.userId,
                        draft = draft,
                        onDraftChange = { nextDraft -> draft = nextDraft },
                        onSend = { scope.launch { send() } },
                    )
                } else {
                    PlaceholderDestination(label = selectedDestination)
                }
            }
```

Keep `Header` above the shell for now so sign-out/reload remain obvious. Add a `Thread details` button in `Header` after this cutover if the inspector needs a visible toggle.

- [ ] **Step 4: Extract content and inspector composables**

Add:

```kotlin
@Composable
private fun ChatContent(
    users: List<UserDto>,
    messages: List<FrickStreamEvent>,
    localUserId: String,
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        MessagesList(
            users = users,
            messages = messages,
            localUserId = localUserId,
            modifier = Modifier.weight(1f),
        )
        Composer(draft = draft, onDraftChange = onDraftChange, onSend = onSend)
    }
}

@Composable
private fun ChatInspector(status: String, users: List<UserDto>) {
    FrickSurface(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            FrickLabel(text = status)
            FrickDivider()
            UsersRow(users = users)
        }
    }
}

@Composable
private fun PlaceholderDestination(label: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        FrickStack(horizontalAlignment = Alignment.CenterHorizontally) {
            FrickHeading(text = label.replaceFirstChar { char -> char.uppercaseChar() })
            FrickLabel(text = "This workspace destination is ready for a real module.")
        }
    }
}
```

- [ ] **Step 5: Add inspector toggle**

Extend `Header` with `onToggleInspector: () -> Unit`, then add another `FrickTextButton`:

```kotlin
            FrickTextButton(
                text = "Details",
                onClick = onToggleInspector,
                modifier = Modifier.weight(1f),
            )
```

Call it from the signed-in branch:

```kotlin
onToggleInspector = { inspectorVisible = !inspectorVisible },
```

- [ ] **Step 6: Build Android**

Run:

```bash
cd apps/android
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools \
PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH \
./gradlew :design:testDebugUnitTest :app:assembleDebug
```

Expected: pass and no warnings.

- [ ] **Step 7: Commit**

```bash
git add apps/android/app/src/main/java/dev/frick/demo/MainActivity.kt
git commit -m "feat(android): use adaptive workspace shell"
```

## Task 7: Rendered Verification Across All Front Ends

**Files:**
- No production changes expected.

- [ ] **Step 1: Run full local checks**

Run:

```bash
pnpm typecheck
pnpm test
swift test --package-path packages/design-swift
xcodebuild -project apps/ios/FrickDemo.xcodeproj -scheme FrickDemo -destination 'platform=iOS Simulator,name=iPhone 17' build -quiet
cd apps/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH ./gradlew :design:testDebugUnitTest :frick:testDebugUnitTest :app:assembleDebug
```

Expected: all pass.

- [ ] **Step 2: Verify web in the in-app browser**

Open `http://127.0.0.1:5173/` in the Browser plugin and verify:

- Page is not blank.
- No Vite/framework overlay.
- Console errors/warnings are absent or explained.
- Desktop layout shows destination rail, thread collection, chat content, and inspector.
- Compact viewport shows bottom destination navigation.
- Sending a chat message still works.

- [ ] **Step 3: Verify iOS simulator**

Run:

```bash
xcrun simctl launch booted dev.frick.demo
```

If the bundle id differs, resolve it from `apps/ios/project.yml`.

Verify:

- Compact iPhone shows destination tabs at the bottom.
- It does not show a root `NavigationSplitView` sidebar on iPhone.
- Thread details opens through the inspector affordance.
- Sending a message still works and keeps focus behavior intact.

- [ ] **Step 4: Verify Android emulator**

Run:

```bash
cd apps/android
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools \
PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH \
./gradlew :app:installDebug
adb -s emulator-5554 shell am start -n dev.frick.demo/.MainActivity
adb -s emulator-5554 exec-out uiautomator dump /dev/tty > /tmp/frick-workspace-android.xml
python3 /Users/bri/.codex/plugins/cache/openai-curated/test-android-apps/63976030/skills/android-emulator-qa/scripts/ui_tree_summarize.py /tmp/frick-workspace-android.xml /tmp/frick-workspace-android.txt
cat /tmp/frick-workspace-android.txt
```

Verify the tree includes Chat, Files, Calls, Admin, Threads, message composer, and Details.

- [ ] **Step 5: Final whitespace and status check**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Only intentional uncommitted files remain.

- [ ] **Step 6: Commit verification-only fixes if needed**

Only commit if the rendered verification finds small fixes:

```bash
git add <changed-files>
git commit -m "fix: polish workspace shell integration"
```

## Self-Review

Spec coverage:

- Semantic navigation language: Tasks 1, 2, and 3 add the cross-platform shell API.
- Apple `sidebarAdaptable` and no root `NavigationSplitView`: Task 2 implements this and Task 5/7 verify it.
- Android adaptive navigation: Task 3 uses Material 3 `NavigationSuiteScaffold`; Task 6 consumes it.
- Web responsive shell: Task 1 implements CSS and Task 4 consumes it.
- Demo cutover: Tasks 4, 5, and 6 update the demos.
- Testing: Task 7 verifies all three front ends.

Placeholder scan:

- No `TBD` or `TODO` steps are present.
- Placeholder destinations are intentional product UI for disabled modules and are specified with exact labels.

Type consistency:

- Web uses `WorkspaceDestination` and `WorkspaceShell`.
- Swift uses `FrickWorkspaceDestination` and `FrickWorkspaceShell`.
- Android uses `FrickWorkspaceDestination`, `FrickWorkspaceDefaults`, and `FrickWorkspaceShell`.
