/**
 * Tests para el sistema de API Keys estilo Stripe.
 *
 * Cubre:
 *   - Formato de key (parse + build, malformed, prefixos, envs)
 *   - Generación (id único, secret aleatorio, hash Argon2id)
 *   - Verificación (success, wrong_secret, not_found, revoked, expired, rotated)
 *   - Rotación (nueva key + grace period)
 *   - Scopes (jerarquía, normalización, hasScope)
 *   - Rate limiter (sliding window)
 *   - Middleware (header extraction, audit log)
 *   - parseExpiresIn (shorthand → ISO 8601)
 */

import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  ApiKeyManager,
  InMemoryStore,
  PerKeyRateLimiter,
  buildKey,
  DEFAULT_SCOPES,
  extractAndVerifyKey,
  hasAllScopes,
  hasAnyScope,
  hasScope,
  normalizeScopes,
  parseExpiresIn,
  parseKey,
  requireScope,
} from "../../src/security/api-keys/mod.ts";
import type { ApiKeyRecord } from "../../src/security/api-keys/types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function newManager(): Promise<{ manager: ApiKeyManager; store: InMemoryStore }> {
  const store = new InMemoryStore();
  return { manager: new ApiKeyManager(store), store };
}

// ─── Format tests ───────────────────────────────────────────────────────────

Deno.test("api-keys - parseKey accepts well-formed keys", () => {
  // 8-char id + 32-char secret
  const parsed = parseKey("sk_live_aB3xY9zK_qR7vN2pT8mE4wK6hJ1cV0sZ9bF2dL5gX");
  assertExists(parsed);
  assertEquals(parsed!.prefix, "sk");
  assertEquals(parsed!.env, "live");
  assertEquals(parsed!.id.length, 8);
  assertEquals(parsed!.secret.length, 32);
});

Deno.test("api-keys - parseKey accepts all 3 prefixes and 2 envs", () => {
  for (const prefix of ["sk", "pk", "rk"] as const) {
    for (const env of ["live", "test"] as const) {
      const key = buildKey(prefix, env, "ABCDEFGH", "a".repeat(32));
      const parsed = parseKey(key);
      assertExists(parsed);
      assertEquals(parsed!.prefix, prefix);
      assertEquals(parsed!.env, env);
    }
  }
});

Deno.test("api-keys - parseKey rejects malformed keys", () => {
  assertEquals(parseKey("garbage"), null);
  assertEquals(parseKey("sk_live_short"), null);
  assertEquals(parseKey("xx_live_aB3xY9zK_qR7vN2pT8mE4wK6hJ1cV0sZ"), null);  // bad prefix
  assertEquals(parseKey("sk_xx_aB3xY9zK_qR7vN2pT8mE4wK6hJ1cV0sZ"), null);    // bad env
  assertEquals(parseKey("sk_live_aB3xY9z_qR7vN2pT8mE4wK6hJ1cV0sZ"), null);   // id too short
  assertEquals(parseKey("sk_live_aB3xY9zK_short"), null);                     // secret too short
  assertEquals(parseKey(""), null);
});

Deno.test("api-keys - buildKey produces the same string that parseKey accepts", () => {
  for (let i = 0; i < 50; i++) {
    const id = "ABCDEFGH";
    const secret = "a".repeat(32);
    const key = buildKey("sk", "live", id, secret);
    const parsed = parseKey(key);
    assertExists(parsed);
    assertEquals(parsed!.id, id);
    assertEquals(parsed!.secret, secret);
  }
});

// ─── Generation + hash ──────────────────────────────────────────────────────

Deno.test("api-keys - create produces a unique id and a PHC hash", async () => {
  const { manager } = await newManager();
  const a = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: DEFAULT_SCOPES.sk,
    name: "Test #1",
    createdBy: "test",
  });
  const b = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: DEFAULT_SCOPES.sk,
    name: "Test #2",
    createdBy: "test",
  });

  assertNotEquals(a.record.id, b.record.id);                    // ids únicos
  assertStringIncludes(a.hash, "$argon2id$");                  // Argon2id PHC
  assertStringIncludes(a.hash, "$v=19$");                      // versión 0x13
  assertStringIncludes(a.hash, "$m=65536,t=3,p=4$");           // parámetros OWASP
  assertEquals(a.record.hash, undefined);                      // hash omitido en el record público
  assertEquals(a.plaintext.includes(a.record.id), true);       // id presente en plaintext
});

