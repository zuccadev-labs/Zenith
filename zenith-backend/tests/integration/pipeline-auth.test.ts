/**
 * Tests de integración del nuevo flujo de autenticación en el pipeline.
 *
 * Cubre:
 *   - API key válida (Bearer / X-API-Key) → ctx.apiKey presente, masterKey undefined
 *   - API key inválida → ctx.apiKeyRejected con motivo, masterKey fallback
 *   - Sin API key, master key correcta desde localhost → masterKey true
 *   - Sin API key, master key desde IP externa → bloqueado
 *   - Sin nada → ctx.apiKey undefined, ctx.masterKey undefined
 *   - Bootstrap: crea sk_live automáticamente en dev si no hay keys
 *   - Producción: NO bootstrap, fuerza al operador a crear keys
 *   - Backward compat: Parse-Server headers (X-Parse-Master-Key) siguen funcionando
 *
 * Estos tests NO levantan un servidor real; ejecutan `extractContext`
 * directamente como una función pura (es un factory que retorna PipelineStep).
 */

// deno-lint-ignore-file no-unused-vars
import { assertEquals, assertExists, type assertNotEquals, assertStrictEquals } from "@std/assert";
import { extractContext } from "../../src/core/pipeline.ts";
import { ApiKeyManager } from "../../src/security/api-keys/manager.ts";
import { InMemoryStore } from "../../src/security/api-keys/store.ts";
import { PerKeyRateLimiter } from "../../src/security/api-keys/middleware.ts";
import { bootstrapApiKey } from "../../src/security/api-keys/bootstrap.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface TestRig {
  manager: ApiKeyManager;
  rateLimiter: PerKeyRateLimiter;
  configMasterKey: string;
  publicKey: string;
}

async function newRig(): Promise<TestRig> {
  return {
    manager: new ApiKeyManager(new InMemoryStore()),
    rateLimiter: new PerKeyRateLimiter(),
    configMasterKey: "x".repeat(64),  // 64 chars (cumple minLength de Phase 0.B)
    publicKey: "-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----",
  };
}

function makeRequest(opts: {
  headers?: Record<string, string>;
  url?: string;
  socketIp?: string;
}): Request {
  const req = new Request(opts.url ?? "http://localhost/parse/health", {
    headers: opts.headers ?? {},
  });
  (req as any).__socketAddr = { hostname: opts.socketIp ?? "127.0.0.1" };
  return req;
}

const PIPELINE_BASE_CTX = {} as any;

// ─── Tests: API key auth ────────────────────────────────────────────────────

Deno.test("integration - API key válida via Bearer autentica la request", async () => {
  const rig = await newRig();
  const { plaintext } = await rig.manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read", "data:write"],
    name: "Test",
    createdBy: "test",
  });

  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });

  const req = makeRequest({
    headers: { "authorization": `Bearer ${plaintext}` },
    socketIp: "203.0.113.42",  // IP externa
  });
  const ctx = await step(req, PIPELINE_BASE_CTX);

  assertExists(ctx.apiKey);
  assertEquals(ctx.apiKey.id.length, 8);
  assertEquals(ctx.apiKey.id.length, 8);
  assertEquals(ctx.apiKey.prefix, "sk");
  assertEquals(ctx.apiKey.env, "live");
  assertEquals(ctx.apiKey.appId, "app1");
  assertEquals(ctx.apiKey.scopes, ["data:read", "data:write"]);
  assertStrictEquals(ctx.masterKey, undefined);  // NO se setea masterKey
  assertEquals(ctx.apiKeyRejected, undefined);     // tampoco rejected
});

Deno.test("integration - API key válida via X-API-Key (Parse-Server compat)", async () => {
  const rig = await newRig();
  const { plaintext } = await rig.manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Test",
    createdBy: "test",
  });

  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });

  const req = makeRequest({
    headers: { "x-api-key": plaintext },
  });
  const ctx = await step(req, PIPELINE_BASE_CTX);
  assertExists(ctx.apiKey);
});

Deno.test("integration - API key con scope * autentica como super admin, solo desde su lista de IP (ADR-015)", async () => {
  const rig = await newRig();
  const { plaintext } = await rig.manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["*"],
    name: "Super admin",
    createdBy: "test",
    allowedIps: ["127.0.0.1"],
    expiresIn: "30d",
  });

  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });

  const req = makeRequest({ headers: { "authorization": `Bearer ${plaintext}` } });
  const ctx = await step(req, PIPELINE_BASE_CTX);
  assertExists(ctx.apiKey);
  assertEquals(ctx.apiKey.scopes, ["*"]);

  const outside = await step(makeRequest({ headers: { "authorization": `Bearer ${plaintext}` }, socketIp: "203.0.113.9" }), PIPELINE_BASE_CTX);
  assertEquals(outside.apiKey, undefined, "outside its allowlist the key is not a credential");
  assertEquals(outside.apiKeyRejected, "ip_not_allowed");
});

