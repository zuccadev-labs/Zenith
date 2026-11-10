# @zuccadev-labs/zenith-cli

`zen`, the Zenith CLI. With the engine ([`@zuccadev-labs/zenith`](https://jsr.io/@zuccadev-labs/zenith))
it is Zenith's **server SDK**: it creates, runs, compiles and operates Zenith projects. Client apps
use [`@zuccadev-labs/zenith-client`](https://www.npmjs.com/package/@zuccadev-labs/zenith-client) instead.

```bash
deno install -g -A --unstable-kv -n zen jsr:@zuccadev-labs/zenith-cli/zen
zen init myapp        # zen.config.ts, cloud/, plugins/, .env (random master key), deno.json
cd myapp && zen dev   # hot reload on http://localhost:1337
zen compile           # one self-contained binary with cloud/ and plugins/ linked in
```

Without installing: `deno run -A --unstable-kv jsr:@zuccadev-labs/zenith-cli/zen <command>`.
From npm: `npm create @zuccadev-labs/zenith myapp`.

## Commands

| Group | Command | |
|---|---|---|
| Development | `init [name]` | New project. Never overwrites an existing one |
| | `dev` | Runs the project with hot reload |
| | `compile [--output]` | Single binary (AOT) |
| | `test` | E2E suites |
| Operations | `deploy [--target local\|docker\|k8s] [--dry-run]` | Compiles the project and deploys it |
| | `logs`, `migrate` | Logs; database migrations |
| | `generate openapi\|docs\|schema\|sdk` | OpenAPI 3.1 and docs from the routes the project mounts |
| Plugins | `plugin keygen\|sign\|verify\|trust\|revoke\|list` | Ed25519 plugin signing |
| | `plugins-lock [dir]` | `plugins.lock.json` (SHA-256 of each plugin) |
| Integrations | `webhook`, `email`, `calendar`, `automation` | Their HTTP APIs |
| Security | `api-keys list\|create\|revoke\|rotate` | The app's API keys (`/zen/api-keys`) |
| | `agent list\|get\|run\|chat` | Backend agents |
| | `mtls-gen-dev` | Development CA and mTLS certificates |

`zen --help` prints the same table from the command registry (each command is a barrits trait).
Commands that talk to a server read `ZENITH_SERVER_URL`, `ZENITH_APP_ID` and `ZENITH_MASTER_KEY`
(or the `.env` of the current directory). The master key only works from localhost.

## Where the engine comes from

`zen init` writes `"@zuccadev-labs/zenith": "jsr:@zuccadev-labs/zenith@^<version>"`. Run from a
checkout of the Zenith monorepo it links the local `zenith-backend/` instead, to try engine changes
before publishing. `ZENITH_ENGINE=jsr|local` forces either.

## License

MIT
