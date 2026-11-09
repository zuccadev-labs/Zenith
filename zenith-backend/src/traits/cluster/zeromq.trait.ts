/**
 * ZeroMQ-based cluster transport for ultra-low latency inter-node messaging via Rust FFI.
 *
 * @barrits-trait
 * @barrits-summary ZenithZeroMQ
 * @barrits-provides cluster-transport
 * @barrits-consumes
 * @barrits-state zmqServerRunning
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

let clusterLib: Deno.DynamicLibrary<any> | null = null;

export const ZeroMQTrait = createTraitDescriptor({
  name: "ZenithZeroMQ",
  provides: ["cluster-transport"],
  consumes: [],
  state: ["zmqServerRunning"],
  runtimes: ["deno"],
  summary: "ZeroMQ-based cluster transport for ultra-low latency inter-node messaging via Rust FFI.",
  create: (deps: Record<string, any>) => {
    const obs = (deps.traits || deps)["telemetry"];
    const traitApi: any = {};

    traitApi.init = () => {
      if (clusterLib) return;
      try {
        const libSuffix = Deno.build.os === "windows" ? "dll" : Deno.build.os === "darwin" ? "dylib" : "so";
        const libPath = `./zenith-cluster/target/release/zenith_cluster.${libSuffix}`;

        clusterLib = Deno.dlopen(libPath, {
          "start_zmq_server": { parameters: ["pointer", "function"], result: "i32" },
          "send_zmq_message": { parameters: ["pointer", "pointer"], result: "pointer" },
          "free_string": { parameters: ["pointer"], result: "void" }
        });
        if (obs?.log) obs.log("[ZeroMQ] Native cluster library loaded successfully.");
      } catch (e) {
        if (obs?.error) obs.error(`[ZeroMQ] FAILED to load cluster library: ${e}`);
      }
    };

    traitApi.startServer = (endpoint: string): boolean => {
      if (!clusterLib) traitApi.init();
      if (!clusterLib) return false;

      const encoder = new TextEncoder();
      const endpointPtr = Deno.UnsafePointer.of(encoder.encode(endpoint + "\0"));

      const callback = new Deno.UnsafeCallback(
        { parameters: ["pointer"], result: "void" },
        (msgPtr: unknown) => {
          try {
            const view = new Deno.UnsafePointerView(msgPtr as Deno.PointerObject<unknown>);
            const msg = view.getCString();
            if (obs?.log) obs.log(`[ZeroMQ] Event received: ${msg}`);
          } catch (_e) { /* noop */ }
        }
      );

      const res = (clusterLib.symbols.start_zmq_server as (a: unknown, b: unknown) => number)(endpointPtr, callback.pointer);
      return res === 0 || res === 1; // 0 = ok, 1 = already running
    };

    traitApi.sendMessage = (endpoint: string, message: any): string => {
      if (!clusterLib) traitApi.init();
      if (!clusterLib) return JSON.stringify({ error: "ZMQ Library not loaded" });

      const encoder = new TextEncoder();
      const endpointPtr = Deno.UnsafePointer.of(encoder.encode(endpoint + "\0"));
      const msgString = typeof message === "string" ? message : JSON.stringify(message);
      const msgPtr = Deno.UnsafePointer.of(encoder.encode(msgString + "\0"));

      const resPtr = (clusterLib.symbols.send_zmq_message as (a: unknown, b: unknown) => Deno.UnsafePointer)(endpointPtr, msgPtr);
      if (!resPtr) return JSON.stringify({ error: "FFI return null" });

      const view = new Deno.UnsafePointerView(resPtr as Deno.PointerObject<unknown>);
      const resString = view.getCString();

      (clusterLib.symbols.free_string as (a: unknown) => void)(resPtr);
      return resString;
    };

    if ((globalThis as any).Zen) {
       (globalThis as any).Zen.Cluster = {
           send: async (endpoint: string, payload: any) => traitApi.sendMessage(endpoint, payload)
       };
    }

    return { "cluster-transport": traitApi };
  }
});
