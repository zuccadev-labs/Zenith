import { Zen } from "@zuccadev-labs/zenith";

// ─── Examples Index ───────────────────────────────────────────────
// Each file below demonstrates a different Zenith Cloud Code feature.
// They are all imported by default; remove or comment out any you
// don't want to use in your project.
//
// All examples use the global `Zen` API object (same as Parse-Server).

import "./01-user-auth.ts";
import "./02-rest-crud.ts";
import "./03-file-storage.ts";
import "./04-media-streaming.ts";
import "./05-graphql.ts";
import "./06-livequery.ts";
import "./07-schema-acl.ts";
import "./08-billing.ts";
import "./09-custom-routes.ts";

export { Zen };

// ─── Ping (used by CI / smoke tests) ──────────────────────────────
Zen.Cloud.define("__ping_examples", async () => {
  return { examples: true, count: 9 };
});
