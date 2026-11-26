# ADR-009 — Phase 4.0 API Parity Closure

> ⚠️ **Estado (2026-11-10): no coincide con el código.** Partes de este documento son obsoletas o incorrectas (rutas, comandos, paquetes). Lo vigente y la lista de diferencias están en [docs/index.md](../index.md).

> **Status:** Accepted
> **Date:** 2026-06-06
> **Deciders:** Platform lead, API lead
> **Supersedes:** none
> **Related:** `docs/development/03_api_parity_audit.md`

## Context

The Phase 3.C API parity audit (`03_api_parity_audit.md`) shows Zenith at
**90 % parity** with the Parse-Server REST API. The 7 % gap is concentrated
in three features:

1. **`POST /batch`** — multi-op atomic requests (max 50 ops per call).
2. **`POST /jobs`** and **`POST /jobs/<name>`** — ad-hoc background job triggers.
3. **`GET/POST /cloud_code/jobs`** — schedule management (CRUD for cron-like jobs).

These features are required by the official Parse SDKs in certain
multi-step flows (signup + ACL grant, signup + role assignment, etc.) and
by backend tooling that relies on the cron-style job scheduler.

## Decision

We commit to closing all three gaps in **Phase 4.0** (target: 2026-Q3).
The implementation will:

1. **`/batch`** — implement in `core/pipeline.ts` (already supports
   transactional sequences). Add a new trait `traits/rest/batch.trait.ts`
   that calls into the pipeline with `atomic=true`.
2. **`/jobs`** — implement a `POST /jobs` route in `traits/queue/job-queue.trait.ts`
   that enqueues a job into the existing `queue.trait.ts` infrastructure.
3. **`/cloud_code/jobs`** — implement a new sub-trait
   `traits/cloud/scheduler.trait.ts` backed by a `cron` collection in MongoDB
   polled by a single-leader watcher.

Each feature gets:

- A new trait with full OpenAPI metadata.
- Integration tests in `tests/integration/`.
- A runbook in `docs/runbooks/`.
- An entry in `CHANGELOG.md`.

## Consequences

### Positive

- 100 % Parse-Server REST API parity reached.
- All official SDKs work unmodified for batch + cron flows.
- Foundation for advanced scheduling features (e.g. recurring exports).

### Negative

- Phase 4.0 timeline extends by ~3 weeks.
- New attack surface (cron expressions from untrusted users need validation).

### Neutral

- Existing customers are unaffected; this is purely additive.
