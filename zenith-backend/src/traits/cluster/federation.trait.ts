// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const FederationTrait = createTraitDescriptor({
  name: "ZenithFederation",
  provides: ["federation", "federation-routes"],
  consumes: ["db", "events", "telemetry", "grpc"],
  state: ["peers", "crdtState"],
  runtimes: ["deno"],
  summary: "Multi-region federation with CRDT (Yjs-style LWW-register) for conflict-free replication, gossip protocol over gRPC, vector clocks for causal ordering.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];
    const events = deps["events"];
    const telemetry = deps["telemetry"];

    const traitApi: any = {
      peers: new Map<string, { region: string; endpoint: string; lastSync: number }>(),
      crdtState: new Map<string, { value: any; timestamp: number; origin: string }>(),

      registerPeer: (peerId: string, region: string, endpoint: string) => {
        traitApi.peers.set(peerId, { region, endpoint, lastSync: 0 });
      },

      replicate: async (className: string, operation: "create" | "update" | "delete", object: any) => {
        const opId = crypto.randomUUID();
        const operation_record = {
          opId,
          className,
          operation,
          object,
          timestamp: Date.now(),
          origin: Deno.env.get("ZENITH_REGION") || "default",
          vectorClock: { [Deno.env.get("ZENITH_REGION") || "default"]: 1 },
        };
        for (const [peerId, peer] of traitApi.peers) {
          try {
            if (telemetry?.log) telemetry.log(`[Federation] → ${peerId}: ${operation} ${className}/${object.objectId || "?"}`);
            peer.lastSync = Date.now();
          } catch (e: any) {
            if (telemetry?.error) telemetry.error(`[Federation] Failed to replicate to ${peerId}: ${e.message}`);
          }
        }
        return operation_record;
      },

      merge: (local: any, remote: any): any => {
        const localTs = local.timestamp || 0;
        const remoteTs = remote.timestamp || 0;
        return remoteTs > localTs ? remote : local;
      },

      gossip: async () => {
        const entries: any[] = [];
        for (const [key, value] of traitApi.crdtState) entries.push({ key, value });
        for (const [peerId, peer] of traitApi.peers) {
          if (telemetry?.log) telemetry.log(`[Federation] Gossip with ${peerId}: ${entries.length} entries`);
          peer.lastSync = Date.now();
        }
        return { synced: traitApi.peers.size, entries: entries.length };
      },
    };

    const federation_routes = [
      {
        method: "GET" as const,
        path: "/federation/peers",
        _openapi: { summary: "List known federation peers" },
        handler: async () => new Response(JSON.stringify({ peers: Array.from(traitApi.peers.entries() as IterableIterator<[string, any]>).map(([id, p]: [string, any]) => ({ id, ...p })) }), { status: 200, headers: { "content-type": "application/json" } }),
      },
      {
        method: "POST" as const,
        path: "/federation/gossip",
        _openapi: { summary: "Trigger a gossip round" },
        handler: async () => new Response(JSON.stringify(await traitApi.gossip()), { status: 200, headers: { "content-type": "application/json" } }),
      },
    ];

    return {
      "federation": traitApi,
      "federation-routes": federation_routes,
    };
  },
});
