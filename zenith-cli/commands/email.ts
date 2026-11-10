/**
 * zen email — Gestión de canales de email y sync.
 *
 * Uso:
 *   zen email channels list
 *   zen email channels create --email sales@corp.com --provider imap --name "Sales"
 *   zen email channels delete <channelId>
 *   zen email sync   <channelId>
 *   zen email threads list [--channel <id>] [--target <className>/<objectId>]
 *   zen email threads get   <threadId>
 *   zen email threads close <threadId>
 *   zen email send --channel <id> --to user@co.com --subject "Hola" --body "Texto"
 */
import { parseArgs } from "@std/cli/parse-args";
import { loadZenConfig, zenApiCall, printTable, printJson, spinner } from "./_utils.ts";

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    string:  ["email","provider","name","channel","to","subject","body","target","assign"],
    boolean: ["json"],
  });
  const sub  = String(parsed._[0] ?? "");
  const sub2 = String(parsed._[1] ?? "");
  const id   = String(parsed._[2] ?? parsed._[1] ?? "");
  const cfg  = await loadZenConfig();

  if (sub === "channels") {
    switch (sub2) {
      case "list": {
        const res = await zenApiCall(cfg, "GET", "/zen/email/channels");
        if (parsed.json) { printJson(res); break; }
        printTable(res.results, ["objectId","name","email","provider","status","syncInterval","lastSyncAt"]);
        break;
      }
      case "create": {
        if (!parsed.email || !parsed.provider) {
          console.error("❌ --email y --provider son obligatorios"); Deno.exit(1);
        }
        const data = { name: parsed.name ?? parsed.email, email: parsed.email, provider: parsed.provider };
        const res  = await zenApiCall(cfg, "POST", "/zen/email/channels", data);
        console.log(`✅ Canal creado: ${res.objectId} (${res.email})`);
        break;
      }
      case "delete": {
        await zenApiCall(cfg, "DELETE", `/zen/email/channels/${id}`);
        console.log(`✅ Canal ${id} eliminado.`);
        break;
      }
      default:
        console.log("Subcomandos: list | create | delete");
    }
    return;
  }

  if (sub === "sync") {
    const channelId = String(parsed._[1] ?? "");
    if (!channelId) { console.error("❌ Proporciona el channelId"); Deno.exit(1); }
    const spin = spinner(`Sincronizando canal ${channelId}...`);
    const res  = await zenApiCall(cfg, "POST", `/zen/email/channels/${channelId}/sync`);
    spin.stop(true);
    console.log(`📬 Sync completado: ${res.synced} mensajes, ${res.threads} hilos nuevos.`);
    return;
  }

  if (sub === "threads") {
    switch (sub2) {
      case "list": {
        const q: Record<string, string> = {};
        if (parsed.channel) q.channelId = parsed.channel;
        if (parsed.target) {
          const [cls, tid] = parsed.target.split("/");
          q.targetClassName = cls; q.targetId = tid;
        }
        const qs  = new URLSearchParams(q).toString();
        const res = await zenApiCall(cfg, "GET", `/zen/email/threads${qs ? "?" + qs : ""}`);
        if (parsed.json) { printJson(res); break; }
        printTable(res.results, ["objectId","subject","status","isRead","messageCount","lastMessageAt","targetClassName","targetId"]);
        break;
      }
      case "get": {
        const res = await zenApiCall(cfg, "GET", `/zen/email/threads/${id}`);
        printJson(res);
        break;
      }
      case "close": {
        const res = await zenApiCall(cfg, "POST", `/zen/email/threads/${id}/close`);
        console.log(`✅ Hilo cerrado: ${res.subject}`);
        break;
      }
      case "assign": {
        if (!parsed.assign) { console.error("❌ --assign <userId> requerido"); Deno.exit(1); }
        const res = await zenApiCall(cfg, "POST", `/zen/email/threads/${id}/assign`, { userId: parsed.assign });
        console.log(`✅ Hilo asignado a: ${parsed.assign}`);
        break;
      }
      default:
        console.log("Subcomandos: list | get | close | assign");
    }
    return;
  }

  if (sub === "send") {
    if (!parsed.channel || !parsed.to || !parsed.subject) {
      console.error("❌ --channel, --to y --subject son obligatorios"); Deno.exit(1);
    }
    const res = await zenApiCall(cfg, "POST", "/zen/email/send", {
      channelId: parsed.channel, to: [parsed.to],
      subject: parsed.subject, body: parsed.body ?? "",
    });
    console.log(`✅ Email enviado. MessageID: ${res.messageId}`);
    return;
  }

  console.log(`
zen email — Gestión de canales de email y sincronización IMAP/SMTP

Uso:
  zen email channels list
  zen email channels create --email <email> --provider <imap|gmail|outlook|ses|mailgun> [--name <name>]
  zen email channels delete <channelId>
  zen email sync   <channelId>
  zen email threads list    [--channel <id>] [--target Contact/<id>]
  zen email threads get     <threadId>
  zen email threads close   <threadId>
  zen email threads assign  <threadId> --assign <userId>
  zen email send --channel <id> --to <email> --subject <text> [--body <text>]
  `);
}
