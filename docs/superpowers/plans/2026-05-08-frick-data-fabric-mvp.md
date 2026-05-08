# Frick Data Fabric MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, testable MVP of Frick as a drop-in realtime data framework with a server, web demo, and native mobile demo apps reading the same backend data.

**Architecture:** The MVP uses a TypeScript monorepo with a schema-aware binary protocol package, a client runtime package, React hooks, a Node sync server backed by SQLite, and demo clients. The server exposes a MessagePack WebSocket sync protocol for web clients and simple REST reads for native demo apps. Tilt runs the server and web demo so the backend runtime is visible locally.

**Tech Stack:** pnpm workspaces, TypeScript, Vitest, Node `node:sqlite`, WebSocket, MessagePack, React/Vite, Tilt, SwiftUI/XcodeGen, Android Compose/Gradle.

---

### Task 1: Monorepo Foundation

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `README.md`

- [x] **Step 1: Write root package and workspace configuration**

Create a pnpm workspace containing packages and apps, with scripts for install, test, typecheck, server, web, and Tilt.

- [x] **Step 2: Add baseline TypeScript config**

Use strict TypeScript settings and package-level configs that extend the root config.

- [x] **Step 3: Add documentation**

Document the stack, local commands, ports, and demo behavior in the README.

### Task 2: Protocol Package

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/schema.ts`
- Create: `packages/protocol/src/frame.ts`
- Create: `packages/protocol/src/sample.ts`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/tests/protocol.test.ts`

- [x] **Step 1: Write failing protocol tests**

Test compact object packing by field id and MessagePack binary frame round-trips.

- [x] **Step 2: Implement schema manifest helpers**

Create manifest types, object packing/unpacking, patch packing/unpacking, and sample Task/Project schema.

- [x] **Step 3: Implement frame encoding**

Create versioned frame tuples and MessagePack encode/decode helpers.

### Task 3: Core Client Runtime

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/runtime.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/tests/runtime.test.ts`

- [x] **Step 1: Write failing runtime tests**

Test applying snapshots/deltas and refreshing query subscriptions.

- [x] **Step 2: Implement runtime store**

Build a small observable replicated object store with query subscriptions, optimistic mutations, WebSocket frame handling, and sync status.

### Task 4: React Bindings

**Files:**
- Create: `packages/react/package.json`
- Create: `packages/react/tsconfig.json`
- Create: `packages/react/src/index.tsx`

- [x] **Step 1: Implement provider and hooks**

Expose `FrickProvider`, `useQuery`, `useMutation`, and `useSyncStatus` as thin adapters over the core runtime.

### Task 5: Sync Server

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/store.ts`
- Create: `apps/server/src/server.ts`
- Create: `apps/server/src/index.ts`
- Create: `apps/server/tests/store.test.ts`

- [x] **Step 1: Write failing store tests**

Test SQLite-backed seed/query/mutation behavior.

- [x] **Step 2: Implement SQLite storage**

Store packed objects and packed patches as MessagePack BLOBs, maintain an op log, and materialize object state.

- [x] **Step 3: Implement HTTP and WebSocket server**

Expose `/health`, `/manifest`, `/objects`, and `/_frick/sync`. Handle subscribe, mutate, ack, delta broadcast, and snapshot refresh frames.

### Task 6: Web Demo

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`

- [x] **Step 1: Build Vite React app**

Create a polished data-dashboard demo that uses Frick hooks to load projects/tasks from the sync server and mutate task state.

### Task 7: Tilt Runtime

**Files:**
- Create: `Tiltfile`

- [x] **Step 1: Add local resources**

Define Tilt resources for dependency install, server, web app, health check, and links to server/web URLs.

### Task 8: iOS SwiftUI Demo

**Files:**
- Create: `apps/ios/project.yml`
- Create: `apps/ios/FrickDemo/FrickDemoApp.swift`
- Create: `apps/ios/FrickDemo/ContentView.swift`

- [x] **Step 1: Create real SwiftUI app project**

Use XcodeGen to generate an iOS app project that fetches server data from `http://127.0.0.1:4099/objects`.

### Task 9: Android Compose Demo

**Files:**
- Create: `apps/android/settings.gradle.kts`
- Create: `apps/android/build.gradle.kts`
- Create: `apps/android/app/build.gradle.kts`
- Create: `apps/android/app/src/main/AndroidManifest.xml`
- Create: `apps/android/app/src/main/java/dev/frick/demo/MainActivity.kt`
- Create: `apps/android/app/src/main/res/values/strings.xml`

- [x] **Step 1: Create real Android app project**

Use Gradle and Compose to build an app that fetches the same server data from `http://10.0.2.2:4099/objects`.

### Task 10: Verification

**Files:**
- Modify only if verification exposes defects.

- [x] **Step 1: Install dependencies**

Run `pnpm install`.

- [x] **Step 2: Run unit tests**

Run `pnpm test`.

- [x] **Step 3: Run typecheck**

Run `pnpm typecheck`.

- [x] **Step 4: Start server and web app**

Run the local stack and verify `/health`, the web app, and Tilt.

- [x] **Step 5: Build and run iOS demo**

Generate the Xcode project, build the app, and launch it on a booted simulator.

- [x] **Step 6: Install Android command-line tooling**

Install Java, Gradle, Android SDK platform tools, emulator, platform, build tools, and a system image.

- [x] **Step 7: Build and run Android demo**

Build the Compose app and launch it on an emulator when Android tooling is available.