Deno.test("api-keys - create with expiresIn shorthand", async () => {
  const { manager } = await newManager();
  const before = Date.now();
  const { record } = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: DEFAULT_SCOPES.sk,
    name: "90-day key",
    createdBy: "test",
    expiresIn: "90d",
  });
  const expiresAt = new Date(record.expiresAt!).getTime();
  const expectedMin = before + 89 * 24 * 60 * 60 * 1000;  // 89 días
  const expectedMax = before + 91 * 24 * 60 * 60 * 1000;  // 91 días
  assertEquals(expiresAt >= expectedMin, true);
  assertEquals(expiresAt <= expectedMax, true);
});

Deno.test("api-keys - parseExpiresIn supports s/m/h/d/w/M/y", () => {
  const now = Date.now();
  const r1 = parseExpiresIn("30s")!;
  const r2 = parseExpiresIn("5m")!;
  const r3 = parseExpiresIn("24h")!;
  const r4 = parseExpiresIn("7d")!;
  const r5 = parseExpiresIn("4w")!;
  const r6 = parseExpiresIn("6M")!;
  const r7 = parseExpiresIn("1y")!;

  assertEquals(Math.abs(new Date(r1).getTime() - (now + 30_000)) < 5000, true);
  assertEquals(Math.abs(new Date(r2).getTime() - (now + 5 * 60_000)) < 5000, true);
  assertEquals(Math.abs(new Date(r3).getTime() - (now + 24 * 3_600_000)) < 5000, true);
  assertEquals(Math.abs(new Date(r4).getTime() - (now + 7 * 86_400_000)) < 5000, true);
  assertEquals(Math.abs(new Date(r5).getTime() - (now + 4 * 7 * 86_400_000)) < 5000, true);
  assertEquals(Math.abs(new Date(r6).getTime() - (now + 6 * 30 * 86_400_000)) < 5000, true);
  assertEquals(Math.abs(new Date(r7).getTime() - (now + 365 * 86_400_000)) < 5000, true);
});

Deno.test("api-keys - parseExpiresIn accepts null, undefined, ISO 8601", () => {
  assertEquals(parseExpiresIn(null), null);
  assertEquals(parseExpiresIn(undefined), null);
  assertEquals(parseExpiresIn(""), null);
  assertEquals(parseExpiresIn("2027-01-01T00:00:00Z"), "2027-01-01T00:00:00Z");
});

Deno.test("api-keys - parseExpiresIn rejects garbage", () => {
  assertThrows(() => parseExpiresIn("30x"), Error, "Invalid expiresIn");
  assertThrows(() => parseExpiresIn("abc"), Error, "Invalid expiresIn");
});

// ─── Verify ────────────────────────────────────────────────────────────────

Deno.test("api-keys - verify accepts a freshly created key", async () => {
  const { manager } = await newManager();
  const { plaintext } = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Test",
    createdBy: "test",
  });
  const result = await manager.verify(plaintext);
  assertEquals(result.valid, true);
  if (result.valid) {
    assertEquals(result.key.appId, "app1");
    assertEquals(result.key.scopes, ["data:read"]);
  }
});

Deno.test("api-keys - verify rejects malformed plaintext", async () => {
  const { manager } = await newManager();
  const result = await manager.verify("not-a-valid-key");
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "malformed");
});

Deno.test("api-keys - verify rejects wrong_secret (different plaintext, same id)", async () => {
  const { manager } = await newManager();
  const { plaintext } = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Test",
    createdBy: "test",
  });
  const parsed = parseKey(plaintext)!;
  // Construye otra key con el mismo id pero secret diferente
  const tampered = buildKey("sk", "live", parsed.id, "X".repeat(32));
  const result = await manager.verify(tampered);
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "wrong_secret");
});

