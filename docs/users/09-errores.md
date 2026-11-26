---
description: "Los códigos de error del motor: los de Parse Server y los rangos propios de Zenith."
tipo: referencia
---

# ¿Qué significa cada código de error?

Un error llega como `{ "code": <número>, "error": "<mensaje>" }` con un estado HTTP acorde. Los códigos por debajo
de 300 son los de Parse Server, con el mismo número; del 300 en adelante son rangos propios de Zenith. Están en
`ZenithErrorCode`, en `zenith-backend/src/core/errors.ts`, y el SDK de cliente exporta el mismo enum.

## Resumen

```json
{ "code": 142, "error": "title is required" }
```

```ts
import { ZenithError, ZenithErrorCode } from "@zuccadev-labs/zenith-client";

try {
  await todo.save();
} catch (e) {
  if (e instanceof ZenithError && e.code === ZenithErrorCode.VALIDATION_ERROR) { /* … */ }
}
```

## Parse Server: API (1 y 100 a 299)

| Nombre | Código | Significado |
|---|---|---|
| `INTERNAL_SERVER_ERROR` | 1 | Error interno: una excepción sin tratar o un fallo de infraestructura |
| `CONNECTION_FAILED` | 100 | No se pudo conectar con el backend |
| `OBJECT_NOT_FOUND` | 101 | El objeto o la sesión no existe, o no tienes permiso de lectura |
| `INVALID_QUERY` | 102 | Restricción o parámetro de consulta mal formado |
| `INVALID_CLASS_NAME` | 103 | Nombre de clase no válido: empieza por letra y solo lleva letras, números o guion bajo |
| `MISSING_OBJECT_ID` | 104 | La operación necesita un `objectId` |
| `INVALID_KEY_NAME` | 105 | Nombre de campo no válido |
| `INVALID_POINTER` | 106 | Puntero mal formado |
| `INVALID_JSON` | 107 | JSON mal formado en el cuerpo |
| `COMMAND_UNAVAILABLE` | 108 | La operación solo está disponible internamente |
| `NOT_INITIALIZED` | 109 | El SDK no se inicializó antes de usarlo |
| `INCORRECT_TYPE` | 111 | El tipo no coincide con el esquema |
| `INVALID_CHANNEL_NAME` | 112 | Nombre de canal no válido |
| `PUSH_MISCONFIGURED` | 113 | Faltan credenciales de push |
| `OBJECT_TOO_LARGE` | 116 | El objeto supera el tamaño máximo |
| `INVALID_LIMIT_ERROR` | 117 | `limit` no válido |
| `INVALID_SKIP_ERROR` | 118 | `skip` no válido |
| `OPERATION_FORBIDDEN` | 119 | Lo impiden los CLP o las ACL. También lo usa una URL firmada inválida o caducada |
| `CACHE_MISS` | 120 | El elemento no está en la caché |
| `INVALID_NESTED_KEY` | 121 | Operación no válida sobre un campo anidado |
| `INVALID_FILE_NAME` | 122 | Nombre de archivo no válido |
| `INVALID_ACL` | 123 | ACL mal formada |
| `TIMEOUT` | 124 | La operación superó su tiempo máximo |
| `INVALID_EMAIL_ADDRESS` | 125 | Email con formato no válido |
| `FILE_SAVE_ERROR` | 130 | No se pudo guardar el archivo |
| `DUPLICATE_VALUE` | 137 | Se violó una restricción de unicidad |
| `INVALID_ROLE_NAME` | 139 | Nombre de rol no válido |
| `EXCEEDED_COLLECTION_QUOTA` | 140 | Se alcanzó el máximo de clases |
| `SCRIPT_FAILED` | 141 | Falló una función de Cloud Code o un trigger |
| `VALIDATION_ERROR` | 142 | Falló una validación: un validador de `Zen.Cloud` o un error lanzado en un trigger `before*` |
| `WEBHOOK_ERROR` | 143 | Falló un Cloud Code Hook |
| `INVALID_IMAGE_DATA` | 150 | Imagen no reconocida |
| `UNSAVED_FILE_ERROR` | 151 | Se adjuntó un archivo sin guardar |
| `INVALID_PUSH_TIME_ERROR` | 152 | Hora de envío de push no válida |
| `FILE_DELETE_ERROR` | 153 | No se pudo borrar el archivo |
| `REQUEST_LIMIT_EXCEEDED` | 155 | Límite de peticiones superado (429) |
| `INVALID_EVENT_NAME` | 160 | Nombre de evento no válido |
| `CLASS_NOT_EMPTY` | 255 | No se borra una clase que tiene objetos |

## Parse Server: usuarios y sesiones (200 a 212)

