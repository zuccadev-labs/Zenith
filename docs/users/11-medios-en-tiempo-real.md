---
description: "Lo que hay hoy de medios en Zenith: streams HLS, señalización SFrame, claves E2EE y la sala WebRTC del SDK, que aún no tiene servidor."
tipo: explicacion
---

# ¿Qué hay hoy de vídeo, audio y streaming?

Hay rutas de streams HLS y, con la pieza `e2eeMedia`, claves E2EE y salas SFrame. La sala WebRTC del SDK de cliente
(`ZenithMediaRoom`, `useZenithMedia`) todavía no tiene servidor que la atienda. No conviene construir una
videollamada sobre esto sin leer antes la última sección.

## Contexto

Quería que una app pudiera hacer llamadas cifradas de extremo a extremo con el mismo backend que guarda sus datos.
El diseño está a medias: hay piezas en el motor y en el SDK, pero no están conectadas entre sí.

## Cómo funciona

| Pieza | Qué expone | Acceso |
|---|---|---|
| `mediaStream` (encendida por defecto) | `POST /streams/:channelId/start`, `POST /streams/:channelId/stop`, `GET /streams/:channelId/manifest.m3u8` | `master` |
| `e2eeMedia` (apagada por defecto; `features.e2ee_media`) | `/e2ee/keys`, `/e2ee/keys/:userId`, `/sframe/rooms`, `/sframe/rooms/:roomId/join` | Las declara el trait |
| SDK de cliente | `ZenithMediaRoom` y, en React, `useZenithMedia({ roomId, userId, mode, audio, video })`. `mode` es `strict_sframe` (cifrado en el cliente) o `hop_by_hop` | Abre `ws://<servidor>/media/<sala>?appId=…` |
| Cloud Code | `Zen.Cloud.onStreamEvent`, `beforePublish`, `beforeWatch` | Se registran, pero no se ejecutan |

## Límites

- **La sala del SDK no conecta con nada.** El servidor entrega los WebSocket de `/media/` a
  `engine.handleWebSocket`, pero ningún trait lo implementa. Lo leí en el código (`zenith-backend/src/mod.ts` y
  `src/core/engine-api.ts`); no lo he probado con dos navegadores.
- **No hay SFU conectado.** La señalización SFrame existe como rutas, pero no hay un servidor de medios detrás.
- **Los triggers de medios no corren.** `onStreamEvent`, `beforePublish` y `beforeWatch` avisan en el log al
  registrarse.
- Las rutas de `e2eeMedia` no las he revisado con la pieza encendida.

Todo está anotado en [Lo que falta](../development/10-lo-que-falta.md). La versión anterior de este documento,
que describía un marco de medios completo, está en el [archivo](./archivo/04-medios-webrtc-original.md).

## Para seguir

- [Piezas y motores](./05-piezas-y-motores.md): encender `e2eeMedia`.
