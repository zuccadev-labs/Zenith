---
description: "Qué es Zenith, qué paquetes tiene y por dónde empezar a usarlo."
---

# Usar Zenith

Zenith es un backend como servicio para Deno, compatible con los SDK de Parse Server. Cada capacidad del motor es
un trait de [barrits](https://jsr.io/@zuccadev-labs/barrits) que se enciende o se apaga en la configuración del
proyecto. Aquí está lo necesario para crear un backend con `zen`, hablar con él desde una app y consultar su API.

## Servidor y cliente

Son dos cosas distintas y conviene no mezclarlas.

| | SDK de servidor | SDK de cliente |
|---|---|---|
| Para qué | Crear y ejecutar tu backend | Que una app (web, móvil, IoT) hable con un backend en marcha |
| Paquetes | `@zuccadev-labs/zenith` (el motor) y `@zuccadev-labs/zenith-cli` (el comando `zen`), en JSR; `@zuccadev-labs/create-zenith` en npm | `@zuccadev-labs/zenith-client`, en npm |
| Dónde corre | Deno 2.4 o posterior | Navegador, Node, Deno y React |
| Crea proyectos | Sí, con `zen init` | No |

En `sdk/` del repositorio solo está hecho el SDK de TypeScript. Las carpetas de Android, Apple, Dart, Flutter,
.NET, PHP y Swift están vacías, y `sdk/arduino` solo trae una cabecera MQTT (`ZenithIoT.h`).

## Documentos

| Documento | Pregunta que responde |
|---|---|
| [Primeros pasos](./01-primeros-pasos.md) | ¿Cómo levanto un servidor y le hablo desde una app? |
| [Usuarios y sesiones](./02-usuarios-y-sesiones.md) | ¿Cómo se registran e inician sesión los usuarios? |
| [Archivos](./03-archivos.md) | ¿Cómo subo, sirvo y comparto archivos? |
| [Acceso y API keys](./04-acceso-y-api-keys.md) | ¿Quién puede llamar a cada ruta y con qué credencial? |
| [Piezas y motores](./05-piezas-y-motores.md) | ¿Qué piezas tiene el motor y cómo se encienden? |
| [Webhooks y Cloud Code Hooks](./06-webhooks-y-hooks.md) | ¿Cómo aviso a otros sistemas y cómo dejo que una URL externa resuelva Cloud Code? |
| [Celdas](./07-celdas.md) | ¿Dónde guardo el estado que pertenece a una sola cosa? |
| [Referencia de la API](./08-referencia-de-la-api.md) | ¿Qué rutas expone un servidor y dónde está su especificación? |
| [Errores](./09-errores.md) | ¿Qué significa cada código de error? |
| [Migrar desde Parse Server](./10-migrar-desde-parse-server.md) | ¿Qué funciona igual que en Parse Server y qué cambia? |
| [Medios en tiempo real](./11-medios-en-tiempo-real.md) | ¿Qué hay hoy de vídeo, audio y streaming? |
| [El comando zen](./12-cli-zen.md) | ¿Qué hace cada comando de `zen`? |

Lo que falta o falla, con su prioridad, está en [Lo que falta](../development/10-lo-que-falta.md). Los documentos
que describían un servicio alojado que no existe están en [el archivo](./archivo/README.md).

## Para agentes

La guía está en [Agentes](../agents/README.md).
