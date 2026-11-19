/**
 * The celld provider (ADR-019, experimental): the generated Wrangler project, its entry Worker (driven
 * in-process over the local provider) and the HTTP client. When the celld binary and esbuild are there
 * (`CELLD_BIN`, `ESBUILD_DIR`, or the copies under `$HOME/.cache/zutool-tmp/celld-bin`), one more test
 * runs the same project on a real `celld dev` node.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  CelldCellsClient,
  celldWranglerConfig,
  generateCelldProject,
  startCelldDev,
} from "../../src/traits/cells/celld.ts";
import { LocalCellsProvider } from "../../src/traits/cells/local.ts";
import { CellError } from "../../src/traits/cells/types.ts";
import { createCellsApi } from "../../src/traits/cells/api.ts";

const FIXTURE = new URL("../fixtures/cells/counter-cell.js", import.meta.url).pathname;

Deno.test("celld: wrangler.json declares the bindings and the SQLite migration", () => {
  const c = celldWranglerConfig({
    name: "zenith-app1",
    classes: [{ className: "Counter", binding: "COUNTER", module: FIXTURE }, {
      className: "Room",
      module: FIXTURE,
    }],
    vars: { MODE: "x" },
  });
  assertEquals(c.main, "zenith-entry.js");
  assertEquals(c.durable_objects.bindings, [
    { name: "COUNTER", class_name: "Counter" },
    { name: "Room", class_name: "Room" },
  ]);
  assertEquals(c.migrations, [{ tag: "v1", new_sqlite_classes: ["Counter", "Room"] }]);
  assertEquals(c.vars, { MODE: "x" });
  assertThrows(() => celldWranglerConfig({ name: "bad name", classes: [] }), CellError);
  assertThrows(
    () =>
      celldWranglerConfig({
        name: "a",
        classes: [{ className: "A", binding: "X", module: FIXTURE }, {
          className: "B",
          binding: "X",
          module: FIXTURE,
        }],
      }),
    CellError,
    "duplicated",
  );
});

/** The generated project, its entry imported here and served over the local provider. */
async function inProcess(token: string | null = "s3cret") {
  const dir = await Deno.makeTempDir({ prefix: "zenith-celld-" });
  const project = await generateCelldProject({
    name: "zenith-test",
    outDir: `${dir}/project`,
    classes: [{ className: "Counter", binding: "COUNTER", module: FIXTURE }],
  });
  // The entry imports cloudflare:workers (celld only); its router and the copied module run here.
  const entry = await Deno.readTextFile(project.entryPath);
  assert(entry.includes('import { DurableObject } from "cloudflare:workers"'));
  assert(entry.includes("export const Counter = zenithCell(__Zc0);"));
  const router = (await import(`file://${project.routerPath}`)).default;
  const mod = await import(`file://${project.dir}/${project.modules[FIXTURE]}`);
  const provider = new LocalCellsProvider({ dir: `${dir}/state`, hibernateAfterMs: 0 });
  provider.define("Counter", mod.Counter, { binding: "COUNTER" });
  const env = { ...provider.env(), ...(token ? { ZENITH_CELLS_TOKEN: token } : {}) };
  const worker = (input: RequestInfo | URL, init?: RequestInit) =>
    router.fetch(new Request(input, init), env) as Promise<Response>;
  return {
    project,
    provider,
    worker,
    client: (t = token ?? "x") =>
      new CelldCellsClient({ url: "http://celld.test/", token: t, fetch: worker as typeof fetch }),
    async close() {
      await provider.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("celld: the entry Worker serves RPC, fetch and ids behind the token", async () => {
  const t = await inProcess();
  try {
    assert((await Deno.readTextFile(`${t.project.dir}/.gitignore`)).includes(".dev.vars"));
    const ns = t.client().namespace<any>("COUNTER");
    const c = ns.getByName("room/1 é") as any;
    const all = await Promise.all(Array.from({ length: 20 }, () => c.increment()));
    assertEquals(new Set(all).size, 20);
    assertEquals(await c.value(), { n: 20, hits: 20, fired: 0, name: "room/1 é" });
    const e = await assertRejects(() => c.fail(), Error, "on purpose");
    assertEquals(e.name, "RangeError");
    const r = await c.fetch("http://x/a/b?q=1", { method: "POST", body: "hi" });
    assertEquals(await r.json(), { path: "/a/b", q: "1", body: "hi" });
    // Ids: the name resolves to the id celld (here, the local provider) derives.
    const resolved = await ns.resolveId(ns.idFromName("room/1 é"));
    assertEquals(resolved.id, t.provider.namespace("COUNTER").idFromName("room/1 é").toString());
    const u = await ns.newUniqueIdAsync();
    assertEquals(await (ns.get(u) as any).increment(5), 5);
    assertEquals(await (ns.get(ns.idFromString(u.toString())) as any).increment(), 6);
    assertThrows(() => ns.newUniqueId(), CellError);
    // Wrong token, unknown binding, no token configured.
    await assertRejects(() =>
      (t.client("nope").namespace("COUNTER").getByName("a") as any).value()
    );
    const res = await t.worker("http://celld.test/__zenith/cells/NOPE/name:a/rpc/value", {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
      body: "{}",
    });
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    await t.close();
  }
  const closed = await inProcess(null);
  try {
    const r = await closed.worker("http://celld.test/__zenith/cells/COUNTER/name:a/id");
    assertEquals(r.status, 503);
    await r.body?.cancel();
  } finally {
    await closed.close();
  }
});

Deno.test("celld provider: off unless marked experimental, and needs a token", async () => {
  const api = createCellsApi({ appId: "gate-test" });
  try {
    assertThrows(
      () => api.configure({ provider: "celld", celld: { url: "http://x", experimental: false } }),
      CellError,
      "experimental",
    );
    assertThrows(
      () =>
        api.configure({
          provider: "celld",
          celld: { url: "http://x", experimental: true, tokenEnv: "ZENITH_TEST_NO_SUCH_VAR" },
        }),
      CellError,
      "token",
    );
    api.configure({
      provider: "celld",
      celld: { url: "http://x", token: "t", experimental: true },
    });
    assertEquals(api.provider, "celld");
    assertEquals(api.local(), null);
    assertThrows(() => api.kv("X"), CellError, "not wired");
  } finally {
    await api.close();
  }
});

// ── Real celld ──────────────────────────────────────────────────────────────────

const HOME = Deno.env.get("HOME") ?? "";
const CELLD = Deno.env.get("CELLD_BIN") ?? `${HOME}/.cache/zutool-tmp/celld-bin/celld`;
const ESBUILD_DIR = Deno.env.get("ESBUILD_DIR") ??
  `${HOME}/.cache/zutool-tmp/celld-bin/esb/node_modules/.bin`;
const exists = (p: string) => {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
};
const haveCelld = exists(CELLD) && exists(`${ESBUILD_DIR}/esbuild`);

function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function until(cond: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting");
}

Deno.test({
  name: "celld e2e: the generated project runs on a real celld dev node",
  ignore: !haveCelld,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "zenith-celld-e2e-" });
    const token = crypto.randomUUID();
    const env = {
      PATH: `${ESBUILD_DIR}:${Deno.env.get("PATH") ?? ""}`,
      HOME,
      TMPDIR: Deno.env.get("TMPDIR") ?? `${HOME}/.cache/zutool-tmp`,
      NO_COLOR: "1",
    };
    const project = await generateCelldProject({
      name: "zenith-e2e",
      outDir: `${dir}/project`,
      classes: [{ className: "Counter", binding: "COUNTER", module: FIXTURE }],
    });
    const port = freePort();
    let node = await startCelldDev({ projectDir: project.dir, port, token, bin: CELLD, env });
    try {
      const ns = new CelldCellsClient({ url: node.url, token }).namespace<any>("COUNTER");
      const c = ns.getByName("e2e") as any;
      const all = await Promise.all(Array.from({ length: 25 }, () => c.increment()));
      assertEquals(new Set(all).size, 25, "celld serializes the cell's events");
      assertEquals((await c.value()).n, 25);
      assertEquals((await c.value()).name, "e2e");
      const r = await c.fetch(`${node.url}/x?q=7`);
      assertEquals((await r.json()).q, "7");
      const e = await assertRejects(() => c.fail(), Error, "on purpose");
      assertEquals(e.name, "RangeError");
      await c.arm(300);
      await until(async () => (await c.value()).fired === 1, 15_000);
      const resolved = await ns.resolveId(ns.idFromName("e2e"));
      assertEquals(resolved.id.length, 64);
      // Durable across a restart of the node.
      await node.close();
      node = await startCelldDev({ projectDir: project.dir, port, token, bin: CELLD, env });
      const again = new CelldCellsClient({ url: node.url, token }).namespace<any>("COUNTER");
      assertEquals(await (again.getByName("e2e") as any).value(), {
        n: 25,
        hits: 25,
        fired: 1,
        name: "e2e",
      });
      const bad = new CelldCellsClient({ url: node.url, token: "wrong" }).namespace("COUNTER");
      await assertRejects(() => (bad.getByName("e2e") as any).value(), CellError, "401");
    } finally {
      await node.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
