# Frick Platform Runtime and Production Dashboard Design

Date: 2026-05-17
Status: Draft for user review

## Purpose

Frick should feel like a self-hostable Firebase-like app platform. Developers
define schemas and product logic in code, then use a ready-made Frick runtime to
run, inspect, operate, instrument, and deploy the app. The app should not own a
copied backend template. The app plugs into a Frick-owned platform runtime.

The current repository already has the framework substrate: schema artifacts,
server runtime, sync protocol, TypeScript/React/Swift/Kotlin clients, storage,
jobs, auth/session basics, admin/inspection routes, a CLI, and a local
dashboard. This design defines the next product layer: a standard runtime and
dashboard that make those capabilities feel like one coherent platform.

## Goals

- Make `frick dev` stand up a complete local platform for a project.
- Make `frick dashboard` and the mounted production dashboard show schema,
  data, accounts, tenants, jobs, storage, analytics, traces, metrics, and logs
  from the running project.
- Make project schemas appear automatically in the dashboard as browsable,
  permission-aware resources.
- Add first-class OpenTelemetry for server and clients.
- Add first-class product analytics with automatic SDK tracking and explicit
  app-defined events.
- Keep analytics local-first and app-owned, with optional export to external
  OTel backends or future Frick Cloud.
- Provide a standard deployable service model that can target Docker Compose
  first and Kubernetes/Helm later.
- Keep app source small: schema, policy/auth integration, handlers,
  projections, jobs, and app config.

## Non-Goals

- Do not generate a full backend platform into each app repository.
- Do not require Frick Cloud for local development or production deployment.
- Do not make dangerous data mutation available in the dashboard without
  explicit app policy.
- Do not replace existing external observability tools. Frick should emit OTel
  cleanly and provide a useful local view.
- Do not make the dashboard the only way to operate Frick. CLI and documented
  runtime APIs remain first-class.

## Product Model

Frick has three layers:

1. **App project**: developer-owned schema, policies, auth bridge, handlers,
   jobs, projections, and client app.
2. **Platform runtime**: Frick-owned server, sync, storage, auth/account
   surfaces, telemetry, product analytics, dashboard APIs, workers, and
   deployment profiles.
3. **Control surfaces**: dashboard, CLI, local dev orchestration, and future
   Frick Cloud connector.

The important boundary is that the app describes what product it is building,
while Frick owns the platform mechanics.

## Runtime Architecture

The platform runtime loads a project module instead of being copied into the
project. A project module exposes:

- schema definitions and schema identity
- optional app manifest metadata
- policy hooks and authorization hooks
- auth provider integration
- object/stream handlers
- projections
- job handlers
- analytics event definitions
- dashboard display hints
- deployment/config overrides

The runtime composes this module with built-in services:

- HTTP and WebSocket sync server
- auth/session/account service
- tenant service
- object, stream, projection, blob, search, and job stores
- admin and dashboard APIs
- audit log
- OpenTelemetry instrumentation
- product analytics ingestion and aggregation
- dashboard static assets mounted at `/_frick/dashboard`
- optional cluster bus
- optional worker process

This preserves the current framework pieces while adding a product-grade
loading and deployment boundary.

## Dashboard Architecture

The dashboard has two supported serving modes:

- **Mounted mode**: the production default. The Frick server serves the
  dashboard at `/_frick/dashboard`, shares same-origin auth, and exposes
  dashboard APIs under documented `/_frick/dashboard/api/*` routes.
- **Standalone mode**: useful for local development, support, and unusual
  deployments. The static app points at a Frick endpoint and authenticates with
  a dashboard-scoped token.

The dashboard is schema-aware. When an app defines objects, streams,
projections, jobs, blobs, indexes, analytics events, and auth/account surfaces,
the dashboard derives navigation and panels from runtime metadata.

Initial dashboard sections:

- Overview
- Schema
- Data browser
- Accounts
- Tenants
- Auth sessions
- Realtime
- Jobs
- Storage
- Search
- Product analytics
- Observability
- Audit log
- Settings

Dashboard actions are capability-gated. Read-only views work broadly for
authorized operators. Mutating actions are only available when the project
module exposes an explicit policy for that action.

