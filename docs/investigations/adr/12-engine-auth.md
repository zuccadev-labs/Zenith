---
description: "ADR-012 — Usuarios y sesiones delegados en engine-auth."
tipo: adr
estado: aceptada
---

# ADR-012 — Usuarios y sesiones delegados en engine-auth

> **Estado:** Aceptada
> **Fecha:** 2026-11-09
> **Relacionado:** `zenith-backend/src/traits/auth/engine-auth.ts`, `zutool/docs/development/engine-auth.md`

## Contexto

El `user.trait.ts` anterior no funcionaba:
- consumía `db`, una capacidad que no provee ningún trait;
- llamaba a métodos que el adaptador no tiene (`db.read`, `update` por filtro);
- guardaba las sesiones en un `Map` en memoria, con un año de vida.

Además, ningún trait proveía `authentication`. El pipeline llamaba a `undefined.verifySession`, el error se
tragaba y **todas las peticiones quedaban anónimas**.

Tenía también fallos de seguridad que se habrían activado al conectarlo:
- `verifyEmail` no pedía ningún token;
- el MFA quedaba activo antes de confirmarlo y su secreto iba en base64.

El ecosistema ya tiene engine-auth: un solo emisor OAuth 2.1/OIDC para Zenith, las pasarelas y los agentes. Ofrece
cuentas locales, LDAP/FreeIPA, proveedores OIDC, rotación de claves y un límite de intentos compartido.

## Decisión

Zenith no gestiona credenciales. `ZenithUserManagement` provee `user-routes`, `user-manager` y `authentication`, y
delega en engine-auth manteniendo la API de Parse Server.

- **`sessionToken`:** es un identificador opaco `r:<64 hex>`. En `_Session` se guardan:
  - su SHA-256, nunca el token;
  - el refresh token de engine-auth, sellado con AES-256-GCM. La clave es `engineAuth.sessionKey` y el AAD es el
    hash de la sesión;
  - la identidad del último access token verificado y su caducidad.
- **Cada petición** se responde desde `_Session`, con 5 s de caché por instancia como hace Parse.
- **El refresh** ocurre cuando caduca el access token, que dura 15 min por defecto. Lo hace una sola instancia, bajo
  un lease con `updateIf`. Si dos instancias presentaran el mismo refresh token, engine-auth lo tomaría como robo y
  cerraría la sesión.
- **Los access tokens de otros servicios** (`Authorization: Bearer`) se verifican en local por FFI
  (`@zuccadev-labs/zutool-ffi`, `auth.verify`) con la JWKS en caché. Se comprueban el emisor, la audiencia, el
  `typ at+jwt`, la caducidad y el algoritmo de la clave.
- **`_User`** es el perfil Parse y se indexa por el `sub` de engine-auth (`objectId = sub`), así que los ACL y los
  punteros siguen funcionando. No guarda contraseña. Se crea en el primer contacto, también para las cuentas de LDAP
  y OIDC.
- **`ctx.auth`** ahora lleva además `groups` (LDAP/FreeIPA), `scope`, `clientId`, `sessionId`, `actor` (RFC 8693)
  y `via`.
- **Zenith envía la IP real** del usuario en `X-Forwarded-For`, y engine-auth solo la acepta de las direcciones de
  `trustedProxies`. Así un atacante no bloquea a todos los usuarios de Zenith.
- **Se cierra en caso de fallo:**
  - con una configuración mala, el servidor no arranca;
  - sin configuración, las rutas responden 503;
  - si engine-auth no responde, la petición queda anónima pero la sesión no se borra;
  - si engine-auth rechaza el refresh (`invalid_grant`), la sesión se borra.
- **No se aceptan credenciales en la URL:** `GET /login` responde 405 (OWASP).
- **Recuperación de contraseña y verificación de correo:** responden 501 hasta que engine-auth las tenga. El MFA
  no expone rutas, porque las rutas del trait anterior se retiraron. No se mantienen funciones de seguridad a
  medias.

## Configuración

```jsonc
"engineAuth": {
  "issuer": "https://auth.example.com",      // iss de los tokens
  "url": "http://engine-auth:8470",          // opcional: dirección interna
  "clientId": "zenith",                      // cliente firstParty en engine-auth
  "audience": "https://api.example.com",     // aud que deben llevar los tokens
  "sessionKey": "<32 bytes en base64>",      // la misma en todas las instancias
  "libDir": "/opt/zutool/lib",               // libzutool_auth (o $ZUTOOL_LIB_DIR)
  "provider": "local"                        // o el id de un proveedor LDAP
}
```

En engine-auth:
- el cliente necesita `"firstParty": true` y la audiencia en `audiences`;
- las direcciones de Zenith van en `trustedProxies`.

El proceso necesita `--allow-ffi`.

## Consecuencias

- Hay un solo sitio para las contraseñas, el bloqueo y el MFA futuro. Las mejoras de engine-auth (passkeys, TOTP,
  DPoP) llegan a Zenith sin reescribir nada.
- El adaptador de base de datos necesita `updateIf`. Mongo lo tiene y ahora lo expone en `database-crud`. Scylla
  no lo tiene, así que las sesiones no funcionan sobre él: el arranque falla con un error claro.
- Revocación: un logout llega a las demás instancias en 5 s como máximo. Una cuenta deshabilitada en engine-auth
  deja de funcionar al siguiente refresh, en 15 min como máximo.
- Pruebas: `tests/integration/engine-auth.test.ts` usa el binario real de engine-auth y su librería FFI, y corre
  en memoria o sobre MongoDB (`ZENITH_TEST_MONGO`; probado con MongoDB 9.0.4).
