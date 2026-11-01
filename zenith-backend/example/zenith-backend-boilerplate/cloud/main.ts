import { Zen } from "@zuccadev-labs/zenith";

// ─── Example Cloud Code ───────────────────────────────────────────
// Uncomment the examples you want to enable:
// import "./examples/01-user-auth.ts";
// import "./examples/02-rest-crud.ts";
// import "./examples/03-file-storage.ts";
// import "./examples/04-media-streaming.ts";
// import "./examples/05-graphql.ts";
// import "./examples/06-livequery.ts";
// import "./examples/07-schema-acl.ts";
// import "./examples/08-billing.ts";
// import "./examples/09-custom-routes.ts";

// ─── Built-in Quick Health Check ──────────────────────────────────
Zen.Cloud.define("health", async () => {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
    uptime: performance.now(),
  };
});

// ─── Your Cloud Functions ─────────────────────────────────────────
// Delete the code above and start writing your own:
//
// import { Zen } from "@zuccadev-labs/zenith";
//
// Zen.Cloud.define("hello", async () => {
//   return { greeting: "Hello, world!" };
// });
