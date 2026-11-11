/**
 * The zen CLI: its command table (barrits), each command against a fake server, `zen init`, and
 * — with ZENITH_TEST_MONGO — a generated project served by `zen dev` end to end.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { COMMANDS, commandTable, helpText } from "../commands/registry.ts";
import { ENGINE_JSR, ENGINE_VERSION, main, runDevCommand } from "../zen.ts";

const MONGO = Deno.env.get("ZENITH_TEST_MONGO");
const tmp = () => Deno.makeTempDir({ prefix: "zen-cli-" });

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = Deno.cwd();
  Deno.chdir(dir);
  try {
    return await fn();
  } finally {
    Deno.chdir(prev);
  }
}

Deno.test("registry: one barrits trait per command, aliases, generated help", () => {
  const table = commandTable();
  const names = new Set([...table.values()].map((c) => c.name));
  assertEquals(names.size, COMMANDS.length, "every trait gives one command");
  for (
    const n of [
      "init",
      "dev",
      "compile",
      "plugins-lock",
      "api-keys",
      "agent",
      "generate",
      "plugin",
      "mtls-gen-dev",
    ]
  ) assert(table.has(n), n);
  assertEquals(table.get("plugins:lock")?.name, "plugins-lock");
  assertEquals(table.get("mtls:gen-dev")?.name, "mtls-gen-dev");
  const help = helpText("zen", "0");
  for (const n of names) assert(help.includes(`  ${n}`), `help lists ${n}`);
});

Deno.test("main: version, unknown command, and no command runs at import", async () => {
  const dir = await tmp();
  await inDir(dir, async () => {
    assertEquals(await main(["version"]), 0);
    assertEquals(await main(["no-such-command"]), 1);
  });
  // The old dispatcher imported plugins-lock, which wrote plugins.lock.json on any command.
  await assertRejects(() => Deno.stat(join(dir, "plugins.lock.json")), Deno.errors.NotFound);
});

Deno.test("plugins-lock: SHA-256 of each plugin, sorted, in the project root", async () => {
  const dir = await tmp();
  await Deno.mkdir(join(dir, "plugins"));
  await Deno.writeTextFile(join(dir, "plugins", "b.ts"), "export const b = 2;\n");
  await Deno.writeTextFile(join(dir, "plugins", "a.ts"), "export const a = 1;\n");
  await Deno.writeTextFile(join(dir, "plugins", "notes.md"), "ignored\n");
  await inDir(dir, async () => assertEquals(await main(["plugins:lock"]), 0));
  const lock = JSON.parse(await Deno.readTextFile(join(dir, "plugins.lock.json")));
  assertEquals(Object.keys(lock), ["a.ts", "b.ts"]);
  const expected = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("export const a = 1;\n")),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
  assertEquals(lock["a.ts"], expected);
  await inDir(dir, async () => assertEquals(await main(["plugins-lock", "./missing"]), 1));
});

Deno.test("init: the project structure, a random master key, never overwrites", async () => {
  const dir = await tmp();
  await inDir(dir, () => runDevCommand("init", ["miapp"]));
  const p = join(dir, "miapp");
  for (
    const f of [
      "zen.config.ts",
      ".env",
      "deno.json",
      "deno.lock",
      ".gitignore",
      "cloud/main.ts",
      "plugins/.gitkeep",
    ]
  ) {
    await Deno.stat(join(p, f));
  }
  const env = await Deno.readTextFile(join(p, ".env"));
  assertMatch(env, /^ZENITH_MASTER_KEY=[0-9a-f]{128}$/m);
  assertMatch(env, /^ZENITH_APP_ID=miapp$/m);
  if (Deno.build.os !== "windows") {
    assertEquals((await Deno.stat(join(p, ".env"))).mode! & 0o777, 0o600);
  }
  const denoJson = JSON.parse(await Deno.readTextFile(join(p, "deno.json")));
  assertMatch(denoJson.imports["@zuccadev-labs/zenith"], /zenith-backend\/src\/mod\.ts$/);
  assert(denoJson.imports["mongodb"], "the engine's import map comes along");
  const config = await Deno.readTextFile(join(p, "zen.config.ts"));
  for (const k of ['cloudCodePath: "./cloud/main.ts"', 'pluginsPath: "./plugins"']) {
    assert(config.includes(k), k);
  }
  assert((await Deno.readTextFile(join(p, ".gitignore"))).includes(".env"));

  const before = await Deno.readTextFile(join(p, ".env"));
  await assertRejects(() => inDir(p, () => runDevCommand("init", [])), Error, "ya existe");
  assertEquals(await Deno.readTextFile(join(p, ".env")), before, "nothing overwritten");
  await assertRejects(() => runDevCommand("init", ["../fuera"]), Error, "no válido");
});

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) {
    v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  }
}

Deno.test("init from JSR: the project depends on the published engine only", async () => {
  const dir = await tmp();
  await withEnv({ ZENITH_ENGINE: "jsr" }, () => inDir(dir, () => runDevCommand("init", ["pub"])));
  const denoJson = JSON.parse(await Deno.readTextFile(join(dir, "pub", "deno.json")));
  assertEquals(denoJson.imports, { "@zuccadev-labs/zenith": ENGINE_JSR });
  assertEquals(denoJson.unstable, ["kv"]);
  // No lockfile copied from a monorepo the user does not have: the first `zen dev` writes it.
  await assertRejects(() => Deno.stat(join(dir, "pub", "deno.lock")), Deno.errors.NotFound);
  await assertRejects(
    () =>
      withEnv({ ZENITH_ENGINE: "npm" }, () => inDir(dir, () => runDevCommand("init", ["otro"]))),
    Error,
    "ZENITH_ENGINE",
  );
});

Deno.test("the engine version new projects get is the engine's own", async () => {
  const engine = JSON.parse(
    await Deno.readTextFile(new URL("../../zenith-backend/deno.json", import.meta.url)),
  );
  assertEquals(ENGINE_VERSION, engine.version);
  assertEquals(ENGINE_JSR, `jsr:@zuccadev-labs/zenith@^${engine.version}`);
});

Deno.test("generate openapi: the routes the router mounts, never an empty spec", async () => {
  const dir = await tmp();
  const out = join(dir, "openapi.json");
  await inDir(dir, async () => assertEquals(await main(["generate", "openapi", "--out", out]), 0));
  const spec = JSON.parse(await Deno.readTextFile(out));
  const ops = Object.values(spec.paths as Record<string, object>).reduce(
    (n, p) => n + Object.keys(p).length,
    0,
  );
  assert(ops >= 200, `${ops} operations`);
  for (
    const p of ["/classes/{className}", "/login", "/files/{filename}", "/zen/api-keys", "/health"]
  ) assert(spec.paths[p], p);
});

/** A fake Zenith server that records what the CLI sends. */
async function withFakeServer(
  reply: (req: Request) => unknown,
  fn: (seen: { method: string; path: string; headers: Headers; body: unknown }[]) => Promise<void>,
) {
  const seen: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const body = req.body ? await req.json().catch(() => null) : null;
    seen.push({ method: req.method, path: new URL(req.url).pathname, headers: req.headers, body });
    return Response.json(reply(req) ?? {});
  });
  const env = {
    ZENITH_SERVER_URL: `http://127.0.0.1:${server.addr.port}`,
    ZENITH_APP_ID: "app1",
    ZENITH_MASTER_KEY: "k".repeat(64),
  };
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    await inDir(await tmp(), () => fn(seen));
  } finally {
    for (const [k, v] of Object.entries(old)) {
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
    await server.shutdown();
  }
}

