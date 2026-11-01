import { Zen } from "@zuccadev-labs/zenith";

// Webhooks
// Zen.Cloud.Webhook lets you register HTTP handlers at /functions/<name>.
// These are full HTTP handlers (unlike Cloud.define which is Parse-style RPC).

Zen.Cloud.Webhook("stripe-events", async (request) => {
  const payload = await request.json();
  const signature = request.headers.get("stripe-signature");
  // Validate signature and process event
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

export { Zen };
