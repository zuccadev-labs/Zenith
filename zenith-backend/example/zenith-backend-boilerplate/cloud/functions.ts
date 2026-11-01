import { Zen } from "@zuccadev-labs/zenith";

// Cloud Functions
// Use Zen.Cloud.define() to create Parse-compatible cloud functions.
// The handler receives a request context with params, user, headers, etc.

Zen.Cloud.define("myFunction", async (request) => {
  const { params, user, headers, ip } = request;
  return { params, user: user?.id ?? "anonymous" };
});

export { Zen };
