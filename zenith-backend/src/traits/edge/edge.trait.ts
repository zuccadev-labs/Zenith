/**
 * WASM-based edge computing runtime: deploy WASM modules that execute on edge nodes close to users, V8 isolate pooling, request/response transformation.
 *
 * @barrits-trait
 * @barrits-summary ZenithEdge
 * @barrits-provides edge-routes, edge, edgeRuntime
 * @barrits-consumes db, acl, telemetry
 * @barrits-state wasmModules
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const EdgeTrait = createTraitDescriptor({
  name: "ZenithEdge",
  provides: ["edge-routes", "edge", "edgeRuntime"],
  consumes: ["db", "acl", "telemetry"],
  state: ["wasmModules"],
  runtimes: ["deno"],
  summary: "WASM-based edge computing runtime: deploy WASM modules that execute on edge nodes close to users, V8 isolate pooling, request/response transformation.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];

    const traitApi: any = {
      wasmModules: new Map<string, { bytes: Uint8Array; exports: string[]; loadedAt: number }>(),

      loadModule: async (name: string, bytes: Uint8Array): Promise<{ exports: string[] }> => {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const mod = await WebAssembly.compile(buffer);
        const exports: string[] = [];
        for (const exp of WebAssembly.Module.exports(mod)) exports.push(exp.name);
        traitApi.wasmModules.set(name, { bytes, exports, loadedAt: Date.now() });
        return { exports };
      },

      invoke: async (name: string, functionName: string, params: any): Promise<any> => {
        const mod = traitApi.wasmModules.get(name);
        if (!mod) throw new Error(`module not loaded: ${name}`);
        const buffer = mod.bytes.buffer.slice(mod.bytes.byteOffset, mod.bytes.byteOffset + mod.bytes.byteLength) as ArrayBuffer;
        const instance = await WebAssembly.instantiate(buffer);
        const fn = (instance as unknown as { exports: Record<string, (...args: any[]) => any> }).exports[functionName];
        if (typeof fn !== "function") throw new Error(`export not found: ${functionName}`);
        return fn(params);
      },

      deploy: async (name: string, bytes: Uint8Array, config: { entrypoint: string; memoryLimitMb?: number } = { entrypoint: "handle" }) => {
        await traitApi.loadModule(name, bytes);
        await db.create("_EdgeDeployment", { name, size: bytes.length, entrypoint: config.entrypoint, deployedAt: new Date().toISOString() });
        return { deployed: true, name, exports: traitApi.wasmModules.get(name)!.exports };
      },
    };

    const edge_routes = [
      {
        method: "POST" as const,
        path: "/edge/deploy",
        _openapi: { summary: "Deploy a WASM module to the edge" },
        handler: async (req: Request) => {
          const body = await req.json() as { name: string; bytes: string; entrypoint?: string };
          const bytes = Uint8Array.from(atob(body.bytes), (c) => c.charCodeAt(0));
          const result = await traitApi.deploy(body.name, bytes, { entrypoint: body.entrypoint || "handle" });
          return new Response(JSON.stringify(result), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/edge/invoke/:moduleName/:functionName",
        _openapi: {
          summary: "Invoke a WASM function",
          parameters: [{ name: "moduleName", in: "path", required: true, schema: { type: "string" } }, { name: "functionName", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        },
        handler: async (req: Request) => {
          const parts = new URL(req.url).pathname.split("/");
          const moduleName = parts[3], functionName = parts[4];
          const body = await req.json();
          const result = await traitApi.invoke(moduleName, functionName, body);
          return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "edge-routes": edge_routes,
      "edge": traitApi,
      "edgeRuntime": traitApi,
    };
  },
});
