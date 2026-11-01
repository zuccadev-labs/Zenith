import { Zen } from "@zuccadev-labs/zenith";

// ─── Database Triggers ─────────────────────────────────────────────────────

/**
 * Automatically inject the current user as the owner of any 'Post' created via REST API.
 * This demonstrates the `beforeSave` trigger capabilities.
 */
Zen.Cloud.beforeSave("Post", async (request) => {
  const obj = request.object;

  // If the object is new (no objectId yet)
  if (!obj.objectId && !obj._id) {
    // Inject owner if authenticated
    if (request.user) {
      obj.owner = { __type: "Pointer", className: "_User", objectId: request.user.objectId || request.user._id };
    }

    // Force some default fields
    obj.viewCount = 0;

    // Sanitize content (Enterprise security feature)
    if (typeof obj.content === "string") {
      // Basic sanitization: replace <script> tags
      obj.content = obj.content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "[Sanitized Content]");
    }
  }
});