Deno.test("api-keys - verify rejects not_found (different id, valid format)", async () => {
  const { manager } = await newManager();
  const fakeKey = buildKey("sk", "live", "ZZZZZZZZ", "a".repeat(32));
  const result = await manager.verify(fakeKey);
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "not_found");
});

Deno.test("api-keys - verify rejects revoked key", async () => {
  const { manager } = await newManager();
  const { record, plaintext } = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Test",
    createdBy: "test",
  });
  await manager.revoke(record.id, "admin", "compromised");
  const result = await manager.verify(plaintext);
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "revoked");
});

Deno.test("api-keys - verify rejects expired key", async () => {
  const { manager } = await newManager();
  const { record, plaintext } = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Expired key",
    createdBy: "test",
  });
  // Forzar expiración en el pasado (hack de testing — no se puede via shorthand)
  await manager["store"].update(record.id, {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const result = await manager.verify(plaintext);
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "expired");
});

Deno.test("api-keys - rotate: new key works, old key has grace period", async () => {
  const { manager } = await newManager();
  const { plaintext: oldKey, record: oldRec } = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read", "data:write"],
    name: "To be rotated",
    createdBy: "test",
  });
  const { plaintext: newKey, record: newRec } = await manager.rotate(oldRec.id, {
    createdBy: "admin",
    gracePeriodMs: 60_000,  // 1 minuto
  });

  // La nueva key funciona
  const v1 = await manager.verify(newKey);
  assertEquals(v1.valid, true);

  // La vieja key todavía funciona durante el grace period
  const v2 = await manager.verify(oldKey);
  assertEquals(v2.valid, true);

  // La nueva key referencia a la vieja
  assertEquals(newRec.metadata?.rotatedFrom, oldRec.id);

  // IDs son diferentes
  assertNotEquals(newRec.id, oldRec.id);
});

Deno.test("api-keys - rotate: after grace period, old key is rejected", async () => {
  const { manager } = await newManager();
  const { plaintext: oldKey, record: oldRec } = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Rotated key",
    createdBy: "test",
  });
  await manager.rotate(oldRec.id, { createdBy: "admin", gracePeriodMs: 50 });
  await new Promise(r => setTimeout(r, 100));
  const result = await manager.verify(oldKey);
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "rotated_grace_over");
});

// ─── Scopes ────────────────────────────────────────────────────────────────

Deno.test("api-keys - hasScope: * matches everything", () => {
  assertEquals(hasScope(["*"], "data:read"), true);
  assertEquals(hasScope(["*"], "admin:write"), true);
  assertEquals(hasScope(["*"], "anything:goes"), true);
});

Deno.test("api-keys - hasScope: recurso:* matches all ops for that resource", () => {
  assertEquals(hasScope(["data:*"], "data:read"), true);
  assertEquals(hasScope(["data:*"], "data:write"), true);
  assertEquals(hasScope(["data:*"], "data:delete"), true);
  assertEquals(hasScope(["data:*"], "users:read"), false);
});

Deno.test("api-keys - hasScope: specific scope is exact match", () => {
  assertEquals(hasScope(["data:read"], "data:read"), true);
  assertEquals(hasScope(["data:read"], "data:write"), false);
  assertEquals(hasScope(["data:read"], "users:read"), false);
});

Deno.test("api-keys - hasAllScopes / hasAnyScope", () => {
  assertEquals(hasAllScopes(["data:read", "data:write"], ["data:read"]), true);
  assertEquals(hasAllScopes(["data:read"], ["data:read", "data:write"]), false);
  assertEquals(hasAnyScope(["data:read"], ["data:read", "data:write"]), true);
  assertEquals(hasAnyScope(["users:read"], ["data:read", "data:write"]), false);
});

Deno.test("api-keys - normalizeScopes: * wins over everything", () => {
  assertEquals(normalizeScopes(["data:read", "data:write", "*"]), ["*"]);
});

Deno.test("api-keys - normalizeScopes: data:* absorbs data:read/data:write", () => {
  const result = normalizeScopes(["data:read", "data:write", "data:delete", "data:*"]);
  assertEquals(result.includes("data:*"), true);
  assertEquals(result.includes("data:read"), false);
});

