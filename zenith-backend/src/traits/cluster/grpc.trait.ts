/**
 * gRPC server with mTLS, SPKI pinning (per ADR-002), reflection support, and protocol-buffer codecs for cluster-internal RPC and external clients.
 *
 * @barrits-trait
 * @barrits-summary ZenithgRPC
 * @barrits-provides grpc, grpc-server
 * @barrits-consumes telemetry
 * @barrits-tags uses:mtls
 * @barrits-state grpcServer, mtlsConfig
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { Buffer } from "node:buffer";

export const gRPCTrait = createTraitDescriptor({
  name: "ZenithgRPC",
  provides: ["grpc", "grpc-server"],
  consumes: ["telemetry"],
  tags: ["uses:mtls"],
  state: ["grpcServer", "mtlsConfig"],
  runtimes: ["deno"],
  summary:
    "gRPC server with mTLS, SPKI pinning (per ADR-002), reflection support, and protocol-buffer codecs for cluster-internal RPC and external clients.",
  // deno-lint-ignore no-explicit-any
  create: (deps: Record<string, any>) => {
    const mtls = deps.traits["mtls"];
    const telemetry = deps.traits["telemetry"];

    const isDevMode = Deno.args.includes("--mode=development") ||
      Deno.env.get("ZENITH_MODE") === "development";

    const traitApi = {
      grpcServer: null as unknown,
      mtlsConfig: null as unknown,

      startServer: async (port: number, services: Record<string, unknown> = {}) => {
        const grpcModule = await import("@grpc/grpc-js");
        const server = new grpcModule.Server();

        for (const [, svc] of Object.entries(services)) {
          const typedSvc = svc as {
            definition: import("@grpc/grpc-js").ServiceDefinition;
            implementation: import("@grpc/grpc-js").UntypedServiceImplementation;
          };
          server.addService(typedSvc.definition, typedSvc.implementation);
        }

        if (mtls) {
          const mtlsCreds = mtls.createServerCredentials();
          await new Promise<void>((resolve, reject) => {
            server.bindAsync(`0.0.0.0:${port}`, mtlsCreds, (err: Error | null, _p: number) => {
              if (err) reject(err);
              else {
                traitApi.grpcServer = server;
                resolve();
              }
            });
          });
          if (telemetry && typeof telemetry === "object" && "log" in telemetry) {
            (telemetry as { log: (msg: string) => void }).log(
              `[gRPC] mTLS server listening on :${port}`,
            );
          }
          return { port, secure: true };
        }

        if (isDevMode) {
          const insecureCreds = grpcModule.ServerCredentials.createInsecure();
          await new Promise<void>((resolve, reject) => {
            server.bindAsync(`0.0.0.0:${port}`, insecureCreds, (err: Error | null, _p: number) => {
              if (err) reject(err);
              else {
                traitApi.grpcServer = server;
                resolve();
              }
            });
          });
          console.warn(
            `[gRPC] ⚠️ Development mode: INSECURE gRPC server listening on :${port}. Do NOT use in production.`,
          );
          return { port, secure: false };
        }

        throw new Error(
          "mTLS dependency required for gRPC server (see ADR-002). For development, run with --mode=development.",
        );
      },

      stopServer: async () => {
        if (traitApi.grpcServer) {
          (traitApi.grpcServer as { forceShutdown: () => void }).forceShutdown();
          traitApi.grpcServer = null;
        }
      },

      /**
       * Unary call to `/<serviceName>/<methodName>` with a generic grpc-js client. Messages travel as
       * JSON, so the server side must register the method with JSON (de)serializers, not protobuf.
       */
      callService: async (
        address: string,
        serviceName: string,
        methodName: string,
        request: unknown,
      ) => {
        const grpcModule = await import("@grpc/grpc-js");
        const creds = mtls
          ? mtls.createClientCredentials(address)
          : isDevMode
          ? grpcModule.credentials.createInsecure()
          : grpcModule.credentials.createSsl();
        const client = new grpcModule.Client(address, creds);
        try {
          return await new Promise((resolve, reject) => {
            client.makeUnaryRequest(
              `/${serviceName}/${methodName}`,
              (value: unknown) => Buffer.from(JSON.stringify(value)),
              (bytes: Buffer) => JSON.parse(bytes.toString("utf8")),
              request,
              (err: Error | null, response?: unknown) => (err ? reject(err) : resolve(response)),
            );
          });
        } finally {
          client.close();
        }
      },
    };

    return {
      "grpc": traitApi,
      "grpc-server": traitApi,
    };
  },
});
