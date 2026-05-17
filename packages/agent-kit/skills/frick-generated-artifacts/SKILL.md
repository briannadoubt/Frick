---
name: frick-generated-artifacts
description: Use when schema, fixture, Swift, Kotlin, design-web, design-swift, or Android design generated artifacts may need regeneration or drift checks.
---

# Frick Generated Artifacts

Read `docs/framework-boundaries.md` and `docs/onboarding.md`.

Never hand-edit generated files. Regenerate with:

```bash
pnpm schema:generate
pnpm design:generate
pnpm verify:generated
```

Generated families include protocol DTOs, fixtures, TypeScript core generated files, web design tokens, Swift generated DTOs/tokens, and Android generated DTOs/tokens.

If generated drift appears, inspect the source schema or design definition rather than patching generated output.
