// apps.config.ts — Template for Zenith applications
//
// This file is a template used by `zenith init` to scaffold new projects.
// When you run `zenith init my-project`, a fresh `apps.config.ts` is
// generated with your chosen app ID, port, and database settings.
//
// For reference, the generated file imports types from the `@zuccadev-labs/zenith`
// package, defines one or more `ZenithAppDefinition` entries, and exports them
// as the `apps` array for the Zenith runtime.
//
// Example generated content:
//
// import type { ZenithConfig, ZenithAppDefinition } from "@zuccadev-labs/zenith";
//
// const { ZENITH_PORT = "3000" } = Deno.env.toObject();
//
// export const apps: ZenithAppDefinition[] = [
//   {
//     mountPath: "/parse",
//     config: {
//       appId: "my_app",
//       masterKey: Deno.env.get("ZENITH_MASTER_KEY") ?? "change_me",
//       serverURL: `http://localhost:${ZENITH_PORT}/parse`,
//       port: parseInt(ZENITH_PORT, 10),
//       cloudCodePath: "./cloud/main.ts",
//       pluginsPath: "./plugins",
//       databaseURI: Deno.env.get("ZENITH_DATABASE_URI") ?? "mongodb://localhost:27017/my_app",
//       allowClientClassCreation: true,
//       enableAnonymousUsers: false,
//     } satisfies ZenithConfig,
//   },
// ];

export const apps = [];
