# Zenith — API Changelog

> **Convention:** [Semantic Versioning 2.0.0](https://semver.org/).
> **Format:** `## [version] — YYYY-MM-DD`, then `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, `### Security`.

---

## [1.0.0] — 2026-06-06

### Added — Phase 3 (B–F): production readiness

- **3.B** — Test coverage audit (H-8). 158 new tests; 356 total passing.
  - `tests/unit/api-keys-{audit,scopes}.test.ts`
  - `tests/unit/plugin-signing-{canonical,keys,trust-store,verifier}.test.ts`
  - `tests/unit/core-{errors,router}.test.ts`
- **3.C** — Parse-Server REST API parity audit. **90 % parity**.
  - 27 of 30 Parse routes implemented.
  - 1 partial route (`/functions` discovery).
  - 2 missing routes (`/batch`, `/jobs` — scheduled for Phase 4.0, see ADR-009).
  - Audit: `docs/development/03_api_parity_audit.md`.
- **3.D** — Performance benchmarks. k6 scenarios for auth, CRUD, push, mixed.
  - Audit: `docs/development/04_performance_benchmarks.md`.
  - SLOs: p95 < 400 ms API, 99.95 % availability, 5 000 RPS / node.
- **3.E** — Operational runbooks. 8 runbooks + SRE cheat sheet.
- **3.F** — Security audit. Threat model, pen-test scope, NIST 800-53 / ISO 27001 / SOC 2 controls checklist, public vulnerability disclosure policy.

### Added — Phase 4.0: production deployment

- **Helm chart** (`k8s/helm/zenith/`): 12 templates, production-grade defaults.
  - `templates/_helpers.tpl`
  - `templates/configmap.yaml`
  - `templates/deployment.yaml`
  - `templates/hpa.yaml`
  - `templates/ingress.yaml`
  - `templates/networkpolicy.yaml`
  - `templates/pdb.yaml`
  - `templates/prometheusrule.yaml`
  - `templates/secret.yaml`
  - `templates/service.yaml`
  - `templates/serviceaccount.yaml`
  - `templates/servicemonitor.yaml`
  - `templates/tests/test-connection.yaml`
  - `values-prod.yaml` for Fortune 500 deployment.
- **Terraform AWS module** (`infra/terraform/modules/zenith-aws/`):
  - VPC with public + private subnets, NAT, flow logs.
  - EKS cluster (1.29) with managed node groups.
  - DocumentDB (MongoDB-compatible) with KMS encryption.
  - ElastiCache Redis (TLS + auth).
  - S3 buckets (uploads + logs) with CRR, lifecycle, KMS.
  - ALB + ACM + Route53 with TLS 1.3.
  - IAM roles (IRSA) for least privilege.
- **Observability** (`observability/`):
  - Grafana dashboard JSON (`zenith-sre-overview.json`).
  - Prometheus alert rules (`zenith-alerts.yaml`): 5 groups, 25+ alerts.
- **C4 architecture diagrams** (`docs/architecture/01_c4_model.md`):
  - System context, container, component, code-level.
  - Sequence diagrams: CRUD, file upload, cloud function.
- **Customer onboarding** (`docs/customer/01_onboarding.md`).
- **TCO calculator** (`docs/customer/02_tco.md`).
- **Tutorials** (`docs/tutorials/`): quickstart, user auth, file upload.
- **DR drill script** (`tools/dr-drill/run-dr-drill.sh`).
- **MkDocs site config** (`site/mkdocs.yml`).

### Added — Phase 0–2 (recap)

- 11 architecture decisions (ADR-001 to ADR-011).
- 40 trait files (one per domain capability).
- Plugin signing (Ed25519 + JCS canonical JSON, ADR-004).
- API keys (Stripe-style, Argon2id-hashed, ADR-003).
- OpenAPI 3.1 generation from AST (ADR-005).
- Prometheus remote_write + Loki shipper (ADR-006).
- HashiCorp Vault integration (ADR-008).
- mTLS with SPKI pinning (ADR-002).
- gRPC federation (zero-config cluster mode).
- MQTT IoT bridge, vector DB, time-series, workflow, agents, AI, billing.

### Security

- 8 of 10 original findings (H-1 to H-10) closed.
- H-8 (test coverage) closed in Phase 3.B.
- H-9 (cardinality safety) closed in Phase 1.G.
- H-10 (fail-closed config) closed in Phase 0.B.
- External pen test scheduled Q3 2026.
- SOC 2 Type I in progress; Type II target 2027-Q2.
- ISO 27001 Stage 1 target 2026-Q4.

### Migration

- `docs/migration/01_from_parse_server.md` — 2-4 week migration guide.
- Bcrypt → Argon2id password rehash (planned Phase 4.0 CLI tool).

---

## [0.9.0] — 2026-05-15 (pre-release, internal)

Initial feature-complete preview. Not for production use.
