---
description: "ADR-018 — Los avisos a personas salen por engine-push (zutool), por su socket."
tipo: adr
estado: aceptada
---

# ADR-018 — Los avisos a personas salen por engine-push (zutool), por su socket

> **Estado:** Aceptada
> **Fecha:** 2026-11-15
> **Relacionado:** `zenith-backend/src/traits/push/engine-push.trait.ts`, `src/traits/push/engine-push-client.ts`,
> `src/traits/push/push.trait.ts`, `src/traits/notifications/notifications.trait.ts`,
> `tests/unit/engine-push.test.ts`; en zutool, `docs/development/engine-push.md`

## Contexto

`ZenithPush` registraba dispositivos, pero `send()` solo escribía `_PushDelivery`: no enviaba nada. En el
ecosistema, **engine-push** es el daemon que entrega todo aviso a personas (ntfy, Web Push, FCM, APNs, Telegram,
Slack, email) con las suscripciones selladas. El hub, Zenith y zagent lo llaman igual: por su socket Unix.

## Decisión

- **`ZenithEnginePush`** (feature `enginePush`, activa por defecto) provee la capacidad `enginePush`: cliente
  JSON-RPC por líneas sin dependencias, sobre `config.enginePush.socket`, o la convención de zutool
  (`ENGINE_PUSH_SOCKET`, `$XDG_RUNTIME_DIR/zutool/engine-push.sock`). Nunca arranca engine-push.
- **Titulares:**
  - un usuario es `zenith:<appId>:<userId>`;
  - una instalación de Parse es `zenith:<appId>:installation:<id>`.
- **`ZenithPush`** (`uses:enginePush`): `send` deja una suscripción `fcm`/`apns` por instalación, con la huella
  del token como nombre (el patrón de `PushRelay` de engine-kit), y hace `push/send`. El resultado conserva
  `sent` y `deliveryLog`; añade `via`, `delivered` y `ok`/`error` por instalación.
- **`ZenithNotifications`** (`uses:enginePush`): cada notificación in-app también va, sin esperar, a las
  suscripciones del usuario en engine-push.
- **Sin engine-push** (socket que no contesta, o `enabled: false`), todo se comporta como antes: `ZenithPush` solo
  registra la entrega (`via: "none"`) y `ZenithNotifications` se queda en in-app.

## Consecuencias

- Las pruebas usan un engine-push falso en un socket temporal. Si está el binario de zutool (`ENGINE_PUSH_BIN`),
  también el real, con un tema ntfy local.
- Queda pendiente:
  - rutas para que un usuario gestione sus propias suscripciones (hoy, desde Cloud Code con `enginePush.subscribe`);
  - el correo transaccional (restablecer la contraseña y verificar el correo), que sigue en el adaptador de Postal,
    porque necesita HTML y remitente propio.
