import { Zen } from "@zuccadev-labs/zenith";

// Database Triggers
// These fire on Parse-Server class operations (beforeSave, afterSave, etc.).
// Uncomment and customize as needed.

// Zen.Cloud.beforeSave("MyClass", async (request) => {
//   const { object, original } = request;
//   object.set("updatedAt", new Date().toISOString());
//   return object;
// });
//
// Zen.Cloud.afterSave("MyClass", async (request) => {
//   console.log("Saved:", request.object.id);
// });
//
// Zen.Cloud.beforeDelete("MyClass", async (request) => {
//   const { object } = request;
//   if (object.get("protected")) throw new Error("Cannot delete protected objects");
// });
//
// Zen.Cloud.afterDelete("MyClass", async (request) => {
//   console.log("Deleted:", request.object.id);
// });

export { Zen };
