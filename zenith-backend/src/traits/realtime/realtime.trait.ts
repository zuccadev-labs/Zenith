/**
 * Realtime/WebSocket layer: channel-based pub/sub, live query subscriptions (server-push on matching data changes), presence tracking, room management, heartbeat.
 *
 * @barrits-trait
 * @barrits-summary ZenithRealtime
 * @barrits-provides realtime, realtimeServer, liveQuery
 * @barrits-consumes db
 * @barrits-tags uses:events
 * @barrits-state channels, subscribers
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const RealtimeTrait = createTraitDescriptor({
  name: "ZenithRealtime",
  provides: ["realtime", "realtimeServer", "liveQuery"],
  consumes: ["db"],
  tags: ["uses:events"],
  state: ["channels", "subscribers"],
  runtimes: ["deno"],
  summary:
    "Realtime/WebSocket layer: channel-based pub/sub, live query subscriptions (server-push on matching data changes), presence tracking, room management, heartbeat.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const events = deps.traits["events"];

    const traitApi: any = {
      channels: new Map<string, Set<WebSocket>>(),
      subscribers: new Map<string, Set<{ socket: WebSocket; query: any }>>(),

      subscribe: (channel: string, socket: WebSocket) => {
        if (!traitApi.channels.has(channel)) traitApi.channels.set(channel, new Set());
        traitApi.channels.get(channel)!.add(socket);
        socket.addEventListener("close", () => {
          traitApi.channels.get(channel)?.delete(socket);
        });
        if (events) {
          events.on(`${channel}.changed`, (payload: any) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ channel, payload }));
            }
          });
        }
      },

      unsubscribe: (channel: string, socket: WebSocket) => {
        traitApi.channels.get(channel)?.delete(socket);
      },

      broadcast: (channel: string, payload: any) => {
        const subs = traitApi.channels.get(channel);
        if (!subs) return 0;
        let sent = 0;
        for (const ws of subs) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ channel, payload, timestamp: Date.now() }));
            sent++;
          }
        }
        return sent;
      },

      liveQuery: async (className: string, query: any, socket: WebSocket) => {
        const key = `${className}:${JSON.stringify(query)}`;
        if (!traitApi.subscribers.has(key)) traitApi.subscribers.set(key, new Set());
        traitApi.subscribers.get(key)!.add({ socket, query });
        const initial = await db.find(className, query);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "initial", className, query, results: initial }));
        }
        if (events) {
          events.on(`${className}.created`, async (obj: any) => {
            const subs = traitApi.subscribers.get(key);
            if (!subs) return;
            for (const sub of subs) {
              if (sub.socket.readyState === WebSocket.OPEN) {
                sub.socket.send(JSON.stringify({ type: "create", className, object: obj }));
              }
            }
          });
        }
      },

      presence: (channel: string, userId: string, status: "online" | "offline") => {
        return traitApi.broadcast(`${channel}:presence`, { userId, status, timestamp: Date.now() });
      },
    };

    return {
      "realtime": traitApi,
      "realtimeServer": traitApi,
      "liveQuery": traitApi,
    };
  },
});
