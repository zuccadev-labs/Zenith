---
description: "Dónde está la especificación OpenAPI de Zenith, cómo se genera y cómo se lee el acceso de cada ruta."
tipo: referencia
---

# ¿Qué rutas expone un servidor y dónde está su especificación?

Cada servidor sirve su propia especificación en `/openapi.json` y la muestra en `/swagger`. Documenta exactamente
las rutas que ha montado su router, con las piezas que tenga encendidas. La de este sitio es la de un proyecto con
las piezas por defecto: 241 rutas.

## Resumen

| Formato | Dónde |
|---|---|
| Portal Redoc | [API (Redoc)](pathname:///reference/index.html) |
| OpenAPI 3.1 | [openapi.json](pathname:///reference/openapi.json) |
| Colección de Postman | [zenith.postman.json](pathname:///reference/zenith.postman.json) |
| Markdown por sección | [api/](pathname:///reference/README.md), un archivo por etiqueta (44) |

En un servidor en marcha: `http://localhost:1337/openapi.json` y `http://localhost:1337/swagger`.

## Generarla

```bash
zen generate docs                     # openapi.json, api/*.md, zenith.postman.json e index.html en ./docs
zen generate openapi --out spec.json  # solo la especificación
zen generate schema                   # los esquemas registrados
```

Dentro de un proyecto, `zen generate` lee `features` y `topology` de `zen.config.ts`, así que documenta las rutas
de ese proyecto. Fuera de un proyecto usa las piezas por defecto y lo avisa. No arranca el servidor ni necesita
base de datos: compone los traits y lee sus rutas (`zenith-backend/src/openapi.ts`).

La de este sitio se regenera desde una carpeta sin `zen.config.ts`:

```bash
zen generate docs --out site/static/reference --app-id miapp
```

`tools/docs-coverage.ts` falla si la versionada no coincide con la que genera el motor.

## El acceso de cada ruta

La `security` de cada operación dice quién puede llamarla ([Acceso y API keys](./04-acceso-y-api-keys.md)):

| `security` | Acceso |
|---|---|
| `masterKey` | `master`: la master key, desde localhost |
| `sessionToken`, `apiKeyBearer`, `apiKeyHeader`, `jwtRs256` | `user`: una sesión, un token de engine-auth o una API key con el scope de la ruta |
| vacía | `public` |

Con las piezas por defecto, de las 241 rutas, 219 son `master`, 7 son `user` y 15 son públicas. Que haya tan pocas
`user` es deliberado: denegar por defecto y abrir ruta por ruta
([ADR-013](../investigations/adr/13-composition-and-access.md)).

## Ver también

- [Cómo se genera la OpenAPI](../development/03-openapi.md), por dentro.
- [Errores](./09-errores.md).
