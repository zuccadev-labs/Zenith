# @zuccadev-labs/zenith-client

Zenith's **client SDK** for JavaScript and TypeScript (browser, Node, Deno, React). It talks to a
running Zenith server; it does not create or run one. For the server side (the engine and the `zen`
CLI) see [`@zuccadev-labs/zenith`](https://jsr.io/@zuccadev-labs/zenith).

```bash
npm install @zuccadev-labs/zenith-client
```

Not published yet: from the monorepo, `npm run build` here and `npm install <path>/sdk/Typescript`.

## Use

```ts
import { Zenith, ZenithObject, ZenithQuery, ZenithUser } from "@zuccadev-labs/zenith-client";

Zenith.initialize({ appId: "myapp", serverURL: "http://localhost:1337" });

await ZenithUser.logIn("alice", "s3cret");                  // POST /login; the session is kept

const todo = new ZenithObject("Todo");
todo.set({ title: "Buy milk", done: false });
await todo.save();                                          // POST /classes/Todo

const open = await new ZenithQuery("Todo").equalTo("done", false).limit(10).find();
```

React: `import { ZenithProvider, useZenithUser, useZenithQuery } from "@zuccadev-labs/zenith-client/react";`

## What the server must allow first

- **Classes:** `/classes/Todo` only accepts classes defined beforehand with `POST /schemas/Todo`
  and the master key, unless the app sets `allowClientClassCreation` (ADR-014).
- **Users:** login and sign-up need engine-auth configured on the server (`engineAuth`); without it
  they answer 503. Password reset and e-mail verification answer 501 for now.
- **Master key:** never in a browser. The server accepts it only from localhost.
- **Server-only routes:** cloud functions (`ZenithCloud.run`), files, LiveQuery and the business
  modules (CRM, ERP, notifications…) are master-only today (ADR-013), so from a browser they fail.
- **API keys** (`restApiKey`): an `sk_` key belongs in trusted backends, never in a browser. A key
  only does what its scopes allow (a `pk_` key reads; writes answer 403).

## License

MIT
