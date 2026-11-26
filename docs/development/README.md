---
description: "Cómo se mantiene Zenith: piezas por dentro, pruebas, OpenAPI, métricas, cadena de suministro, registro y laboratorio."
---

# Desarrollo

Para quien trabaja en el código de Zenith: cómo está hecho por dentro, cómo se prueba y cómo se opera el
laboratorio.

## Trabajar en el repositorio

| Carpeta | Contenido |
|---|---|
| `zenith-backend/` | El motor: traits, pipeline de seguridad y adaptadores |
| `zenith-cli/` | `zen` |
| `create-zenith/` | `npm create @zuccadev-labs/zenith` |
| `sdk/Typescript/` | El SDK de cliente y un ejemplo con Vite y React |
| `site/` | La configuración de este sitio (`zudocs.config.json`) y la referencia de la API generada |
| `tools/` | `docs-coverage.ts`, el simulacro de recuperación (`dr-drill/`) y la cadena de suministro (`supply-chain/`) |
| `lab-infra/`, `k8s/`, `infra/`, `observability/` | Laboratorio, chart de Helm, registro e infraestructura |

## Documentos

| Documento | Pregunta que responde |
|---|---|
| [Piezas por dentro](./01-piezas-por-dentro.md) | ¿Cómo añado una pieza al motor o acoplo un motor externo? |
| [Pruebas](./02-pruebas.md) | ¿Cómo se prueba Zenith y qué cubre el CI? |
| [OpenAPI](./03-openapi.md) | ¿Cómo se genera la especificación de la API? |
| [Métricas](./04-metricas.md) | ¿Qué métricas expone el motor y qué alertas hay? |
| [Cadena de suministro](./05-cadena-de-suministro.md) | ¿Cómo se analizan, firman y atestiguan las imágenes? |
| [Registro de imágenes](./06-registro-de-imagenes.md) | ¿Cómo funciona el registro propio (Zot)? |
| [Laboratorio](./07-laboratorio.md) | ¿Cómo se recrea el laboratorio desde cero? |
| [DNS del laboratorio](./08-dns-del-laboratorio.md) | ¿Cómo se configura el DNS del laboratorio? |
| [Rendimiento](./09-rendimiento.md) | ¿Qué se ha medido del rendimiento? |
| [Lo que falta](./10-lo-que-falta.md) | ¿Qué falta o falla, y con qué prioridad? |

## Documentación

Este sitio se compila con zudocs desde una copia de zuix:

```bash
node <zuix>/zudocs/bin/zudocs.mjs verify --strict --config site/zudocs.config.json
node <zuix>/zudocs/bin/zudocs.mjs build --config site/zudocs.config.json
deno run -A --unstable-kv --config zenith-cli/deno.json tools/docs-coverage.ts
```

`docs-coverage.ts` también corre en el CI. Falla si la referencia de la API está desfasada, si un comando de `zen`,
una pieza del catálogo o un código de error no están documentados, si una versión no coincide o si un documento
lleva una ruta local.

## Archivo

[El archivo](./archivo/README.md) guarda los runbooks, el modelo de amenazas, los documentos de cumplimiento y las
auditorías que describían un servicio alojado o un código que ya no existe.
