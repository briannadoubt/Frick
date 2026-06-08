# Driver brief: finish the FR board

You are an autonomous staff engineer driving the **Frick** monorepo (`/Users/bri/dev/Frick`) — a pre‑1.0, schema‑driven realtime framework with a TypeScript server + web client, a Swift client (`packages/swift`), and an Android/Kotlin client (`apps/android`). Your mission: **work the remaining open tickets on the Scope board to done**, merging each to `main`, keeping every suite green, and producing **cohesive, properly‑architected code** — not a pile of independent patches.

Treat this as a campaign: plan in waves, fan out **worktree‑isolated subagents** for parallelism, verify the integrated result after each wave, and keep the board honest as you go.

---

## 1. The non‑negotiable per‑ticket process

For every ticket (whether you do it or a subagent does):

1. `git checkout -b feat/<frX>-<slug>` off the latest `main`.
2. `scope branch <FR-X> <branch> --in-progress --by claude`.
3. Implement **minimal, focused, additive** changes. Add tests. Add a `## Unreleased` entry to `CHANGELOG.md`.
4. **Quality gate (MANDATORY before any merge)** — run the validators for every package you touched (see §3). They must ALL pass, including the pre‑existing suites. If you cannot get fully green, **do not merge**: leave the branch, `scope comment <FR-X> "<blocker>"`, keep it `in_progress`, and report. Never merge red.
5. Commit. The commit message body MUST end with exactly:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
6. `scope status <FR-X> done --by claude` + `scope comment <FR-X> "<1–2 sentence summary>"`, then `git add .scope/events && git commit -m "chore(scope): <FR-X> done"`.
7. **Merge to main — rebase + fast‑forward push, never check out `main` in a worktree, never force‑push:**
   ```
   git fetch origin
   git rebase origin/main      # replay your commits on the latest main
   # re-run the full quality gate — it must still pass after the rebase
   git push origin HEAD:main   # fast-forward main
   ```
   If the push is rejected (a sibling advanced `main`), repeat `fetch → rebase → gate → push`, up to ~6 times.
8. Report: what shipped, the final test summary lines, and the commit SHA now on `origin/main`.

**Merge‑conflict rules.** `.scope/events/*` are unique‑named append‑only files — they never conflict. The one true contention point is `CHANGELOG.md`'s `## Unreleased` section: on conflict, **keep BOTH your entry and the existing ones**, and before committing the resolution **verify no `<<<<<<<` / `=======` / `>>>>>>>` markers remain** (`grep -nE '^(<<<<<<<|=======|>>>>>>>)' CHANGELOG.md`). A stray marker has already broken `main` once — do not repeat it. For source conflicts, resolve minimally + correctly and re‑run the gate.

---

## 2. Architecture & cohesion bar (the point of this campaign)

- **Build on what exists; do not reinvent.** Read the neighbouring code first and match its patterns, naming, and layering. Examples that must be extended, not duplicated:
  - Server stores all go through the async **`SqlDriver`** seam (`?` placeholders; `dialect` for the rare non‑portable bit; `INSERT … ON CONFLICT … DO UPDATE` / `RETURNING id` for portability). New stores follow the same shape and get SQLite **and** Postgres parity (add to both `migrations.ts` and `pg-framework-migrations.ts` + their `FRAMEWORK_TABLES`).
  - Swift observation tier: `FrickStore<Model: FrickModel>` (`@MainActor @Observable`, `items`/`hasBootstrapped`/`lastError`/`start()`/`reset()`, fed by a `FrickStoreEventSource`) in `packages/swift/Sources/FrickSwift/FrickStore.swift`, and `FrickSessionManager` (FR‑139). New Swift reactive layers compose these — same `@MainActor`/`@Observable` idioms, no parallel store abstraction.
  - Android observation tier: `FrickObservableStore<Model>` (`StateFlow<List<Model>>`, `FrickObjectDecoder`, `start()`/`get()`/`remove()`/`close()`) in `apps/android/frick/.../FrickObservableStore.kt`. New Compose/Kotlin layers compose this.
  - Cluster bus adapters implement `FrickClusterBus` (see `MemoryClusterBus`/`RedisClusterBus`). Push/email/blob adapters follow their existing seam interfaces.
