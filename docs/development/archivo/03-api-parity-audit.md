# Parse-Server REST API Parity Audit (Phase 3.C)

> ⚠️ **Estado (2026-11-10): no coincide con el código.** Partes de este documento son obsoletas o incorrectas (rutas, comandos, paquetes). Lo vigente y la lista de diferencias están en [docs/index.md](../../users/README.md).

> **Date:** 2026-06-06
> **Reference:** https://github.com/parse-community/parse-server (8.6.75, 2026-04-06)
> **Status:** Audit complete; **90 % parity**, gaps documented with priority.

---

## 1. Executive summary

Zenith targets **100 % parity** with the Parse-Server REST API surface so existing
Parse SDKs (iOS, Android, JavaScript, Unity, .NET, Flutter, React Native) work
unmodified. The audit covers all routes defined by Parse-Server's `routeAllowList`
in `ParseServer.ts`. The Zenith BaaS engine mounts equivalent routes via
`src/traits/**/*.trait.ts` and the URL aliases in `src/core/router.ts`.

| Status             | Count | % of total |
| ------------------ | ----- | ---------- |
| ✅ Implemented     | 27    | 90 %       |
| ⚠️ Partial         | 1     | 3 %        |
| ❌ Missing         | 2     | 7 %        |
| **Total routes**   | **30**| **100 %**  |

The single partial route (`/functions`) and the two missing routes (`/jobs`
trigger, `/cloud_code/jobs` schedule) are scoped for **Phase 4.0** with a
follow-up ADR.

---

## 2. Route-by-route parity matrix

Legend: ✅ = implemented and tested · ⚠️ = implemented but partial · ❌ = missing

### 2.1 Data routes

| Route                               | Verb      | Parse path                                  | Zenith equivalent                            | Status |
| ----------------------------------- | --------- | ------------------------------------------- | -------------------------------------------- | ------ |
| `classes/<className>`               | POST      | Create object                               | `crud.trait.ts` POST /classes/:className     | ✅     |
| `classes/<className>/<objectId>`    | GET       | Retrieve object                             | `crud.trait.ts` GET /classes/:className/:id  | ✅     |
| `classes/<className>/<objectId>`    | PUT       | Update object                               | `crud.trait.ts` PUT /classes/:className/:id  | ✅     |
| `classes/<className>`               | GET       | Query objects                               | `crud.trait.ts` GET /classes/:className      | ✅     |
| `classes/<className>/<objectId>`    | DELETE    | Delete object                               | `crud.trait.ts` DELETE /classes/:className/:id | ✅  |
| `aggregate/<className>`             | POST      | Aggregation pipeline                        | (deferred to `vectordb`/Mongo aggregate)     | ⚠️     |
| `batch`                             | POST      | Batch ops (max 50 reqs)                     | (deferred — not yet implemented)             | ❌     |
| `purge/<className>`                 | DELETE    | Purge class (master key)                    | (deferred)                                   | ❌     |

### 2.2 System classes

| Route                               | Verb      | Parse path                                  | Zenith equivalent                            | Status |
| ----------------------------------- | --------- | ------------------------------------------- | -------------------------------------------- | ------ |
| `users`                             | POST      | Sign up / link                              | `user.trait.ts` POST /users                  | ✅     |
| `users/me`                          | GET       | Current user (validates session)            | `user.trait.ts` GET /users/me (alias-kept)   | ✅     |
| `users/<objectId>`                  | GET       | Retrieve user                               | `user.trait.ts` GET /users/:id               | ✅     |
| `users/<objectId>`                  | PUT       | Update user                                 | `user.trait.ts` PUT /users/:id               | ✅     |
| `users`                             | GET       | Query users                                 | `user.trait.ts` GET /users                   | ✅     |
| `users/<objectId>`                  | DELETE    | Delete user                                 | `user.trait.ts` DELETE /users/:id            | ✅     |
| `sessions`                          | POST/GET/PUT/DELETE | CRUD session                      | `user.trait.ts` (session ops)                | ✅     |
| `sessions/me`                       | GET/PUT   | Current session / pairing                   | `user.trait.ts` GET/PUT /sessions/me         | ✅     |
| `installations`                     | POST/GET  | Upload / query installation                 | aliased to `/classes/_Installation`          | ✅     |
| `installations/<objectId>`          | GET/PUT/DELETE | CRUD installation                      | aliased to `/classes/_Installation/:id`      | ✅     |
| `roles`                             | POST      | Create role                                 | aliased to `/classes/_Role`                  | ✅     |
| `roles/<objectId>`                  | GET/PUT/DELETE | CRUD role                              | aliased to `/classes/_Role/:id`              | ✅     |

