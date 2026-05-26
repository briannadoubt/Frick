---
name: frick-jobs
description: Use when designing, implementing, or debugging Frick durable jobs, background work, retries, or job inspection.
---

# Frick Jobs

Read `docs/authoring.md` and `docs/operations.md`.

Job guidance:
- Add job payload shape to the schema before handler code.
- Register handlers through `createFrickServer({ jobs: { handlers } })`; do
  not claim job rows directly from app code.
- Use `createFrickServer({ recurring: { jobs } })` for cron-like schedules.
  Keep `resolveTargets` cheap and deterministic; put slow network or compute
  work in the handler.
- Keep retry behavior and idempotency explicit in the spine.
- Use structured error envelopes for framework-visible failures.
- Inspect local job state with `frick inspect jobs` or `pnpm cli inspect jobs`.

Test enqueue, retry, success, and failure behavior. Do not make client SDKs infer job state from private server storage.
