/**
 * zen automation — Gestión de reglas de automatización IF-THEN.
 *
 * Uso:
 *   zen automation list [--active]
 *   zen automation create --name "Hot Lead" --trigger "Lead.*" --actions '[{"type":"create_task","params":{"title":"Follow up"}}]'
 *   zen automation get    <objectId>
 *   zen automation toggle <objectId>
 *   zen automation test   <objectId> --data '{"score":85,"stage":"qualified"}'
 *   zen automation logs   <objectId>
 *   zen automation delete <objectId>
 *   zen automation actions   (lista acciones disponibles)
 */
import { parseArgs } from "@std/cli/parse-args";
import { loadZenConfig, printJson, printTable, zenApiCall } from "./_utils.ts";

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    string: ["name", "trigger", "conditions", "actions", "data", "class"],
    boolean: ["json", "active"],
  });
  const sub = String(parsed._[0] ?? "");
  const id = String(parsed._[1] ?? "");
  const cfg = await loadZenConfig();

  switch (sub) {
    case "list": {
      const q = parsed.active ? "?isActive=true" : "";
      const res = await zenApiCall(cfg, "GET", `/zen/automation/rules${q}`);
      if (parsed.json) {
        printJson(res);
        break;
      }
      printTable(res.results, [
        "objectId",
        "name",
        "isActive",
        "runCount",
        "errorCount",
        "lastRunAt",
        "trigger",
      ]);
      break;
    }
    case "get": {
      if (!id) {
        console.error("❌ Proporciona el objectId");
        Deno.exit(1);
      }
      const res = await zenApiCall(cfg, "GET", `/zen/automation/rules/${id}`);
      printJson(res);
      break;
    }
    case "create": {
      if (!parsed.name || !parsed.trigger) {
        console.error("❌ --name y --trigger son obligatorios");
        Deno.exit(1);
      }
      const actions = parsed.actions ? JSON.parse(parsed.actions) : [];
      const conditions = parsed.conditions ? JSON.parse(parsed.conditions) : undefined;
      const data = {
        name: parsed.name,
        trigger: { event: parsed.trigger, className: parsed.class ?? undefined, conditions },
        actions,
        isActive: true,
      };
      const res = await zenApiCall(cfg, "POST", "/zen/automation/rules", data);
      console.log(`✅ Regla creada: ${res.objectId}`);
      console.log(`   Trigger: ${res.trigger?.event} | Acciones: ${res.actions?.length}`);
      break;
    }
    case "toggle": {
      if (!id) {
        console.error("❌ Proporciona el objectId");
        Deno.exit(1);
      }
      const res = await zenApiCall(cfg, "POST", `/zen/automation/rules/${id}/toggle`);
      console.log(`${res.isActive ? "▶️  Activada" : "⏸️  Desactivada"}: ${res.name}`);
      break;
    }
    case "test": {
      if (!id) {
        console.error("❌ Proporciona el objectId");
        Deno.exit(1);
      }
      const sampleData = parsed.data ? JSON.parse(parsed.data) : {};
      const res = await zenApiCall(cfg, "POST", `/zen/automation/rules/${id}/test`, sampleData);
      console.log(`\n🧪 Test completado: ${res.log.status.toUpperCase()}`);
      console.log(
        `   Acciones ejecutadas: ${res.log.actionsRun} | Duración: ${res.log.durationMs}ms`,
      );
      if (res.log.error) console.log(`   ⚠️  Error: ${res.log.error}`);
      break;
    }
    case "logs": {
      if (!id) {
        console.error("❌ Proporciona el objectId");
        Deno.exit(1);
      }
      const res = await zenApiCall(cfg, "GET", `/zen/automation/rules/${id}/logs`);
      if (parsed.json) {
        printJson(res);
        break;
      }
      printTable(res.results, [
        "objectId",
        "status",
        "actionsRun",
        "durationMs",
        "triggerEvent",
        "recordId",
        "createdAt",
      ]);
      break;
    }
    case "delete": {
      if (!id) {
        console.error("❌ Proporciona el objectId");
        Deno.exit(1);
      }
      await zenApiCall(cfg, "DELETE", `/zen/automation/rules/${id}`);
      console.log(`✅ Regla ${id} eliminada.`);
      break;
    }
    case "actions": {
      const res = await zenApiCall(cfg, "GET", "/zen/automation/actions");
      console.log("\nAcciones disponibles:");
      for (const a of res.actions) console.log(`  • ${a}`);
      break;
    }
    default:
      console.log(`
zen automation — Motor de automatización IF-THEN

Uso:
  zen automation list [--active]
  zen automation create --name <name> --trigger <event> [--actions <json>] [--conditions <json>] [--class <ClassName>]
  zen automation get    <objectId>
  zen automation toggle <objectId>
  zen automation test   <objectId> [--data <json>]
  zen automation logs   <objectId>
  zen automation delete <objectId>
  zen automation actions

Ejemplos de triggers:
  "Lead.*"           → todos los eventos de Lead
  "Contact.created"  → solo cuando se crea un Contact
  "*"                → cualquier evento del sistema

Ejemplo de acciones (JSON array):
  '[{"type":"create_task","params":{"title":"Follow up","priority":"urgent"}},
    {"type":"send_notification","params":{"userId":"user_123","body":"Hot lead!"}}]'
      `);
  }
}
