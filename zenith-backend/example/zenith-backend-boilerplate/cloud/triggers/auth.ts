import { Zen } from "@zuccadev-labs/zenith";

// Authentication Triggers
// These fire before/after user signup, login, or verification.

// Zen.Cloud.beforeLogin(async (request) => {
//   const { user } = request;
//   if (user.get("banned")) throw new Error("Account is banned");
// });
//
// Zen.Cloud.afterLogin(async (request) => {
//   console.log("User logged in:", request.user?.id);
// });
//
// Zen.Cloud.beforeSignup(async (request) => {
//   const { user } = request;
//   if (!user.get("email")?.includes("@")) throw new Error("Invalid email");
// });

export { Zen };