// ─── Rate limiter ──────────────────────────────────────────────────────────

Deno.test("api-keys - rate limiter allows up to N requests per minute", async () => {
  const { manager } = await newManager();
  const { record } = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Rate-limited",
    createdBy: "test",
    requestsPerMinute: 3,
  });

  const limiter = new PerKeyRateLimiter();
  assertEquals(limiter.check(record), true);
  assertEquals(limiter.check(record), true);
  assertEquals(limiter.check(record), true);
  assertEquals(limiter.check(record), false);  // 4ta request rechazada
  assertEquals(limiter.check(record), false);
});

Deno.test("api-keys - rate limiter: 0 means no limit", () => {
  const fakeRecord: ApiKeyRecord = {
    id: "TEST0000",
    prefix: "sk",
    env: "live",
    appId: "app1",
    hash: "x",
    scopes: [],
    name: "Unlimited",
    createdAt: new Date().toISOString(),
    createdBy: "test",
    rateLimit: { requestsPerMinute: 0 },
    metadata: {},
  };
  const limiter = new PerKeyRateLimiter();
  for (let i = 0; i < 1000; i++) {
    assertEquals(limiter.check(fakeRecord), true);
  }
});

// ─── Middleware ────────────────────────────────────────────────────────────

Deno.test("api-keys - extractAndVerifyKey: reads from Authorization Bearer", async () => {
  const { manager } = await newManager();
  const limiter = new PerKeyRateLimiter();
  const { plaintext } = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Bearer test",
    createdBy: "test",
  });
  const headers = new Headers({ "authorization": `Bearer ${plaintext}` });
  const ctx = await extractAndVerifyKey(headers, manager, limiter, { audit: false });
  assertExists(ctx.record);
  assertEquals(ctx.record!.appId, "app1");
});

Deno.test("api-keys - extractAndVerifyKey: reads from X-API-Key (Parse compat)", async () => {
  const { manager } = await newManager();
  const limiter = new PerKeyRateLimiter();
  const { plaintext } = await manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "X-API-Key test",
    createdBy: "test",
  });
  const headers = new Headers({ "x-api-key": plaintext });
  const ctx = await extractAndVerifyKey(headers, manager, limiter, { audit: false });
  assertExists(ctx.record);
});

Deno.test("api-keys - extractAndVerifyKey: returns reason when no key provided", async () => {
  const { manager } = await newManager();
  const limiter = new PerKeyRateLimiter();
  const ctx = await extractAndVerifyKey(new Headers(), manager, limiter, { audit: false });
  assertEquals(ctx.reason, "no_key_provided");
  assertEquals(ctx.record, undefined);
});

Deno.test("api-keys - requireScope throws on missing scope", () => {
  assertThrows(
    () => requireScope({ record: undefined, scopes: [] }, "data:write"),
    Error,
    "AUTH_REQUIRED",
  );
});

Deno.test("api-keys - requireScope throws on insufficient scope", () => {
  const fakeRec: ApiKeyRecord = {
    id: "TEST0001",
    prefix: "pk",
    env: "live",
    appId: "app1",
    hash: "x",
    scopes: ["data:read"],
    name: "Read-only",
    createdAt: new Date().toISOString(),
    createdBy: "test",
    rateLimit: { requestsPerMinute: 100 },
    metadata: {},
  };
  assertThrows(
    () => requireScope({ record: fakeRec, scopes: ["data:read"] }, "data:write"),
    Error,
    "FORBIDDEN",
  );
});

Deno.test("api-keys - requireScope returns the record when scope is granted", () => {
  const fakeRec: ApiKeyRecord = {
    id: "TEST0002",
    prefix: "sk",
    env: "live",
    appId: "app1",
    hash: "x",
    scopes: ["data:write", "data:*"],
    name: "Writer",
    createdAt: new Date().toISOString(),
    createdBy: "test",
    rateLimit: { requestsPerMinute: 100 },
    metadata: {},
  };
  const rec = requireScope({ record: fakeRec, scopes: ["data:write", "data:*"] }, "data:write");
  assertEquals(rec.id, "TEST0002");
});
