/**
 * The real engine-auth for Zenith's integration tests: its binary, its FFI library and a temporary
 * state directory. Needs ENGINE_AUTH_BIN and ZUTOOL_LIB_DIR (see engine-auth.test.ts).
 */
import { assert } from "@std/assert";

export const BIN = Deno.env.get("ENGINE_AUTH_BIN");
export const LIB_DIR = Deno.env.get("ZUTOOL_LIB_DIR");
export const AUD = "https://zenith.example.test";
export const PASSWORD = "una frase larga y fácil";

// ─── engine-auth ─────────────────────────────────────────────────────────────

export class EngineAuth {
  constructor(readonly url: string, readonly dir: string, readonly child: Deno.ChildProcess) {}

  static async start(extra: Record<string, unknown> = {}): Promise<EngineAuth> {
    const dir = await Deno.makeTempDir({ prefix: "zenith-engine-auth-" });
    await Deno.mkdir(`${dir}/features`);
    await Deno.copyFile(`${LIB_DIR}/libzutool_auth.so`, `${dir}/features/libzutool_auth.so`);
    const built = await new Deno.Command(BIN!, {
      args: ["manifest", "build", `${dir}/features`],
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(built.success, new TextDecoder().decode(built.stderr));
    const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (l.addr as Deno.NetAddr).port;
    l.close();
    const url = `http://127.0.0.1:${port}`;
    const cfg = {
      issuer: url,
      bind: [`127.0.0.1:${port}`],
      signup: "open",
      trustedProxies: ["127.0.0.1"],
      clients: [{
        id: "zenith",
        name: "Zenith",
        redirectUris: ["http://127.0.0.1/cb"],
        audiences: [AUD, "https://otro.example.test"],
        firstParty: true,
      }],
      ...extra,
    };
    await Deno.writeTextFile(`${dir}/config.json`, JSON.stringify(cfg));
    const log = await Deno.open(`${dir}/engine.log`, { write: true, create: true });
    const child = new Deno.Command(BIN!, {
      args: ["--state-dir", dir, "--manifest", `${dir}/features/features.json`, "serve"],
      stdout: "null",
      stderr: "piped",
    }).spawn();
    child.stderr.pipeTo(log.writable).catch(() => {});
    const t = Date.now();
    for (;;) {
      try {
        if ((await fetch(`${url}/healthz`)).ok) break;
      } catch { /* not yet */ }
      if (Date.now() - t > 20_000) {
        throw new Error(
          `engine-auth did not start: ${await Deno.readTextFile(`${dir}/engine.log`)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return new EngineAuth(url, dir, child);
  }

  async cli(args: string[], stdin = ""): Promise<{ ok: boolean; out: any }> {
    const p = new Deno.Command(BIN!, {
      args: [
        "--state-dir",
        this.dir,
        "--manifest",
        `${this.dir}/features/features.json`,
        "-o",
        "json",
        ...args,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
    const o = await p.output();
    let out: any = null;
    try {
      out = JSON.parse(new TextDecoder().decode(o.stdout));
    } catch { /* none */ }
    return { ok: o.success, out };
  }

  async stop() {
    try {
      this.child.kill("SIGTERM");
    } catch { /* gone */ }
    await this.child.status;
    await Deno.remove(this.dir, { recursive: true }).catch(() => {});
  }
}