## Authorization Model

The dashboard supports both project-wide admins and tenant-scoped admins from
the beginning.

- **Project admin**: can inspect and operate all tenants for a deployment.
- **Tenant admin**: can inspect and operate only assigned tenant scopes.

The Frick server owns the authorization decision. The dashboard never decides
authority from local UI state. A dashboard session resolves to:

- principal id
- tenant scope
- project scope
- capabilities
- auth provider metadata

Login is app-owned. The app can use native auth, OIDC, SAML, GitHub, or another
provider, then map the authenticated principal into Frick dashboard
capabilities. This gives bring-your-own identity without making the dashboard
own app identity.

All dashboard mutations write an audit record with:

- actor principal
- tenant/project scope
- action name
- target
- request id
- before/after summary when safe
- timestamp
- result

## Data Browser

Schema-defined data appears automatically. For each object, stream, projection,
and search index, the dashboard can show:

- schema fields
- records/events
- tenant and account visibility
- version/cursor metadata
- validation errors
- indexing status
- related jobs or DevTools events

Default production behavior is read-only. App-defined policies can enable safe
operations such as:

- create invited account
- disable account
- rotate token
- retry job
- cancel job
- rebuild projection
- reindex search index
- edit whitelisted object fields
- delete whitelisted records

Each mutation must pass server-side policy, emit audit, and return a structured
result envelope.

## OpenTelemetry

OpenTelemetry is a first-class runtime service. Frick should instrument the
server and clients by default, while keeping export configurable.

Server instrumentation includes:

- HTTP request spans and metrics
- WebSocket connection and frame metrics
- sync operation spans
- auth/session spans and counters
- storage operation spans where useful
- job claim/run/retry/dead-letter spans and metrics
- blob/search/push/email spans and metrics
- structured exception events
- request id and trace id correlation in logs and dashboard events

The standard runtime includes an OTel Collector service in deployment profiles.
Default local behavior stores enough telemetry locally for the dashboard and can
export through OTLP when configured. Production deployments can export to
Grafana, Honeycomb, Datadog, OpenTelemetry Collector pipelines, or future Frick
Cloud.

Frick keeps its small internal metrics facade only as a compatibility wrapper.
The long-term implementation should bridge that facade to OTel instruments.

## Product Analytics

Product analytics is separate from observability. OTel describes system
behavior; product analytics describes user, account, tenant, and feature
behavior.

Frick ships a local-first analytics pipeline:

- client SDKs emit automatic lifecycle events
- apps can define typed product events
- server validates event names, dimensions, scopes, and privacy rules
- events are tenant-scoped and account-aware
- raw retention is bounded
- aggregates power dashboard views
- optional export sends approved derived events or aggregates to external
  systems

Initial automatic events:

- app/session start and end
- login/logout/signup
- screen or route view when a client integration provides route names
- sync connect/disconnect/reconnect
- sync error
- object read/write summaries
- stream append summaries
- job-triggered user-visible workflow summaries
- client error
- performance timing basics

Apps can define explicit events such as `checkout.started`,
`invite.accepted`, or `message.sent`, with allowed dimensions and sensitivity
classification.

The dashboard starts with simple views:

- active users/accounts/tenants
- session counts
- route/screen activity
- top events
- sync health by client
- errors by version/platform
- tenant/account activity

Funnels, cohorts, retention, and feature adoption come after the event and
aggregation contracts are stable.

## Client SDK Tracking

TypeScript, React, Swift, and Kotlin clients get a common telemetry contract.

The base client tracks sync lifecycle, connection state, errors, schema
compatibility failures, and request ids. UI integrations can add screen/route
tracking:

- React provider can accept a route/screen resolver.
- Swift and Kotlin SDKs expose explicit screen/event APIs and optional
  integration helpers.
- All SDKs expose `track(eventName, properties)` for app-defined product
  events.

Client telemetry must honor privacy defaults:

- no raw message/blob payload capture by default
- no passwords/tokens/secrets
- field-level redaction based on schema sensitivity metadata
- tenant/account/user identifiers normalized through the server
- opt-out and sampling hooks

## Standard Deployment

