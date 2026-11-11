/**
 * zen calendar — Gestión de calendarios, eventos y booking de slots.
 *
 * Uso:
 *   zen calendar channels list
 *   zen calendar channels create --email sales@corp.com --provider google --name "Sales"
 *   zen calendar channels delete <channelId>
 *   zen calendar sync   <channelId>
 *   zen calendar events list  [--channel <id>] [--from <ISO>] [--to <ISO>]
 *   zen calendar events create --channel <id> --title <text> --start <ISO> --end <ISO>
 *   zen calendar events delete <eventId>
 *   zen calendar conflicts --channel <id> --start <ISO> --end <ISO>
 *   zen calendar slots list   <channelId>
 *   zen calendar slots create <channelId> --start <ISO> --end <ISO> [--title <text>]
 *   zen calendar slots book   <slotId> --email client@co.com [--name "Name"]
 *   zen calendar ics record   <ClassName> <objectId>
 *   zen calendar ics channel  <channelId>
 */
import { parseArgs } from "@std/cli/parse-args";
import { loadZenConfig, printJson, printTable, spinner, zenApiCall } from "./_utils.ts";

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    string: [
      "email",
      "provider",
      "name",
      "channel",
      "title",
      "start",
      "end",
      "from",
      "to",
      "assign",
      "name",
    ],
    boolean: ["json"],
  });
  const sub = String(parsed._[0] ?? "");
  const sub2 = String(parsed._[1] ?? "");
  const id = String(parsed._[2] ?? parsed._[1] ?? "");
  const cfg = await loadZenConfig();

  // ── channels ──────────────────────────────────────────────────────────────

  if (sub === "channels") {
    switch (sub2) {
      case "list": {
        const res = await zenApiCall(cfg, "GET", "/zen/calendar/channels");
        if (parsed.json) {
          printJson(res);
          break;
        }
        printTable(res.results, [
          "objectId",
          "name",
          "email",
          "provider",
          "status",
          "timezone",
          "lastSyncAt",
        ]);
        break;
      }
      case "create": {
        if (!parsed.email || !parsed.provider) {
          console.error("❌ --email y --provider son obligatorios");
          Deno.exit(1);
        }
        const res = await zenApiCall(cfg, "POST", "/zen/calendar/channels", {
          name: parsed.name ?? parsed.email,
          email: parsed.email,
          provider: parsed.provider,
        });
        console.log(`✅ Canal creado: ${res.objectId} (${res.email})`);
        break;
      }
      case "delete": {
        await zenApiCall(cfg, "DELETE", `/zen/calendar/channels/${id}`);
        console.log(`✅ Canal ${id} eliminado.`);
        break;
      }
      default:
        console.log("Subcomandos: list | create | delete");
    }
    return;
  }

  // ── sync ──────────────────────────────────────────────────────────────────

  if (sub === "sync") {
    const channelId = String(parsed._[1] ?? "");
    if (!channelId) {
      console.error("❌ Proporciona el channelId");
      Deno.exit(1);
    }
    const spin = spinner(`Sincronizando calendario ${channelId}...`);
    const res = await zenApiCall(cfg, "POST", `/zen/calendar/channels/${channelId}/sync`);
    spin.stop(true);
    console.log(
      `📅 Sync completado: ${res.synced} eventos, ${res.created} creados, ${res.updated} actualizados.`,
    );
    return;
  }

  // ── events ────────────────────────────────────────────────────────────────

  if (sub === "events") {
    switch (sub2) {
      case "list": {
        const q: Record<string, string> = {};
        if (parsed.channel) q.channelId = parsed.channel;
        if (parsed.from) q.from = parsed.from;
        if (parsed.to) q.to = parsed.to;
        const qs = new URLSearchParams(q).toString();
        const res = await zenApiCall(cfg, "GET", `/zen/calendar/events${qs ? "?" + qs : ""}`);
        if (parsed.json) {
          printJson(res);
          break;
        }
        printTable(res.results, [
          "objectId",
          "title",
          "startAt",
          "endAt",
          "status",
          "targetClassName",
          "targetId",
          "meetingUrl",
        ]);
        break;
      }
      case "create": {
        if (!parsed.channel || !parsed.title || !parsed.start || !parsed.end) {
          console.error("❌ --channel, --title, --start y --end son obligatorios");
          Deno.exit(1);
        }
        const res = await zenApiCall(cfg, "POST", "/zen/calendar/events", {
          channelId: parsed.channel,
          title: parsed.title,
          startAt: parsed.start,
          endAt: parsed.end,
        });
        console.log(`✅ Evento creado: ${res.objectId}`);
        if (res.conflictsDetected) {
          console.log(`⚠️  Detectados ${res.conflicts} conflictos de horario.`);
        }
        if (res.meetingUrl) console.log(`🔗 Meeting URL: ${res.meetingUrl}`);
        break;
      }
      case "cancel":
      case "delete": {
        const res = await zenApiCall(cfg, "DELETE", `/zen/calendar/events/${id}`);
        console.log(`✅ Evento cancelado.`);
        break;
      }
      default:
        console.log("Subcomandos: list | create | delete");
    }
    return;
  }

  // ── conflicts ─────────────────────────────────────────────────────────────

  if (sub === "conflicts") {
    if (!parsed.channel || !parsed.start || !parsed.end) {
      console.error("❌ --channel, --start y --end requeridos");
      Deno.exit(1);
    }
    const res = await zenApiCall(cfg, "POST", "/zen/calendar/conflicts", {
      channelId: parsed.channel,
      startAt: parsed.start,
      endAt: parsed.end,
    });
    if (res.hasConflicts) {
      console.log(`⚠️  ${res.conflicts.length} conflicto(s) detectado(s):`);
      printTable(res.conflicts, ["title", "startAt", "endAt", "status"]);
    } else {
      console.log("✅ No hay conflictos en ese rango.");
    }
    return;
  }

  // ── slots ─────────────────────────────────────────────────────────────────

  if (sub === "slots") {
    const channelId = String(parsed._[1] ?? "");
    switch (sub2) {
      case "list": {
        const res = await zenApiCall(cfg, "GET", `/zen/calendar/channels/${channelId}/slots`);
        printTable(res.results, [
          "objectId",
          "title",
          "startAt",
          "endAt",
          "duration",
          "isBooked",
          "bookedBy",
        ]);
        break;
      }
      case "create": {
        if (!parsed.start || !parsed.end) {
          console.error("❌ --start y --end requeridos");
          Deno.exit(1);
        }
        const res = await zenApiCall(cfg, "POST", `/zen/calendar/channels/${channelId}/slots`, {
          startAt: parsed.start,
          endAt: parsed.end,
          title: parsed.title ?? "Meeting",
        });
        console.log(`✅ Slot creado: ${res.objectId} (${res.startAt} → ${res.endAt})`);
        break;
      }
      case "book": {
        const slotId = String(parsed._[2] ?? "");
        if (!slotId || !parsed.email) {
          console.error("❌ <slotId> y --email requeridos");
          Deno.exit(1);
        }
        const res = await zenApiCall(cfg, "POST", `/zen/calendar/slots/${slotId}/book`, {
          email: parsed.email,
          name: parsed.name,
        });
        console.log(`✅ Slot reservado por ${parsed.email}`);
        if (res.event?.meetingUrl) console.log(`🔗 Meeting: ${res.event.meetingUrl}`);
        break;
      }
      default:
        console.log("Subcomandos: list | create | book");
    }
    return;
  }

  // ── ics ───────────────────────────────────────────────────────────────────

  if (sub === "ics") {
    const cfg2 = await loadZenConfig();
    if (sub2 === "record") {
      const cls = String(parsed._[2] ?? "");
      const tid = String(parsed._[3] ?? "");
      console.log(`📅 iCal feed: ${cfg2.serverURL}/zen/calendar/ics/record/${cls}/${tid}`);
    } else if (sub2 === "channel") {
      console.log(`📅 iCal feed: ${cfg2.serverURL}/zen/calendar/ics/channel/${id}`);
    }
    return;
  }

  console.log(`
zen calendar — Gestión de calendarios, eventos y booking

Uso:
  zen calendar channels list
  zen calendar channels create --email <email> --provider <google|outlook|caldav|ical> [--name <name>]
  zen calendar channels delete <channelId>
  zen calendar sync   <channelId>
  zen calendar events list    [--channel <id>] [--from <ISO>] [--to <ISO>]
  zen calendar events create  --channel <id> --title <text> --start <ISO> --end <ISO>
  zen calendar events delete  <eventId>
  zen calendar conflicts      --channel <id> --start <ISO> --end <ISO>
  zen calendar slots list     <channelId>
  zen calendar slots create   <channelId> --start <ISO> --end <ISO> [--title <text>]
  zen calendar slots book     <channelId> <slotId> --email <email> [--name <name>]
  zen calendar ics record     <ClassName> <objectId>
  zen calendar ics channel    <channelId>
  `);
}
