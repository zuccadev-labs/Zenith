/**
 * Event store sobre el bus de eventos (`event-bus.trait.ts`): guarda cada evento en `_Event`, mantiene los
 * últimos 10 000 en memoria para reproducirlos y expone `/events/emit` y `/events/replay`. Es opcional
 * (`features.events`). El bus, en cambio, es núcleo, así que los demás traits publican y se suscriben
 * aunque esta pieza esté apagada.
 *
 * @barrits-trait
 * @barrits-summary ZenithEventStreaming
 * @barrits-provides events-routes, eventStore
 * @barrits-consumes db, events
 * @barrits-state eventSubscribers, eventLog
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const EventStreamingTrait = createTraitDescriptor({
  name: "ZenithEventStreaming",
  provides: ["events-routes", "eventStore"],
  consumes: ["db", "events"],
  state: ["eventSubscribers", "eventLog"],
  runtimes: ["deno"],
  summary: "Event store on top of the core event bus: persists every event in _Event, keeps the last 10 000 for replay, /events/emit and /events/replay.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    const bus = deps.traits["events"];
    const eventLog: Array<{ event: string; payload: any; timestamp: number }> = [];

    // Every event of the bus goes to the log and to _Event.
    bus.on("*", async (e: { event: string; payload: any; timestamp: number }) => {
      eventLog.push(e);
      if (eventLog.length > 10000) eventLog.shift();
      await db.create("_Event", e).catch(() => {});
    });

    const traitApi: any = {
      eventLog,
      emit: (eventName: string, payload: any) => bus.emit(eventName, payload),
      replay: async (filter: { eventName?: string; fromTimestamp?: number; toTimestamp?: number } = {}) => {
        let events = eventLog;
        if (filter.eventName) events = events.filter((e) => e.event === filter.eventName);
        if (filter.fromTimestamp) events = events.filter((e) => e.timestamp >= filter.fromTimestamp!);
        if (filter.toTimestamp) events = events.filter((e) => e.timestamp <= filter.toTimestamp!);
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
      "eventStore": traitApi,
    };
  },
});