Deno.test("api-keys: talks to /zen/api-keys on the server", async () => {
  await withFakeServer((req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "GET") return { results: [] };
    if (path.endsWith("/revoke")) return { revoked: true };
    return {
      key: "sk_test_x",
      record: { id: "abc", prefix: "sk", env: "test", appId: "app1", scopes: ["*"] },
      previous: "abc",
    };
  }, async (seen) => {
    assertEquals(
      await main([
        "api-keys",
        "create",
        "--name",
        "ci",
        "--env",
        "test",
        "--scopes",
        "data:read, data:write",
        "--allowed-ips",
        "203.0.113.10, 2001:db8::/32",
      ]),
      0,
    );
    assertEquals(await main(["api-keys", "list"]), 0);
    assertEquals(await main(["api-keys", "revoke", "--id", "abc", "--reason", "x"]), 0);
    assertEquals(await main(["api-keys", "rotate", "--id", "abc", "--grace", "2d"]), 0);
    assertEquals(seen.map((s) => `${s.method} ${s.path}`), [
      "POST /zen/api-keys",
      "GET /zen/api-keys",
      "POST /zen/api-keys/abc/revoke",
      "POST /zen/api-keys/abc/rotate",
    ]);
    assertEquals((seen[0].body as { scopes: string[] }).scopes, ["data:read", "data:write"]);
    assertEquals((seen[0].body as { allowedIps: string[] }).allowedIps, [
      "203.0.113.10",
      "2001:db8::/32",
    ]);
    assertEquals((seen[3].body as { graceHours: number }).graceHours, 48);
    assertEquals(seen[0].headers.get("x-parse-application-id"), "app1");
    assertEquals(seen[0].headers.get("x-parse-master-key"), "k".repeat(64));
    assertEquals(await main(["api-keys", "create"]), 1, "--name is required");
  });
});

Deno.test("agent: list, run and errors through /zen/agents", async () => {
  await withFakeServer((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/zen/agents") return { agents: [{ id: "ops", name: "Ops" }] };
    return { agentId: "ops", finalAnswer: "hecho", iterations: [] };
  }, async (seen) => {
    assertEquals(await main(["agent", "list"]), 0);
    assertEquals(await main(["agent", "run", "ops", "--input", "estado"]), 0);
    assertEquals(seen.map((s) => `${s.method} ${s.path}`), [
      "GET /zen/agents",
      "POST /zen/agents/ops/run",
    ]);
    assertEquals((seen[1].body as { input: string }).input, "estado");
    assertEquals(await main(["agent", "run", "ops"]), 1, "--input is required");
  });
});

