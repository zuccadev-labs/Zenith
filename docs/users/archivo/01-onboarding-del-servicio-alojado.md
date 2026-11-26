# Zenith — Customer Onboarding

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../index.md).

> **Audience:** Customer Success, Sales Engineers, Onboarding Managers.
> **Time to first request:** < 30 minutes.

## 1. Pre-sales checklist

Before provisioning a new tenant, confirm:

- [ ] Customer signed MSA and DPA.
- [ ] Compliance requirements documented (SOC 2, HIPAA, GDPR, CCPA).
- [ ] Region selected: `us-east-1`, `us-west-2`, `eu-west-1`, `ap-southeast-1`.
- [ ] Tenant name: kebab-case, max 32 chars, unique.
- [ ] Admin email(s) for the first super-user.
- [ ] SSO requirements (OIDC / SAML).
- [ ] Data residency requirements.
- [ ] Expected RPS / storage / monthly active users.

## 2. Provisioning

### 2.1 Create the tenant

```bash
zenith-cli tenants create \
  --name acme-corp \
  --region us-east-1 \
  --plan enterprise \
  --admin-email admin@acme.com
```

Output:

```json
{
  "tenantId": "tnt_acme-corp",
  "appId": "acme-corp-prod",
  "masterKey": "zenith_master_***REDACTED***",
  "apiEndpoint": "https://api.zenith.io/v1/acme-corp",
  "vaultPath": "secret/tenants/tnt_acme-corp/",
  "createdAt": "2026-06-06T12:00:00Z"
}
```

**Critical:** the master key is shown **once**. Store it in the customer's
1Password / Vault. Lost keys require a rotation event (24 h SLA).

### 2.2 Create the admin user

```bash
zenith-cli users create \
  --tenant acme-corp \
  --email admin@acme.com \
  --role super-admin \
  --mfa-required
```

### 2.3 Issue API keys

Three key types are issued (see ADR-003):

```bash
# Publishable key (browser-safe, low rate limit)
zenith-cli keys create --tenant acme-corp --type pk --name "web"
# → pk_live_***

# Server key (server-side, high rate limit)
zenith-cli keys create --tenant acme-corp --type sk --name "api-server"
# → sk_live_***

# Restricted key (least privilege)
zenith-cli keys create --tenant acme-corp --type rk --name "ci-cd" --scopes "data:read,files:read,functions:invoke"
# → rk_live_***
```

### 2.4 Configure webhook for billing alerts

```bash
zenith-cli webhooks create \
  --tenant acme-corp \
  --url https://acme.com/webhooks/zenith \
  --events billing.alert,tenant.quota
```

## 3. Customer handoff

Email template (subject: "Welcome to Zenith — Your API Keys & Quickstart"):

```
Hi {{admin_name}},

Your Zenith tenant is ready!

Tenant:    acme-corp
Region:    us-east-1
Endpoint:  https://api.zenith.io/v1/acme-corp
Master key: zenith_master_***REDACTED*** (see 1Password vault "Acme - Zenith")
API keys:  pk_live_***, sk_live_***, rk_live_*** (see 1Password)

Quickstart (5 min):
  https://docs.zenith.io/tutorials/quickstart

SDKs:
  TypeScript:  https://docs.zenith.io/sdk/typescript
  Python:      https://docs.zenith.io/sdk/python
  Swift:       https://docs.zenith.io/sdk/swift
  Kotlin:      https://docs.zenith.io/sdk/kotlin

Status page:  https://status.zenith.io
Support:      support@zenith.io
Slack (Enterprise only):  https://acme.slack.com/archives/zenith

Office hours:  every Tuesday 14:00 UTC — https://zenith.io/office-hours

Welcome aboard!
— The Zenith Team
```

## 4. Day-1 checklist

- [ ] Customer has 1Password vault with master key + API keys.
- [ ] Customer has issued an `rk` key for their CI/CD.
- [ ] Customer's first app is deployed and producing 1 000+ requests.
- [ ] Status page bookmarked by customer's SRE.
- [ ] Slack channel created (Enterprise only).
- [ ] Office hours invite sent.
- [ ] First 7-day check-in scheduled.

## 5. 7-day check-in

Ask:

- Did the quickstart work end-to-end? Any friction?
- How is the SDK experience?
- Are the rate limits appropriate?
- Any compliance / audit questions?
- Are there gaps in our documentation?

Open follow-up tickets for any friction points.

## 6. 30-day check-in

- [ ] Customer is at expected RPS / MAU.
- [ ] No SEV-1 / SEV-2 incidents in their tenant.
- [ ] Customer has consumed < 80 % of any quota.
- [ ] Renewal conversation started (if annual contract).
- [ ] NPS score collected.

## 7. Common onboarding pitfalls

| Pitfall                                     | Mitigation                                  |
| ------------------------------------------- | ------------------------------------------- |
| Customer stores master key in plaintext     | Document 1Password flow; auto-detect on keys issue |
| Customer uses `sk` in browser               | Auto-reject at the WAF; provide `pk` instead |
| Customer skips MFA for admin                | MFA required by default; cannot disable    |
| Customer chooses wrong region               | Confirm with sales; migration is a paid engagement |
| Customer expects Parse-Server edge cases    | Link to `docs/development/03_api_parity_audit.md` (90% parity) |
| Customer tries to upload > 50 MB file       | Default cap; raise via support ticket       |
