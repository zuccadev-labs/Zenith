/**
 * Bus de eventos del motor, en proceso: las piezas publican eventos de dominio (`Contact.created`,
 * `Workspace.invited`…) y otras se suscriben sin conocerse. Es núcleo: webhooks, automatizaciones y el
 * registro de eventos dependen de él.
 *
 * - `on(evento, handler)`: el handler recibe el `payload`. Con `"*"` recibe `{ event, payload, timestamp }`.
 *   Devuelve la función para darse de baja.
 * - `emit(evento, payload)`: llama a los suscriptores en orden. El fallo de uno se registra y no afecta
 *   a los demás ni a quien emite.
 *
 * El registro persistente y la reproducción son de `EventStreamingTrait` (`features.events`), que se
 * suscribe a este bus.
 *
 * @barrits-trait
 * @barrits-summary ZenithEventBus
 * @barrits-provides events, eventBus
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export type EventHandler = (payload: any) => void | Promise<void>;

export interface EventBus {
  on(eventName: string, handler: EventHandler): () => void;
  off(eventName: string, handler: EventHandler): void;
  emit(eventName: string, payload?: unknown): Promise<void>;
}

export function createEventBus(
  log: (m: string, e: unknown) => void = (m, e) => console.error(m, e),
): EventBus {
  const subscribers = new Map<string, Set<EventHandler>>();
  const bus: EventBus = {
    on(eventName, handler) {
      if (!subscribers.has(eventName)) subscribers.set(eventName, new Set());
      subscribers.get(eventName)!.add(handler);
      return () => bus.off(eventName, handler);
    },
    off(eventName, handler) {
      subscribers.get(eventName)?.delete(handler);
    },
    async emit(eventName, payload) {
      for (const handler of [...(subscribers.get(eventName) ?? [])]) {
        try {
          await handler(payload);
        } catch (e) {
          log(`[events] handler error for ${eventName}:`, e);
        }
      }
      const event = { event: eventName, payload, timestamp: Date.now() };
      for (const handler of [...(subscribers.get("*") ?? [])]) {
        try {
          await handler(event);
        } catch (e) {
          log(`[events] wildcard handler error for ${eventName}:`, e);
        }
      }
    },
  };
  return bus;
}

export const EventBusTrait = createTraitDescriptor({
  name: "ZenithEventBus",
  provides: ["events", "eventBus"],
  consumes: [],
  state: [],
  runtimes: ["deno"],
  summary: "In-process domain event bus: on/off/emit, wildcard subscribers. Core piece.",
  create: () => {
    const bus = createEventBus();
    return { events: bus, eventBus: bus };
  },
});
