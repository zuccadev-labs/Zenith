/**
 * @module @zenith/cli/commands/api-keys
 *
 * API keys estilo Stripe de la app, gestionadas en el servidor (`/zen/api-keys`, master key).
 * Antes el comando creaba las claves en un almacén en memoria del propio CLI: desaparecían al
 * terminar y el servidor nunca las conocía.
 *
 *   zen api-keys list
 *   zen api-keys create --name "Servidor de producción" [--prefix sk|pk|rk] [--env live|test]
 *                       [--scopes "data:read,data:write"] [--expires 90d] [--rpm 1000]
 *                       [--allowed-ips "203.0.113.10,198.51.100.0/24,2001:db8::/32"]
 *
 * Una clave con --scopes "*" equivale a la master key: el servidor exige --allowed-ips (sin
 * 0.0.0.0/0) y --expires de 90 días como máximo (ADR-015).
 *   zen api-keys revoke --id <keyId> [--reason "filtrada"]
 *   zen api-keys rotate --id <keyId> [--grace 24h]
 *
 * Servidor y app: ZENITH_SERVER_URL, ZENITH_APP_ID y ZENITH_MASTER_KEY (o el .env del proyecto).
 */
import { parseArgs } from "@std/cli/parse-args";
import { loadZenConfig, zenApiCall } from "./_utils.ts";

const HELP = `
zen api-keys — API keys de la app (en el servidor)

  list                         Lista las claves (nunca el secreto)
  create --name <n>            Crea una clave. Opciones: --prefix sk|pk|rk  --env live|test
                               --scopes "a,b"  --expires 90d  --rpm 1000
                               --allowed-ips "IP o CIDR,…" (obligatorio con --scopes "*",
                               que además exige --expires de 90d como máximo)
  revoke --id <id>             Revoca una clave ya. Opción: --reason "<motivo>"
  rotate --id <id>             Crea una nueva con los mismos permisos; la vieja vale --grace (24h)
`;

const graceHours = (v: string | undefined): number => {
  if (!v) return 24;
  const m = v.match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`--grace no válido: "${v}". Usa 30m, 24h o 7d.`);
  const n = Number(m[1]);
  return m[2] === "m" ? n / 60 : m[2] === "h" ? n : n * 24;
};

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    string: ["prefix", "env", "scopes", "name", "expires", "rpm", "id", "reason", "grace", "allowed-ips"],
    boolean: ["help", "json"],
    alias: { help: "h" },
  });
  const sub = args._[0] as string | undefined;
  if (!sub || args.help) return void console.log(HELP);
  const cfg = await loadZenConfig();

  switch (sub) {
    case "list": {
      const { results } = await zenApiCall(cfg, "GET", "/zen/api-keys");
      if (args.json) return void console.log(JSON.stringify(results, null, 2));
      if (!results.length) return void console.log(`La app ${cfg.appId} no tiene API keys.`);
      for (const k of results) {
        const status = k.revokedAt ? "REVOCADA" : k.expiresAt && new Date(k.expiresAt) < new Date() ? "EXPIRADA" : "activa";
        const ips = k.allowedIps?.length ? `  IP: ${k.allowedIps.join(",")}` : "";
        console.log(`${k.id}  ${k.prefix}_${k.env}  ${status.padEnd(8)}  ${k.name}  [${k.scopes.join(",")}]${ips}  último uso: ${k.lastUsedAt ?? "nunca"}`);
      }
      return;
    }
    case "create": {
      if (!args.name) throw new Error("--name es obligatorio.");
      const rpm = args.rpm === undefined ? undefined : Number(args.rpm);
      const res = await zenApiCall(cfg, "POST", "/zen/api-keys", {
        name: args.name,
        prefix: args.prefix ?? "sk",
        env: args.env ?? "live",
        scopes: args.scopes ? args.scopes.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        expiresIn: args.expires,
        requestsPerMinute: rpm,
        allowedIps: args["allowed-ips"] ? args["allowed-ips"].split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
      console.log(`✅ Clave ${res.record.id} (${res.record.prefix}_${res.record.env}) para ${res.record.appId}`);
      console.log(`   Permisos: ${res.record.scopes.join(", ")}  ·  Expira: ${res.record.expiresAt ?? "nunca"}`);
      if (res.record.allowedIps?.length) console.log(`   Solo desde: ${res.record.allowedIps.join(", ")}`);
      console.log(`\n🔐 Guárdala ahora, no se vuelve a mostrar:\n   ${res.key}\n`);
      return;
    }
    case "revoke": {
      if (!args.id) throw new Error("--id es obligatorio.");
      await zenApiCall(cfg, "POST", `/zen/api-keys/${encodeURIComponent(args.id)}/revoke`, { reason: args.reason ?? "manual" });
      return void console.log(`✅ Clave ${args.id} revocada.`);
    }
    case "rotate": {
      if (!args.id) throw new Error("--id es obligatorio.");
      const res = await zenApiCall(cfg, "POST", `/zen/api-keys/${encodeURIComponent(args.id)}/rotate`, { graceHours: graceHours(args.grace) });
      console.log(`✅ Nueva clave ${res.record.id}; la anterior (${res.previous}) sigue válida ${args.grace ?? "24h"}.`);
      console.log(`\n🔐 Guárdala ahora, no se vuelve a mostrar:\n   ${res.key}\n`);
      return;
    }
    default:
      throw new Error(`Subcomando desconocido: ${sub}. Usa: zen api-keys --help`);
  }
}
