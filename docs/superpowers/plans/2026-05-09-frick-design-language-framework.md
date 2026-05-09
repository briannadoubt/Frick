# Frick Design Language Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a framework-level cross-platform design language with one typed token/icon/component source of truth, generated static artifacts, native web/SwiftUI/Compose components, and demo apps using bubbly tokenized chat surfaces.

**Architecture:** Use a token-first, native-implementation model. `packages/design` owns the typed DSL, resolver, validation, and generators; `packages/design-web`, `packages/design-swift`, and `apps/android/design` expose platform-native components backed by generated artifacts. Demo apps consume the platform packages and should contain almost no raw styling numbers.

**Tech Stack:** TypeScript 5.9, Vitest, React 19, CSS variables, Swift 6 / SwiftUI / Charts, Android AGP 9.2 / Kotlin 2.3 / Compose Material3.

---

## File Structure

Create these new design framework units:

- `packages/design/`: canonical typed token/icon/component config, resolver, validators, generators, and tests.
- `packages/design-web/`: React provider, generated CSS variables, generated token metadata, semantic icon resolver, and web components.
- `packages/design-swift/`: Swift package named `FrickDesign`, generated token/icon/context structs, and SwiftUI components.
- `apps/android/design/`: Android library module named `dev.frick.design`, generated token/icon/context objects, and Compose components.

Modify existing integration points:

- `package.json`: add design scripts and include design packages in typecheck.
- `pnpm-workspace.yaml`: current `packages/*` pattern already covers new TS packages.
- `apps/web/package.json`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`: consume `@frick/design-web` and remove local design primitives.
- `apps/ios/project.yml`, `apps/ios/FrickDemo/ContentView.swift`: add the local Swift design package and consume `FrickDesign`.
- `apps/android/settings.gradle.kts`, `apps/android/app/build.gradle.kts`, `apps/android/app/src/main/java/dev/frick/demo/MainActivity.kt`: add `:design` and consume `dev.frick.design`.
- `README.md`: document `pnpm design:check`, `pnpm design:generate`, and runtime theme/density controls.

Implementation boundaries:

- `packages/design` must not import React, Swift, Android, or app code.
- `packages/design-web` must not import `@frick/react`; demo apps compose data hooks with design components.
- `packages/design-swift` must not import `FrickSwift`; demo apps compose data clients with design components.
- `apps/android/design` must not depend on `:frick`; demo apps compose data clients with design components.

---

### Task 1: Scaffold Design Packages And Scripts

**Files:**
- Modify: `package.json`
- Create: `packages/design/package.json`
- Create: `packages/design/tsconfig.json`
- Create: `packages/design/src/index.ts`
- Create: `packages/design-web/package.json`
- Create: `packages/design-web/tsconfig.json`
- Create: `packages/design-web/src/index.ts`
- Create: `packages/design-swift/Package.swift`
- Create: `packages/design-swift/Sources/FrickDesign/FrickDesign.swift`
- Create: `apps/android/design/build.gradle.kts`
- Create: `apps/android/design/src/main/AndroidManifest.xml`
- Create: `apps/android/design/src/main/java/dev/frick/design/FrickDesign.kt`
- Modify: `apps/android/settings.gradle.kts`

- [ ] **Step 1: Write the package scaffolds**

Create `packages/design/package.json`:

```json
{
  "name": "@frick/design",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "check": "tsx src/scripts/check.ts",
    "generate": "tsx src/scripts/generate.ts",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^24.10.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vitest": "^4.0.8"
  }
}
```

Create `packages/design/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist-types"
  },
  "include": ["src"]
}
```

Create `packages/design/src/index.ts`:

```ts
export * from "./model.js";
export * from "./define.js";
export * from "./resolver.js";
export * from "./frick.design.js";
```

Create `packages/design-web/package.json`:

```json
{
  "name": "@frick/design-web",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.tsx",
    "./tokens.css": "./src/generated/tokens.css"
  },
  "dependencies": {
    "@frick/design": "workspace:*",
    "lucide-react": "^0.556.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "peerDependencies": {
    "react": ">=18"
  },
  "devDependencies": {
    "@types/react": "^19.2.7",
    "@types/react-dom": "^19.2.3",
    "typescript": "^5.9.3"
  }
}
```

Create `packages/design-web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "rootDir": "src",
    "outDir": "dist-types"
  },
  "references": [{ "path": "../design" }],
  "include": ["src"]
}
```

Create `packages/design-web/src/index.ts`:

```ts
export const frickDesignWebScaffold = true;
```

Create `packages/design-swift/Package.swift`:

```swift
// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "FrickDesign",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "FrickDesign", targets: ["FrickDesign"]),
    ],
    targets: [
        .target(name: "FrickDesign"),
        .testTarget(name: "FrickDesignTests", dependencies: ["FrickDesign"]),
    ]
)
```

Create `packages/design-swift/Sources/FrickDesign/FrickDesign.swift`:

```swift
import SwiftUI

public enum FrickDesignScaffold {
    public static let isAvailable = true
}
```

Create `apps/android/design/build.gradle.kts`:

```kotlin
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.frick.design"
    compileSdk = 37

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        warningsAsErrors = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.05.00")
    implementation(composeBom)

    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
}

tasks.withType<JavaCompile>().configureEach {
    options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror"))
}

tasks.withType<KotlinJvmCompile>().configureEach {
    compilerOptions {
        allWarningsAsErrors.set(true)
        jvmTarget.set(JvmTarget.JVM_17)
    }
}
```

Create `apps/android/design/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android" />
```

Create `apps/android/design/src/main/java/dev/frick/design/FrickDesign.kt`:

```kotlin
package dev.frick.design

object FrickDesignScaffold {
    const val isAvailable: Boolean = true
}
```

Update `apps/android/settings.gradle.kts` to include the design module:

```kotlin
include(":app")
include(":frick")
include(":design")
```

- [ ] **Step 2: Update root scripts**

In `package.json`, update scripts to include the design build:

```json
{
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b packages/protocol packages/core packages/react packages/design packages/design-web apps/server apps/web",
    "schema:generate": "tsx packages/protocol/scripts/generate-native-artifacts.ts",
    "design:check": "pnpm --filter @frick/design check",
    "design:generate": "pnpm --filter @frick/design generate",
    "server": "pnpm --filter @frick/server dev",
    "web": "pnpm --filter @frick/web dev",
    "tilt": "tilt up",
    "ios:generate": "pnpm schema:generate && pnpm design:generate && cd apps/ios && xcodegen generate",
    "ios:build": "pnpm schema:generate && pnpm design:generate && cd apps/ios && xcodebuild -project FrickDemo.xcodeproj -scheme FrickDemo -destination 'platform=iOS Simulator,name=iPhone 17' build",
    "swift:test": "pnpm schema:generate && pnpm design:generate && swift test --package-path packages/swift && swift test --package-path packages/design-swift",
    "android:build": "pnpm schema:generate && pnpm design:generate && cd apps/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH ./gradlew :frick:testDebugUnitTest :frick:lintDebug :frick:assembleDebug :design:lintDebug :design:assembleDebug :app:lintDebug :app:assembleDebug",
    "android:emulator": "sh scripts/android-emulator.sh",
    "android:install": "export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH; adb start-server && adb wait-for-device && adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk && adb shell am start -n dev.frick.demo/.MainActivity"
  }
}
```

Keep the existing dependency block unchanged.

- [ ] **Step 3: Verify scaffolds compile enough to expose missing generator files**

Run:

```bash
pnpm install
pnpm typecheck
swift test --package-path packages/design-swift
cd apps/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH ./gradlew :design:assembleDebug
```

Expected before Task 2: `pnpm typecheck` fails because `packages/design/src/model.ts`, `define.ts`, `resolver.ts`, and `frick.design.ts` do not exist. Swift and Android scaffolds compile.

- [ ] **Step 4: Commit scaffold**

```bash
git add package.json pnpm-lock.yaml apps/android/settings.gradle.kts packages/design packages/design-web packages/design-swift apps/android/design
git commit -m "feat(design): scaffold cross-platform design packages"
```

---

### Task 2: Implement Token/Icon/Component Model And Tests

**Files:**
- Create: `packages/design/src/model.ts`
- Create: `packages/design/src/define.ts`
- Create: `packages/design/src/frick.design.ts`
- Create: `packages/design/src/resolver.ts`
- Create: `packages/design/tests/resolver.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Create `packages/design/tests/resolver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { frickDesignDefinition } from "../src/frick.design.js";
import { resolveDesign } from "../src/resolver.js";

describe("Frick design resolver", () => {
  it("resolves regular density semantic aliases from the 4-point scale", () => {
    const design = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });

    expect(design.semantic.spacing.extraSmall).toBe(4);
    expect(design.semantic.spacing.medium).toBe(16);
    expect(design.component.chatBubble.paddingX).toBe(16);
    expect(design.component.button.height).toBe(40);
  });

  it("resolves compact and comfortable density overrides", () => {
    const compact = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "compact",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });
    const comfortable = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "comfortable",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });

    expect(compact.semantic.spacing.medium).toBe(12);
    expect(compact.component.button.height).toBe(32);
    expect(comfortable.semantic.spacing.medium).toBe(20);
    expect(comfortable.component.button.height).toBe(48);
  });

  it("resolves semantic icon aliases for platform-native packs", () => {
    const web = resolveDesign(frickDesignDefinition, {
      mode: "dark",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });
    const ios = resolveDesign(frickDesignDefinition, {
      mode: "dark",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "ios",
    });

    expect(web.icons["action.send"]).toEqual({ family: "lucide", name: "Send" });
    expect(ios.icons["action.send"]).toEqual({ family: "sf", name: "paperplane.fill" });
  });

  it("rejects unresolved aliases", () => {
    expect(() =>
      resolveDesign(
        {
          ...frickDesignDefinition,
          semantic: {
            ...frickDesignDefinition.semantic,
            spacing: { broken: { $alias: "primitive.space.999" } },
          },
        },
        {
          mode: "light",
          density: "regular",
          brand: "frick",
          iconPack: "native",
          platform: "web",
        },
      ),
    ).toThrow("Unresolved alias primitive.space.999");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @frick/design test -- tests/resolver.test.ts
```

Expected: FAIL because model and resolver files do not exist.

- [ ] **Step 3: Implement the model and typed DSL**

Create `packages/design/src/model.ts`:

```ts
export type FrickMode = "light" | "dark";
export type FrickDensity = "compact" | "regular" | "comfortable";
export type FrickBrand = "frick" | "frickenChat";
export type FrickIconPack = "native" | "frick";
export type FrickPlatform = "web" | "ios" | "android";

export type TokenPrimitive = string | number | boolean | TokenAlias;
export type TokenTree = { readonly [key: string]: TokenPrimitive | TokenTree };

export interface TokenAlias {
  readonly $alias: string;
}

export interface IconMapping {
  readonly family: "lucide" | "sf" | "material" | "frick";
  readonly name: string;
}

export interface IconAliasDefinition {
  readonly web: IconMapping;
  readonly ios: IconMapping;
  readonly android: IconMapping;
  readonly fallback: IconMapping;
}

export interface ComponentDefinition {
  readonly [component: string]: TokenTree;
}

export interface FrickDesignDefinition {
  readonly primitive: TokenTree;
  readonly semantic: TokenTree;
  readonly density: Record<FrickDensity, TokenTree>;
  readonly modes: Record<FrickMode, TokenTree>;
  readonly brands: Record<FrickBrand, TokenTree>;
  readonly component: ComponentDefinition;
  readonly icons: Record<string, IconAliasDefinition>;
}

export interface ResolveOptions {
  readonly mode: FrickMode;
  readonly density: FrickDensity;
  readonly brand: FrickBrand;
  readonly iconPack: FrickIconPack;
  readonly platform: FrickPlatform;
}

export interface ResolvedDesign {
  readonly options: ResolveOptions;
  readonly primitive: Record<string, unknown>;
  readonly semantic: Record<string, any>;
  readonly component: Record<string, any>;
  readonly icons: Record<string, IconMapping>;
}
```

