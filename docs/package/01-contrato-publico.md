---
description: "Qué exporta cada paquete publicado de Zenith y qué cuenta como cambio incompatible."
tipo: referencia
---

# ¿Qué exporta cada paquete y qué cuenta como cambio incompatible?

Lo que está en `exports` de su manifiesto y nada más: un archivo que no aparece ahí no es parte del paquete aunque
se pueda importar desde el repositorio.

## Resumen

| Paquete | Entrada | Contenido |
|---|---|---|
| `@zuccadev-labs/zenith` | `.` | `Zen` (Cloud, DB, Config, Logger, Shell, App…), `createZenithApp(config)`, `selectTraits`, los traits de negocio y los adaptadores |
| | `./openapi` | `generateProjectOpenApi(config)`: la especificación de un proyecto sin arrancarlo |
| | `./plugin-signing` | Firma Ed25519 de plugins y almacén de confianza, el que usa `zen plugin` |
| `@zuccadev-labs/zenith-cli` | `.` | `main(argv, binary)` y la tabla de comandos, para incrustar el CLI |
| | `./zen` | El ejecutable `zen` |
| `@zuccadev-labs/zenith-client` | `.` | `Zenith`, `ZenithObject`, `ZenithQuery`, `ZenithUser`, `ZenithFile`, `ZenithCloud`, `ZenithError` y los módulos de negocio |
| | `./react` | `ZenithProvider`, `useZenithUser`, `useZenithQuery`, `useZenithFile`, `useZenithMedia` |
| `@zuccadev-labs/create-zenith` | `bin` | `create-zenith`, que comprueba Deno y llama a `zen init` |

## Valores y restricciones

- Las cuatro versiones están por debajo de 1.0. Según SemVer, una versión menor (`0.2` → `0.3`) puede romper la
  compatibilidad; cuando lo haga, el `CHANGELOG.md` lo dice en «Changed» o «Removed».
- Además de los `exports`, son contrato la API HTTP que documenta la OpenAPI de cada servidor y los códigos de
  `ZenithErrorCode` ([Errores](../users/09-errores.md)): un cliente de Parse depende de ellos.
- `zen init` escribe `"@zuccadev-labs/zenith": "jsr:@zuccadev-labs/zenith@^<ENGINE_VERSION>"`. Subir la versión
  menor del motor sin subir `ENGINE_VERSION` en `zenith-cli/zen.ts` deja los proyectos nuevos en la anterior.

## Ver también

- [Publicación](./README.md).
- `tools/docs-coverage.ts` falla si una entrada de `exports` no aparece en el README de su paquete ni en `docs/users`.
