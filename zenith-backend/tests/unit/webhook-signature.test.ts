import { assert, assertEquals, assertMatch } from "@std/assert";
import { hmacSha256Hex } from "../../src/core/crypto.ts";
import { parseWebhookSignature, signWebhook, verifyWebhook } from "../../src/security/webhook-signature.ts";
import { WebhookTrait } from "../../src/traits/cloud/webhook.trait.ts";

const BODY = JSON.stringify({ event: "order.paid", data: { id: 1 } });
const NOW = 1_800_000_000_000;

Deno.test("webhook-signature: t in seconds and v1 = HMAC-SHA256(secret, `${t}.${body}`)", async () => {
  const header = await signWebhook("whsec_a", BODY, NOW);
  assertMatch(header, /^t=1800000000,v1=[0-9a-f]{64}$/);
  const v1 = header.split("v1=")[1];
  assertEquals(v1, await hmacSha256Hex("whsec_a", `1800000000.${BODY}`), "a receiver can verify it with any HMAC library");
});

Deno.test("webhook-signature: a signature it produced verifies; tampering does not", async () => {
  const header = await signWebhook("whsec_a", BODY, NOW);
  assert(await verifyWebhook(header, BODY, ["whsec_a"], { nowMs: NOW }));
  assert(!(await verifyWebhook(header, BODY + " ", ["whsec_a"], { nowMs: NOW })), "other body");
  assert(!(await verifyWebhook(header, BODY, ["whsec_b"], { nowMs: NOW })), "other secret");
  assert(!(await verifyWebhook(header.replace("t=1800000000", "t=1800000001"), BODY, ["whsec_a"], { nowMs: NOW })), "other t");
});

Deno.test("webhook-signature: replay outside the tolerance is rejected", async () => {
  const header = await signWebhook("whsec_a", BODY, NOW);
  assert(await verifyWebhook(header, BODY, ["whsec_a"], { nowMs: NOW + 299_000 }));
  assert(!(await verifyWebhook(header, BODY, ["whsec_a"], { nowMs: NOW + 301_000 })));
  assert(!(await verifyWebhook(header, BODY, ["whsec_a"], { nowMs: NOW - 301_000 })));
});

Deno.test("webhook-signature: rotation verifies with the new and the previous secret", async () => {
  const old = await signWebhook("whsec_old", BODY, NOW);
  assert(await verifyWebhook(old, BODY, ["whsec_new", "whsec_old"], { nowMs: NOW }));
  const v1New = (await signWebhook("whsec_new", BODY, NOW)).split("v1=")[1];
  assert(await verifyWebhook(`${old},v1=${v1New}`, BODY, ["whsec_new"], { nowMs: NOW }), "several v1");
});

Deno.test("webhook-signature: fails closed on malformed input", async () => {
  for (const h of [null, "", "garbage", "t=abc,v1=00", "t=1800000000", "v1=" + "a".repeat(64)]) {
    assert(!(await verifyWebhook(h, BODY, ["whsec_a"], { nowMs: NOW })), String(h));
  }
  assert(!(await verifyWebhook(await signWebhook("s", BODY, NOW), BODY, [], { nowMs: NOW })), "no secrets");
  assertEquals(parseWebhookSignature("t=5, v1=" + "b".repeat(64))?.t, 5);
});

Deno.test("webhook trait: sign() then verify() round-trips (it never did before) and survives rotateKey()", async () => {
  const store: Record<string, unknown[]> = {};
  const db = { create: async (c: string, o: unknown) => ((store[c] ??= []).push(o), o), find: async () => [] };
  const trait = (WebhookTrait as any).create({ traits: { db } });
  const api = trait.webhook ?? trait.webhookApi ?? Object.values(trait).find((v: any) => v?.sign && v?.verify);
  const header = await api.sign("primary", BODY);
  assert(await api.verify(header, BODY));
  await api.rotateKey();
  assert(await api.verify(header, BODY), "signed with the previous key during the rotation");
  assert(await api.verify(await api.sign("primary", BODY), BODY));
});