Create `packages/design/src/define.ts`:

```ts
import type { FrickDesignDefinition, TokenAlias } from "./model.js";

export function alias(path: string): TokenAlias {
  return { $alias: path };
}

export function defineDesign(definition: FrickDesignDefinition): FrickDesignDefinition {
  return definition;
}
```

- [ ] **Step 4: Define the canonical Frick design**

Create `packages/design/src/frick.design.ts`:

```ts
import { alias, defineDesign } from "./define.js";

export const frickDesignDefinition = defineDesign({
  primitive: {
    unit: 4,
    space: {
      1: 4,
      2: 8,
      3: 12,
      4: 16,
      5: 20,
      6: 24,
      8: 32,
      10: 40,
      12: 48,
    },
    radius: {
      1: 4,
      2: 8,
      3: 12,
      4: 16,
      5: 20,
      pill: 999,
    },
    color: {
      mint: {
        50: "#ebfff8",
        100: "#c8f7e8",
        500: "#54d8ac",
        700: "#168463",
        900: "#0e352d",
      },
      blue: {
        100: "#dce8ff",
        500: "#5279dc",
        800: "#203a77",
      },
      neutral: {
        0: "#ffffff",
        50: "#f6fbf8",
        100: "#e7f0ec",
        700: "#51655f",
        900: "#111917",
        950: "#0c1110",
      },
      red: {
        100: "#ffe1e7",
        700: "#9e334f",
      },
    },
    font: {
      family: {
        sans: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      },
      size: {
        caption: 12,
        body: 15,
        label: 13,
        title: 28,
        display: 56,
      },
      weight: {
        regular: 400,
        semibold: 650,
        bold: 800,
      },
    },
    opacity: {
      disabled: 0.48,
      overlay: 0.72,
    },
    shadow: {
      soft: "0 14px 48px rgba(23, 54, 45, 0.12)",
    },
    gradient: {
      brandHero: "linear-gradient(135deg, #ebfff8 0%, #dce8ff 100%)",
    },
  },
  semantic: {
    spacing: {
      extraSmall: alias("primitive.space.1"),
      small: alias("primitive.space.2"),
      medium: alias("primitive.space.4"),
      large: alias("primitive.space.6"),
      extraLarge: alias("primitive.space.8"),
    },
    padding: {
      extraSmall: alias("semantic.spacing.extraSmall"),
      small: alias("semantic.spacing.small"),
      medium: alias("semantic.spacing.medium"),
      large: alias("semantic.spacing.large"),
    },
    corner: {
      control: alias("primitive.radius.3"),
      surface: alias("primitive.radius.4"),
      bubble: alias("primitive.radius.5"),
      pill: alias("primitive.radius.pill"),
    },
    color: {
      page: alias("primitive.color.neutral.50"),
      text: alias("primitive.color.neutral.900"),
      textMuted: alias("primitive.color.neutral.700"),
      surface: alias("primitive.color.neutral.0"),
      surfaceRaised: alias("primitive.color.neutral.100"),
      border: "#d7e5df",
      actionPrimary: alias("primitive.color.mint.700"),
      onActionPrimary: alias("primitive.color.neutral.0"),
      incomingBubble: alias("primitive.color.neutral.0"),
      outgoingBubble: alias("primitive.color.mint.100"),
      danger: alias("primitive.color.red.700"),
    },
    typography: {
      body: {
        family: alias("primitive.font.family.sans"),
        size: alias("primitive.font.size.body"),
        weight: alias("primitive.font.weight.regular"),
      },
      label: {
        family: alias("primitive.font.family.sans"),
        size: alias("primitive.font.size.label"),
        weight: alias("primitive.font.weight.semibold"),
      },
      title: {
        family: alias("primitive.font.family.sans"),
        size: alias("primitive.font.size.title"),
        weight: alias("primitive.font.weight.bold"),
      },
    },
  },
  density: {
    compact: {
      semantic: {
        spacing: {
          medium: alias("primitive.space.3"),
          large: alias("primitive.space.5"),
        },
      },
      component: {
        button: { height: alias("primitive.space.8") },
        textField: { height: alias("primitive.space.8") },
      },
    },
    regular: {
      component: {
        button: { height: alias("primitive.space.10") },
        textField: { height: alias("primitive.space.10") },
      },
    },
    comfortable: {
      semantic: {
        spacing: {
          medium: alias("primitive.space.5"),
          large: alias("primitive.space.8"),
        },
      },
      component: {
        button: { height: alias("primitive.space.12") },
        textField: { height: alias("primitive.space.12") },
      },
    },
  },
  modes: {
    light: {},
    dark: {
      semantic: {
        color: {
          page: alias("primitive.color.neutral.950"),
          text: "#eef8f3",
          textMuted: "#a8bbb4",
          surface: "#17211f",
          surfaceRaised: "#202e2a",
          border: "#354943",
          incomingBubble: "#202e2a",
          outgoingBubble: alias("primitive.color.mint.900"),
        },
      },
    },
  },
  brands: {
    frick: {},
    frickenChat: {
      semantic: {
        color: {
          actionPrimary: alias("primitive.color.blue.500"),
          outgoingBubble: alias("primitive.color.blue.100"),
        },
      },
    },
  },
  component: {
    button: {
      height: alias("primitive.space.10"),
      radius: alias("semantic.corner.pill"),
      paddingX: alias("semantic.spacing.medium"),
      background: alias("semantic.color.actionPrimary"),
      foreground: alias("semantic.color.onActionPrimary"),
    },
    textField: {
      height: alias("primitive.space.10"),
      radius: alias("semantic.corner.pill"),
      paddingX: alias("semantic.spacing.medium"),
      background: alias("semantic.color.surface"),
      foreground: alias("semantic.color.text"),
    },
    chatBubble: {
      paddingX: alias("semantic.spacing.medium"),
      paddingY: alias("semantic.spacing.small"),
      radius: alias("semantic.corner.bubble"),
      incomingBackground: alias("semantic.color.incomingBubble"),
      outgoingBackground: alias("semantic.color.outgoingBubble"),
    },
    avatar: {
      size: alias("primitive.space.10"),
      radius: alias("semantic.corner.pill"),
    },
    surface: {
      radius: alias("semantic.corner.surface"),
      background: alias("semantic.color.surface"),
      border: alias("semantic.color.border"),
    },
  },
  icons: {
    "action.send": {
      web: { family: "lucide", name: "Send" },
      ios: { family: "sf", name: "paperplane.fill" },
      android: { family: "material", name: "Send" },
      fallback: { family: "frick", name: "send" },
    },
    "action.reload": {
      web: { family: "lucide", name: "RefreshCw" },
      ios: { family: "sf", name: "arrow.clockwise" },
      android: { family: "material", name: "Refresh" },
      fallback: { family: "frick", name: "reload" },
    },
    "status.live": {
      web: { family: "lucide", name: "RadioTower" },
      ios: { family: "sf", name: "antenna.radiowaves.left.and.right" },
      android: { family: "material", name: "WifiTethering" },
      fallback: { family: "frick", name: "status-live" },
    },
    "chat.message": {
      web: { family: "lucide", name: "MessageCircle" },
      ios: { family: "sf", name: "message.fill" },
      android: { family: "material", name: "ChatBubble" },
      fallback: { family: "frick", name: "chat-message" },
    },
  },
});
```

- [ ] **Step 5: Implement resolver**

Create `packages/design/src/resolver.ts`:

```ts
import type {
  FrickDesignDefinition,
  IconMapping,
  ResolveOptions,
  ResolvedDesign,
  TokenAlias,
  TokenTree,
} from "./model.js";

export function resolveDesign(definition: FrickDesignDefinition, options: ResolveOptions): ResolvedDesign {
  const source = mergeTrees(
    {
      primitive: definition.primitive,
      semantic: definition.semantic,
      component: definition.component,
    },
    definition.density[options.density] ?? {},
    definition.modes[options.mode] ?? {},
    definition.brands[options.brand] ?? {},
  );

  const resolver = createAliasResolver(source);
  return {
    options,
    primitive: resolver.resolveTree(source.primitive as TokenTree),
    semantic: resolver.resolveTree(source.semantic as TokenTree),
    component: resolver.resolveTree(source.component as TokenTree),
    icons: resolveIcons(definition, options),
  };
}

function resolveIcons(definition: FrickDesignDefinition, options: ResolveOptions): Record<string, IconMapping> {
  return Object.fromEntries(
    Object.entries(definition.icons).map(([name, mapping]) => [
      name,
      options.iconPack === "native" ? mapping[options.platform] : mapping.fallback,
    ]),
  );
}

function createAliasResolver(root: TokenTree) {
  const resolvePath = (path: string, seen: string[] = []): unknown => {
    if (seen.includes(path)) {
      throw new Error(`Circular alias ${[...seen, path].join(" -> ")}`);
    }
    const value = getPath(root, path);
    if (value === undefined) {
      throw new Error(`Unresolved alias ${path}`);
    }
    if (isAlias(value)) {
      return resolvePath(value.$alias, [...seen, path]);
    }
    if (isTokenTree(value)) {
      return resolveTree(value, [...seen, path]);
    }
    return value;
  };

  const resolveTree = (tree: TokenTree, seen: string[] = []): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(tree).map(([key, value]) => {
        if (isAlias(value)) {
          return [key, resolvePath(value.$alias, seen)];
        }
        if (isTokenTree(value)) {
          return [key, resolveTree(value, seen)];
        }
        return [key, value];
      }),
    );

  return { resolveTree };
}

function getPath(root: TokenTree, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (isTokenTree(current) && segment in current) {
      return current[segment];
    }
    return undefined;
  }, root);
}

function mergeTrees(...trees: TokenTree[]): TokenTree {
  const output: Record<string, unknown> = {};
  for (const tree of trees) {
    for (const [key, value] of Object.entries(tree)) {
      const existing = output[key];
      output[key] =
        isTokenTree(existing) && isTokenTree(value) ? mergeTrees(existing, value) : value;
    }
  }
  return output as TokenTree;
}

function isAlias(value: unknown): value is TokenAlias {
  return isTokenTree(value) && "$alias" in value && typeof value.$alias === "string";
}

function isTokenTree(value: unknown): value is TokenTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 6: Run resolver tests**

Run:

```bash
pnpm --filter @frick/design test -- tests/resolver.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run TypeScript typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS for TypeScript packages that exist so far.

- [ ] **Step 8: Commit model and resolver**

```bash
git add packages/design
git commit -m "feat(design): resolve design token graph"
```

---

### Task 3: Add Validation And Static Generators

**Files:**
- Create: `packages/design/src/validate.ts`
- Create: `packages/design/src/generate/json.ts`
- Create: `packages/design/src/generate/web.ts`
- Create: `packages/design/src/generate/swift.ts`
- Create: `packages/design/src/generate/kotlin.ts`
- Create: `packages/design/src/scripts/check.ts`
- Create: `packages/design/src/scripts/generate.ts`
- Create: `packages/design/tests/validate.test.ts`
- Create generated: `packages/design/dist/frick.design.json`
- Create generated: `packages/design-web/src/generated/tokens.css`
- Create generated: `packages/design-web/src/generated/tokens.ts`
- Create generated: `packages/design-swift/Sources/FrickDesign/Generated/FrickTokens.swift`
- Create generated: `apps/android/design/src/main/java/dev/frick/design/generated/FrickTokens.kt`

- [ ] **Step 1: Write validation tests**

