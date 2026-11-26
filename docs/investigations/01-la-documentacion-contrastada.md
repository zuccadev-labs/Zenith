---
description: "Notas de la revisión de la documentación contra el código del 2026-11-26: lo que no coincidía, lo que arreglé y lo que queda."
tipo: investigacion
---

# ¿Cuánto se parecía la documentación al código?

Menos de lo que creía. El 2026-11-26 pasé la documentación de MkDocs a zudocs y, de paso, la contrasté documento
por documento con el código. La auditoría del 2026-11-10 ya había marcado los documentos que no coincidían; esta
vez fui a las cifras, las rutas y los comandos concretos, y encontré fallos que no eran de documentación.

## Cómo lo comprobé

- **Rutas:** regeneré la especificación con el motor local (`generateProjectOpenApi`, sin `zen.config.ts`) y la
  comparé, método y ruta, con la versionada.
- **Comandos de `zen`:** la tabla que compone `zenith-cli/commands/registry.ts`, comparada con la ayuda y con el
  README del CLI.
- **Piezas y errores:** `FEATURE_CATALOG` de `traits/catalog.ts` y `ZenithErrorCode` de `core/errors.ts`, frente a
  lo que contaban los documentos.
- **Paquetes:** la versión de cada manifiesto, y los registros de JSR y npm para saber qué está publicado.
- **Afirmaciones de comportamiento:** leyendo el código de cada ruta citada. Donde no ejecuté nada lo digo abajo.

Todo lo que se puede comprobar sin un servidor quedó en `tools/docs-coverage.ts`, que corre en el CI.

## Lo que no coincidía

| Qué encontré | Qué hice |
|---|---|
| La referencia de la API tenía 234 rutas; el motor monta 241. Faltaban `GET /sessions/me`, las cuatro de `/zen/cells` y las dos de mensajes de sesiones de agentes | La regeneré. Con el motor local y con el publicado sale idéntica |
| Los documentos decían 234 rutas por defecto y 278 con todas las piezas | Son 241 y 285. La comprobación falla ahora si una cifra se desvía |
| El README decía que ningún paquete estaba publicado | Los cuatro están publicados desde el 2026-11-19 |
| La ayuda de `zen generate` anunciaba `openapi \| docs \| postman` | El comando acepta `docs \| openapi \| schema \| sdk`. Corregí la ayuda |
| La guía de pruebas decía que el CI no ejecuta las pruebas con engine-auth | Las ejecuta el trabajo `e2e-engine-auth`, con `ZUTOOL_E2E=true` |
| El documento de pendientes daba por roto `updatedAt` en MongoDB, por no publicados los paquetes y por manual el CI | Los tres ya no eran ciertos; pasaron al archivo del documento con su motivo |
| Seis enlaces `file:///` con la ruta de una unidad local, y una sección que nombraba carpetas privadas de mi equipo | Enlaces relativos, y la sección fuera. El repositorio es público |

## Lo que no era de documentación

Al comprobar lo que contaban los documentos de uso aparecieron fallos del código. Están en
[Lo que falta](../development/10-lo-que-falta.md#prioridad-alta), arriba del todo.

| Qué | Por qué importa |
|---|---|
| LiveQuery: `mod.ts` busca `engine["realtime-pubsub"].handleWebSocket` y ningún trait provee esa capacidad | Un cliente de Parse que use LiveQuery recibe el código 107 al conectar |
| La sala de medios del SDK de cliente abre `/media/<sala>` y ningún trait implementa `handleWebSocket` | `useZenithMedia` no conecta con nada |
| Una API key que pasa su límite por minuto deja de autenticar y la petición sigue como anónima | La respuesta parece un fallo de credenciales, no un 429 |
| Sin `RUSTFS_ACCESS_KEY` ni `RUSTFS_SECRET_KEY`, el cliente S3 usa `admin`/`admin` | Unas credenciales conocidas en producción |
| `ZenithFile.save()` sube con la sesión del usuario y `/files` solo acepta la master key | Subir un archivo desde el SDK de cliente falla |
| `tests/load/scenarios/push.js` llama a `/installations`, `/push` y `/push_audiences` | No existen; el escenario no puede pasar |

No arreglé ninguno de estos: son cambios de comportamiento y cada uno merece su prueba. Lo dejé documentado tal
como es hoy, en los documentos de uso y en la lista de pendientes.

## El sitio

zudocs compila la documentación sin enlaces ni anclas rotos. Al revisar la salida vi que el build escribía rutas
absolutas de mi equipo en el JavaScript del sitio (`source: "@site/../../…"`), porque la documentación vive fuera
de la carpeta de la plantilla. Es un fallo de zudocs; lo avisé y lo corrige la 0.5 de zuix. Hasta entonces no
publico el sitio compilado.

Los dos avisos que quedan de `verify` (`url` e `image`) se van cuando el sitio tenga una dirección pública.

## Lo que no he comprobado

- Los fallos de LiveQuery, de la sala de medios, del límite por key y de `ZenithFile.save` los vi leyendo el
  código, no ejecutándolo. Lo siguiente es escribir la prueba que los reproduzca.
- Las rutas de `e2eeMedia` con la pieza encendida.
- Que una base de datos de Parse Server funcione tal cual contra Zenith.
- Los documentos del laboratorio (Proxmox, Packer, DNS): comprobé que los nombres de la zona coinciden con
  `zen.ll.zone`, pero no recreé el laboratorio.
- Las ADR de 002 a 008: las clasifiqué como aceptadas porque el código que describen existe, sin revisarlas línea a
  línea.
