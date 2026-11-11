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
 *   zen webhook rotate-secret <objectId> [--grace-hours 24]
 *   zen webhook messages <objectId> [--status pending|succeeded|failed]   (alias: deliveries)
 *   zen webhook attempts <objectId> <messageId>
 *   zen webhook redeliver <objectId> <messageId>
 *   zen webhook recover <objectId> --since 2026-11-10T00:00:00Z
 *
 * Las entregas siguen Standard Webhooks: el receptor las verifica con la biblioteca oficial
 * (`standardwebhooks`) y el secreto del endpoint.
 */
import { parseArgs } from "@std/cli/parse-args";
import { loadZenConfig, zenApiCall, printTable, printJson } from "./_utils.ts";

export async function run(args: string[]): Promise<void> {
  const parsed  = parseArgs(args, { string: ["url","name","events","status","since","grace-hours","description"], boolean: ["json"] });
  const sub     = String(parsed._[0] ?? "");
  const id      = String(parsed._[1] ?? "");
  const messageId = String(parsed._[2] ?? "");
  const need = (v: string, what: string) => { if (!v) { console.error(`❌ Proporciona ${what}`); Deno.exit(1); } };
  const cfg     = await loadZenConfig();

  switch (sub) {
    case "list": {
      const res = await zenApiCall(cfg, "GET", "/zen/webhooks");
      if (parsed.json) { printJson(res); break; }
      printTable(res.results, ["objectId","name","url","status","events","secretCount","exhaustedCount","lastError"]);
      break;
    }
    case "create": {
      if (!parsed.url) { console.error("❌ --url requerido"); Deno.exit(1); }
      if (!parsed.events) { console.error("❌ --events requerido (ej. 'Contact.*,Deal.created')"); Deno.exit(1); }
      const data = {
        name:   parsed.name ?? "CLI Webhook",
        url:    parsed.url,
        events: parsed.events.split(",").map((e: string) => e.trim()),
        ...(parsed.description ? { description: parsed.description } : {}),
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
      console.log(`✅ Mensaje de prueba encolado: ${res.messageId} (zen webhook messages ${id})`);
      break;
    }
    case "rotate-secret": {
      need(id, "el objectId");
      const grace = parsed["grace-hours"] === undefined ? {} : { graceHours: Number(parsed["grace-hours"]) };
      const res = await zenApiCall(cfg, "POST", `/zen/webhooks/${id}/rotate-secret`, grace);
      console.log(`⚠️  Nuevo secret (solo visible ahora): ${res.secret}`);
      if (res.previousValidUntil) console.log(`   El anterior sigue firmando hasta ${res.previousValidUntil}.`);
      break;
    }
    case "messages":
    case "deliveries": {
      need(id, "el objectId");
      const q = parsed.status ? `?status=${encodeURIComponent(parsed.status)}` : "";
      const res = await zenApiCall(cfg, "GET", `/zen/webhooks/${id}/messages${q}`);
      if (parsed.json) { printJson(res); break; }
      printTable(res.results, ["messageId","type","status","attempts","lastStatusCode","nextAttemptAt","deliveredAt"]);
      break;
    }
    case "attempts": {
      need(id, "el objectId"); need(messageId, "el messageId");
      const res = await zenApiCall(cfg, "GET", `/zen/webhooks/${id}/messages/${messageId}/attempts`);
      if (parsed.json) { printJson(res); break; }
      printTable(res.results, ["attempt","statusCode","durationMs","error","at"]);
      break;
    }
    case "redeliver": {
      need(id, "el objectId"); need(messageId, "el messageId");
      await zenApiCall(cfg, "POST", `/zen/webhooks/${id}/messages/${messageId}/redeliver`);
      console.log(`✅ ${messageId} encolado de nuevo (mismo webhook-id).`);
      break;
    }
    case "recover": {
      need(id, "el objectId"); need(parsed.since ?? "", "--since <fecha ISO>");
      const res = await zenApiCall(cfg, "POST", `/zen/webhooks/${id}/recover`, { since: parsed.since });
      console.log(`✅ ${res.requeued} mensajes fallidos encolados de nuevo.`);
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
  zen webhook rotate-secret <objectId> [--grace-hours 24]
  zen webhook messages  <objectId> [--status pending|succeeded|failed]
  zen webhook attempts  <objectId> <messageId>
  zen webhook redeliver <objectId> <messageId>
  zen webhook recover   <objectId> --since <fecha ISO>

Flags:
  --json    Salida en JSON crudo
      `);
  }
}