| Nombre | Código | Significado |
|---|---|---|
| `USERNAME_MISSING` | 200 | Falta el nombre de usuario |
| `PASSWORD_MISSING` | 201 | Falta la contraseña |
| `USERNAME_TAKEN` | 202 | El nombre de usuario ya existe |
| `EMAIL_TAKEN` | 203 | El email ya está en otra cuenta |
| `MISSING_EMAIL` | 204 | Falta el email |
| `AUTH_DATA_ERROR` | 205 | `authData` de un proveedor externo no válida |
| `SESSION_MISSING` | 206 | La ruta necesita una sesión |
| `MUST_CREATE_USER` | 207 | El usuario tiene que existir antes |
| `ACCOUNT_ALREADY_LINKED` | 208 | El proveedor externo ya está vinculado a otra cuenta |
| `INVALID_SESSION_TOKEN` | 209 | Token de sesión caducado, revocado o no válido |
| `MFA_REQUIRED` | 210 | Hace falta un segundo factor |
| `ACCOUNT_LOCKED` | 211 | Cuenta bloqueada |
| `UNAUTHORIZED` | 212 | Petición no autorizada |

## Zenith: LiveQuery (300 a 349)

| Nombre | Código | Significado |
|---|---|---|
| `LIVEQUERY_SOCKET_CLOSED` | 300 | Se cerró el WebSocket de LiveQuery |
| `LIVEQUERY_SUBSCRIPTION_ERROR` | 301 | No se pudo suscribir a la consulta |
| `LIVEQUERY_UNAUTHORIZED` | 302 | Sin permiso para suscribirse a esa consulta |
| `LIVEQUERY_QUOTA_EXCEEDED` | 303 | Demasiadas suscripciones en la conexión |

## Zenith: medios (350 a 399)

| Nombre | Código | Significado |
|---|---|---|
| `STREAM_NOT_FOUND` | 350 | El stream no existe |
| `STREAM_CODEC_UNSUPPORTED` | 351 | Códec no soportado |
| `STREAM_QUOTA_EXCEEDED` | 352 | Sala llena |
| `RECORDING_FAILED` | 353 | Falló la grabación |
| `SFRAME_KEY_NEGOTIATION_FAILED` | 354 | Se rechazó la negociación de claves E2EE |
| `MEDIA_UNAUTHORIZED` | 355 | Sin permiso para entrar o emitir en la sala |

## Zenith: LDAP y OAuth (400 a 449)

| Nombre | Código | Significado |
|---|---|---|
| `LDAP_CONNECTION_FAILED` | 400 | No se pudo conectar con el LDAP |
| `LDAP_BIND_FAILED` | 401 | Credenciales de bind de LDAP no válidas |
| `LDAP_USER_NOT_FOUND` | 402 | Usuario no encontrado en el LDAP |
| `OAUTH_PROVIDER_UNAVAILABLE` | 403 | El proveedor OAuth no responde |

## Zenith: composición de traits (500 a 599)

| Nombre | Código | Significado |
|---|---|---|
| `TRAIT_CONTRACT_VIOLATION` | 500 | Falta una capacidad obligatoria al componer |
| `TRAIT_CONFLICT` | 501 | Dos traits proveen la misma capacidad |
| `MISSING_PROVIDER` | 502 | Ningún trait provee una capacidad que se pidió |

## Zenith: shell y plugins (600 a 649)

| Nombre | Código | Significado |
|---|---|---|
| `SHELL_COMMAND_NOT_ALLOWED` | 600 | Comando de shell fuera de la lista permitida |
| `SHELL_EXECUTION_FAILED` | 601 | Falló el comando de shell |
| `PLUGIN_INITIALIZATION_ERROR` | 602 | Falló la inicialización de un plugin |

## Valores y restricciones

- El estado HTTP no es el código: un `VALIDATION_ERROR` responde 400 y un `REQUEST_LIMIT_EXCEEDED`, 429.
- `response.error(código, mensaje)` en Cloud Code responde 400 con ese código.
- El SDK de cliente no tiene todavía los tres códigos del rango 600 (`SHELL_COMMAND_NOT_ALLOWED`,
  `SHELL_EXECUTION_FAILED` y `PLUGIN_INITIALIZATION_ERROR`).
- Los rangos propios están definidos, pero hoy el motor solo emite unos pocos (los de shell, entre otros). No he
  revisado código por código cuáles llegan de verdad a un cliente.

## Ver también

- [Acceso y API keys](./04-acceso-y-api-keys.md#errores): 401, 403 y 429.
- [Webhooks y Cloud Code Hooks](./06-webhooks-y-hooks.md): errores de validadores y triggers.
