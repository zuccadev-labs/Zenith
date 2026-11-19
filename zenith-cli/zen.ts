/**
 * @module @zenith/cli/zen
 *
 * The `zen` command. A Zenith project is
 *
 *   zen.config.ts   the app's configuration (reads .env)
 *   cloud/          cloud code: Zen.Cloud.define(...), triggers
 *   plugins/        the project's own plugins (verified against plugins.lock.json)
 *   .env            secrets, never committed
 *   deno.json       import map: @zuccadev-labs/zenith → the engine
 *
 * and the engine stays a dependency: `zen dev` runs the project with hot reload, `zen compile`
 * links it statically into one binary. Every other command comes from `commands/registry.ts`.
 *
 * Zenith's server SDK is the engine (`@zuccadev-labs/zenith`) plus this CLI. The client SDKs
 * (`sdk/`) only talk to a running server; they never create a project.
 *
 *   deno install -g -A --unstable-kv -n zen jsr:@zuccadev-labs/zenith-cli/zen
 *   zen init miapp
 */
import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs/ensure-dir";
import { expandGlob } from "@std/fs/expand-glob";
import { fromFileUrl, join, relative, resolve } from "@std/path";
import { commandTable, helpText } from "./commands/registry.ts";

/** Version of this CLI. */
export const VERSION = "0.3.0";

/** The engine release new projects depend on. Keep in step with zenith-backend/deno.json (a test checks it). */
export const ENGINE_VERSION = "0.2.0";
/** JSR specifier of the engine written into new projects' import map. */
export const ENGINE_JSR = `jsr:@zuccadev-labs/zenith@^${ENGINE_VERSION}`;

/** In the monorepo, the engine next to this CLI. */
const CORE_ENTRY = new URL("../zenith-backend/src/mod.ts", import.meta.url);
const CORE_DENO_JSON = new URL("../zenith-backend/deno.json", import.meta.url);
const CORE_DENO_LOCK = new URL("../zenith-backend/deno.lock", import.meta.url);