Create `packages/design/tests/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { alias } from "../src/define.js";
import { frickDesignDefinition } from "../src/frick.design.js";
import { validateDesign } from "../src/validate.js";

describe("Frick design validation", () => {
  it("accepts the canonical design definition", () => {
    expect(validateDesign(frickDesignDefinition)).toEqual([]);
  });

  it("rejects off-scale numeric spacing values", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      semantic: {
        ...frickDesignDefinition.semantic,
        spacing: { medium: 14 },
      },
    });

    expect(issues).toContain("semantic.spacing.medium must be a 4-point metric or an alias");
  });

  it("rejects component icon references that are not semantic aliases", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      component: {
        ...frickDesignDefinition.component,
        iconButton: { icon: "paperplane.fill" },
      },
    });

    expect(issues).toContain("component.iconButton.icon must reference icon.* semantic aliases");
  });

  it("accepts component icon semantic references", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      component: {
        ...frickDesignDefinition.component,
        iconButton: { icon: alias("icon.action.send") },
      },
    });

    expect(issues).toEqual([]);
  });
});
```

- [ ] **Step 2: Run validation tests to verify failure**

Run:

```bash
pnpm --filter @frick/design test -- tests/validate.test.ts
```

Expected: FAIL because `validate.ts` does not exist.

- [ ] **Step 3: Implement validation**

Create `packages/design/src/validate.ts`:

```ts
import type { FrickDesignDefinition, TokenAlias, TokenTree } from "./model.js";

export function validateDesign(definition: FrickDesignDefinition): string[] {
  const issues: string[] = [];
  validateMetrics("semantic.spacing", readTree(definition.semantic, "spacing"), issues);
  validateMetrics("semantic.padding", readTree(definition.semantic, "padding"), issues);
  validateMetrics("semantic.corner", readTree(definition.semantic, "corner"), issues);
  validateComponentIcons(definition.component, issues);
  validateIconMappings(definition, issues);
  return issues;
}

function validateMetrics(path: string, tree: TokenTree | undefined, issues: string[]): void {
  if (!tree) {
    issues.push(`${path} is required`);
    return;
  }
  for (const [key, value] of Object.entries(tree)) {
    const nextPath = `${path}.${key}`;
    if (isAlias(value)) {
      continue;
    }
    if (isTokenTree(value)) {
      validateMetrics(nextPath, value, issues);
      continue;
    }
    if (typeof value === "number" && (value === 999 || value % 4 === 0)) {
      continue;
    }
    issues.push(`${nextPath} must be a 4-point metric or an alias`);
  }
}

function validateComponentIcons(tree: TokenTree, issues: string[], path = "component"): void {
  for (const [key, value] of Object.entries(tree)) {
    const nextPath = `${path}.${key}`;
    if (key === "icon") {
      if (!isAlias(value) || !value.$alias.startsWith("icon.")) {
        issues.push(`${nextPath} must reference icon.* semantic aliases`);
      }
      continue;
    }
    if (isTokenTree(value)) {
      validateComponentIcons(value, issues, nextPath);
    }
  }
}

function validateIconMappings(definition: FrickDesignDefinition, issues: string[]): void {
  for (const [key, icon] of Object.entries(definition.icons)) {
    for (const platform of ["web", "ios", "android", "fallback"] as const) {
      const mapping = icon[platform];
      if (!mapping.family || !mapping.name) {
        issues.push(`icon.${key}.${platform} must include family and name`);
      }
    }
  }
}

function readTree(tree: TokenTree, key: string): TokenTree | undefined {
  const value = tree[key];
  return isTokenTree(value) ? value : undefined;
}

function isAlias(value: unknown): value is TokenAlias {
  return isTokenTree(value) && "$alias" in value && typeof value.$alias === "string";
}

function isTokenTree(value: unknown): value is TokenTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Implement generators and scripts**

Create `packages/design/src/generate/json.ts`:

```ts
import type { FrickDensity, FrickMode, FrickPlatform, ResolvedDesign } from "../model.js";
import { resolveDesign } from "../resolver.js";
import { frickDesignDefinition } from "../frick.design.js";

export interface DesignArtifact {
  readonly resolved: Record<string, ResolvedDesign>;
}

export function generateJsonArtifact(): DesignArtifact {
  const modes: FrickMode[] = ["light", "dark"];
  const densities: FrickDensity[] = ["compact", "regular", "comfortable"];
  const platforms: FrickPlatform[] = ["web", "ios", "android"];
  const resolved: Record<string, ResolvedDesign> = {};

  for (const mode of modes) {
    for (const density of densities) {
      for (const platform of platforms) {
        const key = `${platform}.${mode}.${density}.frick.native`;
        resolved[key] = resolveDesign(frickDesignDefinition, {
          mode,
          density,
          brand: "frick",
          iconPack: "native",
          platform,
        });
      }
    }
  }

  return { resolved };
}
```

Create `packages/design/src/generate/web.ts`:

```ts
import type { ResolvedDesign } from "../model.js";

