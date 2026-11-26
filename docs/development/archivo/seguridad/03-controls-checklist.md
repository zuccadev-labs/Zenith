# Zenith Security Controls Checklist (NIST 800-53 / ISO 27001 / SOC 2)

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../../../users/README.md).

> **Frameworks covered:** NIST SP 800-53 Rev. 5 (Moderate), ISO 27001:2022, SOC 2 Type II.
> **Date:** 2026-06-06
> **Owner:** Security lead
> **Status:** ~85 % complete. Phase 3.F closes remaining gaps.

## 1. Access control (AC)

| Control                                                | Status | Evidence                                   |
| ------------------------------------------------------ | :----: | ------------------------------------------ |
| AC-2 Account management                                | ✅     | Keycloak + Vault AppRole                    |
| AC-3 Access enforcement                                | ✅     | Trait-level ACL; Mongo row-level security  |
| AC-5 Separation of duties                              | ✅     | Master key ≠ admin ≠ data plane keys       |
| AC-6 Least privilege                                   | ✅     | Default-deny in WAF; scope-limited API keys |
| AC-7 Unsuccessful login attempts                       | ✅     | 5 attempts → 15 min lockout                |
| AC-12 Session termination                              | ✅     | Idle 30 min; absolute 24 h                 |
| AC-17 Remote access                                    | ✅     | mTLS + OIDC                                |

## 2. Audit and accountability (AU)

| Control                                                | Status | Evidence                                   |
| ------------------------------------------------------ | :----: | ------------------------------------------ |
| AU-2 Event logging                                     | ✅     | Audit trait, Vault audit device            |
| AU-3 Content of audit records                          | ✅     | (who, what, when, where, outcome)          |
| AU-4 Audit log storage capacity                        | ✅     | Loki S3 90 d hot, 1 y cold                 |
| AU-5 Response to audit failures                        | ✅     | Page on-call; fail-closed ingestion        |
| AU-9 Protection of audit information                   | ✅     | Append-only; HSM-signed checkpoints        |
| AU-12 Audit record generation                          | ✅     | Every API call, every Vault op             |

## 3. Configuration management (CM)

| Control                                                | Status | Evidence                                   |
| ------------------------------------------------------ | :----: | ------------------------------------------ |
| CM-2 Baseline configuration                            | ✅     | Helm chart + Terraform modules             |
| CM-3 Configuration change control                      | ✅     | PR review + CI + ArgoCD                    |
| CM-6 Configuration settings                            | ✅     | Deno strict, no `any` in core              |
| CM-7 Least functionality                               | ✅     | Feature flags default off; rate-limited    |

## 4. Identification and authentication (IA)

| Control                                                | Status | Evidence                                   |
| ------------------------------------------------------ | :----: | ------------------------------------------ |
| IA-2 User identification and authentication            | ✅     | OIDC + MFA enforced                        |
| IA-3 Device identification                             | ✅     | mTLS with SPKI pinning (ADR-002)           |
| IA-4 Identifier management                            | ✅     | Tenant id + user id + device id            |
| IA-5 Authenticator management                          | ✅     | Argon2id for passwords; Vault for keys     |
| IA-8 Identification and authentication (non-organizational users) | ✅ | Customer accounts in dedicated tenant    |

## 5. Risk assessment (RA)

| Control                                                | Status | Evidence                                   |
| ------------------------------------------------------ | :----: | ------------------------------------------ |
| RA-3 Risk assessment                                  | ✅     | `docs/security/01_threat_model.md`         |
| RA-5 Vulnerability monitoring                          | ✅     | Dependabot + Trivy + Snyk                  |

## 6. System and services acquisition (SA)

| Control                                                | Status | Evidence                                   |
| ------------------------------------------------------ | :----: | ------------------------------------------ |
| SA-3 System development life cycle                     | ✅     | Phase 0 → 4, ADRs, post-mortems            |
| SA-8 Security engineering principles                  | ✅     | Threat model per major feature             |
| SA-10 Developer configuration management               | ✅     | Signed commits, mandatory code review      |
| SA-11 Developer testing                                | ✅     | 356 unit tests + 1 integration test        |
| SA-15 Development process, standards, and tools       | ✅     | `deno fmt`, `deno lint`, `deno check`      |

## 7. System and communications protection (SC)

