# API Versioning Policy

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../../users/README.md).

> **Owner:** API lead, Product lead.
> **Effective:** 2026-06-06.
> **Status:** Accepted.

## 1. Version scheme

We use **URI versioning** with a major-only scheme:

```
https://api.zenith.io/v1/...
https://api.zenith.io/v2/...
```

Major version is bumped for **breaking changes** only (see §3).
Minor and patch versions are **never** exposed in the URI.

## 2. Stability tiers

| Tier             | Guarantee                                | SLA                          |
| ---------------- | ----------------------------------------- | ---------------------------- |
| **Stable**       | No breaking changes for 12 months         | 99.95 %                      |
| **Beta**         | May break with 3 months notice            | 99.5 %                       |
| **Experimental** | May break at any time, no notice          | best-effort                  |

Stable endpoints are marked with `stability: stable` in OpenAPI.
Beta endpoints are marked with `stability: beta` and prefixed `/v1/beta/...`.

## 3. Breaking vs non-breaking

A change is **breaking** if it requires the customer to modify their code
to keep working. Examples:

### Breaking (requires major version bump)

- Removing an endpoint.
- Removing a request field.
- Removing a response field that is documented as part of the contract.
- Renaming a field.
- Changing the type of a field.
- Tightening validation (e.g. making a previously-optional field required).
- Changing authentication requirements.
- Changing the status code of an error.
- Changing pagination defaults (e.g. limit) that customers rely on.

### Non-breaking (no version bump)

- Adding a new endpoint.
- Adding a new optional request field.
- Adding a new response field.
- Loosening validation (e.g. making a previously-required field optional).
- Adding a new error code.
- Adding new enum values (with backwards-compatible handling).
- Performance improvements.
- Bug fixes that change behaviour in a previously-undocumented way.

## 4. Deprecation process

1. **Announce** deprecation in `CHANGELOG.md` and the API docs.
2. **Mark** the endpoint with `deprecated: true` in OpenAPI.
3. **Email** all customers who have called the endpoint in the last 90 days.
4. **Sunset header:** `Sunset: Sat, 01 Jan 2028 00:00:00 GMT`.
5. **Maintain** the endpoint for at least **12 months** after deprecation.
6. **Remove** only with a major version bump.

Example deprecation header on response:

```http
HTTP/1.1 200 OK
Deprecation: true
Sunset: Sat, 01 Jan 2028 00:00:00 GMT
Link: <https://docs.zenith.io/migration/v1-to-v2/users>; rel="successor-version"
```

## 5. Version roadmap

| Version | Status    | Sunset        | Notes                           |
| ------- | --------- | ------------- | ------------------------------- |
| **v1**  | current   | 2028-06-06    | first GA release                |
| v0      | retired   | 2026-01-01    | pre-release, never GA           |

## 6. Beta → Stable graduation

An endpoint is promoted from beta to stable when:

- It has been in beta for at least 3 months.
- It has at least 5 production customers using it.
- The API is documented in OpenAPI.
- The error codes are stable.
- The performance is within the SLO.

## 7. Customer notification

We notify customers of any breaking change via:

- Email to the technical contact (per tenant, 30 days before).
- Slack (Enterprise customers only, 60 days before).
- Status page banner.
- Deprecation header on every affected response.

## 8. SDK compatibility

SDKs follow the same versioning policy as the API:

- **Major version** matches the API major version.
- **Minor version** for new features (e.g. new endpoint support).
- **Patch version** for bug fixes.

SDKs are maintained for the latest API major version plus the previous
one for 12 months after sunset.