- **Cross‑platform semantics stay identical; APIs stay idiomatic.** Swift uses reference types + Observation; Kotlin uses immutable data + `StateFlow`/Flow; web uses signals. Same behavior, platform‑native shape. When a wire/protocol detail changes, change it in `@fricken/protocol` once and mirror in all three clients.
- **Keep tickets that share a design in one agent.** A platform's registry + query helper, or a feature + its tests, belong together so the result is one coherent layer — don't split tightly‑coupled work across parallel agents that can't see each other.
- **Don't widen scope.** Each ticket is additive and backward‑compatible unless it explicitly says otherwise; existing tests must stay green. If something is genuinely a separate concern, file a follow‑up ticket rather than smuggling it in.

---

## 3. Validation matrix (run what you touched; the whole gate must be green)

- TypeScript typecheck (always): `pnpm typecheck` → exit 0.
- Server: `pnpm --filter @fricken/server exec vitest run` (currently ~933 passing).
- Web client / core: `pnpm --filter @fricken/core exec vitest run`.
- Protocol: `pnpm --filter @fricken/protocol test`. Design: `@fricken/design`, `@fricken/design-web`. CLI: `@fricken/cli`. Bench: `bench/`.
- Swift: `cd packages/swift && swift test` (currently 84 passing). Note: editor/SourceKit "cannot find type / no module XCTest" warnings are indexing noise — `swift test` is the source of truth.
- Android: `cd apps/android && ./gradlew :frick:testDebugUnitTest` (the framework module; SDK is installed). CI gates `:frick`, `:frick-compose`, `:design` — run those if you touch them. The demo `:app` is excluded from CI.
- After regenerating artifacts: `pnpm verify:generated` (schema/fixtures/design tokens drift gate). If you change the schema or design tokens, regenerate (`pnpm schema:generate` / `pnpm design:generate`) and commit the result; never hand‑edit generated files.
- Postgres/Redis‑gated suites run only when `FRICK_DATABASE_URL` / `FRICK_REDIS_URL` are set (they skip cleanly otherwise). To exercise them: `docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=frick -e POSTGRES_DB=frick_test postgres:16-alpine` and `docker run -d -p 6380:6379 redis:7-alpine`, then export the URLs. (Colima is the docker runtime here; `colima start` if the daemon is down. Pick a free host port — 5433 is an SSH tunnel.)

Gotchas: `apps/server/src/sync/gateway.ts` contains an intentional NUL byte (a `tenantId\0userId` composite key) — `grep` treats it as binary, use `grep -a` / `rg --text`. Run server/protocol vitest from the repo root (the package `test` scripts `cd ../..`).

---

## 4. The remaining board, grouped into cohesive waves

Current `main`: clean. ~47 open tickets. Recommended order — finish the native parity epics first (highest user priority: "don't leave Swift/Android behind"), then the cross‑cutting UI, then the large infra epics last (some need design or descoping).

**Wave A — finish the native observation tiers (build on FR‑136 Swift / FR‑148 Android):**
- Swift `FR-137` (store registry) **+** `FR-138` (`@FrickQuery` SwiftUI `DynamicProperty`) — one agent, one cohesive layer over `FrickStore<Model>` with Environment plumbing.
- Android `FR-149` (store registry) **+** `FR-150` (Compose collection state / `rememberFrickQuery` over `collectAsState`) — one agent over `FrickObservableStore`.
- Swift `FR-140` (`FrickSharingService`) and Android `FR-152` (sharing service) — observable shared‑with‑me / outgoing‑shares over the grant+invitation surface. Separate agents (different files), but mirror each other's shape.
- `FR-151` (Android observable session manager) — Kotlin parity with Swift `FrickSessionManager` (FR‑139): a `StateFlow` auth‑state holder riding the client's encrypted session persistence, dropping ad‑hoc SharedPreferences.
- `FR-141` (Swift `@FrickModel` macro) — DTO‑wrapper scaffolding macro; lower priority, needs SwiftSyntax. Optional; descope if it balloons.
- `FR-112` (Swift/Kotlin projection subscribe + delta apply) — **mostly already present** (both clients surface `ProjectionDelta`). Likely a verify‑and‑test‑and‑close, or a small apply‑into‑store gap. Touches the sync sockets, so do NOT run it in parallel with anything else that edits `FrickSyncSocket.swift`/`.kt`.

