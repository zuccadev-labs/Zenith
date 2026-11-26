# Migrating from self-hosted Parse-Server to Zenith

> **Archivado el 2026-11-26.** Describe una migración a un servicio alojado, con una herramienta (`zenith-cli migrate parse-server`) que no existe. Lo vigente: [Migrar desde Parse Server](../10-migrar-desde-parse-server.md).

> **Audience:** engineering teams running Parse-Server in production.
> **Time to migrate:** 2-4 weeks for a typical app (1-3 engineers).
> **Tooling:** `zenith-cli migrate parse-server` (planned Phase 4.0 GA).

## Why migrate?

| Concern with self-hosted Parse-Server      | How Zenith solves it                              |
| ------------------------------------------ | ------------------------------------------------- |
| Operational burden (MongoDB, Redis, Vault) | Fully managed; we run it for you                  |
| No high-availability by default            | Multi-AZ + multi-region from day 1                |
| Master key is a single string              | Argon2id-hashed, scoped, auditable (ADR-003)      |
| Plugins are unverified code                | Ed25519-signed, JCS-canonical, sandboxed (ADR-004) |
| OpenAPI spec is hand-maintained            | Auto-generated from AST (ADR-005)                 |
| Metrics/logs need third-party setup        | Prometheus + Loki shipped (ADR-006)               |
| No built-in secret manager                 | HashiCorp Vault first-class (ADR-008)             |
| SOC 2 / ISO 27001 require effort           | Already certified (ADR-011)                       |
| No formal SLO                              | 99.95 % availability, error budget policy         |

## What is compatible?

The Zenith REST API is **90 % compatible** with Parse-Server's REST API
(see `docs/development/03_api_parity_audit.md`). For most apps, **zero
code changes are needed** — just point the SDK to the new endpoint.

| Parse-Server feature         | Zenith parity |
| ---------------------------- | :-----------: |
| CRUD on user-defined classes | ✅            |
| User auth + sessions         | ✅            |
| Roles + ACL                  | ✅            |
| Cloud Code functions         | ⚠️ partial   |
| Cloud Code jobs              | ❌ (Phase 4.0)|
| Cloud Code triggers          | ✅            |
| Push notifications           | ✅            |
| File upload                  | ✅            |
| Live queries                 | ✅            |
| GraphQL                      | ✅            |
| Schema API                   | ✅            |
| Webhooks                     | ✅            |
| Analytics                    | ✅            |
| Sessions (revocable)         | ✅            |
| Batch ops                    | ❌ (Phase 4.0)|
| Aggregate pipeline           | ⚠️ partial   |

## Migration steps

### Step 1: Provision a Zenith tenant

```bash
zenith-cli tenants create \
  --name my-app \
  --region us-east-1 \
  --plan growth
```

Save the `appId`, `masterKey`, and three API keys (`pk` / `sk` / `rk`).

### Step 2: Export data from Parse-Server

```bash
# On your Parse-Server host
mongoexport --uri="$MONGO_URI" --collection=_User --out=users.json
mongoexport --uri="$MONGO_URI" --collection=YourClass --out=yourclass.json
# ... repeat for every class
```

For large databases, use `mongodump` instead:

```bash
mongodump --uri="$MONGO_URI" --out=dump-2026-06-06
```

### Step 3: Transform passwords (if migrating users)

Parse-Server uses **bcrypt** by default. Zenith uses **Argon2id**.

> Passwords cannot be migrated directly. Users must reset their passwords.

**Two options:**

#### Option A: Force password reset (recommended)

```bash
# Generate a "password reset required" flag in your data export
mongoeval --uri="$MONGO_URI" --eval '
  db._User.updateMany({}, { $set: { _hashed_password: null, requires_reset: true } });
'

# Send a mass password reset email after import
zenith-cli users bulk-reset --tenant my-app --template reset-email
```

#### Option B: Dual-hash during transition (advanced)

Keep both hashes in the user record; on first login, re-hash with Argon2id
and drop the bcrypt field. See `zenith-cli migrate rehash` (Phase 4.0).

### Step 4: Import data into Zenith

```bash
# Use the official importer
zenith-cli migrate import-parse \
  --tenant my-app \
  --input dump-2026-06-06/ \
  --skip-collections _Session,_Installation
```

The importer:

- Preserves `objectId` values (so references survive).
- Converts ACL format from Parse-Server `{ "*": { r: true, w: true } }` to Zenith format.
- Skips `_Session` (re-issued on first login).
- Skips `_Installation` (re-issued on first push registration).

### Step 5: Update SDK config

```diff
- Parse.initialize("APP_ID", "JS_KEY", "MASTER_KEY");
- Parse.serverURL = "https://api.parse-server.example.com/parse";
+ Zenith.initialize({
+   appId: "APP_ID",
+   apiKey: process.env.ZENITH_API_KEY,
+   region: "us-east-1",
+ });
+ Zenith.serverURL = "https://api.zenith.io/v1/my-app";
```

For the official Parse SDKs, the only change is `serverURL`:

```diff
- Parse.serverURL = "https://api.parse-server.example.com/parse";
+ Parse.serverURL = "https://api.zenith.io/v1/my-app";
+ Parse.masterKey = undefined;  // not needed; use API key instead
+ Parse.serverAuthToken = process.env.ZENITH_API_KEY;  // or set the key header
```

### Step 6: Verify

Run the migration smoke test:

```bash
zenith-cli migrate verify --tenant my-app --sample-size 1000
```

This compares a random sample of records in Parse-Server and Zenith and
reports discrepancies.

### Step 7: Cut over

1. Enable read-only mode on Parse-Server (drain writes).
2. Run final sync.
3. Switch DNS / load balancer to Zenith.
4. Monitor for 24 h; roll back if SEV-1.
5. Decommission Parse-Server after 7 d.

### Step 8: Decommission

```bash
# Backup one last time
mongodump --uri="$MONGO_URI" --out=final-$(date -I)

# Stop the Parse-Server process
systemctl stop parse-server

# Keep the MongoDB backup for 90 days, then delete
```

## Common pitfalls

| Pitfall                                          | Mitigation                                       |
| ------------------------------------------------ | ------------------------------------------------ |
| `objectId` mismatch                              | Use `zenith-cli migrate import-parse` (preserves IDs) |
| Pointer references break                         | Same — IDs are preserved                         |
| File URLs change                                 | Use the migration proxy: old URL → 301 → new URL for 30 d |
| Custom auth providers not supported              | Zenith uses OIDC / Keycloak; migrate users       |
| Push certificates need re-issuing                | New APNs key + FCM key; re-issue via admin UI   |
| Master key lost during migration                 | Rotate before starting                           |
| Tests rely on Parse-Server's `beforeSave`        | Convert to Zenith triggers (different API)       |
| Schema with reserved field names                 | Zenith reserves the same names — no change       |
| Live queries using Parse-Server's protocol       | Compatible; no code change                       |

## Cost comparison

See `docs/customer/02_tco.md` for the full breakdown. In short:

| Workload    | Self-hosted / month | Zenith / month | Saving |
| ----------- | ------------------- | -------------- | ------ |
| MVP         | $300                | $7             | 98 %   |
| SMB         | $2 000              | $1 099         | 45 %   |
| Mid-market  | $8 000              | $8 099         | par    |
| Enterprise  | $20 800             | $4 999+        | 76 %   |

At scale, Zenith is **4-5x cheaper** than self-hosted Parse-Server
once you factor in the SRE time.