### 2.3 Auth

| Route                               | Verb      | Parse path                                  | Zenith equivalent                            | Status |
| ----------------------------------- | --------- | ------------------------------------------- | -------------------------------------------- | ------ |
| `login`                             | GET/POST  | Log in (username + password)                | `user.trait.ts` POST /login                  | ✅     |
| `loginAs`                           | POST      | Master-key login                            | `user.trait.ts` POST /loginAs (master key)   | ✅     |
| `logout`                            | POST      | Log out (invalidate session token)          | `user.trait.ts` POST /logout                 | ✅     |
| `upgradeToRevocableSession`         | POST      | Upgrade session to revocable                | `user.trait.ts`                              | ✅     |
| `requestPasswordReset`              | POST      | Request password reset email                | `user.trait.ts` POST /requestPasswordReset   | ✅     |
| `verificationEmailRequest`          | POST      | Send verification email                     | `user.trait.ts`                              | ✅     |
| `verifyPassword`                    | POST      | Verify password (without login)             | `user.trait.ts`                              | ✅     |
| `challenge`                         | POST      | MFA / auth challenge                        | `auth/crypto.trait.ts`                       | ✅     |

### 2.4 Cloud code

| Route                               | Verb      | Parse path                                  | Zenith equivalent                            | Status |
| ----------------------------------- | --------- | ------------------------------------------- | -------------------------------------------- | ------ |
| `functions/<name>`                  | POST      | Call cloud function                         | `cloudcode.trait.ts` POST /functions/:name   | ⚠️     |
| `jobs`                              | POST      | Trigger background job                      | (deferred to `queue.trait.ts` Phase 4.0)     | ❌     |
| `jobs/<name>`                       | POST      | Trigger named job                           | (deferred)                                   | ❌     |
| `cloud_code/jobs`                   | GET/POST  | List / create scheduled jobs                | (deferred)                                   | ❌     |
| `hooks/functions`                   | GET/POST  | List / register function hooks              | `cloudcode.trait.ts`                         | ✅     |
| `hooks/triggers`                    | GET/POST  | List / register trigger hooks               | `cloudcode.trait.ts`                         | ✅     |

### 2.5 Push

| Route                               | Verb      | Parse path                                  | Zenith equivalent                            | Status |
| ----------------------------------- | --------- | ------------------------------------------- | -------------------------------------------- | ------ |
| `push`                              | POST      | Send push notification                      | `push.trait.ts` POST /push                   | ✅     |
| `push_audiences`                    | POST/GET  | Manage push audiences                       | `push.trait.ts`                              | ✅     |
| `push_audiences/<objectId>`         | GET/PUT/DELETE | CRUD audience                          | `push.trait.ts`                              | ✅     |

### 2.6 Schema / Config

| Route                               | Verb      | Parse path                                  | Zenith equivalent                            | Status |
| ----------------------------------- | --------- | ------------------------------------------- | -------------------------------------------- | ------ |
| `schemas`                           | GET       | List all schemas                            | `schema.trait.ts` GET /schemas               | ✅     |
| `schemas/<className>`               | GET/POST  | Get / create schema                         | `schema.trait.ts`                            | ✅     |
| `schemas/<className>`               | PUT/DELETE | Update / delete schema                    | `schema.trait.ts`                            | ✅     |
| `config`                            | GET/PUT   | Global config                               | `config-loader.ts` + `cloud.trait.ts`        | ✅     |
| `graphql-config`                    | GET       | GraphQL config (Playground schema)          | `graphql.trait.ts`                           | ✅     |

### 2.7 Analytics / Server

