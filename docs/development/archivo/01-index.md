# Zenith Documentation

> ⚠️ **Estado (2026-11-10): no coincide con el código.** Partes de este documento son obsoletas o incorrectas (rutas, comandos, paquetes). Lo vigente y la lista de diferencias están en [docs/index.md](../../users/README.md).

> **Last updated:** 2026-06-06
> **Generated during:** Phase 3 (B–F) — production readiness.

## Investigations (`docs/investigations/`)

Initial technical investigations (Phase 0–2):

- `00_intro.md` — context, scope, and motivation
- `01_zenith_architecture.md` — high-level architecture (intact, not affected by reconstruction)
- `02_api_keys.md` … `11_hashicorp_vault_secrets.md` — security/infra deep dives

## Architecture decisions (`docs/architecture-decisions/`)

| ADR                                                | Status   | Date       |
| -------------------------------------------------- | -------- | ---------- |
| ADR-001 folder unification | Accepted | 2026-05-10 |
| ADR-002 mTLS SPKI pinning  | Accepted | 2026-05-15 |
| ADR-003 API keys Stripe-style | Accepted | 2026-05-20 |
| ADR-004 plugin signing Ed25519 | Accepted | 2026-05-22 |
| ADR-005 OpenAPI AST generation | Accepted | 2026-05-25 |
| ADR-006 Prometheus + Loki | Accepted | 2026-05-28 |
| ADR-007 production readiness | Accepted | 2026-05-30 |
| ADR-008 HashiCorp Vault | Accepted | 2026-06-01 |
| ADR-009 Phase 4.0 API parity closure | Accepted | 2026-06-06 |
| ADR-010 backup & DR strategy | Accepted | 2026-06-06 |
| ADR-011 security hardening | Accepted | 2026-06-06 |

## Development guides (`docs/development/`)

| Doc                                                       | Purpose                                  |
| --------------------------------------------------------- | ---------------------------------------- |
| [00_index.md](./01-index.md)                                | this file                                |
| 01_zenith_architecture.md | architecture overview (Phase 0) |
| [02_test_coverage_audit.md](./02-test-coverage-audit.md)    | H-8 test coverage audit (Phase 3.B)      |
| [03_api_parity_audit.md](./03-api-parity-audit.md)          | Parse-Server parity (Phase 3.C)          |
| [04_performance_benchmarks.md](../09-rendimiento.md) | k6 setup + SLOs (Phase 3.D)          |
| [`webrtc-media-sdk.md`](../../users/archivo/04-medios-webrtc-original.md)              | WebRTC media SDK design                  |
| [`openapi-swagger.md`](../03-openapi.md) | OpenAPI architecture                     |

## Operational runbooks (`docs/runbooks/`)

See [00_index.md](./runbooks/00-index.md) for the full list. Headline runbooks:

- [01 — Production deployment](./runbooks/01-production-deployment.md)
- [02 — Incident response](./runbooks/02-incident-response.md)
- [05 — API outage](./runbooks/05-api-outage.md)
- [08 — Disaster recovery](./runbooks/08-disaster-recovery.md)

## Security (`docs/security/`)

| Doc                                                     | Purpose                                |
| ------------------------------------------------------- | -------------------------------------- |
| 01_threat_model.md                | STRIDE threat model                    |
| 02_pentest_scope.md              | pen-test RFP scope                     |
| 03_controls_checklist.md    | NIST 800-53 / ISO 27001 / SOC 2 mapping |
| 04_vulnerability_disclosure.md | public disclosure policy      |

## Architecture (`docs/architecture/`)

- `openapi-swagger.md` — OpenAPI 3.1 generation pipeline
- (more to come in Phase 4.0)

## Reading order for new engineers

1. [Investigations 00–01](../../investigations/previas/00-intro.md) — what is Zenith?
2. [ADR-001 – ADR-008](.) — the design decisions
3. 01_zenith_architecture.md — the architecture
4. [02_test_coverage_audit.md](./02-test-coverage-audit.md) — what is tested?
5. [03_api_parity_audit.md](./03-api-parity-audit.md) — what is implemented?
6. [04_performance_benchmarks.md](../09-rendimiento.md) — how fast is it?
7. [runbooks/00_index.md](./runbooks/00-index.md) — how to operate it
8. security/01_threat_model.md — what are the risks?
