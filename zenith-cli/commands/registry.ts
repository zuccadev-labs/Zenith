/**
 * @module @zenith/cli/commands/registry
 *
 * Every `zen` command is a barrits trait that provides the capability `command:<name>`, like the
 * backend's traits. Composing them gives the two entry points (`zen.ts`, `mod.ts`) one table:
 * - a command declared twice, or two commands with the same name, fail composition;
 * - help is generated from the traits' summaries, so it cannot drift from what exists;
 * - each module is imported only when its command runs, so no command runs code at import time.
 *
 * A command module exports `run(args: string[])`, with `args` after the command name.
 */
import {
  type AnyTraitDescriptor,
  composeTraitDescriptors,
  createTraitDescriptor,
} from "@zuccadev-labs/barrits";

export interface ZenCommand {
  name: string;
  group: string;
  summary: string;
  aliases: string[];
  run(args: string[]): Promise<void>;
}

type Module = { run(args: string[]): Promise<void> };

function command(
  name: string,
  group: string,
  summary: string,
  load: () => Promise<Module>,
  aliases: string[] = [],
): AnyTraitDescriptor {
  const capability = `command:${name}`;
  return createTraitDescriptor({
    name: `ZenCommand_${name.replace(/[^A-Za-z0-9]/g, "_")}`,
    provides: [capability],
    runtimes: ["deno"],
    tags: [`group:${group}`],
    summary,
    create: () => ({
      [capability]: {
        name,
        group,
        summary,
        aliases,
        run: async (args: string[]) => await (await load()).run(args),
      } satisfies ZenCommand,
    }),
  });
}

/** `init`, `dev` and `compile` live in zen.ts itself; `load` breaks the import cycle. */
const dev = (name: "init" | "dev" | "compile") => (): Promise<Module> =>
  Promise.resolve({
    run: async (args: string[]) => await (await import("../zen.ts")).runDevCommand(name, args),
  });

export const COMMANDS: readonly AnyTraitDescriptor[] = [
  command(
    "init",
    "Desarrollo",
    "Crea un proyecto Zenith: cloud/, plugins/, zen.config.ts, .env, deno.json",
    dev("init"),
  ),
  command(
    "dev",
    "Desarrollo",
    "Levanta el proyecto con recarga en caliente (lee zen.config.ts, cloud/ y plugins/)",
    dev("dev"),
  ),
  command(
    "compile",
    "Desarrollo",
    "Empaqueta el proyecto en un binario único (AOT)",
    dev("compile"),
  ),
  command(
    "test",
    "Desarrollo",
    "Ejecuta suites E2E  [--watch] [--coverage] [<suite>]",
    async () => ({ run: (await import("./logs.ts")).runTest }),
  ),
  command(
    "deploy",
    "Operaciones",
    "Despliega el servidor  [--target local|docker|k8s] [--dry-run]",
    () => import("./deploy.ts"),
  ),
  command(
    "logs",
    "Operaciones",
    "Muestra o sigue logs  [--follow] [--level] [--service] [--tail N]",
    () => import("./logs.ts"),
  ),
  command(
    "migrate",
    "Operaciones",
    "Migraciones de BD  run | status | rollback | create <name>",
    async () => ({ run: (await import("./logs.ts")).runMigrate }),
  ),
  command(
    "generate",
    "Operaciones",
    "Genera documentación y especificaciones  openapi | docs | postman",
    () => import("./generate.ts"),
  ),
  command(
    "plugin",
    "Plugins",
    "Firma de plugins (Ed25519)  keygen | sign | verify | trust | revoke | list",
    () => import("./plugin.ts"),
  ),
  command(
    "plugins-lock",
    "Plugins",
    "Genera plugins.lock.json (SHA-256 de cada plugin)  [dir]",
    () => import("./plugins-lock.ts"),
    ["plugins:lock"],
  ),
  command(
    "webhook",
    "Integraciones",
    "Webhooks (Standard Webhooks)  list | create | verify | delete | pause | resume | test | rotate-secret | messages | attempts | redeliver | recover",
    () => import("./webhook.ts"),
  ),
  command(
    "email",
    "Integraciones",
    "Correo IMAP/SMTP  channels | threads | send | sync",
    () => import("./email.ts"),
  ),
  command(
    "calendar",
    "Integraciones",
    "Calendarios  channels | events | slots | conflicts | ics | sync",
    () => import("./calendar.ts"),
  ),
  command(
    "automation",
    "Integraciones",
    "Motor IF-THEN  list | create | get | toggle | test | logs | delete | actions",
    () => import("./automation.ts"),
  ),
  command(
    "api-keys",
    "Seguridad",
    "API keys de la app  list | create | revoke | rotate",
    () => import("./api-keys.ts"),
  ),
  command(
    "agent",
    "Seguridad",
    "Agentes del backend  list | get | run | chat",
    () => import("./agent.ts"),
  ),
  command(
    "mtls-gen-dev",
    "Seguridad",
    "Genera CA y certificados mTLS para desarrollo",
    () => import("./mtls-gen-dev.ts"),
    ["mtls:gen-dev"],
  ),
];

/** All commands, by name and alias. Throws if two commands collide. */
export function commandTable(): Map<string, ZenCommand> {
  const caps = composeTraitDescriptors(COMMANDS).traits as Record<string, unknown>;
  const table = new Map<string, ZenCommand>();
  for (const [cap, value] of Object.entries(caps)) {
    if (!cap.startsWith("command:")) continue;
    const c = value as ZenCommand;
    for (const key of [c.name, ...c.aliases]) {
      if (table.has(key)) throw new Error(`zen: "${key}" names two commands.`);
      table.set(key, c);
    }
  }
  return table;
}

export function helpText(binary: string, version: string): string {
  const groups = new Map<string, ZenCommand[]>();
  for (const c of new Set(commandTable().values())) {
    groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  }
  const lines = [
    `Zenith CLI v${version}`,
    "",
    `Uso: ${binary} <comando> [subcomando] [opciones]`,
    "",
  ];
  for (const [group, cmds] of groups) {
    lines.push(`${group}:`);
    for (const c of cmds) lines.push(`  ${c.name.padEnd(14)}${c.summary}`);
    lines.push("");
  }
  lines.push(
    "Variables: ZENITH_SERVER_URL, ZENITH_APP_ID, ZENITH_MASTER_KEY (o .env del directorio actual)",
  );
  lines.push(`Más ayuda: ${binary} <comando> --help`);
  return lines.join("\n");
}