// ─── Tests: API key inválida → master key fallback ─────────────────────────

Deno.test("integration - API key malformada: ctx.apiKeyRejected=malformed, masterKey fallback", async () => {
  const rig = await newRig();
  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });

  const req = makeRequest({
    headers: {
      "authorization": "Bearer not-a-real-key",
      "x-parse-master-key": rig.configMasterKey,  // master key presente
    },
  });
  const ctx = await step(req, PIPELINE_BASE_CTX);

  assertEquals(ctx.apiKey, undefined);
  assertEquals(ctx.apiKeyRejected, "malformed");
  assertEquals(ctx.masterKey, true);  // master key granted (estamos en localhost)
});

Deno.test("integration - API key con secret incorrecto: ctx.apiKeyRejected=wrong_secret", async () => {
  const rig = await newRig();
  const { record } = await rig.manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Test",
    createdBy: "test",
  });
  // Construir una key con el mismo id pero secret diferente
  const tampered = `sk_live_${record.id}_${"X".repeat(32)}`;

  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });

  const req = makeRequest({ headers: { "authorization": `Bearer ${tampered}` } });
  const ctx = await step(req, PIPELINE_BASE_CTX);
  assertEquals(ctx.apiKey, undefined);
  assertEquals(ctx.apiKeyRejected, "wrong_secret");
});

Deno.test("integration - API key revocada: ctx.apiKeyRejected=revoked", async () => {
  const rig = await newRig();
  const { plaintext, record } = await rig.manager.create({
    appId: "app1",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Test",
    createdBy: "test",
  });
  await rig.manager.revoke(record.id, "admin", "test");

  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });

  const req = makeRequest({ headers: { "authorization": `Bearer ${plaintext}` } });
  const ctx = await step(req, PIPELINE_BASE_CTX);
  assertEquals(ctx.apiKeyRejected, "revoked");
});

// ─── Tests: Sin API key, master key ────────────────────────────────────────

Deno.test("integration - sin API key, master key correcta desde localhost: masterKey=true", async () => {
  const rig = await newRig();
  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });

  const req = makeRequest({
    headers: { "x-parse-master-key": rig.configMasterKey },
    socketIp: "127.0.0.1",
  });
  const ctx = await step(req, PIPELINE_BASE_CTX);
  assertEquals(ctx.masterKey, true);
  assertEquals(ctx.apiKey, undefined);
  assertEquals(ctx.apiKeyRejected, "no_key_provided");
});

Deno.test("integration - sin API key, master key desde IP externa: masterKey bloqueado", async () => {
  const rig = await newRig();
  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });

  const req = makeRequest({
    headers: { "x-parse-master-key": rig.configMasterKey },
    socketIp: "203.0.113.42",  // IP externa
  });
  // Silenciar el warning esperado
  const originalWarn = console.warn;
  console.warn = () => {};
  const ctx = await step(req, PIPELINE_BASE_CTX);
  console.warn = originalWarn;

  assertEquals(ctx.masterKey, undefined);
});

Deno.test("integration - sin API key, sin master key: todo undefined", async () => {
  const rig = await newRig();
  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });

  const req = makeRequest({ headers: {} });
  const ctx = await step(req, PIPELINE_BASE_CTX);
  assertEquals(ctx.masterKey, undefined);
  assertEquals(ctx.apiKey, undefined);
  assertEquals(ctx.apiKeyRejected, "no_key_provided");
});

// ─── Tests: Backward compat (signature vieja) ──────────────────────────────

Deno.test("integration - signature vieja (string, string, []) sigue funcionando", async () => {
  const step = extractContext("x".repeat(64), undefined, []);
  const req = makeRequest({});
  const ctx = await step(req, PIPELINE_BASE_CTX);
  assertEquals(ctx.masterKey, undefined);
  assertEquals(ctx.apiKey, undefined);
  // Sin apiKeyManager, ctx.apiKeyRejected queda undefined
  assertEquals(ctx.apiKeyRejected, undefined);
});

// ─── Tests: Bootstrap ──────────────────────────────────────────────────────

Deno.test("integration - bootstrap: crea sk_live automáticamente en dev si no hay keys", async () => {
  const rig = await newRig();
  const result = await bootstrapApiKey(rig.manager, { appId: "freshApp" });
  assertEquals(result.created, true);
  assertExists(result.plaintext);
  assertStringIncludes(result.plaintext, "sk_live_");
  assertEquals(result.keyId.length, 8);

  // La key está en el store
  const keys = await rig.manager.listByApp("freshApp");
  assertEquals(keys.length, 1);
  assertEquals(keys[0].scopes, ["*"]);
});