export function generateCssVariables(design: ResolvedDesign): string {
  const lines = [":root {"];
  flatten("--frick", design.semantic).forEach(([name, value]) => {
    lines.push(`  ${name}: ${formatCssValue(value)};`);
  });
  flatten("--frick-component", design.component).forEach(([name, value]) => {
    lines.push(`  ${name}: ${formatCssValue(value)};`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function generateWebTokensModule(design: ResolvedDesign): string {
  return `export const frickTokens = ${JSON.stringify(design, null, 2)} as const;\n`;
}

function flatten(prefix: string, value: unknown): Array<[string, unknown]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([key, child]) => flatten(`${prefix}-${kebab(key)}`, child));
}

function formatCssValue(value: unknown): string {
  return typeof value === "number" ? `${value}px` : String(value);
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
```

Create `packages/design/src/generate/swift.ts`:

```ts
import type { ResolvedDesign } from "../model.js";

export function generateSwiftTokens(design: ResolvedDesign): string {
  return `import SwiftUI

public enum FrickMode: String, Sendable {
    case system
    case light
    case dark
}

public enum FrickDensity: String, Sendable {
    case compact
    case regular
    case comfortable
}

public struct FrickDesignContext: Sendable {
    public var mode: FrickMode
    public var density: FrickDensity

    public init(mode: FrickMode = .system, density: FrickDensity = .regular) {
        self.mode = mode
        self.density = density
    }
}

public enum FrickTokens {
    public enum Spacing {
        public static let extraSmall: CGFloat = ${design.semantic.spacing.extraSmall}
        public static let small: CGFloat = ${design.semantic.spacing.small}
        public static let medium: CGFloat = ${design.semantic.spacing.medium}
        public static let large: CGFloat = ${design.semantic.spacing.large}
    }

    public enum Radius {
        public static let control: CGFloat = ${design.semantic.corner.control}
        public static let surface: CGFloat = ${design.semantic.corner.surface}
        public static let bubble: CGFloat = ${design.semantic.corner.bubble}
        public static let pill: CGFloat = ${design.semantic.corner.pill}
    }

    public enum Component {
        public static let buttonHeight: CGFloat = ${design.component.button.height}
        public static let textFieldHeight: CGFloat = ${design.component.textField.height}
        public static let chatBubblePaddingX: CGFloat = ${design.component.chatBubble.paddingX}
        public static let chatBubblePaddingY: CGFloat = ${design.component.chatBubble.paddingY}
    }
}

public enum FrickIconName: String, Sendable {
    case actionSend = "${design.icons["action.send"]?.name ?? "paperplane.fill"}"
    case actionReload = "${design.icons["action.reload"]?.name ?? "arrow.clockwise"}"
    case statusLive = "${design.icons["status.live"]?.name ?? "antenna.radiowaves.left.and.right"}"
    case chatMessage = "${design.icons["chat.message"]?.name ?? "message.fill"}"
}
`;
}
```

Create `packages/design/src/generate/kotlin.ts`:

```ts
import type { ResolvedDesign } from "../model.js";

export function generateKotlinTokens(design: ResolvedDesign): string {
  return `package dev.frick.design.generated

import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

enum class FrickMode {
    System,
    Light,
    Dark,
}

enum class FrickDensity {
    Compact,
    Regular,
    Comfortable,
}

object FrickTokens {
    object Spacing {
        val extraSmall = ${design.semantic.spacing.extraSmall}.dp
        val small = ${design.semantic.spacing.small}.dp
        val medium = ${design.semantic.spacing.medium}.dp
        val large = ${design.semantic.spacing.large}.dp
    }

    object Radius {
        val control = ${design.semantic.corner.control}.dp
        val surface = ${design.semantic.corner.surface}.dp
        val bubble = ${design.semantic.corner.bubble}.dp
    }

    object Component {
        val buttonHeight = ${design.component.button.height}.dp
        val textFieldHeight = ${design.component.textField.height}.dp
        val chatBubblePaddingX = ${design.component.chatBubble.paddingX}.dp
        val chatBubblePaddingY = ${design.component.chatBubble.paddingY}.dp
    }
}

enum class FrickIconName {
    ActionSend,
    ActionReload,
    StatusLive,
    ChatMessage,
}
`;
}
```

Create `packages/design/src/scripts/check.ts`:

```ts
import { frickDesignDefinition } from "../frick.design.js";
import { validateDesign } from "../validate.js";

const issues = validateDesign(frickDesignDefinition);
if (issues.length > 0) {
  console.error(issues.join("\n"));
  process.exit(1);
}

console.log("Frick design definition is valid.");
```

Create `packages/design/src/scripts/generate.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateJsonArtifact } from "../generate/json.js";
import { generateCssVariables, generateWebTokensModule } from "../generate/web.js";
import { generateSwiftTokens } from "../generate/swift.js";
import { generateKotlinTokens } from "../generate/kotlin.js";
import { frickDesignDefinition } from "../frick.design.js";
import { resolveDesign } from "../resolver.js";
import { validateDesign } from "../validate.js";

const issues = validateDesign(frickDesignDefinition);
if (issues.length > 0) {
  console.error(issues.join("\n"));
  process.exit(1);
}

const root = resolve(import.meta.dirname, "../../..");
const artifact = generateJsonArtifact();
const webDesign = resolveDesign(frickDesignDefinition, {
  mode: "light",
  density: "regular",
  brand: "frick",
  iconPack: "native",
  platform: "web",
});
const swiftDesign = resolveDesign(frickDesignDefinition, {
  mode: "light",
  density: "regular",
  brand: "frick",
  iconPack: "native",
  platform: "ios",
});
const androidDesign = resolveDesign(frickDesignDefinition, {
  mode: "light",
  density: "regular",
  brand: "frick",
  iconPack: "native",
  platform: "android",
});

await writeGenerated(resolve(root, "packages/design/dist/frick.design.json"), `${JSON.stringify(artifact, null, 2)}\n`);
await writeGenerated(resolve(root, "packages/design-web/src/generated/tokens.css"), generateCssVariables(webDesign));
await writeGenerated(resolve(root, "packages/design-web/src/generated/tokens.ts"), generateWebTokensModule(webDesign));
await writeGenerated(resolve(root, "packages/design-swift/Sources/FrickDesign/Generated/FrickTokens.swift"), generateSwiftTokens(swiftDesign));
await writeGenerated(resolve(root, "apps/android/design/src/main/java/dev/frick/design/generated/FrickTokens.kt"), generateKotlinTokens(androidDesign));

console.log("Generated Frick design artifacts.");

async function writeGenerated(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
```

- [ ] **Step 5: Run generation**

Run:

```bash
pnpm design:check
pnpm design:generate
pnpm --filter @frick/design test
```

Expected: all PASS and generated files are written.

- [ ] **Step 6: Verify generated artifacts are deterministic**

Run:

```bash
pnpm design:generate
git diff -- packages/design/dist/frick.design.json packages/design-web/src/generated/tokens.css packages/design-web/src/generated/tokens.ts packages/design-swift/Sources/FrickDesign/Generated/FrickTokens.swift apps/android/design/src/main/java/dev/frick/design/generated/FrickTokens.kt
```

Expected: no diff after the second generation.

- [ ] **Step 7: Commit generator**

```bash
git add packages/design packages/design-web/src/generated packages/design-swift/Sources/FrickDesign/Generated apps/android/design/src/main/java/dev/frick/design/generated
git commit -m "feat(design): generate platform design artifacts"
```

---

### Task 4: Build Web Provider And Foundation Components

**Files:**
- Replace: `packages/design-web/src/index.ts`
- Create: `packages/design-web/src/index.tsx`
- Create: `packages/design-web/src/provider.tsx`
- Create: `packages/design-web/src/icons.tsx`
- Create: `packages/design-web/src/components.tsx`
- Create: `packages/design-web/src/components.css`
- Create: `packages/design-web/src/components.test.tsx`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Replace the web package entrypoint**

Delete `packages/design-web/src/index.ts`.

Create `packages/design-web/src/index.tsx`:

```tsx
export * from "./provider.js";
export * from "./icons.js";
export * from "./components.js";
import "./generated/tokens.css";
import "./components.css";
```

- [ ] **Step 2: Create provider and hook**

Create `packages/design-web/src/provider.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";

export type FrickMode = "system" | "light" | "dark";
export type FrickDensity = "compact" | "regular" | "comfortable";
export type FrickBrand = "frick" | "frickenChat";
export type FrickIconPack = "native" | "frick";

export interface FrickDesignContextValue {
  readonly mode: FrickMode;
  readonly density: FrickDensity;
  readonly brand: FrickBrand;
  readonly iconPack: FrickIconPack;
}

const FrickDesignContext = createContext<FrickDesignContextValue>({
  mode: "system",
  density: "regular",
  brand: "frick",
  iconPack: "native",
});

export function FrickDesignProvider({
  mode = "system",
  density = "regular",
  brand = "frick",
  iconPack = "native",
  children,
}: Partial<FrickDesignContextValue> & { readonly children: ReactNode }) {
  return (
    <FrickDesignContext.Provider value={{ mode, density, brand, iconPack }}>
      <div data-frick-mode={mode} data-frick-density={density} data-frick-brand={brand}>
        {children}
      </div>
    </FrickDesignContext.Provider>
  );
}

export function useFrickDesign(): FrickDesignContextValue {
  return useContext(FrickDesignContext);
}
```

- [ ] **Step 3: Create semantic icons**

Create `packages/design-web/src/icons.tsx`:

```tsx
import { MessageCircle, RadioTower, RefreshCw, Send, type LucideIcon } from "lucide-react";

export type FrickIconName = "action.send" | "action.reload" | "status.live" | "chat.message";

const iconMap: Record<FrickIconName, LucideIcon> = {
  "action.send": Send,
  "action.reload": RefreshCw,
  "status.live": RadioTower,
  "chat.message": MessageCircle,
};

export function FrickIcon({ name, size = 18 }: { readonly name: FrickIconName; readonly size?: number }) {
  const Icon = iconMap[name];
  return <Icon aria-hidden="true" size={size} />;
}
```

- [ ] **Step 4: Create web components**

Create `packages/design-web/src/components.tsx`:

```tsx
import type {
  ButtonHTMLAttributes,
  ColHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { FrickIcon, type FrickIconName } from "./icons.js";

export function FrickSurface({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`frick-surface ${className}`} {...props} />;
}

export function FrickStack({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`frick-stack ${className}`} {...props} />;
}

export function FrickInline({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`frick-inline ${className}`} {...props} />;
}

export function FrickCluster({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`frick-cluster ${className}`} {...props} />;
}

export function FrickButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`frick-button ${className}`} {...props} />;
}

export function FrickIconButton({
  icon,
  label,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly icon: FrickIconName; readonly label: string }) {
  return (
    <button className={`frick-icon-button ${className}`} aria-label={label} title={label} {...props}>
      <FrickIcon name={icon} />
    </button>
  );
}

export function FrickTextField({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`frick-text-field ${className}`} {...props} />;
}

export function FrickStatusChip({ active, children }: { readonly active?: boolean; readonly children: ReactNode }) {
  return <span className="frick-status-chip" data-active={active === true}>{children}</span>;
}

export function FrickAvatar({ label }: { readonly label: string }) {
  return <span className="frick-avatar">{initials(label)}</span>;
}

export function FrickChatBubble({
  mine,
  author,
  time,
  children,
}: {
  readonly mine?: boolean;
  readonly author: string;
  readonly time?: string;
  readonly children: ReactNode;
}) {
  return (
    <article className="frick-chat-bubble-row" data-mine={mine === true}>
      <FrickAvatar label={author} />
      <div className="frick-chat-bubble">
        <div className="frick-chat-meta">
          <strong>{author}</strong>
          {time ? <span>{time}</span> : null}
        </div>
        <p>{children}</p>
      </div>
    </article>
  );
}

export function FrickMessageList({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`frick-message-list ${className}`} {...props} />;
}

function initials(label: string): string {
  return label
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
```

Create `packages/design-web/src/components.css`:

```css
.frick-surface {
  background: var(--frick-component-surface-background);
  border: 1px solid var(--frick-component-surface-border);
  border-radius: var(--frick-component-surface-radius);
}

.frick-stack {
  display: grid;
  gap: var(--frick-spacing-medium);
}

.frick-inline {
  align-items: center;
  display: flex;
  gap: var(--frick-spacing-small);
}

.frick-cluster {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: var(--frick-spacing-small);
}

.frick-button,
.frick-icon-button {
  align-items: center;
  background: var(--frick-component-button-background);
  border: 0;
  border-radius: var(--frick-component-button-radius);
  color: var(--frick-component-button-foreground);
  cursor: pointer;
  display: inline-flex;
  font-weight: 800;
  justify-content: center;
  min-height: var(--frick-component-button-height);
}

.frick-button {
  padding-inline: var(--frick-component-button-padding-x);
}

.frick-icon-button {
  width: var(--frick-component-button-height);
}

.frick-text-field {
  background: var(--frick-component-text-field-background);
  border: 1px solid var(--frick-color-border);
  border-radius: var(--frick-component-text-field-radius);
  color: var(--frick-component-text-field-foreground);
  min-height: var(--frick-component-text-field-height);
  min-width: 0;
  padding-inline: var(--frick-component-text-field-padding-x);
}

.frick-status-chip {
  align-items: center;
  border: 1px solid var(--frick-color-border);
  border-radius: var(--frick-corner-pill);
  color: var(--frick-color-text-muted);
  display: inline-flex;
  font-weight: 800;
  min-height: 32px;
  padding-inline: var(--frick-spacing-small);
}

.frick-status-chip[data-active="true"] {
  color: var(--frick-color-action-primary);
}

.frick-avatar {
  align-items: center;
  background: var(--frick-color-surface-raised);
  border-radius: var(--frick-component-avatar-radius);
  color: var(--frick-color-action-primary);
  display: inline-flex;
  flex: 0 0 auto;
  font-size: 0.78rem;
  font-weight: 900;
  height: var(--frick-component-avatar-size);
  justify-content: center;
  width: var(--frick-component-avatar-size);
}

.frick-message-list {
  align-content: end;
  display: grid;
  gap: var(--frick-spacing-small);
  overflow-y: auto;
}

.frick-chat-bubble-row {
  align-items: end;
  display: grid;
  gap: var(--frick-spacing-small);
  grid-template-columns: auto minmax(0, 1fr);
  justify-items: start;
}

.frick-chat-bubble-row[data-mine="true"] {
  grid-template-columns: minmax(0, 1fr) auto;
  justify-items: end;
}

.frick-chat-bubble-row[data-mine="true"] .frick-avatar {
  grid-column: 2;
  grid-row: 1;
}

.frick-chat-bubble {
  background: var(--frick-component-chat-bubble-incoming-background);
  border-radius: var(--frick-component-chat-bubble-radius);
  max-width: min(76%, 540px);
  padding: var(--frick-component-chat-bubble-padding-y) var(--frick-component-chat-bubble-padding-x);
}

.frick-chat-bubble-row[data-mine="true"] .frick-chat-bubble {
  background: var(--frick-component-chat-bubble-outgoing-background);
}

.frick-chat-meta {
  align-items: center;
  color: var(--frick-color-text-muted);
  display: flex;
  font-size: 0.82rem;
  gap: var(--frick-spacing-small);
  justify-content: space-between;
  margin-bottom: var(--frick-spacing-extra-small);
}

.frick-chat-bubble p {
  color: var(--frick-color-text);
  margin: 0;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 5: Add a web smoke test**

Create `packages/design-web/src/components.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FrickChatBubble, FrickDesignProvider, FrickIconButton } from "./index.js";

describe("design web components", () => {
  it("renders semantic icon buttons", () => {
    const html = renderToStaticMarkup(<FrickIconButton icon="action.send" label="Send" />);
    expect(html).toContain("aria-label=\"Send\"");
  });

  it("renders chat bubbles inside the design provider", () => {
    const html = renderToStaticMarkup(
      <FrickDesignProvider density="regular">
        <FrickChatBubble author="Ada Lovelace" mine>
          Hello
        </FrickChatBubble>
      </FrickDesignProvider>,
    );
    expect(html).toContain("data-frick-density=\"regular\"");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Hello");
  });
});
```

Run:

```bash
pnpm --filter @frick/design-web exec vitest run src/components.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Wire app dependency**

In `apps/web/package.json`, add:

```json
"@frick/design-web": "workspace:*"
```

Keep existing dependencies.

- [ ] **Step 7: Run web typecheck**

Run:

```bash
pnpm typecheck
```

Expected before demo migration: PASS.

- [ ] **Step 8: Commit web design package**

```bash
git add packages/design-web apps/web/package.json pnpm-lock.yaml
git commit -m "feat(design-web): add tokenized React components"
```

---

### Task 5: Build SwiftUI Design Package Components

**Files:**
- Create: `packages/design-swift/Sources/FrickDesign/Environment.swift`
- Create: `packages/design-swift/Sources/FrickDesign/FoundationComponents.swift`
- Create: `packages/design-swift/Sources/FrickDesign/CommunicationComponents.swift`
- Create: `packages/design-swift/Tests/FrickDesignTests/FrickDesignTests.swift`

- [ ] **Step 1: Create SwiftUI environment**

Create `packages/design-swift/Sources/FrickDesign/Environment.swift`:

```swift
import SwiftUI

private struct FrickDesignEnvironmentKey: EnvironmentKey {
    static let defaultValue = FrickDesignContext()
}

public extension EnvironmentValues {
    var frickDesign: FrickDesignContext {
        get { self[FrickDesignEnvironmentKey.self] }
        set { self[FrickDesignEnvironmentKey.self] = newValue }
    }
}
```

- [ ] **Step 2: Create foundation SwiftUI components**

Create `packages/design-swift/Sources/FrickDesign/FoundationComponents.swift`:

```swift
import SwiftUI

public struct FrickIcon: View {
    private let name: FrickIconName

    public init(_ name: FrickIconName) {
        self.name = name
    }

    public var body: some View {
        Image(systemName: name.rawValue)
    }
}

public struct FrickSurface<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .padding(FrickTokens.Spacing.medium)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: FrickTokens.Radius.surface))
    }
}

public struct FrickStatusChip: View {
    private let title: String
    private let active: Bool

    public init(_ title: String, active: Bool = false) {
        self.title = title
        self.active = active
    }

    public var body: some View {
        Text(title)
            .font(.footnote.weight(.bold))
            .foregroundStyle(active ? .green : .secondary)
            .padding(.horizontal, FrickTokens.Spacing.small)
            .frame(minHeight: 32)
            .background(.thinMaterial, in: Capsule())
    }
}

public struct FrickAvatar: View {
    private let label: String