Deno.test("the CLI refuses to run without a master key (no guessed default)", async () => {
  const old = Deno.env.get("ZENITH_MASTER_KEY");
  Deno.env.delete("ZENITH_MASTER_KEY");
  try {
    await inDir(await tmp(), async () => assertEquals(await main(["api-keys", "list"]), 1));
  } finally {
    if (old !== undefined) Deno.env.set("ZENITH_MASTER_KEY", old);
  }
});

Deno.test({
  name: "e2e: zen init + zen dev serve the project's cloud code",
  ignore: !MONGO,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await tmp();
    await inDir(dir, () => runDevCommand("init", ["e2e"]));
    const p = join(dir, "e2e");
    // A port the OS says is free: a random one could land on another server (the lab's services use 2xxxx).
    const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    const appId = `e2e${Date.now()}`;
    const env = (await Deno.readTextFile(join(p, ".env")))
      .replace(/^ZENITH_APP_ID=.*$/m, `ZENITH_APP_ID=${appId}`)
      .replace(
        /^ZENITH_DATABASE_URI=.*$/m,
        `ZENITH_DATABASE_URI=${MONGO}/${appId}?directConnection=true`,
      )
      .replace(/^ZENITH_PORT=.*$/m, `ZENITH_PORT=${port}`);
    await Deno.writeTextFile(join(p, ".env"), env);
    const master = env.match(/^ZENITH_MASTER_KEY=(.*)$/m)![1];
    await Deno.writeTextFile(
      join(p, "cloud", "main.ts"),
      `import { Zen } from "@zuccadev-labs/zenith";
Zen.Cloud.define("hello", (req: any) => ({ message: "hola " + (req?.params?.name ?? "mundo") }));
// Open to anyone, with its params validated (Parse validator).
Zen.Cloud.define("greet", (req: any) => "hi " + req.params.name, {
  public: true,
  fields: { name: { required: true, type: "string" } },
});
// A Zen.Cloud trigger: before, these never ran.
Zen.Cloud.beforeSave("Todo", (req: any) => {
  if (!req.object.title) throw new Error("title is required");
  req.object.slug = String(req.object.title).toLowerCase().replaceAll(" ", "-");
});
`,
    );

    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        new URL("../zen.ts", import.meta.url).pathname,
        "dev",
      ],
      cwd: p,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const out: string[] = [];
    const pump = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s.pipeThrough(new TextDecoderStream())) out.push(c);
    };
    const pumps = [pump(child.stdout), pump(child.stderr)];
    try {
      const deadline = Date.now() + 120_000;
      while (!out.join("").includes("Zenith en http")) {
        if (Date.now() > deadline) {
          throw new Error("zen dev did not start:\n" + out.join("").slice(-3000));
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: {
            "X-Parse-Application-Id": appId,
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
        });
      const r = await call("/functions/hello", { name: "zen" }, { "X-Parse-Master-Key": master });
      const text = await r.text();
      assertEquals(r.status, 200, text);
      assertMatch(text, /hola zen/);

      // Without a validator a function stays master-only (ADR-013).
      const closed = await call("/functions/hello", {});
      await closed.body?.cancel();
      assertEquals(closed.status, 401);
      // public + fields: no session needed, params validated (Parse's 142).
      const greet = await call("/functions/greet", { name: "ana" });
      assertEquals(await greet.json(), { result: "hi ana" });
      const bad = await call("/functions/greet", {});
      assertEquals(bad.status, 400);
      assertEquals((await bad.json()).code, 142);

      // The project's beforeSave runs on POST /classes: it refuses and it changes the object.
      const asMaster = { "X-Parse-Master-Key": master };
      const refused = await call("/classes/Todo", { done: false }, asMaster);
      const refusedText = await refused.text();
      assert(refused.status >= 400, refusedText);
      assertMatch(refusedText, /title is required/);
      const created = await call("/classes/Todo", { title: "Buy Milk" }, asMaster);
      const { objectId } = await created.json();
      assert(objectId, "created");
      const got = await fetch(`http://127.0.0.1:${port}/classes/Todo/${objectId}`, {
        headers: { "X-Parse-Application-Id": appId, ...asMaster },
      });
      assertEquals((await got.json()).slug, "buy-milk", "the trigger's change was saved");
    } finally {
      child.kill("SIGTERM");
      await child.status;
      await Promise.allSettled(pumps);
      // Best effort: a cleanup failure must not hide the test's own result.
      // In a clean process: inside the test runner the driver's handshake is rejected by MongoDB 9.
      const drop = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `const m = await import("npm:mongodb@^7.8.0"); const c = await new m.MongoClient(${
            JSON.stringify(MONGO)
          }).connect(); await c.db(${JSON.stringify(appId)}).dropDatabase(); await c.close();`,
        ],
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!drop.success) {
        console.warn(
          `[e2e] could not drop ${appId}: ${new TextDecoder().decode(drop.stderr).slice(0, 300)}`,
        );
      }
    }
  },
});
