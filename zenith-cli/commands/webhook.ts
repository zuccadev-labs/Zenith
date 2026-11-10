/**
 * zen webhook — Gestión de webhooks desde la CLI.
 *
 * Uso:
 *   zen webhook list
 *   zen webhook create --url https://... --events "Contact.*,Deal.created" --name "My Hook"
 *   zen webhook delete <objectId>
 *   zen webhook pause  <objectId>
 *   zen webhook resume <objectId>
 *   zen webhook test   <objectId>
 *   zen webhook deliveries <objectId>
 */
import { parseArgs } from "@std/cli/parse-args";
import { loadZenConfig, zenApiCall, printTable, printJson } from "./_utils.ts";

export async function run(args: string[]): Promise<void> {
  const parsed  = parseArgs(args, { string: ["url","name","events"], boolean: ["json"] });
  const sub     = String(parsed._[0] ?? "");
  const id      = String(parsed._[1] ?? "");
  const cfg     = await loadZenConfig();

  switch (sub) {
    case "list": {
      const res = await zenApiCall(cfg, "GET", "/zen/webhooks");
      if (parsed.json) { printJson(res); break; }
      printTable(res.results, ["objectId","name","url","status","events","failureCount","lastTriggeredAt"]);
      break;
    }
    case "create": {
      if (!parsed.url) { console.error("❌ --url requerido"); Deno.exit(1); }
      if (!parsed.events) { console.error("❌ --events requerido (ej. 'Contact.*,Deal.created')"); Deno.exit(1); }
      const data = {
        name:   parsed.name ?? "CLI Webhook",
        url:    parsed.url,
        events: parsed.events.split(",").map((e: string) => e.trim()),
      };
      const res = await zenApiCall(cfg, "POST", "/zen/webhooks", data);
      console.log("✅ Webhook creado:", res.objectId);
      console.log(`⚠️  Secret (solo visible ahora): ${res.secret}`);
      console.log("   Guárdalo — no se mostrará de nuevo.");
      break;
    }
    case "delete": {
      if (!id) { console.error("❌ Proporciona el objectId del webhook"); Deno.exit(1); }
      await zenApiCall(cfg, "DELETE", `/zen/webhooks/${id}`);
      console.log(`✅ Webhook ${id} eliminado.`);
      break;
    }
    case "pause": {
      if (!id) { console.error("❌ Proporciona el objectId"); Deno.exit(1); }
      const res = await zenApiCall(cfg, "POST", `/zen/webhooks/${id}/pause`);
      console.log(`⏸️  Webhook ${id} pausado. Status: ${res.status}`);
      break;
    }
    case "resume": {
      if (!id) { console.error("❌ Proporciona el objectId"); Deno.exit(1); }
      const res = await zenApiCall(cfg, "POST", `/zen/webhooks/${id}/resume`);
      console.log(`▶️  Webhook ${id} reactivado. Status: ${res.status}`);
      break;
    }
    case "test": {
      if (!id) { console.error("❌ Proporciona el objectId"); Deno.exit(1); }
      const res = await zenApiCall(cfg, "POST", `/zen/webhooks/${id}/test`);
      console.log(res.success ? `✅ Test enviado: ${res.message}` : `❌ Falló: ${res.message}`);
      break;
    }
    case "deliveries": {
      if (!id) { console.error("❌ Proporciona el objectId"); Deno.exit(1); }
      const res = await zenApiCall(cfg, "GET", `/zen/webhooks/${id}/deliveries`);
      printTable(res.results, ["objectId","event","statusCode","success","attempt","durationMs","deliveredAt"]);
      break;
    }
    default:
      console.log(`
zen webhook — Gestión de webhooks

Uso:
  zen webhook list
  zen webhook create --url <url> --events "Contact.*,Deal.created" [--name <name>]
  zen webhook delete  <objectId>
  zen webhook pause   <objectId>
  zen webhook resume  <objectId>
  zen webhook test    <objectId>
  zen webhook deliveries <objectId>

Flags:
  --json    Salida en JSON crudo
      `);
  }
}
