import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
// The official Standard Webhooks library: what any receiver uses to verify Zenith's webhooks.
import { Webhook } from "standardwebhooks";
import { generateWebhookSecret, signWebhook, verifyWebhook, webhookHeaders, webhookKeyBytes } from "../../src/security/webhook-signature.ts";

const BODY = JSON.stringify({ type: "Contact.created", timestamp: "2026-11-11T00:00:00.000Z", data: { objectId: "a1" } });
const NOW = Date.now();

Deno.test("webhook-signature: secrets are whsec_ + base64 of 32 random bytes", () => {
  const s = generateWebhookSecret();
  assertMatch(s, /^whsec_[A-Za-z0-9+/]+=*$/);
  assertEquals(webhookKeyBytes(s).length, 32);
  assert(s !== generateWebhookSecret());
  assertThrows(() => webhookKeyBytes("whsec_c2hvcnQ="), Error, "24 to 64");
});

Deno.test("webhook-signature: Zenith's signature verifies with the official standardwebhooks library", async () => {
  const secret = generateWebhookSecret();
  const headers = await webhookHeaders([secret], "msg_abc123", BODY, NOW);
  assertMatch(headers["webhook-signature"], /^v1,[A-Za-z0-9+/]+=*$/);
  const verified = new Webhook(secret).verify(BODY, headers);
  assertEquals(verified, JSON.parse(BODY));
});

Deno.test("webhook-signature: Zenith verifies what the official library signs", async () => {
  const secret = generateWebhookSecret();
  const ts = new Date(Math.floor(NOW / 1000) * 1000);
  const sig = new Webhook(secret).sign("msg_xyz", ts, BODY);
  assertEquals(sig, await signWebhook(secret, "msg_xyz", Math.floor(NOW / 1000), BODY));
  const headers = { "webhook-id": "msg_xyz", "webhook-timestamp": String(Math.floor(NOW / 1000)), "webhook-signature": sig };
  assert(await verifyWebhook(headers, BODY, [secret], { nowMs: NOW }));
});

Deno.test("webhook-signature: rotation sends one signature per secret; either verifies", async () => {
  const oldS = generateWebhookSecret(), newS = generateWebhookSecret();
  const headers = await webhookHeaders([newS, oldS], "msg_rot", BODY, NOW);
  assertEquals(headers["webhook-signature"].split(" ").length, 2);
  new Webhook(oldS).verify(BODY, headers);
  new Webhook(newS).verify(BODY, headers);
});

Deno.test("webhook-signature: tampering, other secret, replay and malformed input fail closed", async () => {
  const secret = generateWebhookSecret();
  const h = await webhookHeaders([secret], "msg_t", BODY, NOW);
  assert(await verifyWebhook(h, BODY, [secret], { nowMs: NOW }));
  assert(!(await verifyWebhook(h, BODY + " ", [secret], { nowMs: NOW })), "body");
  assert(!(await verifyWebhook(h, BODY, [generateWebhookSecret()], { nowMs: NOW })), "secret");
  assert(!(await verifyWebhook({ ...h, "webhook-id": "msg_u" }, BODY, [secret], { nowMs: NOW })), "id is signed");
  assert(!(await verifyWebhook(h, BODY, [secret], { nowMs: NOW + 301_000 })), "replay after 5 min");
  assert(await verifyWebhook(h, BODY, [secret], { nowMs: NOW + 299_000 }));
  for (const bad of [{}, { ...h, "webhook-timestamp": "x" }, { ...h, "webhook-signature": "v2,abc" }]) {
    assert(!(await verifyWebhook(bad, BODY, [secret], { nowMs: NOW })));
  }
  assert(!(await verifyWebhook(h, BODY, [], { nowMs: NOW })), "no secrets");
  await signWebhook(secret, "a.b", 1, BODY).then(() => assert(false), (e) => assertMatch(e.message, /must not contain/));
});

Deno.test("webhook-signature: endpoint verification matches the spec's test vector", async () => {
  // spec/extensions/endpoint-verification.md § Examples
  const challenge = "0njH7N3kV5eXPB+/eh+eoA2Ahvz2JgNp0iC/BLOl6yM=";
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const { endpointVerificationResponse, verifyEndpointVerificationResponse, generateChallenge } = await import("../../src/security/webhook-signature.ts");
  assertEquals(await endpointVerificationResponse(secret, challenge), "v1,2WoO4Z1kjgoudcvk4PX/8LDD6FNJDEUHMtYqZpNx/FA=");
  assert(await verifyEndpointVerificationResponse([generateWebhookSecret(), secret], challenge, "v1,2WoO4Z1kjgoudcvk4PX/8LDD6FNJDEUHMtYqZpNx/FA="));
  for (const bad of [null, "", "v1,AAAA", "v1a,2WoO4Z1kjgoudcvk4PX/8LDD6FNJDEUHMtYqZpNx/FA=", "v1,2WoO4Z1kjgoudcvk4PX/8LDD6FNJDEUHMtYqZpNx/FA= v1,x"]) {
    assert(!(await verifyEndpointVerificationResponse([secret], challenge, bad)), String(bad));
  }
  assertEquals((await import("../../src/core/crypto.ts")).fromBase64(generateChallenge()).length, 32);
});