**Wave B — native sync telemetry (FR‑14 epic):** `FR-74` (Swift OTel spans/metrics for the WS sync loop) and `FR-75` (Android OTel). Both touch the sync sockets — serialize against Wave A's socket‑touching work (FR‑112) and against each other only per‑platform. Mirror the TS client's sync spans.

**Wave C — WorkspaceShell (FR‑16) + component/a11y parity (FR‑17/19):** `FR-86` (web shell), `FR-87` (SwiftUI shell), `FR-88` (Android Compose shell), `FR-89` (demo cutover), `FR-90` (responsive tests); `FR-91`/`FR-92` (iOS/Android component parity to the Phase‑1 set); `FR-102` (dynamic type / text scaling). These are UI‑heavy; lean on the design‑system tokens and the a11y contract (FR‑101, done). Validate Swift/Android via their test modules; web via `@fricken/design-web`.

**Wave D — remaining server/tooling:** `FR-57` (orphaned‑blob cleanup job — **design carefully**: only declared blob‑ref fields are known references; make it opt‑in + grace‑windowed so it can't delete blobs referenced via untyped fields — see the ticket comment), `FR-31` (SAML provider routing — needs assertion/signature validation; use a vetted lib or a pluggable verifier), `FR-99` (codec speed benchmarks across TS/Swift/Kotlin — extend `bench/`).

**Large epics — design‑first, do NOT brute‑force in parallel:**
- `FR-6` Multi‑app/tenant isolation (`FR-36` app_id column + migration, `FR-37` scope threading, `FR-38` per‑app registries, `FR-40` isolation tests): `FR-36`/`FR-37` touch many tables + every read/write path — this is a single, careful, sequential effort (one agent or do it yourself), not a fan‑out. Land `FR-36` (additive `app_id` default) before `FR-37`.
- `FR-15` Realtime calls (`FR-80`–`FR-85`): a WebRTC/SFU subsystem — start with the `MediaPlaneAdapter` interface + fake (already partly specced) and the call control‑plane state machine; SFU/E2EE are deep. Scope a slice; don't attempt all at once.
- `FR-20` Multi‑region (`FR-105`–`FR-107`): design + adapter; lowest priority. A design doc + adapter seam is a reasonable first deliverable.

After each wave: `git fetch && git reset --hard origin/main`, prune agent worktrees (`for wt in $(git worktree list --porcelain | grep "^worktree" | grep agent- | awk '{print $2}'); do git worktree remove --force "$wt"; done; git worktree prune`), then run the **integrated** gate (Swift `swift test`, Android `:frick:testDebugUnitTest`, server/core/protocol vitest, `pnpm typecheck`) to confirm the parallel merges compose. Fix any integration break (or stray CHANGELOG marker) immediately. Close an epic only when all its children are done/cancelled.

---

## 5. Using subagents

Fan out **worktree‑isolated** subagents (`isolation: "worktree"`) for independent, disjoint‑file tickets — but keep tightly‑coupled work (a platform's registry+query, a feature+tests) inside one agent for cohesion. Give each agent: the ticket(s), the exact existing types/files to build on, the §1 process verbatim, the §3 validators for its packages, and the §2 cohesion bar. Pick disjoint file areas per wave so concurrent merges rarely conflict; the rebase+ff‑push loop handles the rest. After dispatching a wave, verify the integrated result yourself before starting the next.

Stop and report if: a quality gate can't be made green, a ticket needs a product/architecture decision that isn't implied by the code + docs, or an epic genuinely needs a design pass before implementation.