const exists = async (p: string): Promise<boolean> => {
  try {
    await Deno.lstat(p);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0"))
    .join("");

/**
 * Where a new project takes the engine from:
 * - "jsr": the published package. The default when zen was installed from JSR.
 * - "local": the monorepo's zenith-backend, to try engine changes before publishing. The default
 *   when zen runs from a checkout that has it.
 * ZENITH_ENGINE=jsr|local overrides the choice.
 */
export async function engineSource(): Promise<"jsr" | "local"> {
  const forced = Deno.env.get("ZENITH_ENGINE");
  if (forced === "jsr" || forced === "local") return forced;
  if (forced) throw new Error(`ZENITH_ENGINE=${forced}: usa "jsr" o "local".`);
  return CORE_ENTRY.protocol === "file:" && (await exists(fromFileUrl(CORE_ENTRY)))
    ? "local"
    : "jsr";
}

/** deno.json of a new project. From JSR the engine brings its own dependencies; locally, its import map comes along. */
async function projectDenoJson(source: "jsr" | "local"): Promise<string> {
  const base = {
    nodeModulesDir: "auto",
    unstable: ["kv"],
    tasks: { dev: "zen dev", compile: "zen compile" },
  };
  if (source === "jsr") {
    return JSON.stringify({ imports: { "@zuccadev-labs/zenith": ENGINE_JSR }, ...base }, null, 2) +
      "\n";
  }
  const core = JSON.parse(await Deno.readTextFile(CORE_DENO_JSON));
  return JSON.stringify(
    {
      imports: { ...core.imports, "@zuccadev-labs/zenith": CORE_ENTRY.href },
      ...base,
      ...(core.minimumDependencyAge ? { minimumDependencyAge: core.minimumDependencyAge } : {}),
    },
    null,
    2,
  ) + "\n";
}

async function runInit(args: string[]): Promise<void> {
  const name = args[0];
  const source = await engineSource();
  if (name !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(
      `Nombre de proyecto no válido: ${JSON.stringify(name)} (letras, números, _ y -).`,
    );
  }
  const dir = name ? resolve(Deno.cwd(), name) : Deno.cwd();
  const appId = (name ?? (dir.split(/[\\/]/).pop() || "zenith_app")).replace(/[^A-Za-z0-9_]/g, "_");
  for (const f of ["zen.config.ts", "deno.json", ".env", "cloud/main.ts"]) {
    if (await exists(join(dir, f))) {
      throw new Error(`${join(dir, f)} ya existe: zen init no sobrescribe un proyecto.`);
    }
  }
  console.log(`🚀 Nuevo proyecto Zenith en ${dir}`);
  await ensureDir(join(dir, "cloud"));
  await ensureDir(join(dir, "plugins"));

  await Deno.writeTextFile(
    join(dir, ".env"),
    [
      `ZENITH_APP_ID=${appId}`,
      `# 64 bytes aleatorios. En producción, desde un gestor de secretos.`,
      `ZENITH_MASTER_KEY=${randomHex(64)}`,
      `ZENITH_DATABASE_URI=mongodb://127.0.0.1:27017/${appId}?directConnection=true`,
      `ZENITH_PORT=1337`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  await Deno.writeTextFile(
    join(dir, "zen.config.ts"),
    `// Configuración de la app. Los secretos vienen de .env (zen dev lo carga).
const env = (name: string): string => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(\`Falta \${name}: defínelo en .env o en el entorno.\`);
  return v;
};
const port = Number(Deno.env.get("ZENITH_PORT") ?? "1337");

export default {
  appId: env("ZENITH_APP_ID"),
  masterKey: env("ZENITH_MASTER_KEY"),
  databaseURI: env("ZENITH_DATABASE_URI"),
  serverURL: \`http://localhost:\${port}\`,
  port,
  cloudCodePath: "./cloud/main.ts",
  pluginsPath: "./plugins",
  features: {},
};
`,
  );

  await Deno.writeTextFile(
    join(dir, "cloud", "main.ts"),
    `import { Zen } from "@zuccadev-labs/zenith";

Zen.Cloud.define("hello", () => ({ message: "Hola desde Zenith Cloud Code" }));
`,
  );
  await Deno.writeTextFile(join(dir, "plugins", ".gitkeep"), "");
  await Deno.writeTextFile(join(dir, "deno.json"), await projectDenoJson(source));
  // Locally, start from the engine's lockfile: the exact versions and hashes it was tested with.
  // From JSR, the first `zen dev` writes the project's own deno.lock (commit it).
  const lock = source === "local" && (await exists(fromFileUrl(CORE_DENO_LOCK)));
  if (lock) await Deno.copyFile(CORE_DENO_LOCK, join(dir, "deno.lock"));
  await Deno.writeTextFile(
    join(dir, ".gitignore"),
    ".env\n.zenith/\nnode_modules/\n/zenith-app\n/zenith-app.exe\n",
  );

  console.log(
    `✅ Creado: cloud/, plugins/, zen.config.ts, .env, deno.json, ${
      lock ? "deno.lock, " : ""
    }.gitignore`,
  );
  console.log(
    `   Motor: ${source === "jsr" ? ENGINE_JSR : `${fromFileUrl(CORE_ENTRY)} (monorepo)`}`,
  );
  console.log(`\n   ${name ? `cd ${name} && ` : ""}zen dev`);
}

/**
 * .zenith/entry.ts: the program `zen dev` runs and `zen compile` links. With `staticLink`, cloud/
 * and plugins/ are imported statically (a compiled binary cannot import project files later).
 */
async function writeEntry(cwd: string, staticLink: boolean): Promise<string> {
  const zenithDir = join(cwd, ".zenith");
  await ensureDir(zenithDir);
  const imports: string[] = [];
  if (staticLink) {
    for (const glob of ["plugins/**/*.{ts,tsx}", "cloud/**/*.{ts,tsx}"]) {
      for await (const e of expandGlob(join(cwd, glob))) {
        if (e.isFile) {
          imports.push(`import "./${relative(zenithDir, e.path).replace(/\\/g, "/")}";`);
        }
      }
    }
  }
  await Deno.writeTextFile(
    join(zenithDir, "manifest.ts"),
    `// Generado por zen. No editar.\n${
      imports.join("\n")
    }\nexport const linked = ${imports.length};\n`,
  );
  const entry = join(zenithDir, "entry.ts");
  await Deno.writeTextFile(
    entry,
    `// Generado por zen. No editar.
import { createZenithApp } from "@zuccadev-labs/zenith";
import config from "../zen.config.ts";
import "./manifest.ts";

const { handler } = await createZenithApp(config as any);
if (!handler) throw new Error("Zenith started without HTTP routes.");
const port = (config as any).port ?? 1337;
Deno.serve({ port }, (req, info) => {
  // The pipeline needs the client address: master key only from localhost, limits per client.
  (req as unknown as { __socketAddr: Deno.NetAddr }).__socketAddr = info.remoteAddr as Deno.NetAddr;
  return handler(req);
});
console.log(\`🌐 Zenith en http://localhost:\${port}\`);
`,
  );
  return entry;
}

async function requireProject(cwd: string): Promise<void> {
  for (const f of ["zen.config.ts", "deno.json"]) {
    if (!(await exists(join(cwd, f)))) {
      throw new Error(`No hay ${f} en ${cwd}: ¿es un proyecto Zenith? (zen init)`);
    }
  }
}

async function runDev(): Promise<void> {
  const cwd = Deno.cwd();
  await requireProject(cwd);
  const entry = await writeEntry(cwd, false);
  console.log("🛠️  Zenith en desarrollo (recarga en caliente)…");
  const envFile = (await exists(join(cwd, ".env"))) ? ["--env-file=.env"] : [];
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-kv",
      "--no-check",
      "--watch",
      ...envFile,
      "--config",
      join(cwd, "deno.json"),
      entry,
      "--mode=development",
    ],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  // Stopping `zen dev` stops the server too (otherwise it is left running, orphaned).
  const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch (_e) { /* already gone */ }
  };
  for (const s of signals) Deno.addSignalListener(s, stop);
  const status = await child.status;
  for (const s of signals) Deno.removeSignalListener(s, stop);
  if (!status.success && status.signal === null) Deno.exit(status.code);
}

async function runCompile(args: string[]): Promise<void> {
  const cwd = Deno.cwd();
  await requireProject(cwd);
  const flags = parseArgs(args, { string: ["output"] });
  const output = resolve(cwd, flags.output ?? "zenith-app");
  const entry = await writeEntry(cwd, true);
  console.log("📦 Compilando el proyecto en un binario…");
  const status = await new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      "--unstable-kv",
      "--no-check",
      "--allow-net",
      "--allow-read",
      "--allow-env",
      "--allow-write",
      "--allow-sys",
      "--allow-ffi",
      "--config",
      join(cwd, "deno.json"),
      "--output",
      output,
      entry,
      "--mode=production",
    ],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error("La compilación falló.");
  console.log(`✅ ${output}`);
}

/** `init`, `dev`, `compile`: used by the registry. */
export async function runDevCommand(
  name: "init" | "dev" | "compile",
  args: string[],
): Promise<void> {
  if (name === "init") return await runInit(args);
  if (name === "dev") return await runDev();
  return await runCompile(args);
}

/** Runs `argv` (command first). `binary` is the name shown in help. Returns the exit code. */
export async function main(argv: string[], binary = "zen"): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(helpText(binary, VERSION));
    return 0;
  }
  if (cmd === "version" || cmd === "--version") {
    console.log(`${binary} v${VERSION}`);
    return 0;
  }
  const command = commandTable().get(cmd);
  if (!command) {
    console.error(`❌ Comando desconocido: ${cmd}. Usa: ${binary} --help`);
    return 1;
  }
  try {
    await command.run(rest);
    return 0;
  } catch (e) {
    console.error(`❌ ${(e as Error).message ?? e}`);
    return 1;
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args, "zen"));
