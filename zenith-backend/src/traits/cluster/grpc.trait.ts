/**
 * gRPC server with mTLS, SPKI pinning (per ADR-002), reflection support, and protocol-buffer codecs for cluster-internal RPC and external clients.
 *
 * @barrits-trait
 * @barrits-summary ZenithgRPC
 * @barrits-provides grpc, grpc-server
 * @barrits-consumes db, acl, telemetry, mtls
 * @barrits-state grpcServer, mtlsConfig
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const gRPCTrait = createTraitDescriptor({
  name: "ZenithgRPC",
  provides: ["grpc", "grpc-server"],
  consumes: ["db", "acl", "telemetry", "mtls"],
  state: ["grpcServer", "mtlsConfig"],
  runtimes: ["deno"],
  summary: "gRPC server with mTLS, SPKI pinning (per ADR-002), reflection support, and protocol-buffer codecs for cluster-internal RPC and external clients.",
  create: (deps: Record<string, unknown>) => {
    const mtls = deps["mtls"];
    const telemetry = deps["telemetry"];

    const isDevMode = Deno.args.includes("--mode=development") || Deno.env.get("ZENITH_MODE") === "development";

    const traitApi = {
      grpcServer: null as unknown,
      mtlsConfig: null as unknown,

      startServer: async (port: number, services: Record<string, unknown> = {}) => {
        const grpcModule = await import("@grpc/grpc-js");
        const protoLoader = await import("@grpc/proto-loader");
        const server = new grpcModule.Server();

        for (const [name, svc] of Object.entries(services)) {
          const typedSvc = svc as { definition: unknown; implementation: unknown };
          server.addService(typedSvc.definition, typedSvc.implementation);
        }

        if (mtls) {
          const mtlsCreds = mtls.createServerCredentials();
          await new Promise<void>((resolve, reject) => {
            server.bindAsync(`0.0.0.0:${port}`, mtlsCreds, (err: Error | null, _p: number) => {
              if (err) reject(err);
              else { traitApi.grpcServer = server; resolve(); }
            });
          });
          if (telemetry && typeof telemetry === "object" && "log" in telemetry) {
            (telemetry as { log: (msg: string) => void }).log(`[gRPC] mTLS server listening on :${port}`);
          }
          return { port, secure: true };
        }

        if (isDevMode) {
          const insecureCreds = grpcModule.ServerCredentials.createInsecure();
          await new Promise<void>((resolve, reject) => {
            server.bindAsync(`0.0.0.0:${port}`, insecureCreds, (err: Error | null, _p: number) => {
              if (err) reject(err);
              else { traitApi.grpcServer = server; resolve(); }
            });
          });
          console.warn(`[gRPC] ⚠️ Development mode: INSECURE gRPC server listening on :${port}. Do NOT use in production.`);
          return { port, secure: false };
        }

        throw new Error("mTLS dependency required for gRPC server (see ADR-002). For development, run with --mode=development.");
      },

      stopServer: async () => {
        if (traitApi.grpcServer) {
          (traitApi.grpcServer as { forceShutdown: () => void }).forceShutdown();
          traitApi.grpcServer = null;
        }
      },

      callService: async (address: string, _serviceName: string, methodName: string, request: unknown) => {
        const grpcModule = await import("@grpc/grpc-js");
        const creds = mtls
          ? mtls.createClientCredentials(address)
          : isDevMode
            ? grpcModule.credentials.createInsecure()
            : grpcModule.credentials.createSsl();
        const client = new (grpcModule as unknown as { makeGenericClientConstructor: (ctor: unknown, name: string) => new (address: string, creds: unknown) => Record<string, (req: unknown, cb: (err: Error | null, res: unknown) => void) => void> })({}, `/${methodName}`)(address, creds);
        return new Promise((resolve, reject) => {
          client[methodName](request, (err: Error | null, response: unknown) => {
            if (err) reject(err); else resolve(response);
          });
        });
      },
    };

    return {
      "grpc": traitApi,
      "grpc-server": traitApi,
    };
  },
});