    public init(label: String) {
        self.label = label
    }

    public var body: some View {
        Text(initials(label))
            .font(.caption.weight(.black))
            .frame(width: FrickTokens.Component.buttonHeight, height: FrickTokens.Component.buttonHeight)
            .background(.green.opacity(0.18), in: Circle())
            .foregroundStyle(.green)
    }

    private func initials(_ value: String) -> String {
        value
            .split(separator: " ")
            .compactMap(\.first)
            .prefix(2)
            .map(String.init)
            .joined()
            .uppercased()
    }
}
```

- [ ] **Step 3: Create communication SwiftUI components**

Create `packages/design-swift/Sources/FrickDesign/CommunicationComponents.swift`:

```swift
import SwiftUI

public struct FrickChatBubble: View {
    private let author: String
    private let bodyText: String
    private let isMine: Bool

    public init(author: String, bodyText: String, isMine: Bool = false) {
        self.author = author
        self.bodyText = bodyText
        self.isMine = isMine
    }

    public var body: some View {
        HStack(alignment: .bottom, spacing: FrickTokens.Spacing.small) {
            if !isMine {
                FrickAvatar(label: author)
            }
            VStack(alignment: .leading, spacing: FrickTokens.Spacing.extraSmall) {
                Text(author)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(bodyText)
                    .font(.body)
                    .foregroundStyle(.primary)
            }
            .padding(.horizontal, FrickTokens.Component.chatBubblePaddingX)
            .padding(.vertical, FrickTokens.Component.chatBubblePaddingY)
            .background(isMine ? Color.green.opacity(0.2) : Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: FrickTokens.Radius.bubble))
            if isMine {
                FrickAvatar(label: author)
            }
        }
        .frame(maxWidth: .infinity, alignment: isMine ? .trailing : .leading)
    }
}

public struct FrickComposer: View {
    @Binding private var text: String
    private let placeholder: String
    private let onSend: () -> Void

    public init(text: Binding<String>, placeholder: String, onSend: @escaping () -> Void) {
        self._text = text
        self.placeholder = placeholder
        self.onSend = onSend
    }

    public var body: some View {
        HStack(spacing: FrickTokens.Spacing.small) {
            TextField(placeholder, text: $text)
                .textFieldStyle(.roundedBorder)
            Button(action: onSend) {
                FrickIcon(.actionSend)
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
```

- [ ] **Step 4: Add Swift compile tests**

Create `packages/design-swift/Tests/FrickDesignTests/FrickDesignTests.swift`:

```swift
import SwiftUI
import Testing
@testable import FrickDesign

@Test func generatedTokensAreAvailable() {
    #expect(FrickTokens.Spacing.medium > FrickTokens.Spacing.small)
    #expect(FrickIconName.actionSend.rawValue == "paperplane.fill")
}

@MainActor
@Test func componentsCanBeConstructed() {
    _ = FrickSurface {
        FrickStatusChip("Live", active: true)
    }
    _ = FrickChatBubble(author: "Ada Lovelace", bodyText: "Hello", isMine: true)
}
```

- [ ] **Step 5: Run Swift design tests**

Run:

```bash
swift test --package-path packages/design-swift
```

Expected: PASS.

- [ ] **Step 6: Commit Swift package**

```bash
git add packages/design-swift
git commit -m "feat(design-swift): add SwiftUI design components"
```

---

### Task 6: Build Android Compose Design Components

**Files:**
- Create: `apps/android/design/src/main/java/dev/frick/design/FrickDesignTheme.kt`
- Create: `apps/android/design/src/main/java/dev/frick/design/FoundationComponents.kt`
- Create: `apps/android/design/src/main/java/dev/frick/design/CommunicationComponents.kt`
- Create: `apps/android/design/src/test/java/dev/frick/design/FrickDesignTest.kt`

- [ ] **Step 1: Create Compose theme context**

Create `apps/android/design/src/main/java/dev/frick/design/FrickDesignTheme.kt`:

```kotlin
package dev.frick.design

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import dev.frick.design.generated.FrickDensity
import dev.frick.design.generated.FrickMode

data class FrickDesignContext(
    val mode: FrickMode = FrickMode.System,
    val density: FrickDensity = FrickDensity.Regular,
)

val LocalFrickDesign = compositionLocalOf { FrickDesignContext() }

@Composable
fun FrickDesignTheme(
    context: FrickDesignContext = FrickDesignContext(),
    content: @Composable () -> Unit,
) {
    val colorScheme = when (context.mode) {
        FrickMode.Dark -> darkColorScheme()
        FrickMode.Light -> lightColorScheme()
        FrickMode.System -> MaterialTheme.colorScheme
    }

    androidx.compose.runtime.CompositionLocalProvider(LocalFrickDesign provides context) {
        MaterialTheme(colorScheme = colorScheme, content = content)
    }
}
```

- [ ] **Step 2: Create foundation Compose components**

Create `apps/android/design/src/main/java/dev/frick/design/FoundationComponents.kt`:

```kotlin
package dev.frick.design

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import dev.frick.design.generated.FrickTokens

@Composable
fun FrickSurface(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = MaterialTheme.shapes.medium,
        tonalElevation = FrickTokens.Spacing.extraSmall,
        content = content,
    )
}

@Composable
fun FrickInline(
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(FrickTokens.Spacing.small),
        content = content,
    )
}

@Composable
fun FrickStatusChip(
    label: String,
    active: Boolean,
    modifier: Modifier = Modifier,
) {
    AssistChip(
        modifier = modifier,
        onClick = {},
        label = {
            Text(
                text = label,
                fontWeight = FontWeight.Bold,
                color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
    )
}

@Composable
fun FrickAvatar(label: String, modifier: Modifier = Modifier) {
    Text(
        text = initials(label),
        modifier = modifier
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primaryContainer)
            .padding(FrickTokens.Spacing.small),
        color = MaterialTheme.colorScheme.onPrimaryContainer,
        fontWeight = FontWeight.Black,
    )
}

private fun initials(label: String): String =
    label
        .split(" ")
        .mapNotNull { part -> part.firstOrNull()?.uppercaseChar() }
        .take(2)
        .joinToString("")
```

- [ ] **Step 3: Create communication Compose components**

Create `apps/android/design/src/main/java/dev/frick/design/CommunicationComponents.kt`:

```kotlin
package dev.frick.design

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import dev.frick.design.generated.FrickTokens

@Composable
fun FrickMessageList(
    state: LazyListState,
    modifier: Modifier = Modifier,
    content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit,
) {
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        state = state,
        verticalArrangement = Arrangement.spacedBy(FrickTokens.Spacing.small),
        content = content,
    )
}

@Composable
fun FrickChatBubble(
    author: String,
    body: String,
    isMine: Boolean,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        if (!isMine) {
            FrickAvatar(author)
        }
        Column(
            modifier = Modifier
                .padding(horizontal = FrickTokens.Spacing.small)
                .background(
                    color = if (isMine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(FrickTokens.Radius.bubble),
                )
                .padding(
                    horizontal = FrickTokens.Component.chatBubblePaddingX,
                    vertical = FrickTokens.Component.chatBubblePaddingY,
                ),
            verticalArrangement = Arrangement.spacedBy(FrickTokens.Spacing.extraSmall),
        ) {
            Text(
                text = author,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontWeight = FontWeight.SemiBold,
            )
            Text(text = body, style = MaterialTheme.typography.bodyLarge)
        }
        if (isMine) {
            FrickAvatar(author)
        }
    }
}

@Composable
fun FrickComposer(
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FrickTokens.Spacing.small),
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = onDraftChange,
            modifier = Modifier.weight(1f),
            singleLine = true,
            label = { Text("Message the foundation") },
        )
        Button(onClick = onSend) {
            Text("Send")
        }
    }
}
```

- [ ] **Step 4: Add Android design unit test**

Create `apps/android/design/src/test/java/dev/frick/design/FrickDesignTest.kt`:

```kotlin
package dev.frick.design

import dev.frick.design.generated.FrickIconName
import dev.frick.design.generated.FrickTokens
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class FrickDesignTest {
    @Test
    fun generatedTokensAreAvailable() {
        assertTrue(FrickTokens.Spacing.medium.value > FrickTokens.Spacing.small.value)
        assertEquals(FrickIconName.ActionSend, FrickIconName.valueOf("ActionSend"))
    }
}
```

- [ ] **Step 5: Run Android design build**

Run:

```bash
cd apps/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH ./gradlew :design:testDebugUnitTest :design:lintDebug :design:assembleDebug
```

Expected: PASS.

- [ ] **Step 6: Commit Android package**

```bash
git add apps/android/design
git commit -m "feat(design-android): add Compose design components"
```

---

### Task 7: Add Full Phase 1 Component Surface

**Files:**
- Modify: `packages/design-web/src/components.tsx`
- Modify: `packages/design-web/src/components.css`
- Modify: `packages/design-swift/Sources/FrickDesign/FoundationComponents.swift`
- Modify: `apps/android/design/src/main/java/dev/frick/design/FoundationComponents.kt`
- Create: `packages/design-web/src/data-components.test.tsx`
- Modify: `packages/design-swift/Tests/FrickDesignTests/FrickDesignTests.swift`
- Modify: `apps/android/design/src/test/java/dev/frick/design/FrickDesignTest.kt`

- [ ] **Step 1: Add web table, picker, and chart components**

Append these exports to `packages/design-web/src/components.tsx`:

```tsx
export function FrickText({ className = "", ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={`frick-text ${className}`} {...props} />;
}

export function FrickHeading({ className = "", ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={`frick-heading ${className}`} {...props} />;
}

export function FrickLabel({ className = "", ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`frick-label ${className}`} {...props} />;
}

export function FrickDivider(props: HTMLAttributes<HTMLHRElement>) {
  return <hr className="frick-divider" {...props} />;
}

export function FrickSpacer({ size = "medium" }: { readonly size?: "small" | "medium" | "large" }) {
  return <span aria-hidden="true" className="frick-spacer" data-size={size} />;
}

export function FrickAppShell({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`frick-app-shell ${className}`} {...props} />;
}

export function FrickToolbar({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`frick-toolbar ${className}`} {...props} />;
}

export function FrickScrollArea({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`frick-scroll-area ${className}`} {...props} />;
}

export function FrickTextArea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`frick-text-area ${className}`} {...props} />;
}

