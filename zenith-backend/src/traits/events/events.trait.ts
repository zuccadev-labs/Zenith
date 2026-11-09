/**
 * Event sourcing bus: domain events (CRUD triggers, custom events), pub/sub with Kafka adapter (optional), replay log, event-store projections.
 *
 * @barrits-trait
 * @barrits-summary ZenithEventStreaming
 * @barrits-provides events-routes, events, eventBus
 * @barrits-consumes db
 * @barrits-state eventSubscribers, eventLog
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const EventStreamingTrait = createTraitDescriptor({
  name: "ZenithEventStreaming",
  provides: ["events-routes", "events", "eventBus"],
  consumes: ["db"],
  state: ["eventSubscribers", "eventLog"],
  runtimes: ["deno"],
  summary: "Event sourcing bus: domain events (CRUD triggers, custom events), pub/sub with Kafka adapter (optional), replay log, event-store projections.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    const traitApi: any = {
      subscribers: new Map<string, Set<(payload: any) => void | Promise<void>>>(),
      eventLog: [] as Array<{ event: string; payload: any; timestamp: number }>,

      on: (eventName: string, handler: (payload: any) => void | Promise<void>) => {
        if (!traitApi.subscribers.has(eventName)) traitApi.subscribers.set(eventName, new Set());
        traitApi.subscribers.get(eventName)!.add(handler);
        return () => traitApi.subscribers.get(eventName)?.delete(handler);
      },

      off: (eventName: string, handler: (payload: any) => any) => {
        traitApi.subscribers.get(eventName)?.delete(handler);
      },

      emit: async (eventName: string, payload: any) => {
        const event = { event: eventName, payload, timestamp: Date.now() };
        traitApi.eventLog.push(event);
        if (traitApi.eventLog.length > 10000) traitApi.eventLog.shift();
        await db.create("_Event", event).catch(() => {});
        const subs = traitApi.subscribers.get(eventName) || new Set();
        for (const handler of subs) {
          try { await handler(payload); } catch (e) { console.error(`[Events] handler error for ${eventName}:`, e); }
        }
        const wildcards = traitApi.subscribers.get("*");
        if (wildcards) {
          for (const handler of wildcards) {
            try { await handler(event); } catch (e) { console.error(`[Events] wildcard handler error:`, e); }
          }
        }
      },

      replay: async (filter: { eventName?: string; fromTimestamp?: number; toTimestamp?: number } = {}) => {
        let events: Array<{ event: string; timestamp: number; payload: any }> = traitApi.eventLog;
        if (filter.eventName) events = events.filter((e: { event: string }) => e.event === filter.eventName);
        if (filter.fromTimestamp) events = events.filter((e: { timestamp: number }) => e.timestamp >= filter.fromTimestamp!);
        if (filter.toTimestamp) events = events.filter((e: { timestamp: number }) => e.timestamp <= filter.toTimestamp!);
        return events;
      },
    };

    const events_routes = [
      {
        method: "POST" as const,
        path: "/events/emit",
        _openapi: { summary: "Emit a custom domain event" },
        handler: async (req: Request) => {
          const body = await req.json() as { event: string; payload: any };
          await traitApi.emit(body.event, body.payload);
          return new Response(JSON.stringify({ emitted: true }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/events/replay",
        _openapi: { summary: "Replay event log" },
        handler: async (req: Request) => {
          const url = new URL(req.url);
          const filter: any = {};
          if (url.searchParams.get("eventName")) filter.eventName = url.searchParams.get("eventName");
          if (url.searchParams.get("from")) filter.fromTimestamp = parseInt(url.searchParams.get("from")!, 10);
          if (url.searchParams.get("to")) filter.toTimestamp = parseInt(url.searchParams.get("to")!, 10);
          const events = await traitApi.replay(filter);
          return new Response(JSON.stringify({ events }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "events-routes": events_routes,
      "events": traitApi,
      "eventBus": traitApi,
    };
  },
});
