# Documentación de Zenith

> Auditada contra el código el 2026-11-10. Cada documento que no coincide con el código lleva un
> aviso de estado en su cabecera; aquí está el mapa completo.

## Empieza aquí

- **[Quickstart](tutorials/01_quickstart.md):** un servidor con `zen` y una app con el SDK de cliente.
- **[Referencia de la API HTTP](README.md):** generada con `zen generate docs`. Tiene las mismas rutas que monta el router (230 con las features por defecto); también está en `openapi.json`, en la colección de Postman `zenith.postman.json` y en `index.html` (Redoc).

## Servidor y cliente

| | SDK de servidor | SDK de cliente |
|---|---|---|
| Paquetes | `@zuccadev-labs/zenith` (motor) y `@zuccadev-labs/zenith-cli` (`zen`), en JSR; `@zuccadev-labs/create-zenith` en npm | `@zuccadev-labs/zenith-client` (npm) |
| Documentación | [zenith-backend/README](../zenith-backend/README.md), [zenith-cli/README](../zenith-cli/README.md) | [sdk/Typescript/README](../sdk/Typescript/README.md) |
| Crea proyectos | Sí, con `zen init` | No |

Los otros lenguajes de `sdk/` (Android, Apple, Dart, Flutter, .NET, PHP y Swift) son carpetas vacías.
`sdk/arduino` solo trae `ZenithIoT.h` (MQTT).

## Vigente

| Documento | Tema |
|---|---|
| [ADR-012](architecture-decisions/ADR-012-engine-auth.md) | engine-auth: usuarios y sesiones |
| [ADR-013](architecture-decisions/ADR-013-composition-and-access.md) | Composición y acceso: `public`, `user`, `master` |
| [ADR-014](architecture-decisions/ADR-014-classes-for-users.md) | `/classes` para usuarios: CLP y ACL |
| [ADR-015](architecture-decisions/ADR-015-api-key-access-policy.md) | API keys: scopes aplicados, política de IP, keys `*` acotadas |
| [ADR-016](architecture-decisions/ADR-016-shared-crypto-and-single-api-keys.md) | Primitivas criptográficas compartidas, firma de webhooks y un solo sistema de API keys |
| [ADR-017](architecture-decisions/ADR-017-webhooks-hooks-event-bus.md) | Webhooks con Standard Webhooks, Cloud Code Hooks de Parse y bus de eventos en el núcleo |
| [ADR-002](architecture-decisions/ADR-002-mtls.md) a [ADR-008](architecture-decisions/ADR-008-hashicorp-vault.md) | mTLS, API keys, firma de plugins, OpenAPI, observabilidad, producción y Vault. En lo técnico coinciden, con matices (ADR-007 sin verificar a fondo) |
| [openapi-swagger.md](architecture/openapi-swagger.md) | Cómo se genera la OpenAPI |
| [features-and-engines.md](architecture/features-and-engines.md) | Catálogo de piezas, activarlas al arrancar o en caliente, y cómo se acoplan los motores |
| [webhooks-and-hooks.md](architecture/webhooks-and-hooks.md) | Webhooks salientes (verificación en el receptor) y Cloud Code Hooks de Parse |
| [zenith-backend/docs/pending.md](../zenith-backend/docs/pending.md) | **Lo que falta o falla, con prioridad** |
| [zenith-backend/docs/errors.md](../zenith-backend/docs/errors.md) | Códigos de error |
| [lab-infra/docs/recrear-desde-cero.md](../lab-infra/docs/recrear-desde-cero.md) | Recrear el laboratorio |

## No coincide con el código (aviso «no coincide»)

| Documento | Diferencias principales |
|---|---|
| `tutorials/02_user_auth.md` | Usa `api.zenith.io/v1`. `/requestPasswordReset` responde 501 y MFA no existe. La API del SDK es otra: `ZenithUser.logIn`/`signUp`/`become`. |
| `tutorials/03_files.md` | Usa `files.zenith.io` y una API `zenith.files.*` que no existe. Lo real: `/files/:filename` (solo master) y `ZenithFile`. |
| `customer/03_rate_limits.md` | Solo coinciden los límites por tipo de key (pk 6000, sk 1000 y rk 60 por minuto). No existen las cabeceras `X-RateLimit-*` ni los planes. |
| `development/03_api_parity_audit.md` | Marca como hechas rutas que no existen (`/sessions`, `/config`, `/serverInfo`…) y como pendientes `/batch` y `/jobs`, que sí existen. |
| `development/00_index.md`, `02_test_coverage_audit.md` | Enlaces y tests que no existen. |
| `development/webrtc-media-sdk.md` | Usa `@zenith/core` y `@zenith/react-sdk`. Lo real: `Zen.Cloud.onStreamEvent(handler)` y `useZenithMedia` del SDK de cliente. |
| `architecture-decisions.md` | `ZENITH_TOPOLOGY` y el CLI `zenith-agent` no existen (lo real es `config.topology` y `zen agent`). El SFU no está conectado. |
| ADR-001, ADR-009 | Rutas de carpetas antiguas; `/batch` y `/jobs` ya existen. |
| `implementation_plan.md` (raíz) | Comandos del CLI que no existen. El real está en [zenith-cli/README](../zenith-cli/README.md). |
| `k8s/helm/zenith/README.md` | `charts.zenith.io` no existe. Los secretos `MASTER_KEY`/`JWT_SECRET` no son los que lee la imagen (`apps.config.ts` pide `APP1_MASTER_KEY` y `APP2_MASTER_KEY`); esto último no está verificado en ejecución. |
| `lab-infra/README.md` | Los scripts están en la raíz (`start.sh`, `start.ps1`), no en `scripts/`. `docker-compose.proxmox.yml` no existe. |

## Diseño aspiracional (aviso «aspiracional»)

Describen un SaaS alojado que no existe (`*.zenith.io`, regiones, precios, SLA, certificaciones):
`ROADMAP.md`, `customer/01_onboarding.md`, `customer/02_tco.md`, `migration/01_from_parse_server.md`,
`architecture/01` a `04`, ADR-010, ADR-011, `compliance/*`, `security/*`, `runbooks/*` e
`infra/terraform/README.md`. Sirven como intención de producto, no como guía.

## Histórico

`investigations/*` son las investigaciones de diseño previas al código actual. `agents/` y `prompt*.md` son notas internas.
