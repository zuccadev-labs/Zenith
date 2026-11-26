---
description: "El modelo de acceso por ruta (public, user, master), las API keys con scopes y lista de IP, y los límites de peticiones."
tipo: referencia
---

# ¿Quién puede llamar a cada ruta y con qué credencial?

Cada ruta declara un acceso: `public`, `user` o `master`. Una ruta que no declara nada es `master`. La OpenAPI de
cada servidor lo documenta en la `security` de cada operación.

## Resumen

| Acceso | Quién entra | Ejemplos |
|---|---|---|
| `public` | Cualquiera, sin credenciales | `/health`, `/openapi.json`, `/login`, `POST /users`, una URL firmada de `/files` |
| `user` | Una sesión de usuario, o una API key cuyos scopes cubran el de la ruta | `/classes`, `/batch`, funciones con `requireUser` |
| `master` | La master key, solo desde localhost | `/schemas`, `/files`, `/zen/*`, los módulos de negocio |

Lo decidí así en [ADR-013](../investigations/adr/13-composition-and-access.md): denegar por defecto y abrir ruta por
ruta. Hoy están abiertas a usuarios `/classes` y `/batch` ([ADR-014](../investigations/adr/14-classes-for-users.md));
el resto se abre trait por trait ([Lo que falta](../development/10-lo-que-falta.md)).

## Credenciales

| Cabecera | Qué lleva |
|---|---|
| `X-Parse-Application-Id` (o `Zen-Application-Id`) | El `appId`. Siempre |
| `X-Parse-Session-Token` (o `Zen-Session-Token`) | Token de sesión `r:…` |
| `Authorization: Bearer <valor>` | Un token de sesión, un token de acceso de engine-auth o una API key |
| `X-API-Key`, `Zen-API-Key` o `X-Parse-REST-API-Key` | Una API key |
| `X-Parse-Master-Key` (o `Zen-Master-Key`) | La master key. Fuera de localhost se rechaza y se avisa en el log |

Si una petición se autentica con una API key, la master key que traiga no se tiene en cuenta.

## API keys

Se gestionan con `zen api-keys` o con `/zen/api-keys`, solo con la master key: ninguna API key puede crear, rotar
ni revocar otra, tampoco una `*` ([ADR-015](../investigations/adr/15-api-key-access-policy.md)).

```bash
zen api-keys create --name ci --env test --allowed-ips 203.0.113.10
zen api-keys create --name lectura --prefix pk --scopes "data:read"
zen api-keys create --name deploy --scopes "*" --allowed-ips 203.0.113.10 --expires 30d
zen api-keys list
zen api-keys rotate --id <keyId> --grace 24h
zen api-keys revoke --id <keyId> --reason "filtrada"
```

La key completa solo se muestra al crearla.

### Tipos

| Prefijo | Para | Scopes por defecto | Peticiones por minuto |
|---|---|---|---|
| `sk_` | Backends de confianza | `data:read`, `data:write`, `data:create`, `data:delete`, `users:read`, `users:write`, `files:read`, `files:write`, `files:delete`, `functions:invoke`, `functions:deploy`, `push:send`, `analytics:read` | 1000 |
| `pk_` | Clientes públicos | `data:read`, `users:read`, `files:read`, `analytics:read` | 6000 |
| `rk_` | Un uso concreto | `analytics:read` | 60 |

`--rpm` cambia el límite de una key. `--env live|test` marca el entorno en el propio prefijo (`sk_live_…`).

### Scopes

- `recurso:acción` concede una operación; `recurso:*`, todas las de ese recurso; `*`, todo.
- Una ruta `user` solo acepta API keys si declara un scope. Si no lo declara, las rechaza.
- En el CRUD: leer pide `data:read`; crear, `data:create`; modificar o incrementar, `data:write`; borrar,
  `data:delete`. En `_User`, `users:read` y `users:write`. `/batch` comprueba cada suboperación.

### Lista de IP (`allowedIps`)

- Cualquier key puede llevarla: hasta 100 direcciones IPv4 o IPv6, o rangos CIDR.
- Fuera de la lista, la key se rechaza con 401 y el intento queda en la auditoría
  (`key.rejected`, `reason: ip_not_allowed`).
- La IP es la del socket. `X-Forwarded-For` solo cuenta si el socket es un proxy declarado en `trustedProxies`.

### Keys `*`

Una key con scope `*` equivale a la master key, así que le exijo lo mismo que a ella:

- solo puede ser `sk_`;
- `--allowed-ips` es obligatoria y no admite `0.0.0.0/0` ni `::/0`;
- caduca en 90 días como máximo; se renueva rotándola.

Un despliegue sin IP fija (autoescalado, serverless) no puede usar keys `*`: usa keys con scopes concretos o sale
por una IP fija.

### Rotación

La key nueva conserva los scopes, la lista de IP y la duración de la anterior. La anterior sigue valiendo durante
el periodo de gracia: 24 h por defecto y 30 días como máximo.

## Límites de peticiones

| Límite | Cuánto | Respuesta al pasarlo |
|---|---|---|
| Por IP, en `/login` y `POST /users` | 10 por minuto | 429, código 155 |
| Por IP, en el resto de rutas | 100 por minuto | 429, código 155 |
| Por API key | El de su tipo, o `--rpm` | Ver abajo |

La master key no tiene límite por IP.

Cuando una key pasa su límite, durante ese minuto deja de autenticar: la petición sigue como anónima y una ruta
`user` la rechaza por falta de credenciales, no con 429. Así lo leo en el código (`security/api-keys/middleware.ts`
y `core/pipeline.ts`, donde nadie lee `apiKeyRejected`); no lo he comprobado con una prueba. Está anotado en
[Lo que falta](../development/10-lo-que-falta.md).

No hay cabeceras `X-RateLimit-*` en las respuestas normales, ni planes con límites distintos.

## Errores

| Respuesta | Cuándo |
|---|---|
| 401 | Credencial ausente, inválida, caducada, revocada o fuera de su lista de IP |
| 403 | Credencial válida sin el scope de la ruta; una `pk_` que intenta escribir; una API key en `/zen/api-keys` |
| 429 | Límite por IP |

## Ver también

- [Usuarios y sesiones](./02-usuarios-y-sesiones.md).
- [ADR-015](../investigations/adr/15-api-key-access-policy.md) y
  [ADR-016](../investigations/adr/16-shared-crypto-and-single-api-keys.md): las decisiones y sus fuentes.
- Código: `zenith-backend/src/security/api-keys/`.
