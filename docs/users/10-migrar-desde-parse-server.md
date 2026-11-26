---
description: "Qué rutas y comportamientos de Parse Server tiene Zenith, cuáles cambian a propósito y cuáles faltan."
tipo: explicacion
---

# ¿Qué funciona igual que en Parse Server y qué cambia?

Los SDK de Parse hablan con Zenith por las mismas rutas y cabeceras, con los mismos códigos de error. Lo que cambia
es casi todo a propósito: la master key solo vale desde localhost, `/classes` solo acepta clases definidas y los
usuarios viven en engine-auth. No hay herramienta de migración de datos.

## Contexto

Escribí Zenith para que una app hecha con Parse Server pudiera cambiar de servidor sin cambiar de SDK. Las
decisiones de seguridad que se apartan de Parse están en los ADR 012 a 015; aquí solo las resumo.

## Cómo funciona

### Igual que en Parse Server

| Qué | Rutas | Notas |
|---|---|---|
| Objetos | `/classes/:className`, `/classes/:className/:objectId`, `/batch` | Abiertas a usuarios, con ACL y CLP |
| Usuarios | `POST /users`, `/login`, `/logout`, `/users/me`, `/sessions/me` | `/users/:id` se resuelve como `/classes/_User/:id` |
| Esquemas | `/schemas`, `/schemas/:className` | Solo master |
| Cloud Code | `/functions/:name`, `/jobs/:name`, `Zen.Cloud.define`, `beforeSave` y los demás triggers de objetos, archivos y login | Validadores con la semántica de Parse |
| Cloud Code Hooks | `/hooks/functions`, `/hooks/triggers` | Solo master; firma Standard Webhooks además de `X-Parse-Webhook-Key` |
| Archivos | `/files/:filename` | Solo master |
| Roles | `/roles` | Solo master |
| Cabeceras | `X-Parse-Application-Id`, `X-Parse-Session-Token`, `X-Parse-Master-Key`, `X-Parse-REST-API-Key` | También con prefijo `Zen-` |
| Errores | `{ code, error }` | Mismos números que Parse por debajo de 300 ([Errores](./09-errores.md)) |

### Distinto a propósito

| En Parse Server | En Zenith | Por qué |
|---|---|---|
| La master key vale desde cualquier sitio | Solo desde localhost | Una master key robada no sirve desde fuera ([ADR-013](../investigations/adr/13-composition-and-access.md)) |
| Un cliente crea clases al guardar | `/classes` solo acepta clases definidas con `/schemas`, salvo con `allowClientClassCreation: true` | Que un cliente no invente esquemas ([ADR-014](../investigations/adr/14-classes-for-users.md)) |
| Las rutas aceptan cualquier sesión | Cada ruta declara `public`, `user` o `master`, y lo que no declara es `master` | Denegar por defecto |
| Las funciones Cloud las llama cualquiera | Solo master, salvo `requireUser`, roles o `public: true` | Lo mismo |
| Contraseñas en `_User` | Cuentas en engine-auth; `_User` es el perfil, sin contraseña | Un solo emisor de identidad para el ecosistema ([ADR-012](../investigations/adr/12-engine-auth.md)) |
| `GET /login?username=…` | 405; solo `POST` | Las credenciales no van en la URL |
| REST API key única | API keys con scopes, lista de IP y rotación | [ADR-015](../investigations/adr/15-api-key-access-policy.md) |
| Un hook `after*` que falla puede romper la petición | Se registra y no deshace la operación | El objeto ya está guardado |

## Por qué es así

Parse Server confía en que la master key no salga del servidor y en que el cliente se porte bien. Yo preferí que
el servidor no dependa de eso. A cambio, una app de Parse que use la master key desde fuera, o que cree clases desde
el cliente, necesita cambios antes de migrar.

## Límites

Faltan, o no funcionan todavía:

| Qué | Estado |
|---|---|
| Recuperación de contraseña y verificación de email | 501 ([Usuarios y sesiones](./02-usuarios-y-sesiones.md)) |
| LiveQuery por WebSocket | Leyendo el código, el WebSocket no tiene manejador ([Lo que falta](../development/10-lo-que-falta.md)) |
| Triggers de LiveQuery (`beforeConnect`, `beforeSubscribe`, `afterLiveQueryEvent`) y `beforePasswordResetRequest` | Se registran y avisan en el log, pero no se ejecutan |
| `/config`, `/serverInfo`, `/installations`, `/push`, `/aggregate`, `/purge`, listar `/sessions` | No existen |
| Herramienta para copiar los datos de una base de Parse | No existe |

Los datos de una base MongoDB de Parse no los he probado contra Zenith. La diferencia que sé que exige trabajo son
los usuarios: sus contraseñas tienen que pasar a engine-auth, y `_User.objectId` pasa a ser el `sub` de
engine-auth.

## Para seguir

- [Primeros pasos](./01-primeros-pasos.md).
- [Acceso y API keys](./04-acceso-y-api-keys.md).
- [Referencia de la API](./08-referencia-de-la-api.md).
