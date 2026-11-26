---
description: "Qué paquetes publica Zenith, en qué versión están y cómo se publica una nueva."
---

# Publicar Zenith

Zenith publica cuatro paquetes, cada uno con su propia versión. Los publica `.github/workflows/release.yml` desde
CI, sin tokens guardados: JSR y npm confían en ese flujo por OIDC de GitHub, y npm añade una atestación de
procedencia.

## Paquetes

| Paquete | Versión | Registro | Carpeta | Etiqueta de publicación |
|---|---|---|---|---|
| `@zuccadev-labs/zenith` | 0.2.0 | JSR | `zenith-backend/` | `zenith-v*` |
| `@zuccadev-labs/zenith-cli` | 0.3.0 | JSR | `zenith-cli/` | `zenith-cli-v*` |
| `@zuccadev-labs/zenith-client` | 0.2.0 | npm | `sdk/Typescript/` | `zenith-client-v*` |
| `@zuccadev-labs/create-zenith` | 0.1.0 | npm | `create-zenith/` | `create-zenith-v*` |

Las primeras versiones salieron el 2026-11-19. `tools/docs-coverage.ts` comprueba que esta tabla da la versión de
cada manifiesto.

## Publicar una versión

1. Subir la versión en el manifiesto del paquete (`deno.json` o `package.json`) y anotar el cambio en
   `CHANGELOG.md`.
2. Si cambia la versión del motor, cambiar también `ENGINE_VERSION` en `zenith-cli/zen.ts`: es la que `zen init`
   escribe en los proyectos nuevos.
3. Fusionar, crear la etiqueta y subirla:

   ```bash
   git tag zenith-client-v0.2.1 && git push origin zenith-client-v0.2.1
   ```

El trabajo comprueba que la versión de la etiqueta es la del manifiesto. Una versión ya publicada la rechaza el
registro, así que no se puede sobrescribir nada.

## Documentos

| Documento | Pregunta que responde |
|---|---|
| [Contrato público](./01-contrato-publico.md) | ¿Qué exporta cada paquete y qué cuenta como cambio incompatible? |
