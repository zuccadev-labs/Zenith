---
description: "Referencia de los comandos de zen, el CLI de Zenith: desarrollo, operaciones, plugins, integraciones y seguridad."
tipo: referencia
---

# ¿Qué hace cada comando de `zen`?

`zen` es el CLI de Zenith, del paquete `@zuccadev-labs/zenith-cli`. Junto con el motor es el SDK de servidor: crea,
ejecuta, compila y opera proyectos. Cada comando es un trait de barrits (`zenith-cli/commands/registry.ts`), así que
`zen --help` imprime la misma lista que esta página.

## Resumen

```bash
deno install -g -A --unstable-kv -n zen jsr:@zuccadev-labs/zenith-cli/zen
zen --help
zen <comando> --help
```

Sin instalar: `deno run -A --unstable-kv jsr:@zuccadev-labs/zenith-cli/zen <comando>`.

## Comandos

| Comando | Grupo | Qué hace |
|---|---|---|
| `init [nombre]` | Desarrollo | Crea un proyecto: `zen.config.ts`, `cloud/`, `plugins/`, `.env` con una master key aleatoria, `deno.json`. Nunca sobrescribe uno que exista |
| `dev` | Desarrollo | Levanta el proyecto con recarga en caliente; lee `zen.config.ts`, `cloud/` y `plugins/` |
| `compile [--output <archivo>]` | Desarrollo | Un binario único (AOT) con `cloud/` y `plugins/` enlazados |
| `test [--watch] [--coverage] [<suite>]` | Desarrollo | Suites E2E |
| `deploy [--target local\|docker\|k8s] [--dry-run]` | Operaciones | Compila y despliega |
| `logs [--follow] [--level] [--service] [--tail N]` | Operaciones | Muestra o sigue los logs |
| `migrate run\|status\|rollback\|create <nombre>` | Operaciones | Migraciones de base de datos |
| `generate docs\|openapi\|schema\|sdk` | Operaciones | Especificación OpenAPI 3.1, referencia en Markdown, colección de Postman y portal Redoc ([Referencia de la API](./08-referencia-de-la-api.md)) |
| `plugin keygen\|sign\|verify\|trust\|revoke\|list` | Plugins | Firma de plugins con Ed25519 ([ADR-004](../investigations/adr/04-plugin-signing.md)) |
| `plugins-lock [dir]` | Plugins | `plugins.lock.json`, con el SHA-256 de cada plugin. Alias: `plugins:lock` |
| `webhook list\|create\|verify\|delete\|pause\|resume\|test\|rotate-secret\|messages\|attempts\|redeliver\|recover` | Integraciones | Webhooks ([Webhooks y Cloud Code Hooks](./06-webhooks-y-hooks.md)) |
| `email channels\|threads\|send\|sync` | Integraciones | Correo IMAP y SMTP |
| `calendar channels\|events\|slots\|conflicts\|ics\|sync` | Integraciones | Calendarios |
| `automation list\|create\|get\|toggle\|test\|logs\|delete\|actions` | Integraciones | Reglas de automatización (si pasa esto, haz aquello) |
| `api-keys list\|create\|revoke\|rotate` | Seguridad | API keys de la app ([Acceso y API keys](./04-acceso-y-api-keys.md)) |
| `agent list\|get\|run\|chat` | Seguridad | Agentes del backend |
| `mtls-gen-dev` | Seguridad | CA y certificados mTLS de desarrollo ([ADR-002](../investigations/adr/02-mtls.md)). Alias: `mtls:gen-dev` |

## Valores y restricciones

- Los comandos que hablan con un servidor (`zen api-keys`, `zen webhook`, `zen email`, `zen calendar`,
  `zen automation`, `zen agent`, `zen logs`, `zen migrate`) leen `ZENITH_SERVER_URL`, `ZENITH_APP_ID` y `ZENITH_MASTER_KEY`, o el
  `.env` de la carpeta actual. La master key solo funciona desde localhost.
- `zen init` escribe la dependencia `"@zuccadev-labs/zenith": "jsr:@zuccadev-labs/zenith@^<versión>"`. Ejecutado
  desde un clon del repositorio enlaza `zenith-backend/` en su lugar. `ZENITH_ENGINE=jsr` o `ZENITH_ENGINE=local`
  fuerzan uno u otro.
- `zen dev` y `zen compile` necesitan `--unstable-kv`, porque el motor usa Deno KV. La instalación de arriba ya lo
  incluye.
- El binario también se puede llamar `zenith`.

## Ejemplos

```bash
zen init miapp && cd miapp && zen dev
zen generate docs --out ./docs
zen api-keys create --name ci --env test --allowed-ips 203.0.113.10
zen webhook create --url https://api.example.com/zenith --events "Contact.*,Deal.won" --name crm
zen plugin sign plugins/mi-plugin.ts
zen compile --output miapp-server
```

## Ver también

- `zenith-cli/README.md`, que es el README del paquete en JSR.
- [Primeros pasos](./01-primeros-pasos.md).
