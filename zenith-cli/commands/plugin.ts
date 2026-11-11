/**
 * @cli zenith plugin <subcommand>
 *
 * Subcomandos:
 *   zenith plugin keygen <author-id>
 *     Genera un nuevo par Ed25519 y guarda en ~/.zenith/keys/<author-id>.{pub,priv}
 *
 *   zenith plugin sign <plugin-file>
 *     Firma el plugin y produce <plugin-file>.manifest.json
 *     (lee la private key de ~/.zenith/keys/<author-id>.priv o ZENITH_PLUGIN_KEY env)
 *
 *   zenith plugin verify <plugin-file>
 *     Verifica la firma contra el trust store local
 *
 *   zenith plugin trust <keyId> <publicKeyB64>
 *     Agrega una clave pública al trust store del proyecto
 *
 *   zenith plugin revoke <keyId> [--reason="..."]
 *     Marca una clave como revocada
 *
 *   zenith plugin list
 *     Lista las claves confiadas y revocadas
 */

import {
  addKey,
  buildKeyId,
  buildPluginArtifact,
  generateKeyPair,
  loadMergedTrustStore,
  parseManifest,
  type PluginPermission,
  projectTrustPath,
  revokeKey,
  saveTrustStore,
  sha256OfFile,
  signPlugin,
  validatePublicKey,
  verifyPlugin,
} from "@zuccadev-labs/zenith/plugin-signing";

// ── helpers ────────────────────────────────────────────────────────────────

const KEYS_DIR = `${Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/tmp"}/.zenith/keys`;

function die(msg: string, code = 1): never {
  console.error(`[zenith plugin] \u274c ${msg}`);
  Deno.exit(code);
}

function printOk(msg: string) {
  console.log(`[zenith plugin] \u2705 ${msg}`);
}

async function ensureKeysDir(): Promise<string> {
  await Deno.mkdir(KEYS_DIR, { recursive: true });
  return KEYS_DIR;
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] ?? "true";
  }
  return out;
}

function printUsage() {
  console.log(`zenith plugin \u2014 plugin manifest signing (Ed25519)

Subcomandos:
  keygen <author-id>                  Genera par Ed25519 en ~/.zenith/keys/
  sign   <plugin-file>                Firma el plugin y crea .manifest.json
  verify <plugin-file>                Verifica la firma contra trust store
  trust  <keyId> <publicKeyB64>       Agrega clave al trust store del proyecto
  revoke <keyId> --reason="..."       Revoca una clave
  list                                Lista claves del trust store merged
  help                                Muestra este mensaje
`);
}

// ── keygen ──────────────────────────────────────────────────────────────────

async function cmdKeygen(args: string[]): Promise<void> {
  const authorId = args[0];
  if (!authorId) die("Falta <author-id>");
  if (!/^[a-z0-9-]+$/.test(authorId)) {
    die(`author-id inv\u00e1lido: "${authorId}" (lowercase alphanumeric + hyphens)`);
  }

  const kp = await generateKeyPair();
  const keyId = buildKeyId(authorId, kp.publicKey);

  const dir = await ensureKeysDir();
  const pubPath = `${dir}/${authorId}.pub`;
  const privPath = `${dir}/${authorId}.priv`;

  await Deno.writeTextFile(
    pubPath,
    `# Zenith Ed25519 public key\n# keyId: ${keyId}\n# alg: Ed25519\n${kp.publicKey}\n`,
  );
  await Deno.writeTextFile(
    privPath,
    `# Zenith Ed25519 private key (PKCS8)\n# keyId: ${keyId}\n# KEEP SECRET \u2014 do not commit\n${kp.privateKey}\n`,
  );

  // Permisos 600 en la privada (Unix only; Windows lo ignora silenciosamente)
  if (Deno.build.os !== "windows") {
    try {
      await Deno.chmod(privPath, 0o600);
    } catch { /* noop */ }
  }

  printOk(`Par de claves generado:`);
  console.log(`  keyId:    ${keyId}`);
  console.log(`  p\u00fablica:  ${pubPath}`);
  console.log(`  privada: ${privPath}  (permisos 600)`);
  console.log(`\n  Para que un operador conf\u00ede en esta clave, debe ejecutar:`);
  console.log(`    zenith plugin trust ${keyId} ${kp.publicKey}`);
}

