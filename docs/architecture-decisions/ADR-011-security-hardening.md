# ADR-011 — Security Hardening & Compliance Posture

> **Status:** Accepted
> **Date:** 2026-06-06
> **Deciders:** Security lead, VP Engineering, CTO
> **Supersedes:** none
> **Related:** `docs/security/01_threat_model.md`, `docs/security/02_pentest_scope.md`, `docs/security/03_controls_checklist.md`

## Context

Zenith targets Fortune 500 customers who require a documented security
posture: SOC 2 Type II, ISO 27001, GDPR, CCPA, HIPAA (in 2027), and
PCI-DSS (in 2027). The Phase 3.F security audit (`docs/security/`)
establishes the baseline. This ADR commits to closing the remaining gaps
on a fixed timeline.

## Decision

We commit to the following security milestones:

| Milestone                                | Target date  | Owner            |
| ---------------------------------------- | ------------ | ---------------- |
| External pen test (NCC Group)            | 2026-08-31   | Security lead    |
| Bug bounty public launch (HackerOne)     | 2026-07-15   | Security lead    |
| SOC 2 Type I                             | 2026-10-31   | Security lead    |
| SOC 2 Type II                            | 2027-04-30   | Security lead    |
| ISO 27001 Stage 1                        | 2026-10-31   | Security lead    |
| ISO 27001 Stage 2                        | 2027-01-31   | Security lead    |
| GDPR DPA template                        | 2026-07-15   | Legal            |
| CCPA addendum                            | 2026-07-15   | Legal            |
| HIPAA risk assessment                    | 2027-Q1      | Security lead    |
| PCI-DSS SAQ-D                            | 2027-Q3      | Security lead    |

### Hardening controls (mandatory pre-prod)

1. **mTLS everywhere** (already in place — ADR-002).
2. **Argon2id for password hashing** (m=64MB, t=3, p=4).
3. **Ed25519 for plugin signatures** (already in place — ADR-004).
4. **Vault for all secrets** (already in place — ADR-008).
5. **Field-level encryption** for PII columns (email, phone, address).
6. **TLS 1.3 only**, modern cipher suites.
7. **HSTS preload**, HPKP, OCSP stapling.
8. **CSP, X-Frame-Options, X-Content-Type-Options** on every response.
9. **WAF rules** for OWASP Top 10.
10. **Rate limits** per IP, per user, per API key.

### Logging and monitoring

- All API calls logged with (who, what, when, where, outcome).
- All Vault operations logged to an append-only device.
- All K8s API calls logged to CloudTrail + Datadog.
- SIEM (Datadog Cloud SIEM) with 1-year retention.
- On-call rotation: 24/7 with 5-min acknowledgement SLA for SEV-1.

### Incident response

- Runbook `02_incident_response.md` is the authoritative reference.
- SEV-1 page → ack in 5 min → mitigation in 1 h.
- Post-mortem within 5 business days.
- Public post-mortem for any customer-impacting incident.

## Consequences

### Positive

- Eligible for Fortune 500 procurement (SOC 2 + ISO 27001).
- Reduced cyber-insurance premium (estimated -$8K/year).
- Faster enterprise sales cycle (questionnaires become checkboxes).

### Negative

- ~$120 K/year ongoing cost (auditors, bug bounty, pen tests).
- Requires dedicated GRC headcount from 2026-Q4.

### Neutral

- All commitments are tracked in `docs/security/00_open_items.md`.
