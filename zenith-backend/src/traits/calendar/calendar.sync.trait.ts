// deno-lint-ignore-file no-unused-vars
/**
 * Calendar Sync Trait — Sincronización con Google Calendar / CalDAV / iCal.
 *
 * Arquitectura:
 *   CalendarChannel → conexión OAuth2/CalDAV por cuenta
 *   CalendarEvent   → evento sincronizado, vinculado a Contact/Deal/Lead via Target
 *   CalendarSlot    → slot de disponibilidad para meeting booking
 *
 * Patrón adaptador: el núcleo define el contrato; adaptadores externos
 * implementan la integración real (Google, Outlook, Calendly).
 * zen plugin install @zenith/google-calendar-adapter
 *
 * Capacidades únicas vs. Twenty:
 *   - Vinculación automática evento → CRM record (attendees → Contacts)
 *   - Booking de slots (appointment scheduling)
 *   - iCal feed público por Contact/Deal
 *   - Detección de conflictos
 *
 * @barrits-trait
 * @barrits-summary ZenithCalendarSync
 * @barrits-provides calendar_routes, calendarSync
 * @barrits-consumes cloud, db
 * @barrits-tags uses:events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import {
  errRes,
  jsonRes,
  NO_CONTENT,
  now,
  parsePage,
  pathParams,
  ptr,
  queryParams,
  sortResults,
} from "../../core/trait-utils.ts";

// ── Tipos públicos ─────────────────────────────────────────────────────────────

/** A connected calendar account (OAuth2, CalDAV or iCal feed) that events are synced from. */
export interface CalendarChannel {
  /** Unique id of the channel record. */
  objectId: string;
  /** Display name of the channel. */
  name: string;
  /** Email address of the calendar account. */
  email: string;
  /** Calendar provider; selects the registered {@link CalendarAdapterDef} used to sync. */
  provider: "google" | "outlook" | "caldav" | "ical" | "custom";
  /** Sync state: `error` after a failed fetch, `paused` skips syncing. */
  status: "active" | "error" | "paused";
  /** IANA time zone of the calendar (for example `Europe/Madrid`). */
  timezone: string;
  /** Interval between automatic syncs, in seconds. */
  syncInterval: number;
  /** ISO 8601 timestamp of the last sync attempt. */
  lastSyncAt?: string;
  /** Id of the calendar on the provider side. */
  calendarId?: string;
}

/** A calendar event synced from (or pushed to) a provider, optionally linked to a CRM record. */
export interface CalendarEvent {
  /** Unique id of the event record. */
  objectId: string;
  /** Id of the {@link CalendarChannel} the event belongs to. */
  channelId: string;
  /** Id of the event on the provider (for example the Google event id). */
  externalId: string;
  /** Event title. */
  title: string;
  /** Free-text description. */
  description?: string;
  /** Physical location of the event. */
  location?: string;
  /** Start time, ISO 8601. */
  startAt: string;
  /** End time, ISO 8601. */
  endAt: string;
  /** Whether the event spans whole days instead of a time range. */
  isAllDay: boolean;
  /** Event status as reported by the provider. */
  status: "confirmed" | "tentative" | "cancelled";
  /** Invited people and their response; their emails are matched against CRM records on sync. */
  attendees: Array<
    { email: string; name?: string; status: "accepted" | "declined" | "tentative" | "unknown" }
  >;
  /** Class of the linked CRM record (polymorphic target), for example `Contact` or `Deal`. */
  targetClassName?: string;
  /** Id of the linked CRM record. */
  targetId?: string;
  /** Recurrence rule as an RFC 5545 RRULE string. */
  recurrence?: string;
  /** Video meeting link (Google Meet, Teams, Zoom). */
  meetingUrl?: string;
  /** Reminders to fire before the event starts. */
  reminders?: Array<{ method: "email" | "popup"; minutesBefore: number }>;
  /** Creation timestamp, ISO 8601. */
  createdAt: string;
  /** Last update timestamp, ISO 8601. */
  updatedAt: string;
}

/** An availability slot that an external person can book as a meeting. */
export interface CalendarSlot {
  /** Unique id of the slot record. */
  objectId: string;
  /** Id of the {@link CalendarChannel} the booked event is created in. */
  channelId: string;
  /** Slot start, ISO 8601. */
  startAt: string;
  /** Slot end, ISO 8601. */
  endAt: string;
  /** Meeting length in minutes (defaults to 30). */
  duration: number;
  /** Title given to the booked event, for example `"30-min Sales Call"`. */
  title: string;
  /** Whether the slot has already been booked. */
  isBooked: boolean;
  /** Email of the person who booked the slot. */
  bookedBy?: string;
  /** `objectId` of the {@link CalendarEvent} created when the slot was booked. */
  eventId?: string;
  /** Buffer time kept free before and after the meeting, in minutes. */
  bufferMins: number;
}