// ── sign ────────────────────────────────────────────────────────────────────

async function readPrivateKey(authorId: string, flags: Record<string, string>): Promise<string> {
  // Prioridad: --key=<base64> > ZENITH_PLUGIN_KEY env > ~/.zenith/keys/<author>.priv
  if (flags.key) return flags.key;
  const envKey = Deno.env.get("ZENITH_PLUGIN_KEY");
  if (envKey) return envKey;
  const privPath = `${KEYS_DIR}/${authorId}.priv`;
  try {
    const content = await Deno.readTextFile(privPath);
    // Skip comentarios (#) y líneas vacías
    const b64 = content.split("\n").filter((l) => l && !l.startsWith("#")).join("").trim();
    return b64;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      die(`No se encontr\u00f3 la clave privada. Prob\u00e1:
  zenith plugin keygen ${authorId}
  export ZENITH_PLUGIN_KEY=<base64>
  --key=<base64>`);
    }
    throw e;
  }
}

async function cmdSign(args: string[]): Promise<void> {
  const pluginFile = args[0];
  if (!pluginFile) die("Falta <plugin-file>");
  const flags = parseFlags(args.slice(1));
  const authorId = flags.author || flags.a;
  if (!authorId) die("Falta --author=<author-id>");

  const { sha256, size } = await sha256OfFile(pluginFile);
  const name = pluginFile.split("/").pop()?.split("\\").pop() ?? pluginFile;
  const version = flags.version || flags.v || "0.0.0";
  const versionStr = Array.isArray(version) ? version[0] : version;

  const permissionsStr = flags.permissions || flags.p || "data:read";
  const permissions = permissionsStr.split(",").map((p) => p.trim()) as PluginPermission[];

  const privB64 = await readPrivateKey(authorId, flags);
  const { buildKeyId: _b, importPublicRaw: _i, ...rest } = await import(
    "@zuccadev-labs/zenith/plugin-signing"
  );
  // Necesitamos la pub key para construir el keyId. Asumimos que la p\u00fablica est\u00e1 al lado.
  const pubPath = `${KEYS_DIR}/${authorId}.pub`;
  let pubB64: string;
  try {
    const content = await Deno.readTextFile(pubPath);
    pubB64 = content.split("\n").filter((l) => l && !l.startsWith("#")).join("").trim();
  } catch {
    die(`No se encontr\u00f3 la clave p\u00fablica en ${pubPath}`);
  }
  const keyId = buildKeyId(authorId, pubB64);

  const artifact = buildPluginArtifact({
    name,
    version: versionStr,
    sha256,
    size,
    permissions,
    author: {
      id: authorId,
      keyId,
      ...(flags.contact ? { contact: flags.contact } : {}),
    },
  });

  const manifest = await signPlugin({
    artifact,
    privateKeyB64: privB64,
    authorId,
    keyId,
  });

  const manifestPath = `${pluginFile}.manifest.json`;
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  printOk(`Plugin firmado:`);
  console.log(`  manifest: ${manifestPath}`);
  console.log(`  keyId:    ${keyId}`);
  console.log(`  sha256:   ${sha256.substring(0, 16)}...`);
  console.log(`\n  \u26a0\ufe0f  Distribu\u00ed el .manifest.json junto con el plugin.`);
  console.log(`  El operador debe aprobar la clave:`);
  console.log(`    zenith plugin trust ${keyId} ${pubB64}`);
}

// ── verify ──────────────────────────────────────────────────────────────────

