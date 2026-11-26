# Zenith para agentes

Backend como servicio para Deno, compatible con los SDK de Parse Server y compuesto con traits de barrits. La guía
completa, con reglas, patrones y verificación, está en `docs/agents/README.md`.

- Monorepo: `zenith-backend/` (el motor, `@zuccadev-labs/zenith` en JSR), `zenith-cli/` (`zen`,
  `@zuccadev-labs/zenith-cli` en JSR), `sdk/Typescript/` (`@zuccadev-labs/zenith-client` en npm) y
  `create-zenith/` (npm). Las otras carpetas de `sdk/` están vacías.
- Una pieza del motor es un trait con una entrada en `zenith-backend/src/traits/catalog.ts`. Un comando de `zen`
  es un trait en `zenith-cli/commands/registry.ts`.
- Cada ruta declara `access` (`public`, `user` o `master`); sin declarar es `master`. La master key solo vale desde
  localhost.
- Verificación: la tabla de `docs/agents/README.md`. Un cambio que toca rutas, comandos, piezas o errores pasa
  también `tools/docs-coverage.ts`.
- Documentación en `docs/`, en español, por áreas (`users`, `agents`, `development`, `investigations`,
  `package`). El sitio se compila con zudocs (`site/zudocs.config.json`).
- No se editan a mano: `site/static/reference/` (sale de `zen generate docs`).
- Un agente no publica ni crea etiquetas de publicación.
- Nada de rutas absolutas, credenciales ni datos privados en lo versionado.