/** Registry of pluggable calendar adapters, keyed by provider. */
const CALENDAR_ADAPTERS = new Map<string, CalendarAdapterDef>();

/**
 * Contract a calendar provider integration implements (Google, Outlook, CalDAV...).
 * Registered at runtime with `calendarSync.registerAdapter()`; channels whose `provider`
 * has no adapter are only marked as synced.
 */
export interface CalendarAdapterDef {
  /** Provider name this adapter handles; matched against {@link CalendarChannel.provider}. */
  provider: string;
  /** Fetches the provider's events of `channel` between `from` and `to`. */
  fetchEvents: (
    channel: CalendarChannel,
    from: Date,
    to: Date,
  ) => Promise<Partial<CalendarEvent>[]>;
  /** Creates the event on the provider and returns its external id and meeting link. */
  createEvent: (
    channel: CalendarChannel,
    event: Partial<CalendarEvent>,
  ) => Promise<{ externalId: string; meetingUrl?: string }>;
  /** Pushes changes of a local event to the provider event `externalId`. */
  updateEvent: (
    channel: CalendarChannel,
    externalId: string,
    event: Partial<CalendarEvent>,
  ) => Promise<void>;
  /** Deletes the provider event `externalId`. */
  deleteEvent: (channel: CalendarChannel, externalId: string) => Promise<void>;
}

const CALENDAR_SCHEMA = {
  CalendarChannel: {
    name: "String",
    email: "String",
    provider: "String",
    status: "String",
    timezone: "String",
  },
  CalendarEvent: {
    channelId: "String",
    externalId: "String",
    title: "String",
    startAt: "Date",
    endAt: "Date",
    status: "String",
    isAllDay: "Boolean",
  },
  CalendarSlot: {
    channelId: "String",
    startAt: "Date",
    endAt: "Date",
    duration: "Number",
    isBooked: "Boolean",
    title: "String",
  },
};

/**
 * Calendar sync trait: connects calendar channels through pluggable provider adapters, links
 * synced events to CRM records by attendee email, manages bookable slots, detects conflicts and
 * serves iCal feeds. Provides the `calendarSync` API and the `/zen/calendar/*` routes; consumes
 * `cloud` and `db`.
 */