async function cmdVerify(args: string[]): Promise<void> {
  const pluginFile = args[0];
  if (!pluginFile) die("Falta <plugin-file>");
  const flags = parseFlags(args.slice(1));

  const manifestPath = flags.manifest || `${pluginFile}.manifest.json`;
  let manifestRaw: string;
  try {
    manifestRaw = await Deno.readTextFile(manifestPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      die(`No se encontr\u00f3 manifest en ${manifestPath}`);
    }
    throw e;
  }
  const manifest = parseManifest(manifestRaw);

  const trust = await loadMergedTrustStore();
  const result = await verifyPlugin({ pluginPath: pluginFile, manifest, trust });

  if (result.ok) {
    printOk(`Plugin v\u00e1lido:`);
    console.log(`  keyId:  ${result.keyId}`);
    console.log(`  author: ${result.author}`);
  } else {
    die(`Plugin INV\u00c1LIDO: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
  }
}

// ── trust ───────────────────────────────────────────────────────────────────

async function cmdTrust(args: string[]): Promise<void> {
  const keyId = args[0];
  const publicKeyB64 = args[1];
  if (!keyId || !publicKeyB64) {
    die("Uso: zenith plugin trust <keyId> <publicKeyB64>");
  }
  if (!(await validatePublicKey(publicKeyB64))) {
    die(`publicKey inv\u00e1lida (no es una clave Ed25519)`);
  }
  const flags = parseFlags(args.slice(2));
  const projectPath = projectTrustPath();

  const trust = await loadMergedTrustStore();
  // Filtrar las del project (reemplazar)
  const others = trust.keys.filter((k) => k.keyId !== keyId);
  const updated = {
    version: "1.0" as const,
    keys: [
      ...others.filter((k) => !projectPath.includes("/")), // noop: mantenemos del global
      {
        keyId,
        publicKey: publicKeyB64,
        alg: "Ed25519" as const,
        addedAt: new Date().toISOString(),
        addedBy: "user" as const,
        ...(flags.label ? { label: flags.label } : {}),
      },
    ],
  };

  // Persistir solo en project store
  const projectStore = { version: "1.0" as const, keys: updated.keys };
  await saveTrustStore(projectPath, projectStore);
  printOk(`Clave ${keyId} agregada al trust store del proyecto (${projectPath})`);
}

// ── revoke ──────────────────────────────────────────────────────────────────

async function cmdRevoke(args: string[]): Promise<void> {
  const keyId = args[0];
  if (!keyId) die("Uso: zenith plugin revoke <keyId> [--reason='...']");
  const flags = parseFlags(args.slice(1));
  const reason = flags.reason || "Manually revoked";
  const projectPath = projectTrustPath();

  let store;
  try {
    const content = await Deno.readTextFile(projectPath);
    store = JSON.parse(content);
  } catch {
    store = { version: "1.0", keys: [] };
  }
  const updated = revokeKey(store, keyId, reason);
  await saveTrustStore(projectPath, updated);
  printOk(`Clave ${keyId} revocada. Raz\u00f3n: ${reason}`);
}

// ── list ────────────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  const trust = await loadMergedTrustStore();
  if (trust.keys.length === 0) {
    console.log("[zenith plugin] No hay claves en el trust store.");
    return;
  }
  console.log("Claves confiadas:");
  for (const k of trust.keys) {
    const status = k.revokedAt ? `\u26d4 REVOCADA (${k.revokedAt})` : "\u2705 activa";
    const label = k.label || k.addedBy;
    console.log(`  ${k.keyId}  [${status}]  addedBy=${k.addedBy}  label=${label}`);
  }
}

// ── dispatcher ──────────────────────────────────────────────────────────────

export async function runPluginCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "keygen":
      await cmdKeygen(rest);
      break;
    case "sign":
      await cmdSign(rest);
      break;
    case "verify":
      await cmdVerify(rest);
      break;
    case "trust":
      await cmdTrust(rest);
      break;
    case "revoke":
      await cmdRevoke(rest);
      break;
    case "list":
      await cmdList();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      die(`Subcomando desconocido: ${sub}\nEjecut\u00e1 'zenith plugin help' para ver opciones.`);
  }
}

/** Registry entry point (args after "plugin"). */
export const run = runPluginCommand;
