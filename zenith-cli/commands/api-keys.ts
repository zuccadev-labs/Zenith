/**
 * @module @zenith/cli/commands/api-keys
 *
 * CLI para gestión de API Keys estilo Stripe.
 *
 * Subcomandos:
 *   zenith api-keys create --app <appId> --prefix <sk|pk|rk> --env <live|test>
 *                          --scopes <scope1,scope2> --name "Production server #1"
 *                          [--expires 90d] [--rpm 1000]
 *   zenith api-keys list   --app <appId>
 *   zenith api-keys revoke  --id <keyId> --reason "compromised"
 *   zenith api-keys rotate  --id <keyId> [--grace 24h]
 *
 * ⚠️  Por ahora usa InMemoryStore (no persistencia). Para producción,
 * conectar a MongoDBStore (Fase 1.G).
 */

import { parseArgs } from "jsr:@std/cli/parse-args";
import {
  ApiKeyManager,
  InMemoryStore,
  DEFAULT_SCOPES,
  type ApiKeyEnv,
  type ApiKeyPrefix,
  type ApiKeyScope,
} from "../../zenith-backend/src/security/api-keys/mod.ts";

const HELP = `
zenith api-keys — Gestión de API Keys estilo Stripe
====================================================

USO:
  zenith api-keys <subcomando> [opciones]

SUBCOMANDOS:
  create    Crea una nueva API key
  list      Lista las keys de una app (sin el secreto)
  revoke    Revoca una key inmediatamente
  rotate    Rota una key (genera nueva + marca la vieja con grace period)

EJEMPLOS:
  zenith api-keys create --app myAppId1 --prefix sk --env live \\
                         --scopes "data:read,data:write,users:read" \\
                         --name "Production server #1" --expires 90d

  zenith api-keys list   --app myAppId1
  zenith api-keys revoke --id aB3xY9zK --reason "leaked in git"
  zenith api-keys rotate --id aB3xY9zK --grace 24h
`;

function getManager(): ApiKeyManager {
  // TODO Fase 1.G: usar MongoDBStore en producción
  return new ApiKeyManager(new InMemoryStore());
}

function die(msg: string, code = 1): never {
  console.error(`❌ ${msg}`);
  Deno.exit(code);
}

async function cmdCreate(args: ReturnType<typeof parseArgs>): Promise<void> {
  const appId = args.app as string | undefined;
  const prefix = (args.prefix as ApiKeyPrefix | undefined) ?? "sk";
  const env = (args.env as ApiKeyEnv | undefined) ?? "live";
  const name = (args.name as string | undefined) ?? "Unnamed key";
  const scopesStr = (args.scopes as string | undefined) ?? "";
  const expiresIn = args.expires as string | undefined;
  const rpm = args.rpm ? parseInt(args.rpm as string, 10) : undefined;
  const createdBy = (args["created-by"] as string | undefined) ?? "admin:cli";

  if (!appId) die("--app es requerido");

  if (!["sk", "pk", "rk"].includes(prefix)) {
    die(`--prefix inválido: '${prefix}'. Use sk, pk o rk.`);
  }
  if (!["live", "test"].includes(env)) {
    die(`--env inválido: '${env}'. Use live o test.`);
  }

  const scopes = scopesStr
    ? (scopesStr.split(",").map(s => s.trim()) as ApiKeyScope[])
    : DEFAULT_SCOPES[prefix];

  const manager = getManager();
  const result = await manager.create({
    appId,
    prefix,
    env,
    scopes,
    name,
    createdBy,
    expiresIn,
    requestsPerMinute: rpm,
  });

  console.log("✅ API key creada exitosamente\n");
  console.log(`  ID:      ${result.record.id}`);
  console.log(`  Prefix:  ${result.record.prefix}_${result.record.env}`);
  console.log(`  App:     ${result.record.appId}`);
  console.log(`  Name:    ${result.record.name}`);
  console.log(`  Scopes:  ${result.record.scopes.join(", ")}`);
  console.log(`  Rate:    ${result.record.rateLimit.requestsPerMinute} req/min`);
  if (result.record.expiresAt) {
    console.log(`  Expires: ${result.record.expiresAt}`);
  } else {
    console.log(`  Expires: never`);
  }
  console.log("");
  console.log("🔐 KEY (guárdala AHORA — no se mostrará de nuevo):");
  console.log(`  ${result.plaintext}`);
  console.log("");
  console.log("⚠️  Esta key da acceso completo al backend con los scopes concedidos.");
  console.log("   Trátala como una contraseña. Si se filtra, revócala INMEDIATAMENTE:");
  console.log(`   zenith api-keys revoke --id ${result.record.id} --reason "leaked"`);
}

