# Zenith Public Roadmap

> **Updated:** 2026-06-06
> **Cadence:** monthly update
> **Owner:** Product lead
> **Live:** https://zenith.io/roadmap

## Themes for 2026

- **H1 — Production readiness** (shipped Q2)
- **H2 — Multi-region & SDK maturity** (in progress)
- **H3 — Marketplace & ecosystem** (Q3)
- **H4 — AI & data** (Q4)

## Now (in progress, Q2 2026)

- [x] Test coverage audit (H-8)
- [x] Parse-Server parity audit
- [x] k6 performance benchmarks
- [x] Operational runbooks (8)
- [x] Security audit + trust center
- [x] Helm chart (Fortune 500-grade)
- [x] Terraform AWS module
- [x] Grafana + Prometheus dashboards
- [x] SLI/SLO definitions
- [x] Container image security policy
- [x] Public vulnerability disclosure
- [x] C4 architecture diagrams
- [x] Customer onboarding playbook
- [x] DR drill automation
- [x] SRE cheat sheet
- [x] API versioning policy
- [x] Plugin marketplace design
- [x] Multi-region active-active design

## Next (Q3 2026)

- [ ] **Phase 4.0 — batch + jobs + cloud_code/jobs** (ADR-009)
- [ ] **External penetration test** (NCC Group)
- [ ] **Bug bounty public launch** (HackerOne)
- [ ] **SOC 2 Type I** audit (Schellman)
- [ ] **GDPR DPA template** published
- [ ] **ISO 27001 Stage 1** audit (BSI)
- [ ] **Internal plugin marketplace** (5 plugins)
- [ ] **SDK auto-generation** from OpenAPI (TypeScript, Python, Swift, Kotlin)
- [ ] **Self-service tenant onboarding** (sign up via dashboard)
- [ ] **Multi-region: us-east-1 + us-west-2** active-active
- [ ] **Webhooks v2** (with retry + DLQ)
- [ ] **GraphQL subscriptions**
- [ ] **Custom domain per tenant** (e.g. api.acme.com)
- [ ] **Per-tenant custom rate limits** (self-service)
- [ ] **Audit log export** to SIEM (Splunk, Datadog, Sumo)
- [ ] **Per-tenant IP allow-lists**
- [ ] **Chaos engineering program** (monthly game days)

## Later (Q4 2026)

- [ ] **Phase 4.1 — full SDK suite** (Java, Go, Ruby, PHP, .NET, Flutter)
- [ ] **Phase 4.1 — public plugin marketplace** (20+ vetted plugins)
- [ ] **Phase 4.1 — paid plugins + revenue share**
- [ ] **SOC 2 Type II** audit window opens
- [ ] **ISO 27001 Stage 2** audit
- [ ] **Multi-region: + eu-west-1** (GDPR data residency)
- [ ] **HIPAA risk assessment** (Phase 1)
- [ ] **AI Gateway** (OpenAI, Anthropic, Cohere, custom models)
- [ ] **Vector DB GA** (Qdrant, Pinecone, Weaviate adapters)
- [ ] **Realtime WebSocket fan-out** (millions of concurrent connections)
- [ ] **Time-series DB GA** (TimescaleDB, InfluxDB, ScyllaDB adapters)
- [ ] **Workflow engine GA** (BPMN-like orchestration)
- [ ] **Edge functions** (Cloudflare Workers, Fastly Compute)
- [ ] **WebRTC GA** (media server, E2EE, recording)
- [ ] **IoT MQTT bridge GA** (millions of devices)

## Considering (2027+)

- [ ] **Multi-region: + ap-southeast-1**
- [ ] **PCI-DSS SAQ-D** certification
- [ ] **FedRAMP Moderate** certification
- [ ] **HIPAA** certification
- [ ] **BAA template** for healthcare customers
- [ ] **Quantum-safe crypto migration** (Dilithium, Kyber)
- [ ] **On-prem edition** (Zenith in a box for air-gapped deployments)
- [ ] **White-label** admin dashboard
- [ ] **AI agent marketplace**
- [ ] **Block-chain anchor** for tamper-evident audit log

## Recently shipped

See `CHANGELOG.md` for the full list.

## How to influence the roadmap

- **Feature requests:** open a ticket at https://github.com/zuccadev-labs/Zenith/issues
- **Customer requests:** file via your CSM (Enterprise) or support@zenith.io
- **Quarterly survey:** every customer gets a survey in March, June, September, December
- **Office hours:** every Tuesday 14:00 UTC — https://zenith.io/office-hours

## What we are NOT doing

To set expectations, here are things we have **deliberately decided not to do**:

- ❌ Native mobile SDKs for unsupported platforms (we use the official Parse SDKs)
- ❌ On-prem single-tenant installation (use a dedicated region instead)
- ❌ Custom server-side frameworks (use Cloud Code)
- ❌ Native GraphQL schema merging with REST (one or the other)
- ❌ PHP SDK (use the REST API via Guzzle)
- ❌ Custom auth providers beyond OIDC / SAML (use Keycloak federation)
- ❌ Bring-your-own KMS (use HashiCorp Vault + AWS KMS / GCP KMS)
