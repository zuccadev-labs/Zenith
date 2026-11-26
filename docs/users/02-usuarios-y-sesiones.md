---
description: "Registro, login y sesiones con las rutas de Parse Server, respaldadas por engine-auth."
tipo: guia
---

# ¿Cómo se registran e inician sesión los usuarios?

Con las rutas de Parse Server (`POST /users`, `POST /login`, `POST /logout`, `GET /users/me`) o con `ZenithUser` del
SDK de cliente. Por debajo, quien decide quién eres es engine-auth: Zenith no guarda contraseñas.

## Requisitos

- Un engine-auth en marcha, con un cliente de primera parte registrado (`firstParty: true`).
- `engineAuth` en `zen.config.ts`. Sin esa configuración, todas las rutas de usuario responden 503 y cualquier
  token se trata como anónimo. Lo decidí así para que un servidor no arranque a medio proteger
  ([ADR-012](../investigations/adr/12-engine-auth.md)).

```ts
// zen.config.ts
export default {
  appId: "miapp",
  engineAuth: {
    issuer: "https://auth.example.com",   // iss de los tokens
    url: "http://engine-auth:8470",       // si Zenith lo alcanza por otra dirección
    clientId: "zenith-miapp",
    audience: "https://api.example.com",  // los tokens deben traerlo en aud
    sessionKey: Deno.env.get("ZENITH_SESSION_KEY")!, // 32 bytes aleatorios, base64; igual en todas las instancias
    // provider: "local" (por defecto) o el id de un proveedor LDAP de engine-auth
    // sessionLength: segundos; por defecto 90 días, el máximo de engine-auth
  },
};
```

`libDir` apunta a la carpeta de `libzutool_auth` si no está en `$ZUTOOL_LIB_DIR`: Zenith verifica los tokens de
acceso en local, por FFI, contra el JWKS en caché.

## Pasos

1. **Registrar** un usuario:

   ```bash
   curl -X POST http://localhost:1337/users \
     -H "X-Parse-Application-Id: miapp" -H "Content-Type: application/json" \
     -d '{"username":"alice","password":"a-long-passphrase","email":"alice@example.com"}'
   ```

   Responde 201 con `objectId`, `createdAt` y `sessionToken`, como Parse Server. La cuenta se crea en engine-auth y el perfil en `_User`, con
   `objectId` igual al `sub` de engine-auth, así que las ACL y los punteros siguen funcionando.

2. **Iniciar sesión**, con nombre de usuario o email:

   ```bash
   curl -X POST http://localhost:1337/login \
     -H "X-Parse-Application-Id: miapp" -H "Content-Type: application/json" \
     -d '{"username":"alice","password":"a-long-passphrase"}'
   ```

   `GET /login` responde 405: las credenciales no se aceptan en la URL, porque acaban en los logs de acceso y en
   el historial del navegador. Los SDK de Parse ya usan `POST`.

3. **Usar la sesión** en cada petición, con `X-Parse-Session-Token: r:…` o `Authorization: Bearer r:…`.
   `GET /users/me` devuelve el usuario y `GET /sessions/me`, la sesión.

4. **Cerrar sesión** con `POST /logout`. Termina también la sesión en engine-auth.

Desde el SDK de cliente:

```ts
import { Zenith, ZenithUser } from "@zuccadev-labs/zenith-client";

Zenith.initialize({ appId: "miapp", serverURL: "http://localhost:1337" });

const user = new ZenithUser();
user.username = "alice";
user.email = "alice@example.com";
user.password = "a-long-passphrase";
await user.signUp();

await ZenithUser.logIn("alice", "a-long-passphrase");
ZenithUser.current();               // el usuario guardado en el almacenamiento del SDK
await ZenithUser.become(token);     // retomar una sesión por su token
await ZenithUser.logOut();
```

En React, `useZenithUser` de `@zuccadev-labs/zenith-client/react`.

## Cómo funciona la sesión

- El `sessionToken` (`r:` y 64 caracteres hexadecimales) es un identificador opaco. `_Session` solo guarda su
  SHA-256, el refresh token de engine-auth sellado con AES-256-GCM (`sessionKey`) y la identidad del último token
  de acceso verificado. Un cliente de Parse nunca ve un token de engine-auth.
- Mientras el token de acceso está vigente (15 minutos por defecto), una petición se resuelve desde `_Session`, con
  una caché de 5 s por instancia, como hace Parse Server. Después, una sola instancia lo renueva bajo un
  arrendamiento (`updateIf`), para que dos peticiones simultáneas no presenten el mismo refresh token: engine-auth lo
  tomaría como un robo y cerraría la sesión.
- Una cuenta revocada o desactivada deja de funcionar en la siguiente renovación.
- Un servicio o agente del ecosistema puede llamar con `Authorization: Bearer <token de acceso>` de engine-auth. Se
  comprueban emisor, audiencia, `typ: at+jwt`, caducidad y algoritmo de la clave.

## Triggers de login

`Zen.Cloud.beforeLogin`, `afterLogin`, `beforeLogout` y `afterLogout` se ejecutan.

- `beforeLogin` corre después de comprobar las credenciales y antes de crear la sesión. Si rechaza el login, se
  revoca también lo que engine-auth ya había emitido.
- El logout no se bloquea nunca.

## Lo que todavía no funciona

| Qué | Respuesta | Por qué |
|---|---|---|
| `POST /requestPasswordReset` (`ZenithUser.requestPasswordReset`) | 501 | engine-auth aún no tiene recuperación de contraseña |
| `POST /verificationEmailRequest` (`ZenithUser.requestEmailVerification`) | 501 | Lo mismo con la verificación de email |
| MFA | No existe | Pendiente en engine-auth |

Preferí que respondan 501 a que funcionen a medias. `ZenithUser.verifyEmail` y `ZenithUser.linkWith` existen en el
SDK de cliente, pero no he comprobado que el servidor los atienda.

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| 503 en `/users` o `/login` | Falta `engineAuth` en `zen.config.ts` | Configurarlo y reiniciar |
| 405 en `/login` | Se mandó con `GET` | `POST` con las credenciales en el cuerpo |
| 429 en `/login` o en `POST /users` | Más de 10 intentos por minuto desde la misma IP | Esperar; es la protección contra fuerza bruta ([Acceso y API keys](./04-acceso-y-api-keys.md#límites-de-peticiones)) |

## Relacionado

- [ADR-012](../investigations/adr/12-engine-auth.md): por qué los usuarios viven en engine-auth.
- [Acceso y API keys](./04-acceso-y-api-keys.md).
- Código: `zenith-backend/src/traits/auth/engine-auth.ts`.
