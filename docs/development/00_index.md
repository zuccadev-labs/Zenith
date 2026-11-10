# Zenith Documentation

> ⚠️ **Estado (2026-11-10): no coincide con el código.** Partes de este documento son obsoletas o incorrectas (rutas, comandos, paquetes). Lo vigente y la lista de diferencias están en [docs/index.md](../index.md).

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
| [ADR-001](ADR-001-folder-unification.md) folder unification | Accepted | 2026-05-10 |
| [ADR-002](ADR-002-mtls-spki-pinning.md) mTLS SPKI pinning  | Accepted | 2026-05-15 |
| [ADR-003](ADR-003-api-keys-stripe-style.md) API keys Stripe-style | Accepted | 2026-05-20 |
| [ADR-004](ADR-004-plugin-signing-ed25519.md) plugin signing Ed25519 | Accepted | 2026-05-22 |
| [ADR-005](ADR-005-openapi-ast-generation.md) OpenAPI AST generation | Accepted | 2026-05-25 |
| [ADR-006](ADR-006-prometheus-loki.md) Prometheus + Loki | Accepted | 2026-05-28 |
| [ADR-007](ADR-007-production-readiness.md) production readiness | Accepted | 2026-05-30 |
| [ADR-008](ADR-008-hashicorp-vault.md) HashiCorp Vault | Accepted | 2026-06-01 |
| [ADR-009](ADR-009-api-parity-closure.md) Phase 4.0 API parity closure | Accepted | 2026-06-06 |
| [ADR-010](ADR-010-backup-strategy.md) backup & DR strategy | Accepted | 2026-06-06 |
| [ADR-011](ADR-011-security-hardening.md) security hardening | Accepted | 2026-06-06 |

## Development guides (`docs/development/`)

| Doc                                                       | Purpose                                  |
| --------------------------------------------------------- | ---------------------------------------- |
| [00_index.md](00_index.md)                                | this file                                |
| [01_zenith_architecture.md](../investigations/01_zenith_architecture.md) | architecture overview (Phase 0) |
| [02_test_coverage_audit.md](02_test_coverage_audit.md)    | H-8 test coverage audit (Phase 3.B)      |
| [03_api_parity_audit.md](03_api_parity_audit.md)          | Parse-Server parity (Phase 3.C)          |
| [04_performance_benchmarks.md](04_performance_benchmarks.md) | k6 setup + SLOs (Phase 3.D)          |
| [`webrtc-media-sdk.md`](webrtc-media-sdk.md)              | WebRTC media SDK design                  |
| [`openapi-swagger.md`](../architecture/openapi-swagger.md) | OpenAPI architecture                     |

## Operational runbooks (`docs/runbooks/`)

See [00_index.md](../runbooks/00_index.md) for the full list. Headline runbooks:

- [01 — Production deployment](../runbooks/01_production_deployment.md)
- [02 — Incident response](../runbooks/02_incident_response.md)
- [05 — API outage](../runbooks/05_api_outage.md)
- [08 — Disaster recovery](../runbooks/08_disaster_recovery.md)

## Security (`docs/security/`)

| Doc                                                     | Purpose                                |
| ------------------------------------------------------- | -------------------------------------- |
| [01_threat_model.md](01_threat_model.md)                | STRIDE threat model                    |
| [02_pentest_scope.md](02_pentest_scope.md)              | pen-test RFP scope                     |
| [03_controls_checklist.md](03_controls_checklist.md)    | NIST 800-53 / ISO 27001 / SOC 2 mapping |
| [04_vulnerability_disclosure.md](04_vulnerability_disclosure.md) | public disclosure policy      |

## Architecture (`docs/architecture/`)

- [`openapi-swagger.md`](openapi-swagger.md) — OpenAPI 3.1 generation pipeline
- (more to come in Phase 4.0)

## Reading order for new engineers

1. [Investigations 00–01](../investigations/00_intro.md) — what is Zenith?
2. [ADR-001 – ADR-008](.) — the design decisions
3. [01_zenith_architecture.md](../investigations/01_zenith_architecture.md) — the architecture
4. [02_test_coverage_audit.md](02_test_coverage_audit.md) — what is tested?
5. [03_api_parity_audit.md](03_api_parity_audit.md) — what is implemented?
6. [04_performance_benchmarks.md](04_performance_benchmarks.md) — how fast is it?
7. [runbooks/00_index.md](../runbooks/00_index.md) — how to operate it
8. [security/01_threat_model.md](01_threat_model.md) — what are the risks?
