---
description: "Reglas, patrones y verificación para un agente de IA que trabaja en el repositorio de Zenith."
tipo: agente
---

# ¿Cómo trabaja un agente de IA en Zenith?

Siguiendo estas reglas, con estos patrones, y dando un cambio por terminado solo cuando pasa la verificación de
abajo. La versión corta está en `AGENTS.md`, en la raíz.

## Qué leer antes de tocar nada

| Tarea | Lee | Contrato legible por máquina |
|---|---|---|
| Añadir o cambiar una pieza del motor | [Piezas por dentro](../development/01-piezas-por-dentro.md) | `zenith-backend/src/traits/catalog.ts` |
| Añadir o cambiar una ruta | [Acceso y API keys](../users/04-acceso-y-api-keys.md), [OpenAPI](../development/03-openapi.md) | La OpenAPI generada (`zen generate openapi`) |
| Añadir un comando de `zen` | [El comando zen](../users/12-cli-zen.md) | `zenith-cli/commands/registry.ts` |
| Cambiar un código de error | [Errores](../users/09-errores.md) | `zenith-backend/src/core/errors.ts` y `sdk/Typescript/src/core/ZenithError.ts` |
| Documentar | Este documento y la sección «Documentación» de abajo | `site/zudocs.config.json` |
| Publicar | [Publicación](../package/README.md) | `.github/workflows/release.yml` |

## Reglas

1. **Denegar por defecto.** Una ruta nueva sin `access` es `master`. Abrirla a usuarios exige comprobar los permisos
   de cada objeto en su handler y declarar un `scope` para las API keys
   ([ADR-013](../investigations/adr/13-composition-and-access.md)).
2. **Una pieza, una entrada del catálogo.** Nada se registra fuera de `catalog.ts`. Lo opcional se declara con
   `uses:<capacidad>`, nunca con `consumes`.
3. **Reutilizar lo que hay**: `core/crypto.ts` para aleatorios, hashes y HMAC; `security/outbound-http.ts` para
   peticiones salientes; `security/webhook-signature.ts` para firmas; el bus de eventos para publicar.
4. **Ningún secreto con valor por defecto en producción.** Si falta, el servidor falla al arrancar o lo avisa.
5. **Nada privado en lo versionado**: ni rutas absolutas, ni credenciales, ni nombres de proyectos privados.
6. **La documentación sigue al código.** Un cambio que añade una ruta, un comando, una pieza o un código de error
   regenera la referencia y actualiza su documento en el mismo commit. Un cambio visible va al `CHANGELOG.md`.
7. **No publicar.** Un agente no crea etiquetas de publicación ni ejecuta `deno publish` o `npm publish` sin
   `--dry-run`.

## Patrones

### Una ruta nueva

```ts
// en la capacidad <área>_routes de su trait
{
  method: "GET",
  path: "/zen/things/:id",
  access: "user",
  scope: "data:read",
  _openapi: { summary: "Get a thing", tags: ["Things"] },
  handler: async (req, ctx) => { /* comprobar ACL del objeto con ctx.user */ },
}
```

El router la monta, la OpenAPI la documenta y la prueba de paridad comprueba que coinciden. Después:
`zen generate docs --out site/static/reference --app-id miapp`, desde una carpeta sin `zen.config.ts`.

### Documentación

- En español, en `docs/`, por áreas: `users`, `agents`, `development`, `investigations` y `package`.
- Un documento responde una pregunta, que es su título `#`, seguido de un párrafo que la contesta.
- Nombre `NN-nombre.md`; `README.md` es la portada del área y lista sus documentos.
- Primera persona del mantenedor para decisiones («decidí», «lo dejé para después porque…»); impersonal directa
  para referencia e instrucciones. Nunca la voz de un asistente ni de un informe de trabajo.
- Lo que no se ha comprobado se dice. Lo que deja de estar vigente pasa a `archivo/` con una nota; no se borra.
- Los ejemplos de código, con la interfaz en inglés.
- Un ADR no se reescribe: se escribe otro y el anterior pasa a sustituido.

## Verificación

| Comando | Comprueba |
|---|---|
| `deno fmt --check src/ tests/`, `deno lint src/`, `deno check --frozen src/mod.ts` (en `zenith-backend/`) | Formato, lint y tipos del motor |
| `deno test --allow-all --no-check --unstable-kv --frozen tests/unit/` (en `zenith-backend/`) | Pruebas unitarias |
| `deno task test:integration` (en `zenith-backend/`) | Integración; necesita MongoDB ([Pruebas](../development/02-pruebas.md)) |
| `deno test --allow-all --no-check --unstable-kv --frozen` (en `zenith-cli/`) | El CLI, con `zen init` y `zen dev` de punta a punta |
| `npx tsc --noEmit -p .` (en `sdk/Typescript/`) | Tipos del SDK de cliente |
| `deno run -A --unstable-kv --config zenith-cli/deno.json tools/docs-coverage.ts` | Que la documentación cubre rutas, comandos, piezas, errores y versiones |
| `node <zuix>/zudocs/bin/zudocs.mjs verify --strict --config site/zudocs.config.json` | Estructura, enlaces y anclas de `docs/` |
| `deno publish --dry-run --allow-dirty` (en `zenith-backend/` y `zenith-cli/`) | Que los paquetes de JSR se pueden publicar |

## Cuando falta algo

| Falta | Qué hacer |
|---|---|
| Un dato que no está en el código | No escribirlo. Decirlo en el informe |
| Un motor externo (engine-auth, celld) para probar | Decirlo; no simularlo en una prueba que se presenta como de integración |
| Una decisión de diseño | Proponerla al mantenedor; no escribir el ADR como aceptado |

## Archivo

[El prompt de experto en barrits](./archivo/01-prompt-experto-barrits.md) es una nota interna anterior a esta guía.