export function FrickSegmentedControl({
  options,
  value,
  onChange,
}: {
  readonly options: readonly string[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="frick-segmented-control" role="tablist">
      {options.map((option) => (
        <button key={option} type="button" aria-selected={option === value} onClick={() => onChange(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

export function FrickToggle({
  checked,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="frick-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function FrickBadge({ children }: { readonly children: ReactNode }) {
  return <span className="frick-badge">{children}</span>;
}

export function FrickPresenceDot({ active }: { readonly active: boolean }) {
  return <span aria-label={active ? "Present" : "Away"} className="frick-presence-dot" data-active={active} />;
}

export function FrickProgressRing() {
  return <span aria-label="Loading" className="frick-progress-ring" />;
}

export function FrickToast({ children }: { readonly children: ReactNode }) {
  return <div className="frick-toast" role="status">{children}</div>;
}

export function FrickErrorState({ title, message }: { readonly title: string; readonly message: string }) {
  return <FrickSurface className="frick-state"><strong>{title}</strong><p>{message}</p></FrickSurface>;
}

export function FrickEmptyState({ title, message }: { readonly title: string; readonly message: string }) {
  return <FrickSurface className="frick-state"><strong>{title}</strong><p>{message}</p></FrickSurface>;
}

export function FrickAvatarGroup({ labels }: { readonly labels: readonly string[] }) {
  return <div className="frick-avatar-group">{labels.map((label) => <FrickAvatar key={label} label={label} />)}</div>;
}

export function FrickUserRow({ label, detail }: { readonly label: string; readonly detail?: string }) {
  return <div className="frick-user-row"><FrickAvatar label={label} /><div><strong>{label}</strong>{detail ? <span>{detail}</span> : null}</div></div>;
}

export function FrickComposer({
  draft,
  onDraftChange,
  onSend,
}: {
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSend: () => void;
}) {
  return (
    <form className="frick-composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
      <FrickTextField aria-label="Message" placeholder="Message the foundation" value={draft} onChange={(event) => onDraftChange(event.target.value)} />
      <FrickIconButton icon="action.send" label="Send message" type="submit" />
    </form>
  );
}

export function FrickTypingIndicator({ active }: { readonly active: boolean }) {
  return <FrickBadge>{active ? "Typing" : "Idle"}</FrickBadge>;
}

export function FrickReceipt({ label }: { readonly label: string }) {
  return <span className="frick-receipt">{label}</span>;
}

export function FrickReactionRow({ reactions }: { readonly reactions: readonly string[] }) {
  return <div className="frick-reaction-row">{reactions.map((reaction) => <FrickBadge key={reaction}>{reaction}</FrickBadge>)}</div>;
}

export function FrickSignalPanel({ count, onOffer }: { readonly count: number; readonly onOffer: () => void }) {
  return <FrickSurface className="frick-signal-panel"><strong>{count}</strong><FrickButton onClick={onOffer}>Send offer</FrickButton></FrickSurface>;
}

export function FrickCallButton({ onClick }: { readonly onClick: () => void }) {
  return <FrickButton onClick={onClick}>Call</FrickButton>;
}

export function FrickTable({ className = "", ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={`frick-table ${className}`} {...props} />;
}

export function FrickDataGrid({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`frick-data-grid ${className}`} role="grid" {...props} />;
}

export function FrickColumn(props: ColHTMLAttributes<HTMLTableColElement>) {
  return <col {...props} />;
}

export function FrickCell({ header, ...props }: HTMLAttributes<HTMLTableCellElement> & { readonly header?: boolean }) {
  return header ? <th {...props} /> : <td {...props} />;
}

export function FrickMetricCard({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <FrickSurface className="frick-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </FrickSurface>
  );
}

export function FrickDatePicker(props: InputHTMLAttributes<HTMLInputElement>) {
  return <FrickTextField type="date" {...props} />;
}

export function FrickTimePicker(props: InputHTMLAttributes<HTMLInputElement>) {
  return <FrickTextField type="time" {...props} />;
}

export function FrickDateTimePicker(props: InputHTMLAttributes<HTMLInputElement>) {
  return <FrickTextField type="datetime-local" {...props} />;
}

export function FrickDateRangePicker({
  start,
  end,
  onStartChange,
  onEndChange,
}: {
  readonly start: string;
  readonly end: string;
  readonly onStartChange: (value: string) => void;
  readonly onEndChange: (value: string) => void;
}) {
  return <div className="frick-date-range"><FrickDatePicker value={start} onChange={(event) => onStartChange(event.target.value)} /><FrickDatePicker value={end} onChange={(event) => onEndChange(event.target.value)} /></div>;
}

export function FrickTimeline({ items }: { readonly items: readonly string[] }) {
  return <ol className="frick-timeline">{items.map((item) => <li key={item}>{item}</li>)}</ol>;
}

export function FrickChartSurface({ children }: { readonly children: ReactNode }) {
  return <FrickSurface className="frick-chart-surface">{children}</FrickSurface>;
}

export function FrickSparkline({ values }: { readonly values: readonly number[] }) {
  const max = Math.max(1, ...values);
  const points = values
    .map((value, index) => `${(index / Math.max(1, values.length - 1)) * 100},${40 - (value / max) * 36}`)
    .join(" ");
  return (
    <svg className="frick-sparkline" viewBox="0 0 100 44" role="img" aria-label="Sparkline">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const FrickLineChart = FrickSparkline;
export const FrickAreaChart = FrickSparkline;
export const FrickBarChart = FrickSparkline;

export function FrickPieChart({ values }: { readonly values: readonly number[] }) {
  const total = Math.max(1, values.reduce((sum, value) => sum + value, 0));
  return <FrickChartSurface><strong>{Math.round((values[0] ?? 0) / total * 100)}%</strong></FrickChartSurface>;
}
```

Append CSS to `packages/design-web/src/components.css`:

```css
.frick-table {
  border-collapse: collapse;
  inline-size: 100%;
}

.frick-table th,
.frick-table td {
  border-bottom: 1px solid var(--frick-color-border);
  padding: var(--frick-spacing-small);
  text-align: start;
}

.frick-metric-card {
  display: grid;
  gap: var(--frick-spacing-extra-small);
  padding: var(--frick-spacing-medium);
}

.frick-metric-card span {
  color: var(--frick-color-text-muted);
  font-size: 0.84rem;
}

.frick-metric-card strong {
  color: var(--frick-color-text);
  font-size: 2rem;
}

.frick-sparkline {
  color: var(--frick-color-action-primary);
  display: block;
  height: 44px;
  width: 100%;
}

.frick-app-shell,
.frick-scroll-area {
  min-height: 0;
}

.frick-toolbar,
.frick-composer,
.frick-user-row,
.frick-date-range,
.frick-reaction-row {
  align-items: center;
  display: flex;
  gap: var(--frick-spacing-small);
}

.frick-text-area {
  min-height: 96px;
  resize: vertical;
}

.frick-segmented-control,
.frick-avatar-group {
  display: inline-flex;
  gap: var(--frick-spacing-extra-small);
}

.frick-badge,
.frick-receipt {
  border-radius: var(--frick-corner-pill);
  background: var(--frick-color-surface-raised);
  color: var(--frick-color-text-muted);
  font-size: 0.82rem;
  font-weight: 800;
  padding: var(--frick-spacing-extra-small) var(--frick-spacing-small);
}

.frick-presence-dot {
  background: var(--frick-color-text-muted);
  border-radius: var(--frick-corner-pill);
  display: inline-block;
  height: var(--frick-spacing-small);
  width: var(--frick-spacing-small);
}

.frick-presence-dot[data-active="true"] {
  background: var(--frick-color-action-primary);
}

.frick-progress-ring {
  border: 2px solid var(--frick-color-border);
  border-top-color: var(--frick-color-action-primary);
  border-radius: var(--frick-corner-pill);
  display: inline-block;
  height: 20px;
  width: 20px;
}

.frick-toast,
.frick-state,
.frick-signal-panel,
.frick-chart-surface {
  padding: var(--frick-spacing-medium);
}

.frick-data-grid {
  display: grid;
  gap: var(--frick-spacing-extra-small);
}

.frick-timeline {
  display: grid;
  gap: var(--frick-spacing-small);
  margin: 0;
  padding-inline-start: var(--frick-spacing-large);
}
```

- [ ] **Step 2: Add web component tests**

Create `packages/design-web/src/data-components.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FrickDataGrid,
  FrickDatePicker,
  FrickDateTimePicker,
  FrickCell,
  FrickMetricCard,
  FrickPieChart,
  FrickSparkline,
  FrickTable,
  FrickTimeline,
} from "./index.js";

describe("extended web design components", () => {
  it("renders table and grid markup", () => {
    const html = renderToStaticMarkup(
      <FrickTable>
        <tbody>
          <tr><td>Ada</td></tr>
        </tbody>
      </FrickTable>,
    );
    expect(html).toContain("<table");
    expect(html).toContain("Ada");
    expect(renderToStaticMarkup(<FrickDataGrid><FrickCell>Cell</FrickCell></FrickDataGrid>)).toContain("role=\"grid\"");
  });

  it("renders date inputs, timeline, and charts", () => {
    expect(renderToStaticMarkup(<FrickDatePicker value="2026-05-09" readOnly />)).toContain("type=\"date\"");
    expect(renderToStaticMarkup(<FrickDateTimePicker value="2026-05-09T12:00" readOnly />)).toContain("datetime-local");
    expect(renderToStaticMarkup(<FrickTimeline items={["One"]} />)).toContain("One");
    expect(renderToStaticMarkup(<FrickSparkline values={[1, 4, 2]} />)).toContain("<polyline");
    expect(renderToStaticMarkup(<FrickPieChart values={[1, 3]} />)).toContain("25%");
    expect(renderToStaticMarkup(<FrickMetricCard label="Messages" value="19" />)).toContain("Messages");
  });
});
```

- [ ] **Step 3: Add Swift extended components**

Append to `packages/design-swift/Sources/FrickDesign/FoundationComponents.swift`:

```swift
public struct FrickText: View {
    private let value: String
    public init(_ value: String) { self.value = value }
    public var body: some View { Text(value).font(.body) }
}

public struct FrickHeading: View {
    private let value: String
    public init(_ value: String) { self.value = value }
    public var body: some View { Text(value).font(.title.weight(.bold)) }
}

public struct FrickLabel: View {
    private let value: String
    public init(_ value: String) { self.value = value }
    public var body: some View { Text(value).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
}

public struct FrickDivider: View {
    public init() {}
    public var body: some View { Divider() }
}

public struct FrickSpacer: View {
    public init() {}
    public var body: some View { Spacer(minLength: FrickTokens.Spacing.medium) }
}

public struct FrickStack<Content: View>: View {
    private let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View { VStack(alignment: .leading, spacing: FrickTokens.Spacing.medium) { content } }
}

public struct FrickInline<Content: View>: View {
    private let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View { HStack(spacing: FrickTokens.Spacing.small) { content } }
}

public typealias FrickCluster<Content: View> = FrickInline<Content>
public typealias FrickToolbar<Content: View> = FrickInline<Content>
public typealias FrickAppShell<Content: View> = FrickStack<Content>

public struct FrickScrollArea<Content: View>: View {
    private let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View { ScrollView { content } }
}

public struct FrickBadge: View {
    private let label: String
    public init(_ label: String) { self.label = label }
    public var body: some View { Text(label).font(.caption.weight(.bold)).padding(.horizontal, FrickTokens.Spacing.small).padding(.vertical, FrickTokens.Spacing.extraSmall).background(.thinMaterial, in: Capsule()) }
}

public struct FrickPresenceDot: View {
    private let active: Bool
    public init(active: Bool) { self.active = active }
    public var body: some View { Circle().fill(active ? .green : .secondary).frame(width: FrickTokens.Spacing.small, height: FrickTokens.Spacing.small) }
}

public struct FrickProgressRing: View {
    public init() {}
    public var body: some View { ProgressView() }
}

public struct FrickErrorState: View {
    private let title: String
    private let message: String
    public init(title: String, message: String) { self.title = title; self.message = message }
    public var body: some View { FrickSurface { VStack(alignment: .leading) { Text(title).font(.headline); Text(message).foregroundStyle(.secondary) } } }
}

public typealias FrickEmptyState = FrickErrorState

public struct FrickAvatarGroup: View {
    private let labels: [String]
    public init(labels: [String]) { self.labels = labels }
    public var body: some View { HStack(spacing: -FrickTokens.Spacing.extraSmall) { ForEach(labels, id: \.self) { FrickAvatar(label: $0) } } }
}

public struct FrickUserRow: View {
    private let label: String
    public init(label: String) { self.label = label }
    public var body: some View { HStack { FrickAvatar(label: label); Text(label).font(.headline) } }
}

public struct FrickMetricCard: View {
    private let label: String
    private let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }

    public var body: some View {
        FrickSurface {
            VStack(alignment: .leading, spacing: FrickTokens.Spacing.extraSmall) {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.title.weight(.bold))
            }
        }
    }
}

public struct FrickTable<Content: View>: View {
    private let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View { VStack(alignment: .leading, spacing: FrickTokens.Spacing.small) { content } }
}

public typealias FrickDataGrid<Content: View> = FrickTable<Content>
public typealias FrickColumn = FrickLabel
public typealias FrickCell = FrickText

public struct FrickTimePicker: View {
    private let title: String
    @Binding private var date: Date
    public init(_ title: String, date: Binding<Date>) { self.title = title; self._date = date }
    public var body: some View { DatePicker(title, selection: $date, displayedComponents: .hourAndMinute) }
}

public struct FrickDateTimePicker: View {
    private let title: String
    @Binding private var date: Date
    public init(_ title: String, date: Binding<Date>) { self.title = title; self._date = date }
    public var body: some View { DatePicker(title, selection: $date) }
}

public struct FrickDateRangePicker: View {
    @Binding private var start: Date
    @Binding private var end: Date
    public init(start: Binding<Date>, end: Binding<Date>) { self._start = start; self._end = end }
    public var body: some View { VStack { FrickDatePicker("Start", date: $start); FrickDatePicker("End", date: $end) } }
}

public struct FrickTimeline: View {
    private let items: [String]
    public init(items: [String]) { self.items = items }
    public var body: some View { VStack(alignment: .leading) { ForEach(items, id: \.self) { Text($0) } } }
}

public struct FrickChartSurface<Content: View>: View {
    private let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View { FrickSurface { content } }
}

public struct FrickDatePicker: View {
    private let title: String
    @Binding private var date: Date

    public init(_ title: String, date: Binding<Date>) {
        self.title = title
        self._date = date
    }

    public var body: some View {
        DatePicker(title, selection: $date, displayedComponents: .date)
    }
}

public struct FrickSparkline: View {
    private let values: [Double]

    public init(values: [Double]) {
        self.values = values
    }

    public var body: some View {
        GeometryReader { proxy in
            Path { path in
                guard let first = values.first else { return }
                let maxValue = max(1, values.max() ?? 1)
                path.move(to: point(index: 0, value: first, maxValue: maxValue, size: proxy.size))
                for pair in values.enumerated() {
                    path.addLine(to: point(index: pair.offset, value: pair.element, maxValue: maxValue, size: proxy.size))
                }
            }
            .stroke(.green, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
        }
        .frame(height: 44)
    }

    private func point(index: Int, value: Double, maxValue: Double, size: CGSize) -> CGPoint {
        let x = values.count <= 1 ? 0 : Double(index) / Double(values.count - 1) * size.width
        let y = size.height - (value / maxValue * size.height)
        return CGPoint(x: x, y: y)
    }
}

public typealias FrickLineChart = FrickSparkline
public typealias FrickBarChart = FrickSparkline
public typealias FrickAreaChart = FrickSparkline

public struct FrickPieChart: View {
    private let values: [Double]
    public init(values: [Double]) { self.values = values }
    public var body: some View { FrickChartSurface { Text("\(Int((values.first ?? 0) / max(1, values.reduce(0, +)) * 100))%") } }
}
```

- [ ] **Step 4: Add Android extended components**

Append to `apps/android/design/src/main/java/dev/frick/design/FoundationComponents.kt`:

```kotlin
@Composable
fun FrickText(value: String, modifier: Modifier = Modifier) {
    Text(text = value, modifier = modifier, style = MaterialTheme.typography.bodyLarge)
}

@Composable
fun FrickHeading(value: String, modifier: Modifier = Modifier) {
    Text(text = value, modifier = modifier, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
}

@Composable
fun FrickLabel(value: String, modifier: Modifier = Modifier) {
    Text(text = value, modifier = modifier, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
fun FrickDivider(modifier: Modifier = Modifier) {
    androidx.compose.material3.HorizontalDivider(modifier = modifier)
}

@Composable
fun FrickBadge(label: String, modifier: Modifier = Modifier) {
    AssistChip(modifier = modifier, onClick = {}, label = { Text(label) })
}

@Composable
fun FrickPresenceDot(active: Boolean, modifier: Modifier = Modifier) {
    androidx.compose.foundation.Canvas(modifier = modifier.padding(FrickTokens.Spacing.extraSmall)) {
        drawCircle(color = if (active) androidx.compose.ui.graphics.Color.Green else androidx.compose.ui.graphics.Color.Gray)
    }
}

@Composable
fun FrickProgressRing(modifier: Modifier = Modifier) {
    androidx.compose.material3.CircularProgressIndicator(modifier = modifier)
}

@Composable
fun FrickErrorState(title: String, message: String, modifier: Modifier = Modifier) {
    FrickSurface(modifier = modifier) {
        androidx.compose.foundation.layout.Column(modifier = Modifier.padding(FrickTokens.Spacing.medium)) {
            Text(text = title, fontWeight = FontWeight.Bold)
            Text(text = message, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun FrickEmptyState(title: String, message: String, modifier: Modifier = Modifier) {
    FrickErrorState(title = title, message = message, modifier = modifier)
}

@Composable
fun FrickAvatarGroup(labels: List<String>, modifier: Modifier = Modifier) {
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(FrickTokens.Spacing.extraSmall)) {
        labels.forEach { label -> FrickAvatar(label) }
    }
}

@Composable
fun FrickUserRow(label: String, modifier: Modifier = Modifier) {
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(FrickTokens.Spacing.small)) {
        FrickAvatar(label)
        Text(text = label, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun FrickMetricCard(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    FrickSurface(modifier = modifier) {
        androidx.compose.foundation.layout.Column(
            modifier = Modifier.padding(FrickTokens.Spacing.medium),
            verticalArrangement = Arrangement.spacedBy(FrickTokens.Spacing.extraSmall),
        ) {
            Text(text = label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(text = value, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
fun FrickTimeline(items: List<String>, modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(FrickTokens.Spacing.small)) {
        items.forEach { item -> Text(text = item) }
    }
}

@Composable
fun FrickSparkline(values: List<Float>, modifier: Modifier = Modifier) {
    Text(text = values.joinToString(prefix = "Sparkline ", separator = ", "), modifier = modifier)
}

@Composable
fun FrickLineChart(values: List<Float>, modifier: Modifier = Modifier) = FrickSparkline(values, modifier)

@Composable
fun FrickBarChart(values: List<Float>, modifier: Modifier = Modifier) = FrickSparkline(values, modifier)

@Composable
fun FrickAreaChart(values: List<Float>, modifier: Modifier = Modifier) = FrickSparkline(values, modifier)

@Composable
fun FrickPieChart(values: List<Float>, modifier: Modifier = Modifier) {
    val total = values.sum().coerceAtLeast(1f)
    Text(text = "${((values.firstOrNull() ?: 0f) / total * 100).toInt()}%", modifier = modifier)
}
```

- [ ] **Step 5: Run extended component tests**

Run:

```bash
pnpm --filter @frick/design-web exec vitest run src/components.test.tsx src/data-components.test.tsx
swift test --package-path packages/design-swift
cd apps/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH ./gradlew :design:testDebugUnitTest :design:lintDebug :design:assembleDebug
```

Expected: PASS.

- [ ] **Step 6: Commit extended components**

```bash
git add packages/design-web packages/design-swift apps/android/design
git commit -m "feat(design): add data picker and chart components"
```

---

### Task 8: Migrate Web Demo To Design Components

**Files:**
- Modify: `apps/web/src/App.tsx`
- Replace: `apps/web/src/styles.css`

- [ ] **Step 1: Update web app imports**

In `apps/web/src/App.tsx`, remove direct `lucide-react` imports and add:

```tsx
import {
  FrickAvatar,
  FrickButton,
  FrickChatBubble,
  FrickDesignProvider,
  FrickIcon,
  FrickIconButton,
  FrickMessageList,
  FrickMetricCard,
  FrickStatusChip,
  FrickSurface,
  FrickTextField,
} from "@frick/design-web";
```

- [ ] **Step 2: Wrap the app in design provider**

Replace the `return (` line with:

```tsx
  return (
    <FrickDesignProvider mode={theme} density="regular" brand="frick" iconPack="native">
      <main className="shell">
```

Add the closing `</FrickDesignProvider>` after `</main>`.

- [ ] **Step 3: Replace status, metrics, users, messages, composer, and signals with design components**

Replace the metric section with:

```tsx
        <section className="metrics" aria-label="Runtime metrics">
          <FrickMetricCard label="Schema" value="foundation" />
          <FrickMetricCard label="Cursor" value={`#${lastCursor}`} />
          <FrickMetricCard label="Pending" value={String(status.pendingMutations)} />
        </section>
```

Replace the status markup with:

```tsx
            <FrickStatusChip active={status.connected}>
              <FrickIcon name="status.live" />
              <span>{status.connected ? "Live" : "Offline"}</span>
            </FrickStatusChip>
```

Replace the theme button with:

```tsx
            <FrickIconButton
              icon="action.reload"
              label={theme === "dark" ? "Use light theme" : "Use dark theme"}
              type="button"
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            />
```

Use `FrickSurface` for side panels and call panel:

```tsx
          <FrickSurface className="side-panel">
            <PanelTitle title="Users" />
            <div className="user-list">
              {users.map((user) => (
                <div className="user-row" key={user.id}>
                  <FrickAvatar label={user.displayName} />
                  <strong>{user.displayName}</strong>
                </div>
              ))}
            </div>
          </FrickSurface>
```

Replace message list contents:

```tsx
            <FrickMessageList className="messages">
              {sortedMessages.map((message) => {
                const author = displayName(users, message.payload.senderId);
                return (
                  <FrickChatBubble
                    author={author}
                    key={message.eventId}
                    mine={message.payload.senderId === localUserId}
                    time={new Date(message.payload.createdAt).toLocaleTimeString()}
                  >
                    {message.payload.body}
                  </FrickChatBubble>
                );
              })}
              {sortedMessages.length === 0 ? <p className="empty">No messages yet</p> : null}
              <div aria-hidden="true" ref={messagesEndRef} />
            </FrickMessageList>
```

Replace composer input and send button:

```tsx
              <FrickTextField
                aria-label="Message"
                placeholder="Message the foundation"
                value={draft}
                onChange={(event) => void updateDraft(event.target.value)}
              />
              <FrickIconButton icon="action.send" label="Send message" type="submit" />
```

Replace `PanelTitle` implementation with text-only title:

```tsx
function PanelTitle({ title }: { title: string }) {
  return (
    <div className="panel-title">
      <h2>{title}</h2>
    </div>
  );
}
```

- [ ] **Step 4: Replace app CSS with shell/layout-only styles**

Replace `apps/web/src/styles.css` with:

```css
:root {
  color: var(--frick-color-text);
  background: var(--frick-color-page);
  color-scheme: light;
  font-family: var(--frick-typography-body-family);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

:root[data-theme="dark"] {
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}

button,
input {
  font: inherit;
}

.shell {
  min-height: 100vh;
  background:
    linear-gradient(120deg, rgba(84, 216, 172, 0.2), transparent 35%),
    linear-gradient(300deg, rgba(82, 121, 220, 0.16), transparent 42%),
    var(--frick-color-page);
  padding: var(--frick-spacing-extra-large);
}

.workspace {
  margin: 0 auto;
  max-width: 1180px;
}

.topbar {
  align-items: flex-start;
  display: flex;
  gap: var(--frick-spacing-large);
  justify-content: space-between;
  margin-bottom: var(--frick-spacing-large);
}

.top-actions {
  align-items: center;
  display: flex;
  gap: var(--frick-spacing-small);
}

.eyebrow {
  color: var(--frick-color-action-primary);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0;
  margin: 0 0 var(--frick-spacing-small);
  text-transform: uppercase;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  color: var(--frick-color-text);
  font-size: clamp(2.6rem, 8vw, 4.2rem);
  line-height: 0.98;
  letter-spacing: 0;
  max-width: 760px;
}

.metrics {
  display: grid;
  gap: var(--frick-spacing-small);
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-bottom: var(--frick-spacing-medium);
}

.grid {
  align-items: start;
  display: grid;
  gap: var(--frick-spacing-medium);
  grid-template-columns: minmax(180px, 0.75fr) minmax(0, 2fr) minmax(180px, 0.75fr);
}

.side-panel,
.call-panel {
  padding: var(--frick-spacing-medium);
}

.message-panel {
  display: grid;
  grid-template-rows: auto minmax(320px, min(54vh, 540px)) auto;
  overflow: hidden;
}

.panel-head {
  align-items: center;
  border-bottom: 1px solid var(--frick-color-border);
  display: flex;
  gap: var(--frick-spacing-medium);
  justify-content: space-between;
  padding: var(--frick-spacing-medium);
}

.panel-title {
  color: var(--frick-color-text);
}

.panel-title h2 {
  font-size: 1.05rem;
  line-height: 1.2;
}

.user-list {
  display: grid;
  gap: var(--frick-spacing-small);
  margin-top: var(--frick-spacing-medium);
}

.user-row {
  align-items: center;
  display: grid;
  gap: var(--frick-spacing-small);
  grid-template-columns: auto minmax(0, 1fr);
}

.user-row strong {
  color: var(--frick-color-text);
  overflow-wrap: anywhere;
}

.typing {
  border: 1px solid var(--frick-color-border);
  border-radius: var(--frick-corner-pill);
  color: var(--frick-color-text-muted);
  font-size: 0.84rem;
  font-weight: 800;
  padding: var(--frick-spacing-extra-small) var(--frick-spacing-small);
}

.typing[data-active="true"] {
  color: var(--frick-color-action-primary);
}

.messages {
  min-height: 320px;
  padding: var(--frick-spacing-medium);
  scroll-behavior: smooth;
}

.empty {
  color: var(--frick-color-text-muted);
  font-size: 0.9rem;
}

.composer {
  border-top: 1px solid var(--frick-color-border);
  display: grid;
  gap: var(--frick-spacing-small);
  grid-template-columns: minmax(0, 1fr) auto;
  padding: var(--frick-spacing-medium);
}

.call-panel {
  display: grid;
  gap: var(--frick-spacing-medium);
}

.signal-count {
  color: var(--frick-color-text);
  font-size: 3rem;
  line-height: 1;
}

@media (max-width: 900px) {
  .grid,
  .metrics {
    grid-template-columns: 1fr;
  }

  .topbar {
    align-items: stretch;
    flex-direction: column;
  }

  .top-actions {
    justify-content: space-between;
  }
}

@media (max-width: 520px) {
  .shell {
    padding: var(--frick-spacing-medium);
  }
}
```

- [ ] **Step 5: Run web checks**

Run:

```bash
pnpm typecheck
pnpm --filter @frick/web build
```

Expected: PASS.

- [ ] **Step 6: Commit web migration**

```bash
git add apps/web packages/design-web
git commit -m "feat(web): use Frick design components"
```

---

### Task 9: Migrate iOS Demo To Swift Design Components

**Files:**
- Modify: `apps/ios/project.yml`
- Modify: `apps/ios/FrickDemo/ContentView.swift`

- [ ] **Step 1: Add FrickDesign package to XcodeGen**

Update `apps/ios/project.yml` package block:

```yaml
packages:
  FrickSwift:
    path: ../../packages/swift
  FrickDesign:
    path: ../../packages/design-swift
```

Update target dependencies:

```yaml
dependencies:
  - package: FrickSwift
  - package: FrickDesign
  - sdk: AppIntents.framework
```

- [ ] **Step 2: Use FrickDesign in ContentView**

At the top of `apps/ios/FrickDemo/ContentView.swift`, add:

```swift
import FrickDesign
```

Replace the user row avatar block with:

```swift
FrickAvatar(label: user.displayName)
Text(user.displayName)
    .font(.headline)
```

Replace the message cell `VStack` with:

```swift
FrickChatBubble(
    author: model.displayName(for: message.payload["senderId"] ?? ""),
    bodyText: message.payload["body"] ?? "",
    isMine: (message.payload["senderId"] ?? "") == "user-ada"
)
```

Replace the composer `HStack` with:

```swift
FrickComposer(text: $model.draft, placeholder: "Message the foundation") {
    Task { await model.send() }
}
```

Replace status text with:

```swift
FrickStatusChip(model.status, active: model.status == "Live")
```

- [ ] **Step 3: Regenerate and build iOS**

Run:

```bash
pnpm ios:generate
pnpm ios:build
```

Expected: PASS.

- [ ] **Step 4: Commit iOS migration**

```bash
git add apps/ios packages/design-swift
git commit -m "feat(ios): use Frick design components"
```

---

### Task 10: Migrate Android Demo To Compose Design Components

**Files:**
- Modify: `apps/android/app/build.gradle.kts`
- Modify: `apps/android/app/src/main/java/dev/frick/demo/MainActivity.kt`

- [ ] **Step 1: Add app dependency on design module**

In `apps/android/app/build.gradle.kts`, add:

```kotlin
implementation(project(":design"))
```

next to the existing `implementation(project(":frick"))`.

- [ ] **Step 2: Replace app theme wrapper**

In `MainActivity.kt`, add imports:

```kotlin
import dev.frick.design.FrickAvatar
import dev.frick.design.FrickChatBubble
import dev.frick.design.FrickComposer
import dev.frick.design.FrickDesignTheme
import dev.frick.design.FrickMessageList
import dev.frick.design.FrickStatusChip
```

Replace:

```kotlin
FrickTheme {
    Surface(modifier = Modifier.fillMaxSize()) {
        FrickDemo()
    }
}
```

with:

```kotlin
FrickDesignTheme {
    Surface(modifier = Modifier.fillMaxSize()) {
        FrickDemo()
    }
}
```

Delete the local `FrickTheme` composable after imports are cleaned up.

- [ ] **Step 3: Replace local avatar and status UI**

In `Header`, replace the status `Text` with:

```kotlin
FrickStatusChip(label = status, active = status == "Live")
```

In `UsersRow`, replace the `Surface` initials block with:

```kotlin
FrickAvatar(label = user.displayName)
```

- [ ] **Step 4: Replace messages and composer**

In `MessagesList`, replace `LazyColumn` with:

```kotlin
FrickMessageList(
    modifier = modifier,
    state = listState,
) {
    items(messages, key = { message -> message.eventId }) { message ->
        val author = displayName(users, message.payload["senderId"].orEmpty())
        FrickChatBubble(
            author = author,
            body = message.payload["body"].orEmpty(),
            isMine = message.payload["senderId"].orEmpty() == "user-ada",
        )
    }
}
```

In `Composer`, replace the full `Row` body with:

```kotlin
FrickComposer(
    draft = draft,
    onDraftChange = onDraftChange,
    onSend = onSend,
    modifier = Modifier.fillMaxWidth(),
)
```

- [ ] **Step 5: Run Android checks**

Run:

```bash
pnpm android:build
```

Expected: PASS.

- [ ] **Step 6: Commit Android migration**

```bash
git add apps/android
git commit -m "feat(android): use Frick design components"
```

---

### Task 11: Runtime Verification Across Apps

**Files:**
- No source files unless checks expose defects.

- [ ] **Step 1: Run full static verification**

Run:

```bash
pnpm design:check
pnpm design:generate
pnpm test
pnpm typecheck
pnpm --filter @frick/web build
pnpm swift:test
pnpm ios:build
pnpm android:build
```

Expected: all commands pass.

- [ ] **Step 2: Start backend and web if they are not running**

Run:

```bash
lsof -nP -iTCP:4099 -sTCP:LISTEN || pnpm server
lsof -nP -iTCP:5173 -sTCP:LISTEN || pnpm web
```

Expected: server listens on `127.0.0.1:4099`, web listens on `127.0.0.1:5173`.

- [ ] **Step 3: Verify web visually**

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Expected:

- Runtime metrics use `FrickMetricCard`.
- Messages render as incoming/outgoing chat bubbles.
- Composer uses tokenized text field and icon send button.
- Status chip says `Live`.
- Existing bottom scroll anchor still shows the newest message.

- [ ] **Step 4: Launch iOS**

Use XcodeBuildMCP:

1. Run `session_show_defaults`.
2. If defaults are missing, set:
   - project path: `/Users/bri/dev/Frick/apps/ios/FrickDemo.xcodeproj`
   - scheme: `FrickDemo`
   - simulator: `iPhone 17`
   - platform: `iOS Simulator`
   - configuration: `Debug`
   - bundle id: `dev.frick.demo`
3. Run `build_run_sim`.

Expected: iOS launches, shows `Foundation General`, `Live`, bubbly messages, and composer.

- [ ] **Step 5: Launch Android**

Run:

```bash
pnpm android:install
```

Expected: Android launches, shows `Foundation General`, `Live`, bubbly messages, and composer.

- [ ] **Step 6: Verify realtime propagation with a smoke message**

Run:

```bash
ts=$(date +%s)
body="Design smoke $ts"
curl -sS -X POST http://127.0.0.1:4099/append \
  -H 'content-type: application/json' \
  -d "{\"requestId\":\"design-smoke-$ts\",\"replicaId\":\"codex-design-smoke\",\"stream\":\"MessageStream\",\"key\":\"conversation-general\",\"event\":\"MessageSent\",\"payload\":{\"messageId\":\"message-design-smoke-$ts\",\"senderId\":\"user-ada\",\"body\":\"$body\",\"createdAt\":\"2026-05-09T00:00:00.000Z\"}}"
printf '%s\n' "$body"
```

Expected: the smoke message appears at the bottom of web, iOS, and Android.

- [ ] **Step 7: Commit verification fixes or final status**

If code changed during verification:

```bash
git add <changed-files>
git commit -m "fix(design): stabilize cross-platform demo migration"
```

If no code changed, do not create an empty commit.

---

### Task 12: Documentation

**Files:**
- Modify: `README.md`
- Create: `docs/design-language.md`

- [ ] **Step 1: Update README commands**

Add under Commands in `README.md`:

```md
Design system:

```bash
pnpm design:check
pnpm design:generate
```
```

Add to What The Harnesses Prove:

```md
- A typed design token and icon graph generates static web, Swift, and Kotlin artifacts.
- Web, iOS, and Android demos consume semantic native design components with runtime density and theme context.
```

- [ ] **Step 2: Add design docs**

Create `docs/design-language.md`:

```md
# Frick Design Language

Frick's design language is authored once in `packages/design` and generated into web, SwiftUI, and Android Compose artifacts.

## Commands

```bash
pnpm design:check
pnpm design:generate
```

## Runtime Context

- `mode`: `system`, `light`, or `dark`
- `density`: `compact`, `regular`, or `comfortable`
- `brand`: `frick` or `frickenChat`
- `iconPack`: `native` or `frick`

## Rules

- Use semantic tokens and components instead of raw spacing, radius, color, or icon literals.
- Use `FrickIcon` semantic names instead of importing platform icon names in app code.
- Keep data clients separate from design packages.
- Commit generated artifacts after changing canonical design definitions.
```

- [ ] **Step 3: Run final docs-adjacent verification**

Run:

```bash
pnpm design:check
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit docs**

```bash
git add README.md docs/design-language.md
git commit -m "docs: document Frick design language workflow"
```

---

## Self-Review Checklist

- Spec coverage: token graph, icon aliases, runtime context, generation, validation, web/Swift/Android components, tables/date/charts, demo rollout, and tests are covered by Tasks 1-12.
- Red-flag scan: this plan has concrete file paths, commands, code snippets, and expected results for every task.
- Type consistency: `FrickDesignProvider`, `FrickTokens`, `FrickIconName`, `FrickChatBubble`, `FrickComposer`, and density/mode names are consistent across tasks.
- Execution boundary: this plan does not publish packages or build an enterprise grid/charting platform; it produces a working Phase 1 native design framework.
