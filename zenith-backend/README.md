# @zuccadev-labs/zenith

The Zenith engine: a Parse Server–compatible backend for Deno, composed from
[barrits](https://jsr.io/@zuccadev-labs/barrits) traits. This is the **server SDK** together with the
`zen` CLI ([`@zuccadev-labs/zenith-cli`](https://jsr.io/@zuccadev-labs/zenith-cli)). Apps that only
talk to a running server use the client SDK, [`@zuccadev-labs/zenith-client`](https://www.npmjs.com/package/@zuccadev-labs/zenith-client).

You normally do not import this package by hand: `zen init` creates a project that depends on it.

```bash
deno install -g -A --unstable-kv -n zen jsr:@zuccadev-labs/zenith-cli/zen
zen init myapp && cd myapp && zen dev
```

## Exports

| Path | Contents |
|---|---|
| `@zuccadev-labs/zenith` | `Zen` (Cloud, DB, Config, Logger, Shell, App…), `createZenithApp(config)`, `selectTraits`, the business traits and adapters |
| `@zuccadev-labs/zenith/openapi` | `generateProjectOpenApi(config)`: the OpenAPI 3.1 spec of a project without starting it |
| `@zuccadev-labs/zenith/plugin-signing` | Ed25519 plugin signing and trust store (used by `zen plugin`) |

Cloud code in a project:

```ts
import { Zen } from "@zuccadev-labs/zenith";

Zen.Cloud.define("hello", (req) => ({ message: `hola ${req.params.name ?? "mundo"}` }));
Zen.Cloud.beforeSave("Todo", (req) => { if (!req.object.title) throw new Error("title is required"); });
```

## Requirements

- Deno 2.4 or later, run with `--unstable-kv` (the engine uses Deno KV).
- MongoDB (the default database adapter).
- Users and sessions come from engine-auth (`config.engineAuth`, ADR-012). Without it the user routes answer 503.

## Access model

Every route declares who may call it (ADR-013): `public`, `user` (session or API key) or `master`
(master key, accepted only from localhost). Routes that declare nothing are `master`. An API key
reaches a `user` route only within its scopes (`data:read`, `data:write`…), and a route that declares
no scope does not accept API keys. Any key may be locked to IPs or CIDR ranges (`allowedIps`); a key
with scope `*` must be, must expire within 90 days and cannot manage keys (ADR-015). The live
`/openapi.json` documents exactly the routes the router mounts, with this access as its `security`.

## License

MIT
