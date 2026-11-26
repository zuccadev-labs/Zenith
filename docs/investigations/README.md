---
description: "Las decisiones de arquitectura de Zenith (ADR) y las investigaciones que las precedieron."
---

# Investigación y decisiones

Aquí están las decisiones de arquitectura (ADR) y las notas de investigación de antes de escribir el código. Un ADR
no se reescribe: si la decisión cambia, escribo otro y el anterior pasa a sustituido.

## Notas de investigación

| Nota | Pregunta que responde |
|---|---|
| [La documentación, contrastada](./01-la-documentacion-contrastada.md) | ¿Cuánto se parecía la documentación al código? (2026-11-26) |

## Decisiones (ADR)

Las de 012 en adelante están escritas contra el código actual. Las anteriores son de otra etapa del proyecto; el
estado dice cuánto se sostienen hoy.

| ADR | Decisión | Estado |
|---|---|---|
| [001](./adr/01-folder-unification.md) | Unificar las carpetas duplicadas del monorepo | Aceptada; las rutas que cita ya no son las del repositorio |
| [002](./adr/02-mtls.md) | mTLS con pinning de SPKI entre nodos | Aceptada |
| [003](./adr/03-api-keys.md) | API keys al estilo de Stripe con Argon2id | Aceptada; ampliada por 015 y 016 |
| [004](./adr/04-plugin-signing.md) | Firma de manifiestos de plugins con Ed25519 | Aceptada |
| [005](./adr/05-openapi-ast-generation.md) | OpenAPI 3.1 generada a partir de los traits compuestos | Aceptada |
| [006](./adr/06-prometheus-remote-write-loki.md) | Prometheus `remote_write` y envío de logs a Loki | Aceptada |
| [007](./adr/07-production-readiness.md) | Limpieza para producción | Aceptada; no la he verificado a fondo contra el código |
| [008](./adr/08-hashicorp-vault.md) | HashiCorp Vault para los secretos | Aceptada |
| [009](./adr/09-api-parity-closure.md) | Cerrar la paridad con la API de Parse Server | Sustituida: `/batch` y `/jobs` ya existen |
| [010](./adr/10-backup-strategy.md) | Copias de seguridad y recuperación | No aplicada: servicio alojado que no existe |
| [011](./adr/11-security-hardening.md) | Endurecimiento y cumplimiento | No aplicada: servicio alojado que no existe |
| [012](./adr/12-engine-auth.md) | Usuarios y sesiones delegados en engine-auth | Aceptada |
| [013](./adr/13-composition-and-access.md) | Composición por capacidades y acceso denegado por defecto | Aceptada |
| [014](./adr/14-classes-for-users.md) | `/classes` abierto a usuarios | Aceptada |
| [015](./adr/15-api-key-access-policy.md) | Scopes y política de IP de las API keys | Aceptada |
| [016](./adr/16-shared-crypto-and-single-api-keys.md) | Primitivas criptográficas compartidas y un solo sistema de API keys | Aceptada |
| [017](./adr/17-webhooks-hooks-event-bus.md) | Standard Webhooks, Cloud Code Hooks y bus de eventos en el núcleo | Aceptada |
| [018](./adr/18-engine-push.md) | Los avisos a personas salen por engine-push | Aceptada |
| [019](./adr/19-cells.md) | La celda (Durable Object) como unidad de trabajo con estado | Aceptada |

## Investigaciones previas

Las escribí antes del código actual. Describen lo que pensaba construir, no lo que hay; las dejo porque explican de
dónde salen varias decisiones.

| Investigación | Tema |
|---|---|
| [00](./previas/00-intro.md) | La idea inicial de Zenith |
| [01](./previas/01-parse-server-architecture-analysis.md) | La arquitectura de Parse Server y cómo llevarla a Zenith |
| [02](./previas/02-barrits-integration-design.md) | Traits de barrits y orquestación determinista |
| [03](./previas/03-zenith-architecture.md) | La arquitectura del núcleo |
| [04](./previas/04-schema-and-blockchain-design.md) | Esquemas y soporte de blockchain |
| [05](./previas/05-observability-and-openapi.md) | OpenTelemetry y OpenAPI |
| [06](./previas/06-security-microservices-audit.md) | Seguridad, microservicios y auditoría |
| [07](./previas/07-business-models.md) | Modelos de negocio |
| [08](./previas/08-plugin-signing-supply-chain.md) | Firma de plugins y cadena de suministro |
| [09](./previas/09-openapi-ast-generation.md) | OpenAPI desde los traits compuestos |
| [10](./previas/10-observability-remote-write.md) | `remote_write` de Prometheus y Loki |
| [11](./previas/11-hashicorp-vault-secrets.md) | HashiCorp Vault |

## Archivo

[Decisiones de arquitectura originales](./archivo/01-decisiones-de-arquitectura-originales.md): el primer documento
de decisiones. `ZENITH_TOPOLOGY` y el CLI `zenith-agent`, que aparecen en él, no existen; lo real es
`config.topology` y `zen agent`.

[Roadmap del servicio alojado](./archivo/02-roadmap-del-servicio-alojado.md): el roadmap público que tenía en la raíz, con
fechas y planes de un servicio que no existe.