async function cmdList(args: ReturnType<typeof parseArgs>): Promise<void> {
  const appId = args.app as string | undefined;
  if (!appId) die("--app es requerido");

  const manager = getManager();
  const keys = await manager.listByApp(appId);

  if (keys.length === 0) {
    console.log(`No hay API keys registradas para la app '${appId}'.`);
    console.log("");
    console.log("💡 Esto puede ser porque:");
    console.log("   - Aún no creaste ninguna key para esta app:");
    console.log(`     zenith api-keys create --app ${appId} --prefix sk --env live \\`);
    console.log(`                            --name "Mi primera key"`);
    console.log("   - El store es in-memory y los datos se pierden al reiniciar.");
    console.log("     (Fase 1.G: MongoDBStore para persistencia entre procesos)");
    return;
  }

  console.log(`API keys para la app '${appId}' (${keys.length}):\n`);
  console.log("ID         PREFIX   ENV     SCOPES                            CREATED                LAST USED              EXPIRES                STATUS");
  console.log("─────────  ───────  ──────  ───────────────────────────────  ────────────────────  ────────────────────  ────────────────────  ──────");
  for (const k of keys) {
    const scopes = k.scopes.join(",");
    const truncated = scopes.length > 30 ? scopes.slice(0, 27) + "..." : scopes;
    const status = k.revokedAt ? "REVOKED" : (k.expiresAt && new Date(k.expiresAt) < new Date() ? "EXPIRED" : "active");
    console.log(
      `${k.id.padEnd(10)}  ${k.prefix}_${k.env.padEnd(5)}  ${k.env.padEnd(7)}  ${truncated.padEnd(31)}  ${k.createdAt}  ${k.lastUsedAt ?? "(never)".padEnd(20)}  ${k.expiresAt ?? "never".padEnd(20)}  ${status}`,
    );
  }
  console.log("");
  console.log("⚠️  Los secretos NUNCA se listan. Solo se pueden ver al crear la key.");
}

async function cmdRevoke(args: ReturnType<typeof parseArgs>): Promise<void> {
  const id = args.id as string | undefined;
  const reason = (args.reason as string | undefined) ?? "manual";
  const actor = (args.actor as string | undefined) ?? "admin:cli";

  if (!id) die("--id es requerido");

  const manager = getManager();
  await manager.revoke(id, actor, reason);
  console.log(`✅ Key ${id} revocada. Razón: ${reason}. Actor: ${actor}.`);
}

async function cmdRotate(args: ReturnType<typeof parseArgs>): Promise<void> {
  const id = args.id as string | undefined;
  const grace = args.grace as string | undefined;
  const actor = (args.actor as string | undefined) ?? "admin:cli";

  if (!id) die("--id es requerido");

  let graceMs: number;
  if (!grace) {
    graceMs = 24 * 60 * 60 * 1000;  // 24h default
  } else {
    const m = grace.match(/^(\d+)([smhd])$/);
    if (!m) die(`--grace inválido: '${grace}'. Use "24h", "30m", etc.`);
    const n = parseInt(m[1], 10);
    graceMs = (
      m[2] === "s" ? n * 1000 :
      m[2] === "m" ? n * 60_000 :
      m[2] === "h" ? n * 3_600_000 :
      n * 86_400_000
    );
  }

  const manager = getManager();
  const result = await manager.rotate(id, { createdBy: actor, gracePeriodMs: graceMs });

  console.log("✅ Rotación completada\n");
  console.log(`  Key vieja: ${id} (sigue válida por ${grace ?? "24h"})`);
  console.log(`  Key nueva: ${result.record.id}`);
  console.log("");
  console.log("🔐 NUEVA KEY (guárdala AHORA — no se mostrará de nuevo):");
  console.log(`  ${result.plaintext}`);
  console.log("");
  console.log("💡 Recomendado: actualiza tu código/app para usar la nueva key");
  console.log("   y verifica que todo funcione antes de que expire la grace period.");
}

export async function runApiKeys(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["app", "prefix", "env", "scopes", "name", "expires", "rpm", "id", "reason", "grace", "created-by", "actor"],
    boolean: ["help"],
    alias: { help: "h" },
  });

  const subcommand = args._[0] as string | undefined;

  if (!subcommand || args.help) {
    console.log(HELP);
    return;
  }

  switch (subcommand) {
    case "create": return await cmdCreate(args);
    case "list":   return await cmdList(args);
    case "revoke": return await cmdRevoke(args);
    case "rotate": return await cmdRotate(args);
    default:
      die(`Subcomando desconocido: '${subcommand}'`);
  }
}

if (import.meta.main) {
  await runApiKeys();
}