Frick should define one logical service model and support multiple runners.

Initial service model:

- `frick-server`
- `frick-worker`
- `frick-dashboard` mounted by server, with standalone static serving available
- `frick-otel-collector`
- `frick-analytics-store`
- `frick-cluster-bus` when horizontal scale is enabled
- application database

The first concrete deployment target should be Docker Compose because it is the
fastest path to a working self-hosted platform. Kubernetes/Helm should follow
from the same logical service model.

Commands:

- `frick dev`: starts the full local platform for a project.
- `frick dashboard`: opens or serves the dashboard for the project.
- `frick deploy --profile compose`: builds/runs the standard stack for the
  project using Compose.
- `frick doctor`: checks project, runtime, telemetry, dashboard, and deployment
  health.

Tilt remains a contributor/developer orchestration frontend for this repo. It
should eventually stand up the same logical services, but Tilt is not itself the
production deployment model.

## Migration From Current Repo

Current pieces map naturally into the platform:

- `apps/server` becomes or feeds the reusable runtime package.
- `apps/dev-dashboard` becomes the dashboard app and mounted static asset.
- `apps/cli` gains `dev`, `deploy`, and richer dashboard commands.
- `packages/core`, `packages/react`, Swift, and Kotlin add telemetry clients.
- Existing inspection, metrics, DevTools events, and admin routes become
  dashboard/observability inputs.
- The cluster bus contract remains the horizontal realtime fan-out extension.

The main missing boundary is the project module/manifest shape that lets the
runtime load app code without copying platform implementation into the app.

## First Implementation Slices

1. **Platform boundary**: define project module and manifest contracts, then
   load the current foundation app through that path.
2. **Mounted dashboard**: serve dashboard assets from the server and protect
   them with dashboard session/capability checks.
3. **Schema metadata API**: expose schema/object/stream/projection/job metadata
   for dashboard navigation and data browsing.
4. **Dashboard auth and audit**: project-admin and tenant-admin capabilities,
   auth provider bridge, and audit store/API.
5. **OTel server baseline**: add OTel SDK integration, collector config, trace
   ids, HTTP/sync/job metrics, and bridge existing metrics.
6. **Product analytics baseline**: local event ingestion, typed event
   definitions, client `track`, auto lifecycle events, and basic aggregates.
7. **Standard local stack**: `frick dev` runs server, dashboard, OTel collector,
   analytics store, worker, and optional bus.
8. **Compose deployment profile**: `frick deploy --profile compose` runs the
   same logical stack outside the repo.

## Testing Strategy

- Unit tests for project manifest loading and validation.
- Server tests for dashboard auth, capabilities, audit, and schema metadata.
- Browser tests for mounted and standalone dashboard modes.
- Integration tests for OTel span/metric emission using an in-memory exporter.
- Integration tests for analytics ingestion, redaction, tenant isolation, and
  aggregate queries.
- Client SDK tests for auto tracking, explicit `track`, opt-out, and redaction.
- Deployment smoke tests for the Compose profile.
- Security tests for dashboard access, cross-tenant isolation, token handling,
  and disabled production inspection routes.

## Risks

- Scope can balloon into a full hosted cloud product. The first product should
  remain self-hostable and local-first.
- Product analytics can accidentally collect sensitive data. Schema sensitivity
  metadata, redaction, and policy hooks are required early.
- Dashboard mutation can become dangerous. Start read-mostly and require
  explicit policies for write actions.
- OTel dependencies can make app bundles heavier. Keep SDK instrumentation
  modular, especially for browser and mobile clients.
- A deployment stack can hide operational complexity. Keep generated profiles
  inspectable and keep CLI commands backed by documented config.

## Approval Criteria

The design is ready to plan when these statements are accepted:

- Frick is positioned as a self-hostable Firebase-like platform runtime.
- App source plugs into Frick; Frick does not copy a full backend into app
  source.
- Dashboard is production-first, mounted by default, and standalone when useful.
- Schema-defined resources appear automatically in the dashboard.
- Project admins and tenant admins are supported from the start.
- OTel and product analytics are first-class, local-first, and exportable.
- Docker Compose is the first deployment target, with Kubernetes/Helm later.
