/**
 * Tests del VaultClient (HTTP API).
 *
 * Estrategia:
 *   - **Unit tests**: mockean `globalThis.fetch` para validar paths,
 *     headers, parsing de responses, retry+backoff. Corren siempre.
 *   - **Integration tests**: requieren un Vault real (Docker: `vault dev`).
 *     Se skipean si `VAULT_TEST_ADDR` no está configurado.
 *
 * Para correr los integration tests:
 *   docker run -d --name zenith-test-vault -p 8200:8200 \
 *     -e VAULT_DEV_ROOT_TOKEN_ID=root -e VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200 \
 *     hashicorp/vault:1.16
 *   VAULT_TEST_ADDR=https://localhost:8200 VAULT_TEST_TOKEN=root \
 *     deno test --allow-all tests/unit/vault-client.test.ts
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { VaultClient, type VaultLogger } from "../../src/security/secrets/vault-client.ts";

const silent: VaultLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ── Constructor validation ─────────────────────────────────────────────────

Deno.test("VaultClient: requires HTTPS", () => {
  assertThrows(() => new VaultClient({ address: "http://vault:8200" }), Error, "HTTPS");
});

Deno.test("VaultClient: requires address", () => {
  assertThrows(() => new VaultClient({ address: "" }), Error, "address is required");
});

Deno.test("VaultClient: rejects invalid URL", () => {
  assertThrows(() => new VaultClient({ address: "not-a-url" }), Error, "not a valid URL");
});

// ── Mock fetch helper ──────────────────────────────────────────────────────

interface MockRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function makeMockFetch(handler: (req: MockRequest) => Response | Promise<Response>) {
  const calls: MockRequest[] = [];
  const fetchImpl = async (url: any, init: any = {}): Promise<Response> => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const req: MockRequest = {
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers as Record<string, string>) ?? {},
      body,
    };
    calls.push(req);
    return await handler(req);
  };
  return { fetchImpl, calls };
}

// ── KV v2 ──────────────────────────────────────────────────────────────────

Deno.test("VaultClient: kvGet constructs correct path", async () => {
  const { fetchImpl, calls } = makeMockFetch(() =>
    new Response(
      JSON.stringify({
        data: {
          data: { foo: "bar" },
          metadata: { version: 1, created_time: "2026-06-06", deletion_time: "", destroyed: false },
        },
      }),
      { status: 200 },
    )
  );

  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl,
    logger: silent,
  });
  const res = await client.kvGet("zenith/jwt-keys");

  assert(res);
  assertEquals((res!.data as any).foo, "bar");
  assertEquals(res!.metadata.version, 1);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://vault:8200/v1/secret/data/zenith/jwt-keys");
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].headers["X-Vault-Token"], "tok");
});

Deno.test("VaultClient: kvGet with version param", async () => {
  const { fetchImpl, calls } = makeMockFetch(() => new Response("{}", { status: 200 }));
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl,
    logger: silent,
  });
  await client.kvGet("zenith/jwt-keys", 3);
  assertEquals(calls[0].url, "https://vault:8200/v1/secret/data/zenith/jwt-keys?version=3");
});

Deno.test("VaultClient: kvGet returns null on 404", async () => {
  const fetchImpl = async () => new Response('{"errors":["not found"]}', { status: 404 });
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl: fetchImpl as any,
    logger: silent,
  });
  const res = await client.kvGet("missing");
  assertEquals(res, null);
});

Deno.test("VaultClient: kvPut sends data and returns version", async () => {
  const { fetchImpl, calls } = makeMockFetch(() =>
    new Response(
      JSON.stringify({
        data: { version: 7 },
      }),
      { status: 200 },
    )
  );
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl,
    logger: silent,
  });
  const { version } = await client.kvPut("zenith/key", { foo: "bar" });
  assertEquals(version, 7);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].url, "https://vault:8200/v1/secret/data/zenith/key");
  assertEquals(calls[0].body.data.foo, "bar");
});

Deno.test("VaultClient: kvList uses LIST method", async () => {
  const { fetchImpl, calls } = makeMockFetch(() =>
    new Response(
      JSON.stringify({
        data: { keys: ["a", "b", "c"] },
      }),
      { status: 200 },
    )
  );
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl,
    logger: silent,
  });
  const keys = await client.kvList("zenith");
  assertEquals(keys, ["a", "b", "c"]);
  assertEquals(calls[0].method, "LIST");
  assertEquals(calls[0].url, "https://vault:8200/v1/secret/metadata/zenith");
});

Deno.test("VaultClient: kvList returns [] on 404", async () => {
  const fetchImpl = async () => new Response("not found", { status: 404 });
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl: fetchImpl as any,
    logger: silent,
  });
  const keys = await client.kvList("missing");
  assertEquals(keys, []);
});

// ── Auth ───────────────────────────────────────────────────────────────────

Deno.test("VaultClient: loginAppRole sends correct body and stores token", async () => {
  const { fetchImpl, calls } = makeMockFetch(() =>
    new Response(
      JSON.stringify({
        auth: {
          client_token: "hvs.newtoken",
          accessor: "acc",
          ttl: 3600,
          policies: ["default", "zenith"],
          renewable: true,
          expire_time: 9999999999,
        },
      }),
      { status: 200 },
    )
  );
  const client = new VaultClient({ address: "https://vault:8200", fetchImpl, logger: silent });
  const info = await client.loginAppRole("role-1", "secret-1");
  assertEquals(info.ttl, 3600);
  assertEquals(info.renewable, true);
  // Login request must NOT include token header
  assertEquals(calls[0].headers["X-Vault-Token"], undefined);
  assertEquals(calls[0].url, "https://vault:8200/v1/auth/approle/login");
  assertEquals(calls[0].body.role_id, "role-1");
  assertEquals(calls[0].body.secret_id, "secret-1");
  // Subsequent request should use the new token
  const fetch2 = makeMockFetch((req) => {
    if (req.url.includes("/auth/approle/login")) {
      return new Response(
        JSON.stringify({
          auth: {
            client_token: "hvs.tok2",
            accessor: "a2",
            ttl: 3600,
            policies: [],
            renewable: true,
            expire_time: 0,
          },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        data: { accessor: "a2", ttl: 3600, policies: [], renewable: true, expire_time: 0 },
      }),
      { status: 200 },
    );
  });
  const client2 = new VaultClient({
    address: "https://vault:8200",
    fetchImpl: fetch2.fetchImpl,
    logger: silent,
  });
  await client2.loginAppRole("r", "s");
  await client2.lookupSelf();
  assertEquals(fetch2.calls[1].headers["X-Vault-Token"], "hvs.tok2");
});

Deno.test("VaultClient: loginUserpass uses PUT method", async () => {
  const { fetchImpl, calls } = makeMockFetch(() =>
    new Response(
      JSON.stringify({
        auth: { client_token: "tok", ttl: 60, policies: [], renewable: false, expire_time: 0 },
      }),
      { status: 200 },
    )
  );
  const client = new VaultClient({ address: "https://vault:8200", fetchImpl, logger: silent });
  await client.loginUserpass("alice", "pass");
  assertEquals(calls[0].method, "PUT");
  assertEquals(calls[0].url, "https://vault:8200/v1/auth/userpass/login/alice");
  assertEquals(calls[0].body.password, "pass");
});

Deno.test("VaultClient: requires auth header on protected endpoints", async () => {
  const client = new VaultClient({ address: "https://vault:8200", logger: silent });
  await assertRejects(() => client.kvGet("path"), Error, "No token set");
});

// ── PKI ────────────────────────────────────────────────────────────────────

Deno.test("VaultClient: pkiIssue constructs correct request", async () => {
  const { fetchImpl, calls } = makeMockFetch(() =>
    new Response(
      JSON.stringify({
        data: {
          certificate: "-----BEGIN CERTIFICATE-----\n...",
          issuing_ca: "-----BEGIN CERTIFICATE-----\n...",
          ca_chain: ["c1", "c2"],
          private_key: "-----BEGIN RSA PRIVATE KEY-----\n...",
          private_key_type: "rsa",
          serial_number: "00:11:22",
          expiration: 9999999999,
        },
      }),
      { status: 200 },
    )
  );
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl,
    logger: silent,
  });
  const res = await client.pkiIssue("internal", "zenith.example.com", {
    altNames: ["api.zenith.example.com"],
    ipSans: ["10.0.0.1"],
    ttl: "720h",
  });
  assert(res.certificate.startsWith("-----BEGIN"));
  assertEquals(calls[0].url, "https://vault:8200/v1/pki/issue/internal");
  assertEquals(calls[0].body.common_name, "zenith.example.com");
  assertEquals(calls[0].body.alt_names, "api.zenith.example.com");
  assertEquals(calls[0].body.ip_sans, "10.0.0.1");
  assertEquals(calls[0].body.ttl, "720h");
  assertEquals(calls[0].body.format, "pem");
});

// ── Transit ────────────────────────────────────────────────────────────────

Deno.test("VaultClient: transitEncrypt base64-encodes plaintext", async () => {
  const { fetchImpl, calls } = makeMockFetch(() =>
    new Response(
      JSON.stringify({
        data: { ciphertext: "vault:v1:abc123" },
      }),
      { status: 200 },
    )
  );
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl,
    logger: silent,
  });
  const ct = await client.transitEncrypt("my-key", "hello world");
  assertEquals(ct, "vault:v1:abc123");
  assertEquals(calls[0].url, "https://vault:8200/v1/transit/encrypt/my-key");
  // plaintext="hello world" → base64="aGVsbG8gd29ybGQ="
  assertEquals(calls[0].body.plaintext, "aGVsbG8gd29ybGQ=");
});

Deno.test("VaultClient: transitDecrypt returns decoded plaintext", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: { plaintext: "aGVsbG8gd29ybGQ=" }, // base64("hello world")
      }),
      { status: 200 },
    );
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl: fetchImpl as any,
    logger: silent,
  });
  const pt = await client.transitDecrypt("my-key", "vault:v1:abc");
  assertEquals(pt, "hello world");
});

// ── Retry / backoff ────────────────────────────────────────────────────────

Deno.test("VaultClient: 5xx triggers retry with backoff", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    if (attempts < 3) return new Response("server error", { status: 503 });
    return new Response(
      JSON.stringify({
        data: {
          data: { foo: "bar" },
          metadata: { version: 1, created_time: "", deletion_time: "", destroyed: false },
        },
      }),
      { status: 200 },
    );
  };
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl: fetchImpl as any,
    maxRetries: 5,
    logger: silent,
  });
  const res = await client.kvGet("path");
  assert(res);
  assertEquals(attempts, 3);
});

Deno.test("VaultClient: 4xx (non-429) drops without retry", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    return new Response("forbidden", { status: 403 });
  };
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl: fetchImpl as any,
    logger: silent,
  });
  await assertRejects(() => client.kvGet("path"), Error, "403");
  assertEquals(attempts, 1);
});

Deno.test("VaultClient: 429 triggers retry", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    if (attempts < 2) return new Response("", { status: 429 });
    return new Response(
      JSON.stringify({
        data: { accessor: "a", ttl: 60, policies: [], renewable: false, expire_time: 0 },
      }),
      { status: 200 },
    );
  };
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl: fetchImpl as any,
    logger: silent,
  });
  await client.lookupSelf();
  assertEquals(attempts, 2);
});

// ── Headers ────────────────────────────────────────────────────────────────

Deno.test("VaultClient: namespace header set when configured", async () => {
  const { fetchImpl, calls } = makeMockFetch(() => new Response("{}", { status: 200 }));
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    namespace: "my-ns",
    fetchImpl,
    logger: silent,
  });
  await client.kvGet("path");
  assertEquals(calls[0].headers["X-Vault-Namespace"], "my-ns");
});

Deno.test("VaultClient: User-Agent set", async () => {
  const { fetchImpl, calls } = makeMockFetch(() => new Response("{}", { status: 200 }));
  const client = new VaultClient({
    address: "https://vault:8200",
    token: "tok",
    fetchImpl,
    logger: silent,
  });
  await client.kvGet("path");
  assert(calls[0].headers["User-Agent"]?.startsWith("zenith-core/"));
});

// ── Integration tests (requieren Vault real) ───────────────────────────────

const TEST_ADDR = Deno.env.get("VAULT_TEST_ADDR");
const TEST_TOKEN = Deno.env.get("VAULT_TEST_TOKEN");
const HAS_VAULT = !!TEST_ADDR;

if (!HAS_VAULT) {
  Deno.test({
    name:
      "VaultClient: integration tests SKIPPED (set VAULT_TEST_ADDR + VAULT_TEST_TOKEN to enable)",
    ignore: true,
    fn: () => {},
  });
} else {
  Deno.test("VaultClient: roundtrip kvPut → kvGet with real Vault", async () => {
    const client = new VaultClient({ address: TEST_ADDR!, token: TEST_TOKEN!, logger: silent });
    const path = `zenith/test/${Date.now()}/kv`;
    const { version } = await client.kvPut(path, { greeting: "hello", n: 42 });
    assertEquals(version, 1);
    const got = await client.kvGet(path);
    assert(got);
    assertEquals((got!.data as any).greeting, "hello");
    assertEquals((got!.data as any).n, 42);
    await client.kvDelete(path);
  });

  Deno.test("VaultClient: lookupSelf returns valid token info", async () => {
    // The dev root token never expires (ttl 0, no expire_time): a child token with a TTL shows that
    // the expiry is parsed. Before, the test asserted a TTL on the root token and could never pass.
    const created = await fetch(`${TEST_ADDR}/v1/auth/token/create`, {
      method: "POST",
      headers: { "X-Vault-Token": TEST_TOKEN!, "content-type": "application/json" },
      body: JSON.stringify({ ttl: "1h", policies: ["default"] }),
    });
    const child = (await created.json()).auth.client_token as string;
    const info = await new VaultClient({ address: TEST_ADDR!, token: child, logger: silent })
      .lookupSelf();
    assert(info.ttl > 3000 && info.ttl <= 3600, `ttl ${info.ttl}`);
    const root = await new VaultClient({ address: TEST_ADDR!, token: TEST_TOKEN!, logger: silent })
      .lookupSelf();
    assertEquals(root.ttl, 0, "the root token does not expire");
  });

  Deno.test("VaultClient: kvList returns keys", async () => {
    const client = new VaultClient({ address: TEST_ADDR!, token: TEST_TOKEN!, logger: silent });
    const prefix = `zenith/test/${Date.now()}`;
    await client.kvPut(`${prefix}/a`, { x: 1 });
    await client.kvPut(`${prefix}/b`, { x: 2 });
    const keys = await client.kvList(prefix);
    assert(keys.length >= 2);
    for (const k of keys) {
      await client.kvDelete(`${prefix}/${k.replace(/\/$/, "")}`);
    }
  });
}
