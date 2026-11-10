/**
 * API key access policy (ADR-015): IP allowlists for any key; unrestricted keys (scope *) only as
 * secret keys, locked to listed networks and short-lived; rotation never widens a key.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  ApiKeyPolicyError,
  checkKeyPolicy,
  ipAllowed,
  parseCidr,
  UNRESTRICTED_MAX_LIFETIME_DAYS,
} from "../../src/security/api-keys/policy.ts";
import { ApiKeyManager } from "../../src/security/api-keys/manager.ts";
import { InMemoryStore } from "../../src/security/api-keys/store.ts";

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

Deno.test("policy: IPv4, IPv6, CIDR and IPv4-mapped IPv6", () => {
  assert(ipAllowed("203.0.113.7", ["203.0.113.0/24"]));
  assert(!ipAllowed("203.0.114.7", ["203.0.113.0/24"]));
  assert(ipAllowed("::ffff:203.0.113.7", ["203.0.113.7"]), "a v4 client seen through a dual-stack socket");
  assert(ipAllowed("2001:db8::1", ["2001:db8::/32"]));
  assert(!ipAllowed("2001:db9::1", ["2001:db8::/32"]));
  assert(ipAllowed("fe80::1:2.3.4.5", ["fe80::/10"]));
  assert(!ipAllowed("127.0.0.1", ["::1"]), "v4 and v6 loopback are different entries");
  assert(!ipAllowed(undefined, ["0.0.0.0/0"]), "no address never matches");
  assert(!ipAllowed("unknown", ["0.0.0.0/0"]));
  for (const bad of ["300.1.1.1", "1.2.3", "01.2.3.4", "1::2::3", "1.2.3.4/33", "2001:db8::/129", "gg::1", "1.2.3.4/24/1"]) {
    assertEquals(parseCidr(bad), null, bad);
  }
});

Deno.test("policy: unrestricted keys need sk, a real allowlist and a short life", () => {
  const ok = { prefix: "sk" as const, scopes: ["*" as const], allowedIps: ["198.51.100.0/24"], expiresAt: inDays(30) };
  assertEquals(checkKeyPolicy(ok), ["198.51.100.0/24"]);
  assertThrows(() => checkKeyPolicy({ ...ok, prefix: "pk" }), ApiKeyPolicyError, "secret keys");
  assertThrows(() => checkKeyPolicy({ ...ok, allowedIps: [] }), ApiKeyPolicyError, "allowedIps");
  assertThrows(() => checkKeyPolicy({ ...ok, allowedIps: ["0.0.0.0/0"] }), ApiKeyPolicyError, "everywhere");
  assertThrows(() => checkKeyPolicy({ ...ok, allowedIps: ["::/0"] }), ApiKeyPolicyError, "everywhere");
  assertThrows(() => checkKeyPolicy({ ...ok, expiresAt: undefined }), ApiKeyPolicyError, "expire");
  assertThrows(() => checkKeyPolicy({ ...ok, expiresAt: inDays(UNRESTRICTED_MAX_LIFETIME_DAYS + 1) }), ApiKeyPolicyError, "expire");
  assertThrows(() => checkKeyPolicy({ ...ok, allowedIps: ["not-an-ip"] }), ApiKeyPolicyError, "not an IPv4/IPv6");
  // Scoped keys: the allowlist is optional, and validated when given.
  assertEquals(checkKeyPolicy({ prefix: "pk", scopes: ["data:read"] }), []);
  assertThrows(() => checkKeyPolicy({ prefix: "sk", scopes: ["data:read"], allowedIps: ["1.2.3.4/40"] }), ApiKeyPolicyError);
});

Deno.test("policy: the manager enforces it on create, verify and rotate", async () => {
  const store = new InMemoryStore();
  const manager = new ApiKeyManager(store);
  const base = { appId: "a", env: "test" as const, name: "k", createdBy: "master" };

  await assertRejects(() => manager.create({ ...base, prefix: "sk", scopes: ["*"] }), ApiKeyPolicyError);

  const full = await manager.create({ ...base, prefix: "sk", scopes: ["*"], allowedIps: ["198.51.100.0/24"], expiresIn: "30d" });
  assertEquals((await manager.verify(full.plaintext, "198.51.100.9")).valid, true);
  const outside = await manager.verify(full.plaintext, "203.0.113.9");
  assertEquals(outside.valid ? "valid" : outside.reason, "ip_not_allowed");
  const noIp = await manager.verify(full.plaintext);
  assertEquals(noIp.valid ? "valid" : noIp.reason, "ip_not_allowed", "an unknown client address is refused");

  // A wrong secret is reported as such, without revealing the policy.
  const wrong = await manager.verify(full.plaintext.slice(0, -2) + "zz", "203.0.113.9");
  assertEquals(wrong.valid ? "valid" : wrong.reason, "wrong_secret");

  // A scoped key with an allowlist is held to it too; without one it works from anywhere.
  const scoped = await manager.create({ ...base, prefix: "rk", scopes: ["analytics:read"], allowedIps: ["2001:db8::/32"] });
  assertEquals((await manager.verify(scoped.plaintext, "2001:db8::5")).valid, true);
  assertEquals((await manager.verify(scoped.plaintext, "198.51.100.9")).valid, false);
  const open = await manager.create({ ...base, prefix: "pk", scopes: ["data:read"] });
  assertEquals((await manager.verify(open.plaintext, "203.0.113.1")).valid, true);

  // Older data: an unrestricted key stored without an allowlist is refused (fails closed).
  await store.update(full.record.id, { allowedIps: undefined });
  const legacy = await manager.verify(full.plaintext, "198.51.100.9");
  assertEquals(legacy.valid ? "valid" : legacy.reason, "policy_missing");
  await store.update(full.record.id, { allowedIps: ["198.51.100.0/24"] });

  // Rotation keeps the allowlist and the lifetime (before, the new key never expired).
  const rotated = await manager.rotate(full.record.id, { createdBy: "master", gracePeriodMs: 0 });
  assertEquals(rotated.record.allowedIps, ["198.51.100.0/24"]);
  assert(rotated.record.expiresAt, "the rotated key expires");
  const life = new Date(rotated.record.expiresAt!).getTime() - Date.now();
  assert(life > 29 * 86_400_000 && life <= 30 * 86_400_000 + 60_000, `lifetime ${life}`);
  assertEquals((await manager.verify(rotated.plaintext, "203.0.113.9")).valid, false);
});