export const CalendarSyncTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithCalendarSync",
  provides: ["calendar_routes", "calendarSync"],
  consumes: ["cloud", "db"],
  tags: ["uses:events"],
  state: [],
  runtimes: ["deno"],
  summary:
    "Calendar sync (Google/Outlook/CalDAV). Events linked to CRM records via Target. Booking slots, iCal feeds, conflict detection. Adapter pattern for provider swap.",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const events = deps.traits["events"];

    if (deps.traits["cloud"]?.defineSchema) {
      for (const [n, f] of Object.entries(CALENDAR_SCHEMA)) {
        deps.traits["cloud"].defineSchema(n, f as any, {});
      }
    }

    // ── Match attendees → CRM records ────────────────────────────────────────

    async function matchAttendeesToCRM(
      attendeeEmails: string[],
    ): Promise<Array<{ email: string; className: string; objectId: string }>> {
      const results: Array<{ email: string; className: string; objectId: string }> = [];
      for (const email of attendeeEmails) {
        const contacts = await db.find("Contact", { email }).catch(() => []);
        if (contacts[0]) {
          results.push({ email, className: "Contact", objectId: contacts[0].objectId });
          continue;
        }
        const leads = await db.find("Lead", { email }).catch(() => []);
        if (leads[0]) results.push({ email, className: "Lead", objectId: leads[0].objectId });
      }
      return results;
    }

    // ── Detección de conflictos ──────────────────────────────────────────────

    async function detectConflicts(
      channelId: string,
      startAt: string,
      endAt: string,
      excludeId?: string,
    ) {
      const existing = await db.find("CalendarEvent", { channelId, status: "confirmed" });
      return existing.filter((e: any) => {
        if (excludeId && e.objectId === excludeId) return false;
        const eStart = new Date(e.startAt).getTime();
        const eEnd = new Date(e.endAt).getTime();
        const nStart = new Date(startAt).getTime();
        const nEnd = new Date(endAt).getTime();
        return !(nEnd <= eStart || nStart >= eEnd); // solapamiento
      });
    }

    // ── Generador iCal ────────────────────────────────────────────────────────

    function generateICS(eventsArr: CalendarEvent[], calName: string): string {
      const esc = (s: string) => s.replace(/[,;\\]/g, "\\$&").replace(/\n/g, "\\n");
      const dt = (iso: string, allDay = false) =>
        allDay
          ? iso.slice(0, 10).replace(/-/g, "")
          : iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "") + (iso.endsWith("Z") ? "" : "Z");

      const vevents = eventsArr.map((ev) =>
        [
          "BEGIN:VEVENT",
          `UID:${ev.externalId || ev.objectId}@zenith`,
          `DTSTAMP:${dt(now())}`,
          `DTSTART${ev.isAllDay ? ";VALUE=DATE" : ""}:${dt(ev.startAt, ev.isAllDay)}`,
          `DTEND${ev.isAllDay ? ";VALUE=DATE" : ""}:${dt(ev.endAt, ev.isAllDay)}`,
          `SUMMARY:${esc(ev.title)}`,
          ev.description ? `DESCRIPTION:${esc(ev.description)}` : "",
          ev.location ? `LOCATION:${esc(ev.location)}` : "",
          ev.meetingUrl ? `URL:${ev.meetingUrl}` : "",
          ev.recurrence ? `RRULE:${ev.recurrence}` : "",
          `STATUS:${ev.status.toUpperCase()}`,
          ...(ev.attendees ?? []).map((a) => `ATTENDEE;CN=${a.name ?? a.email}:mailto:${a.email}`),
          "END:VEVENT",
        ].filter(Boolean).join("\r\n")
      ).join("\r\n");

      return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Zenith BaaS//Calendar//EN",
        `X-WR-CALNAME:${esc(calName)}`,
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        vevents,
        "END:VCALENDAR",
      ].join("\r\n");
    }

    // ── Sync job ──────────────────────────────────────────────────────────────

    async function syncChannel(
      channelId: string,
      fromDays = 7,
      toDays = 30,
    ): Promise<{ synced: number; created: number; updated: number }> {
      const channel = await db.read("CalendarChannel", channelId);
      if (!channel) throw ZenithErrors.notFound("CalendarChannel", channelId);
      if (channel.status === "paused") return { synced: 0, created: 0, updated: 0 };

      const adapter = CALENDAR_ADAPTERS.get(channel.provider);
      if (!adapter) {
        await db.update("CalendarChannel", { objectId: channelId }, {
          lastSyncAt: now(),
          updatedAt: now(),
        });
        return { synced: 0, created: 0, updated: 0 };
      }

      const from = new Date(Date.now() - fromDays * 86400000);
      const to = new Date(Date.now() + toDays * 86400000);
      const remote = await adapter.fetchEvents(channel, from, to).catch((e: Error) => {
        db.update("CalendarChannel", { objectId: channelId }, {
          status: "error",
          errorMsg: e.message,
          updatedAt: now(),
        });
        return [];
      });

      let created = 0, updated = 0;
      for (const ev of remote) {
        if (!ev.externalId || !ev.startAt || !ev.endAt) continue;

        // Match attendees → CRM records
        const crmMatches = await matchAttendeesToCRM(
          (ev.attendees ?? []).map((a: any) => a.email).filter(Boolean),
        );
        const primaryTarget = crmMatches[0];

        const existing = await db.find("CalendarEvent", { channelId, externalId: ev.externalId });
        const payload = {
          channelId,
          externalId: ev.externalId,
          title: ev.title ?? "Sin título",
          description: ev.description,
          location: ev.location,
          startAt: ev.startAt,
          endAt: ev.endAt,
          isAllDay: ev.isAllDay ?? false,
          status: ev.status ?? "confirmed",
          attendees: ev.attendees ?? [],
          meetingUrl: ev.meetingUrl,
          recurrence: ev.recurrence,
          reminders: ev.reminders,
          targetClassName: primaryTarget?.className ?? null,
          targetId: primaryTarget?.objectId ?? null,
          updatedAt: now(),
        };

        if (existing[0]) {
          await db.update("CalendarEvent", { objectId: existing[0].objectId }, payload);
          updated++;
        } else {
          await db.create("CalendarEvent", { ...payload, createdAt: now() });
          created++;
          if (events) events.emit("Calendar.eventCreated", payload);
        }
      }

      await db.update("CalendarChannel", { objectId: channelId }, {
        lastSyncAt: now(),
        status: "active",
        updatedAt: now(),
      });
      return { synced: remote.length, created, updated };
    }

    const api = {
      registerAdapter: (def: CalendarAdapterDef) => {
        CALENDAR_ADAPTERS.set(def.provider, def);
        return def;
      },
      syncChannel,

      // ── Channels ───────────────────────────────────────────────────────────
      async listChannels() {
        return { results: await db.find("CalendarChannel", {}) };
      },
      async createChannel(data: Record<string, any>, ctx: any) {
        if (!data.email || !data.provider) {
          throw ZenithErrors.validationFailed("email y provider son obligatorios.");
        }
        return db.create("CalendarChannel", {
          ...data,
          status: "active",
          timezone: data.timezone ?? "UTC",
          syncInterval: data.syncInterval ?? 300,
          createdBy: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(),
          updatedAt: now(),
        });
      },
      async deleteChannel(objectId: string) {
        if (!await db.read("CalendarChannel", objectId)) {
          throw ZenithErrors.notFound("CalendarChannel", objectId);
        }
        await db.delete("CalendarChannel", { objectId });
        return { success: true };
      },

      // ── Events ─────────────────────────────────────────────────────────────
      async listEvents(q: Record<string, any>) {
        const where: Record<string, any> = {};
        if (q.channelId) where.channelId = q.channelId;
        if (q.targetClassName) where.targetClassName = q.targetClassName;
        if (q.targetId) where.targetId = q.targetId;
        if (q.status) where.status = q.status;
        const { limit, skip } = parsePage(q);
        const all = await db.find("CalendarEvent", where);
        // Filtrar por rango de fechas si se especifica
        let filtered = all;
        if (q.from) filtered = filtered.filter((e: any) => new Date(e.endAt) >= new Date(q.from));
        if (q.to) filtered = filtered.filter((e: any) => new Date(e.startAt) <= new Date(q.to));
        return {
          results: sortResults(filtered, "startAt").slice(skip, skip + limit),
          total: filtered.length,
        };
      },

      async getEvent(objectId: string) {
        const ev = await db.read("CalendarEvent", objectId);
        if (!ev) throw ZenithErrors.notFound("CalendarEvent", objectId);
        return ev;
      },

      async createEvent(data: Record<string, any>, ctx: any) {
        if (!data.channelId || !data.title || !data.startAt || !data.endAt) {
          throw ZenithErrors.validationFailed(
            "channelId, title, startAt y endAt son obligatorios.",
          );
        }
        if (new Date(data.startAt) >= new Date(data.endAt)) {
          throw ZenithErrors.validationFailed("startAt debe ser anterior a endAt.");
        }

        const conflicts = await detectConflicts(data.channelId, data.startAt, data.endAt);
        const channel = await db.read("CalendarChannel", data.channelId);
        let externalId = `zenith_${crypto.randomUUID()}`;
        let meetingUrl: string | undefined;

        if (channel) {
          const adapter = CALENDAR_ADAPTERS.get(channel.provider);
          if (adapter) {
            const res = await adapter.createEvent(channel, data).catch((): {
              externalId: string;
              meetingUrl?: string;
            } => ({ externalId }));
            externalId = res.externalId ?? externalId;
            meetingUrl = res.meetingUrl;
          }
        }

        const created = await db.create("CalendarEvent", {
          ...data,
          externalId,
          meetingUrl: meetingUrl ?? data.meetingUrl,
          isAllDay: data.isAllDay ?? false,
          status: data.status ?? "confirmed",
          attendees: data.attendees ?? [],
          conflicts: conflicts.length,
          createdBy: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(),
          updatedAt: now(),
        });

        if (events) events.emit("Calendar.eventCreated", created);
        return { ...created, conflictsDetected: conflicts.length > 0, conflicts: conflicts.length };
      },

      async updateEvent(objectId: string, data: Record<string, any>, ctx: any) {
        const ev = await db.read("CalendarEvent", objectId);
        if (!ev) throw ZenithErrors.notFound("CalendarEvent", objectId);

        const startAt = data.startAt ?? ev.startAt;
        const endAt = data.endAt ?? ev.endAt;
        if (new Date(startAt) >= new Date(endAt)) {
          throw ZenithErrors.validationFailed("startAt debe ser anterior a endAt.");
        }

        const channel = await db.read("CalendarChannel", ev.channelId);
        if (channel) {
          const adapter = CALENDAR_ADAPTERS.get(channel.provider);
          if (adapter) {
            await adapter.updateEvent(channel, ev.externalId, { ...ev, ...data }).catch(() => {});
          }
        }

        const updated = await db.update("CalendarEvent", { objectId }, {
          ...data,
          updatedAt: now(),
        });
        if (events) events.emit("Calendar.eventUpdated", updated);
        return updated;
      },

      async deleteEvent(objectId: string) {
        const ev = await db.read("CalendarEvent", objectId);
        if (!ev) throw ZenithErrors.notFound("CalendarEvent", objectId);
        const channel = await db.read("CalendarChannel", ev.channelId);
        if (channel) {
          const adapter = CALENDAR_ADAPTERS.get(channel.provider);
          if (adapter) await adapter.deleteEvent(channel, ev.externalId).catch(() => {});
        }
        await db.update("CalendarEvent", { objectId }, { status: "cancelled", updatedAt: now() });
        if (events) events.emit("Calendar.eventCancelled", { objectId, channelId: ev.channelId });
        return { success: true };
      },

      async checkConflicts(channelId: string, startAt: string, endAt: string) {
        const conflicts = await detectConflicts(channelId, startAt, endAt);
        return { hasConflicts: conflicts.length > 0, conflicts };
      },

      // ── Booking Slots ──────────────────────────────────────────────────────
      async listSlots(channelId: string) {
        const slots = await db.find("CalendarSlot", { channelId, isBooked: false });
        const future = slots.filter((s: any) => new Date(s.startAt) > new Date());
        return { results: sortResults(future, "startAt") };
      },

      async createSlot(data: Record<string, any>, ctx: any) {
        if (!data.channelId || !data.startAt || !data.endAt) {
          throw ZenithErrors.validationFailed("channelId, startAt y endAt son obligatorios.");
        }
        return db.create("CalendarSlot", {
          ...data,
          isBooked: false,
          duration: data.duration ?? 30,
          bufferMins: data.bufferMins ?? 0,
          title: data.title ?? "Meeting",
          createdAt: now(),
          updatedAt: now(),
        });
      },

      async bookSlot(objectId: string, bookerEmail: string, bookerName?: string) {
        const slot = await db.read("CalendarSlot", objectId);
        if (!slot) throw ZenithErrors.notFound("CalendarSlot", objectId);
        if (slot.isBooked) throw ZenithErrors.validationFailed("Este slot ya fue reservado.");
        if (new Date(slot.startAt) <= new Date()) {
          throw ZenithErrors.validationFailed("El slot ya expiró.");
        }

        // Crear evento de calendario confirmado
        const event = await api.createEvent({
          channelId: slot.channelId,
          title: slot.title,
          startAt: slot.startAt,
          endAt: slot.endAt,
          isAllDay: false,
          status: "confirmed",
          attendees: [{ email: bookerEmail, name: bookerName, status: "accepted" }],
        }, { user: null });

        await db.update("CalendarSlot", { objectId }, {
          isBooked: true,
          bookedBy: bookerEmail,
          eventId: event.objectId,
          updatedAt: now(),
        });

        if (events) {
          events.emit("Calendar.slotBooked", {
            slotId: objectId,
            bookerEmail,
            eventId: event.objectId,
          });
        }
        return { slot: { ...slot, isBooked: true }, event };
      },

      // ── iCal feed ─────────────────────────────────────────────────────────
      async icsForRecord(targetClassName: string, targetId: string): Promise<Response> {
        const evArr = await db.find("CalendarEvent", { targetClassName, targetId });
        const confirmed = evArr.filter((e: any) => e.status !== "cancelled");
        const ics = generateICS(confirmed, `${targetClassName} — ${targetId}`);
        return new Response(ics, {
          headers: {
            "content-type": "text/calendar; charset=utf-8",
            "content-disposition": `attachment; filename="${targetClassName}_${targetId}.ics"`,
          },
        });
      },

      async icsForChannel(channelId: string): Promise<Response> {
        const channel = await db.read("CalendarChannel", channelId);
        if (!channel) throw ZenithErrors.notFound("CalendarChannel", channelId);
        const evArr = await db.find("CalendarEvent", { channelId });
        const ics = generateICS(evArr.filter((e: any) => e.status !== "cancelled"), channel.name);
        return new Response(ics, {
          headers: {
            "content-type": "text/calendar; charset=utf-8",
            "content-disposition": `attachment; filename="channel_${channelId}.ics"`,
          },
        });
      },
    };

    const calendar_routes = [
      // Channels
      {
        method: "GET" as const,
        path: "/zen/calendar/channels",
        _openapi: { summary: "Listar canales de calendario", tags: ["Calendar"] },
        handler: async (_r: Request, _c: any) => {
          try {
            return jsonRes(await api.listChannels());
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/calendar/channels",
        _openapi: { summary: "Crear canal de calendario", tags: ["Calendar"] },
        handler: async (r: Request, c: any) => {
          try {
            return jsonRes(await api.createChannel(await r.json(), c), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "DELETE" as const,
        path: "/zen/calendar/channels/:objectId",
        _openapi: { summary: "Eliminar canal", tags: ["Calendar"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/calendar/channels/:objectId", r.url)!;
            await api.deleteChannel(p.objectId);
            return NO_CONTENT;
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/calendar/channels/:objectId/sync",
        _openapi: { summary: "Forzar sync de canal", tags: ["Calendar"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/calendar/channels/:objectId/sync", r.url)!;
            return jsonRes(await api.syncChannel(p.objectId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      // Events
      {
        method: "GET" as const,
        path: "/zen/calendar/events",
        _openapi: {
          summary: "Listar eventos (filtros: from, to, targetId, status)",
          tags: ["Calendar"],
        },
        handler: async (r: Request, _c: any) => {
          try {
            return jsonRes(await api.listEvents(queryParams(new URL(r.url))));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/calendar/events/:objectId",
        _openapi: { summary: "Obtener evento", tags: ["Calendar"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/calendar/events/:objectId", r.url)!;
            return jsonRes(await api.getEvent(p.objectId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/calendar/events",
        _openapi: { summary: "Crear evento (+ push al proveedor)", tags: ["Calendar"] },
        handler: async (r: Request, c: any) => {
          try {
            return jsonRes(await api.createEvent(await r.json(), c), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "PUT" as const,
        path: "/zen/calendar/events/:objectId",
        _openapi: { summary: "Actualizar evento", tags: ["Calendar"] },
        handler: async (r: Request, c: any) => {
          try {
            const p = pathParams("/zen/calendar/events/:objectId", r.url)!;
            return jsonRes(await api.updateEvent(p.objectId, await r.json(), c));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "DELETE" as const,
        path: "/zen/calendar/events/:objectId",
        _openapi: { summary: "Cancelar evento", tags: ["Calendar"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/calendar/events/:objectId", r.url)!;
            return jsonRes(await api.deleteEvent(p.objectId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/calendar/conflicts",
        _openapi: { summary: "Detectar conflictos de horario", tags: ["Calendar"] },
        handler: async (r: Request, _c: any) => {
          try {
            const b = await r.json();
            return jsonRes(await api.checkConflicts(b.channelId, b.startAt, b.endAt));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      // Slots / Booking
      {
        method: "GET" as const,
        path: "/zen/calendar/channels/:channelId/slots",
        _openapi: { summary: "Listar slots disponibles", tags: ["Calendar"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/calendar/channels/:channelId/slots", r.url)!;
            return jsonRes(await api.listSlots(p.channelId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/calendar/channels/:channelId/slots",
        _openapi: { summary: "Crear slot de disponibilidad", tags: ["Calendar"] },
        handler: async (r: Request, c: any) => {
          try {
            const p = pathParams("/zen/calendar/channels/:channelId/slots", r.url)!;
            return jsonRes(
              await api.createSlot({ ...await r.json(), channelId: p.channelId }, c),
              201,
            );
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/calendar/slots/:objectId/book",
        _openapi: { summary: "Reservar slot (appointment booking)", tags: ["Calendar"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/calendar/slots/:objectId/book", r.url)!;
            const b = await r.json();
            return jsonRes(await api.bookSlot(p.objectId, b.email, b.name));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      // iCal feeds
      {
        method: "GET" as const,
        path: "/zen/calendar/ics/record/:targetClassName/:targetId",
        _openapi: { summary: "Feed iCal por record CRM (.ics)", tags: ["Calendar"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/calendar/ics/record/:targetClassName/:targetId", r.url)!;
            return await api.icsForRecord(p.targetClassName, p.targetId);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/calendar/ics/channel/:channelId",
        _openapi: { summary: "Feed iCal completo del canal (.ics)", tags: ["Calendar"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/calendar/ics/channel/:channelId", r.url)!;
            return await api.icsForChannel(p.channelId);
          } catch (e) {
            return errRes(e);
          }
        },
      },
    ];

    return { calendar_routes, calendarSync: api };
  },
});