| Control                                                | Status | Evidence                                   |
| ------------------------------------------------------ | :----: | ------------------------------------------ |
| SC-5 Denial of service protection                      | ✅     | Cloudflare WAF + rate limits               |
| SC-7 Boundary protection                              | ✅     | VPC, security groups, WAF                  |
| SC-8 Transmission confidentiality and integrity       | ✅     | TLS 1.3 only, HSTS preload                 |
| SC-12 Cryptographic key establishment and management   | ✅     | Vault (transit + KV) + AWS KMS             |
| SC-13 Cryptographic protection                        | ✅     | AES-256-GCM, Ed25519, Argon2id            |
| SC-28 Protection of information at rest               | ✅     | Disk encryption + DB-level field encryption |

## 8. System and information integrity (SI)

| Control                                                | Status | Evidence                                   |
| ------------------------------------------------------ | :----: | ------------------------------------------ |
| SI-2 Flaw remediation                                  | ✅     | Patch SLA: critical 24 h, high 7 d         |
| SI-4 Information system monitoring                     | ✅     | Prometheus + Loki + Grafana                |
| SI-7 Software, firmware, and information integrity     | ✅     | Plugin signatures, container image signing  |
| SI-10 Information input validation                    | ✅     | Zod-like runtime validation on every route |
| SI-11 Error handling                                   | ✅     | Generic 5xx; details only in audit log     |

## 9. ISO 27001 Annex A controls

| Control                                                | Status | Evidence                                   |
| ------------------------------------------------------ | :----: | ------------------------------------------ |
| A.5.15 Access control                                  | ✅     | Same as AC-* above                         |
| A.5.17 Authentication information                      | ✅     | Argon2id; never logged                     |
| A.5.24 Information security incident management        | ✅     | `docs/runbooks/02_incident_response.md`    |
| A.5.30 ICT readiness for business continuity           | ✅     | `docs/runbooks/08_disaster_recovery.md`    |
| A.8.2 Privileged access rights                         | ✅     | Break-glass accounts, MFA, audit           |
| A.8.5 Secure authentication                            | ✅     | OIDC + MFA; no passwords in app            |
| A.8.9 Configuration management                         | ✅     | GitOps (ArgoCD); immutable images         |
| A.8.12 Data leakage prevention                         | ✅     | DLP scanner on outbound                    |
| A.8.16 Monitoring activities                           | ✅     | SIEM (Datadog)                             |
| A.8.23 Web filtering                                   | ✅     | Cloudflare WAF + custom rules              |
| A.8.28 Secure coding                                   | ✅     | Linting, type-check, peer review           |

## 10. SOC 2 Trust Service Criteria

| Criterion                                              | Status | Evidence                                   |
| ------------------------------------------------------ | :----: | ------------------------------------------ |
| CC1 Control environment                               | ✅     | Code of conduct, security training         |
| CC2 Communication and information                     | ✅     | Statuspage, customer comms runbook         |
| CC3 Risk assessment                                   | ✅     | Threat model + risk register               |
| CC4 Monitoring activities                             | ✅     | SIEM + on-call rotation                    |
| CC5 Control activities                                | ✅     | ADRs + runbooks                            |
| CC6 Logical and physical access                        | ✅     | AC-* above                                 |
| CC7 System operations                                 | ✅     | AU-* + SI-* above                          |
| CC8 Change management                                 | ✅     | PR review + CI/CD                          |
| CC9 Risk mitigation                                   | ✅     | Insurance (cyber liability $5M)           |
| A1 Availability                                       | ✅     | SLO 99.95 %; multi-AZ; DR runbook          |
| C1 Confidentiality                                    | ✅     | TLS + KMS + tenant scoping                 |
| P1 Processing integrity                                | ✅     | Input validation + audit + signing         |
| CC Additional criteria for confidentiality             | ✅     | Field encryption, key rotation, audit      |

## 11. Open items

- [ ] **SOC 2 Type II report** — audit window starts 2026-07-01 (Schellman).
- [ ] **ISO 27001 certification** — Stage 1 audit 2026-10-01 (BSI).
- [ ] **Cyber insurance** — renewal due 2026-09-01 (AIG).
- [ ] **Bug bounty** — public launch 2026-07-15 (HackerOne).
- [ ] **External pentest** — RFP issued, vendor selection 2026-07-15.
