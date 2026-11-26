# GDPR Data Processing Addendum (DPA) — Template

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../../../users/README.md).

> **Effective:** 2026-07-15 (planned)
> **Owner:** Legal, DPO
> **Required for:** all customers in the EU/EEA/UK.

This template is provided to customers as part of the MSA. The full
executable version is signed by both parties and stored in the customer's
1Password vault and Zenith's contract repository.

---

## 1. Definitions

- **"GDPR"** means Regulation (EU) 2016/679 of the European Parliament
  and of the Council.
- **"Personal Data"**, **"Processing"**, **"Controller"**, **"Processor"**,
  **"Data Subject"**, **"Supervisory Authority"** have the meanings given
  in GDPR Article 4.
- **"Customer"** is the Controller.
- **"Zenith"** is the Processor.

## 2. Scope and roles

The Customer is the Controller of Personal Data uploaded to the Zenith
service. Zenith is the Processor and processes Personal Data only on the
documented instructions of the Customer (this DPA + the MSA + the
Customer's use of the service).

## 3. Processing details

| Category                | Details                                            |
| ----------------------- | -------------------------------------------------- |
| Subject matter          | hosting of Customer's application data             |
| Duration                | for the term of the MSA + 30 d deletion window     |
| Nature                  | storage, retrieval, processing, transmission      |
| Purpose                 | providing the Zenith service                      |
| Categories of data      | any data the Customer chooses to upload            |
| Categories of data subjects | end users of the Customer's application         |

## 4. Processor obligations

Zenith will:

1. Process Personal Data only on documented instructions.
2. Ensure that persons authorised to process Personal Data are committed
   to confidentiality.
3. Implement the technical and organisational measures listed in
   **Annex A** (Security Measures).
4. Engage sub-processors only with the Customer's prior specific or
   general written authorisation. The list of sub-processors is
   published at <https://zenith.io/trust-center#sub-processors>.
   Zenith will notify the Customer at least 30 days before adding or
   replacing a sub-processor.
5. Assist the Customer in fulfilling its obligations under GDPR
   Articles 32-36 (security, breach notification, DPIA).
6. Assist the Customer in responding to Data Subject requests (access,
   rectification, erasure, portability, restriction, objection).
7. At the choice of the Customer, delete or return all Personal Data
   after the end of the provision of services, and delete existing
   copies unless retention is required by law.
8. Make available to the Customer all information necessary to
   demonstrate compliance with this DPA, and allow audits (see §9).

## 5. Controller obligations

The Customer is responsible for:

1. The lawfulness of the Processing (legal basis, transparency, purpose limitation).
2. The accuracy of the Personal Data.
3. Responding to Data Subject requests (Zenith provides tooling, not legal advice).
4. Conducting a DPIA where required.
5. Notifying the Supervisory Authority of any breach, where required.

## 6. International transfers

Personal Data processed under this DPA may be transferred to countries
outside the EEA only if:

- The recipient country is covered by an **adequacy decision** (e.g. EU
  countries, UK, Switzerland, etc.).
- The parties have executed the **EU Standard Contractual Clauses (SCCs)**
  (Module 2: Controller-to-Processor), with the following options:
  - **Annex:** technical and organisational measures (Annex A).
  - **Annex:** list of sub-processors.
  - **Annex:** data flows.
- For transfers to the US, Zenith relies on the **EU-US Data Privacy
  Framework** (when applicable) or SCCs + supplementary measures
  (encryption at rest with EU-controlled KMS keys, encryption in
  transit with TLS 1.3).

## 7. Personal data breach notification

Zenith will notify the Customer **without undue delay, and in any case
within 48 hours**, of any Personal Data breach affecting the Customer's
data. The notification will include:

- Nature of the breach.
- Categories and approximate number of data subjects.
- Likely consequences.
- Measures taken or proposed.

## 8. Sub-processors

The Customer authorises the use of the sub-processors listed at
<https://zenith.io/trust-center#sub-processors>. Zenith will notify the
Customer 30 days before any change. The Customer may object on
reasonable grounds; if the parties cannot resolve the objection, the
Customer may terminate the affected services.

## 9. Audits

- **Annual SOC 2 Type II** report (free, under NDA).
- **Annual ISO 27001** certificate (free, under NDA).
- **On-site audit** at the Customer's request, no more than once per
  year, with 30 days' notice, at the Customer's expense, subject to
  Zenith's security policies.

## 10. Liability

Liability is governed by the MSA. The DPA does not increase either
party's liability beyond the MSA.

## 11. Annex A — Security measures

See `docs/security/03_controls_checklist.md` for the full mapping to
NIST 800-53 / ISO 27001 / SOC 2.

Headline measures:

- TLS 1.3 in transit; AES-256-GCM at rest.
- Customer-managed KMS keys.
- Field-level encryption for PII columns.
- Append-only audit log.
- 24/7 SOC; SEV-1 response in 5 minutes.
- Annual third-party penetration test.

## 12. Governing law

This DPA is governed by the laws of Ireland, with exclusive jurisdiction
in the courts of Dublin.

---

**Signed:**

For and on behalf of Zenith Labs:
Name: ___________________________
Title: Data Protection Officer
Date: ___________________________

For and on behalf of the Customer:
Name: ___________________________
Title: ___________________________
Date: ___________________________