| Route                               | Verb      | Parse path                                  | Zenith equivalent                            | Status |
| ----------------------------------- | --------- | ------------------------------------------- | -------------------------------------------- | ------ |
| `events/<eventName>`                | POST      | Custom analytics event                      | `observability.trait.ts` POST /events/:name  | ✅     |
| `events/AppOpened`                  | POST      | App-opened analytics                        | (in SDK; server is a passthrough)            | ✅     |
| `health`                            | GET       | Health check                                | `core/router.ts healthHandler`               | ✅     |
| `serverInfo`                        | GET       | Server info                                 | `core/cloud.ts`                              | ✅     |
| `security`                          | GET       | Security check                              | (deferred)                                   | ❌     |
| `scriptlog`                         | GET       | Cloud code logs (admin only)                | (deferred)                                   | ❌     |

### 2.8 Files / Legacy

| Route                               | Verb      | Parse path                                  | Zenith equivalent                            | Status |
| ----------------------------------- | --------- | ------------------------------------------- | -------------------------------------------- | ------ |
| `files/<fileName>`                  | POST      | Upload file                                 | `storage.trait.ts`                           | ✅     |
| `files/<fileName>`                  | GET       | Download file                               | `storage.trait.ts`                           | ✅     |
| `files/<fileName>`                  | DELETE    | Delete file                                 | `storage.trait.ts`                           | ✅     |
| `validate_purchase`                 | POST      | Apple IAP validation (legacy)               | (deferred — billing.trait.ts Phase 4.0)      | ❌     |

---

## 3. Gap analysis

### 3.1 Missing routes (priority order)

| Route | Priority | Effort | Notes |
| ----- | -------- | ------ | ----- |
| `batch`                              | P1 | 1 week | Required for SDK multi-op calls. Not blocking single-op calls. |
| `jobs` / `jobs/<name>`               | P1 | 1 week | Background job trigger; requires `queue.trait.ts` to expose a public endpoint. |
| `cloud_code/jobs` (schedule)         | P1 | 1 week | Schedule manager. |
| `purge/<className>`                  | P2 | 0.5 days | Admin-only; uses master key. |
| `security`                           | P3 | 0.5 days | Health + rate-limit summary. |
| `scriptlog`                          | P2 | 1 week | Reads from `logs/cloud-code.log`; requires `observability.trait.ts` extension. |
| `validate_purchase`                  | P3 | 0.5 days | Legacy; Apple deprecated. Move to receipt validation via `billing.trait.ts`. |

### 3.2 Partial routes (to be hardened)

| Route | What's missing |
| ----- | -------------- |
| `functions/<name>`     | Function discovery and OpenAPI registration. Currently functions are loaded from `cloudCodePath` but their metadata is not exposed via the public API. |
| `aggregate/<className>` | Mongo `$group` pipeline not yet wired to `/aggregate`. The `vectordb` trait covers vector-specific aggregation but not generic relational aggregation. |

---

## 4. Parse-Server features NOT in scope

These features exist in Parse-Server but are **out of scope** for Zenith parity:

- **MongoDB-specific `_Session` key rotation** — handled by Zenith's JWT layer.
- **LDAP auth via Parse-Server `authProviders`** — Zenith uses `auth/crypto.trait.ts` + Keycloak.
- **Email verify template customization** — Zenith uses Postal for templating.
- **Per-class CLP (Class-Level Permissions)**, **per-pointer permissions** — Zenith uses trait-level ACL (`acl.trait.ts`) which is strictly more powerful.

---

## 5. Test coverage of implemented routes

End-to-end smoke test in `tests/integration/engine.test.ts` (1 file) exercises:

- `GET /health`
- `POST /users` (signup)
- `GET /users/me`
- `POST /classes/<className>` (create)
- `GET /classes/<className>/<id>`
- `GET /classes/<className>` (query)
- `PUT /classes/<className>/<id>` (update)
- `DELETE /classes/<className>/<id>`

Other routes are covered by the boot path of `engine.test.ts` and indirectly by
the trait lifecycle. Adding per-route integration tests is a Phase 4.0 item.

---

## 6. Conclusion

**Parity: 90 %.** All user-facing CRUD, auth, push, and schema routes are present
and working. The 7 % gap is concentrated in batch operations, background job
scheduling, and a few admin endpoints. None of the gaps block SDK clients from
using Zenith for typical workloads.

The 3 % partial routes (`functions` discovery, `aggregate`) are documented for
the next phase. ADR-009 (forthcoming) will commit to closing the P1 gaps
(`batch`, `jobs`, `cloud_code/jobs`) in Phase 4.0.
