import { ensureDir } from "@std/fs/ensure-dir";
import { join, relative } from "@std/path";

interface InitOptions {
  projectName: string;
  appId: string;
  port: number;
  targetDir: string;
  masterKey?: string;
  dbUri?: string;
}

const CLOUD_MAIN_TS = `import { Zen } from "@zuccadev-labs/zenith";

// Import cloud functions and triggers.
// The engine loads this file via the \`cloudCodePath\` config option.
import "./examples/main.ts";
`;

function generateConfigCode(opts: InitOptions): string {
  const mk = opts.masterKey || `zen_dev_insecure_${crypto.randomUUID().slice(0, 16)}`;
  return `import type { ZenithConfig, ZenithAppDefinition } from "@zuccadev-labs/zenith";

const {
  ZENITH_PORT = "${opts.port}",
  ZENITH_MASTER_KEY = "${mk}",
  ZENITH_DATABASE_URI = "${opts.dbUri || 'mongodb://localhost:27017/' + opts.appId}",
} = Deno.env.toObject();

export const apps: ZenithAppDefinition[] = [
  {
    mountPath: "/parse",
    config: {
      appId: "${opts.appId}",
      masterKey: ZENITH_MASTER_KEY,
      serverURL: \`http://localhost:\${ZENITH_PORT}/parse\`,
      port: parseInt(ZENITH_PORT, 10),
      cloudCodePath: "./cloud/main.ts",
      pluginsPath: "./plugins",
      databaseURI: ZENITH_DATABASE_URI,
      allowClientClassCreation: true,
      enableAnonymousUsers: false,
    } satisfies ZenithConfig,
  },
];
`;
}

function generateEnvFile(opts: InitOptions): string {
  const mk = opts.masterKey || `zen_dev_insecure_${crypto.randomUUID().slice(0, 16)}`;
  return `# Zenith Project: ${opts.projectName}
ZENITH_APP_ID=${opts.appId}
ZENITH_PORT=${opts.port}
ZENITH_MASTER_KEY=${mk}
ZENITH_DATABASE_URI=${opts.dbUri || `mongodb://localhost:27017/${opts.appId}`}
`;
}

function generateDenoJson(opts: InitOptions): string {
  return JSON.stringify({
    name: opts.projectName,
    version: "0.1.0",
    exports: "./cloud/main.ts",
    tasks: {
      dev: "deno run -A --watch=cloud/,plugins/,apps.config.ts jsr:@zuccadev-labs/zenith dev",
      start: "deno run -A jsr:@zuccadev-labs/zenith --mode=production",
    },
    imports: { "@zuccadev-labs/zenith": "jsr:@zuccadev-labs/zenith@^0.1.0" },
  }, null, 2) + "\n";
}

function generateGitignore(): string {
  return ["node_modules/", "dist/", "_build/", "coverage/", "logs/", ".env", ""].join("\n");
}

async function copyDirContents(srcDir: string, destDir: string): Promise<void> {
  for await (const entry of Deno.readDir(srcDir)) {
    if (entry.name.startsWith(".")) continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory) {
      await ensureDir(dest);
      await copyDirContents(src, dest);
    } else if (entry.isFile) {
      await Deno.copyFile(src, dest);
    }
  }
}

export async function initProject(opts: InitOptions): Promise<void> {
  const { projectName, targetDir } = opts;

  console.log(`\n  Initializing Zenith project: ${projectName}`);
  console.log(`  Location: ${targetDir}\n`);

  // Check target doesn't exist or is empty
  try {
    const existing = await Deno.stat(targetDir);
    if (existing.isDirectory) {
      for await (const _ of Deno.readDir(targetDir)) {
        console.error(`  Target directory '${targetDir}' already exists and is not empty.`);
        console.error(`  Choose a different name or remove it first.`);
        Deno.exit(1);
      }
    }
  } catch {
    // Directory doesn't exist - proceed
  }

  // Create directory scaffold
  await ensureDir(targetDir);
  await ensureDir(join(targetDir, "cloud", "examples"));
  await ensureDir(join(targetDir, "plugins"));
  await ensureDir(join(targetDir, ".zenith"));

  // Copy cloud examples from boilerplate
  const boilerplateDir = join(import.meta.dirname!, "..", "example", "zenith-backend-boilerplate");
  try {
    const examplesSrc = join(boilerplateDir, "cloud", "examples");
    await copyDirContents(examplesSrc, join(targetDir, "cloud", "examples"));
  } catch {
    await Deno.writeTextFile(
      join(targetDir, "cloud", "examples", "health.ts"),
      `import { Zen } from "@zuccadev-labs/zenith";\n\nZen.Cloud.define("ping", async () => {\n  return { message: "pong from ${projectName}" };\n});\n`,
    );
  }

  // Write files
  await Deno.writeTextFile(join(targetDir, "cloud", "main.ts"), CLOUD_MAIN_TS);
  await Deno.writeTextFile(join(targetDir, "apps.config.ts"), generateConfigCode(opts));
  await Deno.writeTextFile(join(targetDir, ".env"), generateEnvFile(opts));
  await Deno.writeTextFile(join(targetDir, "deno.json"), generateDenoJson(opts));
  await Deno.writeTextFile(join(targetDir, ".gitignore"), generateGitignore());

  console.log(`  Project '${projectName}' initialized successfully!\n`);
  console.log(`  Next steps:`);
  console.log(`    cd ${relative(Deno.cwd(), targetDir) || "."}`);
  console.log(`    deno task dev\n`);
  console.log(`  Structure:`);
  console.log(`    ${projectName}/`);
  console.log(`    ├── apps.config.ts    — Application configuration`);
  console.log(`    ├── cloud/            — Cloud Code (functions, triggers)`);
  console.log(`    │   ├── main.ts       — Entry point`);
  console.log(`    │   └── examples/     — Reference examples`);
  console.log(`    ├── plugins/          — Extensions directory`);
  console.log(`    ├── .env              — Environment variables`);
  console.log(`    └── deno.json         — Deno configuration\n`);
}
