# Zenith — API Changelog

> **Convention:** [Semantic Versioning 2.0.0](https://semver.org/).
> **Format:** `## [version] — YYYY-MM-DD`, then `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, `### Security`.

---

## Unreleased

### Changed

- Documentation moved from MkDocs to zudocs, in areas (`docs/users`, `development`, `investigations`, `agents`,
  `package`), and rewritten against the code. Documents that described a hosted service that does not exist are in
  each area's `archivo/`.
- API reference regenerated: 241 routes with the default pieces (it listed 234 and missed `/sessions/me`,
  `/zen/cells` and the agent session messages).
- `tools/docs-coverage.ts`, in CI: fails when the API reference is stale or a route count, `zen` command, catalog
  piece, error code, package version or link outside `docs/` does not match the code.

### Fixed

- `zen generate --help` listed `openapi | docs | postman`; the subcommands are `docs | openapi | schema | sdk`.
- Helm chart: the README and `values.yaml` asked for `MASTER_KEY` and `JWT_SECRET`; the image reads
  `APP1_MASTER_KEY` and `APP2_MASTER_KEY`.

## Packages — 2026-11-19

`@zuccadev-labs/zenith` 0.2.0 and `@zuccadev-labs/zenith-cli` 0.3.0 (JSR); `@zuccadev-labs/zenith-client` 0.2.0 and
`@zuccadev-labs/create-zenith` 0.1.0 (npm, first release).

### Added

- **Cells** (ADR-019, `docs/users/07-celdas.md`): the cell, a single-writer actor with its own SQLite storage and
  the Durable Objects API that celld and Cloudflare implement, is the standard unit of stateful work.
  - `local` provider: input gate, `blockConcurrencyWhile`, KV and `sql.exec` storage, transactions, alarms that
    survive restarts, hibernation, residency and storage limits.
  - `KVNamespace` and `Queue` bindings, `Zen.Cells` in Cloud Code, admin routes under `/zen/cells` (master key).
  - `celld` provider (experimental, `cells.celld.experimental: true`): generated `wrangler.json` and entry, HTTP
    client with a bearer token; tested end to end against celld 0.6.3 (`celld dev`).
  - ADK agent sessions run as cells: history reaches the model, one turn at a time per session.
- Every exported symbol of both JSR packages is documented (`deno doc --lint` clean); types referenced by the public
  API (`ZenithConfig`, `EngineAPI`, adapters, vector DB types, `EmbedFn`…) are exported.
- Supply chain: keyless Sigstore signature of the server image (public Rekor log) and GitHub attestations for its
  build provenance and SBOM, besides the own-key cosign signature; packages released from CI through OIDC with
  provenance (`release.yml`, one tag per package).

### Changed

- Dependencies, CI tools and lab images at their latest stable versions (24 h minimum age); Node 26 LTS in CI.
- `create-zenith`: the `bin` path npm 12 rejected on publish.

### Security

- `sql.exec` in a cell cannot leave the cell's database (`ATTACH`, `VACUUM INTO`, writable PRAGMAs and internal
  tables are rejected).

> The entries below are from an earlier stage of the project. Version 1.0.0 was never published (the first
> release is 2026-11-19, above), and the documents they cite were moved: the hosted-service ones are archived in
> `docs/*/archivo/`.

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
