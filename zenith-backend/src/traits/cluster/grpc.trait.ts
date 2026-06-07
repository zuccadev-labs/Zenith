// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const gRPCTrait = createTraitDescriptor({
  name: "ZenithgRPC",
  provides: ["grpc", "grpc-server"],
  consumes: ["db", "acl", "telemetry", "mtls"],
  state: ["grpcServer", "mtlsConfig"],
  runtimes: ["deno"],
  summary: "gRPC server with mTLS, SPKI pinning (per ADR-002), reflection support, and protocol-buffer codecs for cluster-internal RPC and external clients.",
  create: (deps: Record<string, any>) => {
    const grpc = deps["grpc"];
    const mtls = deps["mtls"];
    const telemetry = deps["telemetry"];

    const traitApi: any = {
      grpcServer: null as any,
      mtlsConfig: null as any,

      startServer: async (port: number, services: Record<string, any> = {}) => {
        if (mtls) {
          const grpcModule = await import("@grpc/grpc-js");
          const protoLoader = await import("@grpc/proto-loader");
          const fs = await import("node:fs");
          const mtlsCreds = mtls.createServerCredentials();
          const server = new grpcModule.Server();
          for (const [name, svc] of Object.entries(services)) {
            server.addService(svc.definition, svc.implementation);
          }
          await new Promise<void>((resolve, reject) => {
            server.bindAsync(`0.0.0.0:${port}`, mtlsCreds, (err: Error | null, p: number) => {
              if (err) reject(err);
              else { traitApi.grpcServer = server; resolve(); }
            });
          });
          if (telemetry?.log) telemetry.log(`[gRPC] mTLS server listening on :${port}`);
          return { port, secure: true };
        }
        if (telemetry?.error) telemetry.error("[gRPC] mtls dependency missing - refusing to start insecure server");
        throw new Error("mTLS dependency required for gRPC server (see ADR-002)");
      },

      stopServer: async () => {
        if (traitApi.grpcServer) {
          traitApi.grpcServer.forceShutdown();
          traitApi.grpcServer = null;
        }
      },

      callService: async (address: string, serviceName: string, methodName: string, request: any) => {
        const grpcModule = await import("@grpc/grpc-js");
        const creds = mtls ? mtls.createClientCredentials(address) : grpcModule.credentials.createInsecure();
        const client = new (grpcModule as any).makeGenericClientConstructor({})(`/${serviceName}`, address, creds);
        return new Promise((resolve, reject) => {
          (client as any)[methodName](request, (err: any, response: any) => {
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
