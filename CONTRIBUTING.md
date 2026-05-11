# Contributing to Frick

Thanks for working on Frick. This document covers the bare minimum you need to make a change land cleanly: how to run the test suite, the workflow we follow inside the repo, what commit messages and PRs should look like, and where the big-picture architectural plan lives.

If you haven't run the project before, start with the [onboarding guide](./docs/onboarding.md) — it gets you to a working local server and web demo before you make your first edit.

## Running the test suite

The full quality gate is:

```bash
pnpm test                  # vitest across all TS packages and apps
pnpm typecheck             # composite tsc -b
pnpm verify:generated      # regenerates artifacts; fails if anything drifted
```

If you touched the Swift or Android client paths, also run the native checks. They take longer (and require Xcode and the Android SDK respectively):

```bash
pnpm swift:test            # swift test for packages/swift and packages/design-swift
pnpm android:build         # Gradle: unit tests + lint + assembleDebug for frick, design, app
```

For ad-hoc iteration:

```bash
pnpm server                # boots the dev server on 127.0.0.1:4099
pnpm web                   # boots the web demo on 127.0.0.1:5173
pnpm tilt                  # one-command local dashboard (install, schema:generate, server, web)
pnpm cli <command>         # invoke the `frick` CLI in development mode
```

## Workflow

We use subagent-driven development for non-trivial changes. The short version:

1. Capture the intent as a design document under `docs/superpowers/specs/` and a delivery plan under `docs/superpowers/plans/`. The plan slices the work into independent, individually-shippable pieces.
2. Each slice is implemented in its own worktree by a focused agent — small, scoped, verifiable.
3. Every slice ends green on `pnpm test && pnpm typecheck && pnpm verify:generated` (plus native checks if it touched native paths). Slices that share files coordinate via the plan.

For small, obvious fixes you can skip the spec-and-plan dance and just open a PR. Use judgement.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/). The common prefixes you'll use:

- `feat(scope):` — new user-visible capability.
- `fix(scope):` — bug fix.
- `docs:` — documentation only.
- `refactor(scope):` — internal change with no behavioral diff.
- `test(scope):` — test-only changes.
- `chore:` — dependency bumps, tooling, anything else.

The body should focus on **why**, not what — the diff already shows what changed. Keep the subject under ~72 characters and avoid trailing punctuation.

## Pull requests

Every PR is expected to:

- Pass `pnpm test`, `pnpm typecheck`, and `pnpm verify:generated` locally before review.
- Include native verification in the PR description if the change touched Swift (`pnpm swift:test`) or Android (`pnpm android:build`) paths.
- Include or update relevant tests. Doc-only changes are exempt.
- Update the relevant doc (`docs/operations.md`, `docs/authoring.md`, `docs/schema-author-tutorial.md`, etc.) when behavior or surface area changes.
- Avoid hand-editing generated artifacts. Regenerate them with `pnpm schema:generate` / `pnpm fixtures:generate` and commit the result.

If you're changing the schema, read [`docs/schema-author-tutorial.md`](./docs/schema-author-tutorial.md) first and run `pnpm cli lint --against <baseline>` to confirm whether you need a `schemaRevision` bump.

## The bigger picture

The framework hardening spec is the canonical roadmap for what Frick is becoming and why each slice exists. Read it before a non-trivial change so your work lines up with the rest of the in-flight slices:

- [`docs/superpowers/specs/2026-05-10-frick-fullstack-framework-hardening-design.md`](./docs/superpowers/specs/2026-05-10-frick-fullstack-framework-hardening-design.md)

The matching delivery plan and other specs live alongside it under `docs/superpowers/`.

## Reporting issues

When filing a bug, include:

- the Frick commit hash you reproduced on,
- the schema id and hash (`pnpm cli schema check` will print them),
- the platform(s) involved (server, web, iOS, Android),
- the smallest reproduction you can manage — ideally a failing test under the relevant package's `tests/` directory.