Deno.test("integration - bootstrap: NO crea en producción (--mode=production)", async () => {
  const rig = await newRig();
  // Simular modo producción
  const originalArgs = Deno.args;
  // @ts-ignore - manipulación directa
  Deno.args = ["--mode=production"];
  const originalEnv = Deno.env.get("ZENITH_MODE");
  Deno.env.set("ZENITH_MODE", "production");

  try {
    const result = await bootstrapApiKey(rig.manager, { appId: "prodApp" });
    assertEquals(result.created, false);
    assertEquals(result.keyId, "");

    const keys = await rig.manager.listByApp("prodApp");
    assertEquals(keys.length, 0);
  } finally {
    // @ts-ignore
    Deno.args = originalArgs;
    if (originalEnv) Deno.env.set("ZENITH_MODE", originalEnv);
    else Deno.env.delete("ZENITH_MODE");
  }
});

Deno.test("integration - bootstrap: si ya hay key, no crea otra (idempotente)", async () => {
  const rig = await newRig();
  await rig.manager.create({
    appId: "existing",
    prefix: "sk",
    env: "live",
    scopes: ["data:read"],
    name: "Pre-existing",
    createdBy: "test",
  });

  const result = await bootstrapApiKey(rig.manager, { appId: "existing" });
  assertEquals(result.created, false);
  assertExists(result.keyId);

  const keys = await rig.manager.listByApp("existing");
  assertEquals(keys.length, 1);  // solo la original
});

// ─── Tests: appId propagation ──────────────────────────────────────────────

Deno.test("integration - appId se extrae de Zen-Application-Id header", async () => {
  const rig = await newRig();
  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });
  const req = makeRequest({ headers: { "zen-application-id": "myApp42" } });
  const ctx = await step(req, PIPELINE_BASE_CTX);
  assertEquals(ctx.appId, "myApp42");
});

Deno.test("integration - appId fallback a X-Parse-Application-Id (compat)", async () => {
  const rig = await newRig();
  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });
  const req = makeRequest({ headers: { "x-parse-application-id": "myApp42" } });
  const ctx = await step(req, PIPELINE_BASE_CTX);
  assertEquals(ctx.appId, "myApp42");
});

Deno.test("integration - appId fallback a query param ?appId=", async () => {
  const rig = await newRig();
  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });
  const req = makeRequest({ url: "http://localhost/parse/health?appId=myApp42" });
  const ctx = await step(req, PIPELINE_BASE_CTX);
  assertEquals(ctx.appId, "myApp42");
});

// ─── Tests: IP resolution ──────────────────────────────────────────────────

Deno.test("integration - IP se lee del socket (H-02), no de X-Forwarded-For sin trustedProxies", async () => {
  const rig = await newRig();
  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    audit: false,
  });

  // Atacante intenta spoof: socket=externa, X-Forwarded-For=127.0.0.1
  // Sin trustedProxies configurados, X-Forwarded-For debe ser IGNORADO
  const req = makeRequest({
    headers: {
      "x-forwarded-for": "127.0.0.1",
      "x-parse-master-key": rig.configMasterKey,
    },
    socketIp: "203.0.113.42",
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  const ctx = await step(req, PIPELINE_BASE_CTX);
  console.warn = originalWarn;

  // El master key debe ser rechazado porque la IP real es externa
  assertEquals(ctx.masterKey, undefined);
});

Deno.test("integration - IP se confía en X-Forwarded-For si el socket está en trustedProxies", async () => {
  const rig = await newRig();
  const step = extractContext({
    configMasterKey: rig.configMasterKey,
    apiKeyManager: rig.manager,
    rateLimiter: rig.rateLimiter,
    trustedProxies: ["10.0.0.5"],  // ALB o nginx
    audit: false,
  });

  // El socket es 10.0.0.5 (ALB). X-Forwarded-For trae la IP real del cliente.
  const req = makeRequest({
    headers: {
      "x-forwarded-for": "127.0.0.1",
      "x-parse-master-key": rig.configMasterKey,
    },
    socketIp: "10.0.0.5",
  });
  const ctx = await step(req, PIPELINE_BASE_CTX);
  // El master key debe ser aceptado porque la IP resuelta es localhost
  assertEquals(ctx.masterKey, true);
});

// Helper para string includes (assertStringIncludes no está exportado en el assert usado)
function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`Expected "${actual}" to include "${expected}"`);
  }
}
