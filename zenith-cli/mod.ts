/**
 * @module @zenith/cli
 * Zenith CLI — Unified command dispatcher.
 *
 * Single entrypoint for ALL CLI operations across the monorepo:
 *   - Developer commands: init, dev, compile
 *   - AI Agent:           agent (interactive / daemon)
 *   - Backend utilities:  plugins:lock
 *
 * Compiled with:  deno compile -A zenith-cli/mod.ts
 */

import { parseArgs } from "jsr:@std/cli/parse-args";

import * as initCmd from "./zen.ts";
import * as agentCmd from "./commands/agent.ts";
import * as pluginsLockCmd from "./commands/plugins-lock.ts";
import { runMtlsGenDev } from "./commands/mtls-gen-dev.ts";
import { runApiKeys } from "./commands/api-keys.ts";
import { runPluginCommand } from "./commands/plugin.ts";

const VERSION = "0.1.0";

const HELP = `
Zenith CLI v${VERSION}
=======================================

USO:
  zenith <comando> [opciones]

COMANDOS DE DESARROLLO:
  init <name>         Crea un nuevo proyecto Zenith (cloud/, plugins/, zen.config.ts)
  dev                 Inicia el backend en modo desarrollo con hot-reloading
  compile             Empaqueta el backend en un único binario AOT sellado

COMANDOS DE AGENTE (LLM / AIOps):
  agent -i            Modo interactivo (REPL de chat con el cluster)
  agent -d            Modo daemon (auto-sanacion cada N segundos)

BACKEND UTILITIES:
  plugins:lock [dir]  Genera o actualiza plugins.lock.json (integridad SHA-256)
  mtls:gen-dev        Genera CA + server + client certs para desarrollo local
                      Imprime el SPKI pin del server cert
  api-keys            Gestión de API Keys (create/list/revoke/rotate)
  plugin <sub>        Gestión de plugin signing (Ed25519): keygen/sign/verify/trust/revoke/list
  version             Muestra la version del CLI

Opciones globales:
  --url <url>         URL del backend (default: $ZENITH_API_URL)
  --key <key>         Master Key del backend
  --help, -h          Muestra esta ayuda
`;

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "interactive", "daemon"],
    alias: { help: "h", interactive: "i", daemon: "d" },
  });
  const cmd = args._[0];

  if (!cmd || args.help) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "version":
      console.log(`zenith v${VERSION}`);
      return;

    case "init":
    case "dev":
    case "compile": {
      // Forward to zen.ts which already handles these commands
      if (typeof (initCmd as any).run === "function") {
        await (initCmd as any).run(cmd);
      } else {
        console.error(`[zenith] El comando '${cmd}' no está disponible en este build del CLI.`);
        Deno.exit(1);
      }
      return;
    }

    case "agent": {
      // agent.ts usa Deno.args directamente
      if (args.interactive) {
        await (agentCmd as any).runInteractive();
      } else if (args.daemon) {
        const idx = Deno.args.indexOf("--interval");
        const interval = idx !== -1 ? parseInt(Deno.args[idx + 1]) || 300 : 300;
        (agentCmd as any).runDaemon(interval);
      } else {
        console.log("Uso: zenith agent --interactive | --daemon [--interval <segs>]");
      }
      return;
    }

    case "plugins:lock": {
      // plugins-lock.ts ejecuta al import; nada más que hacer.
      return;
    }

    case "mtls:gen-dev": {
      await runMtlsGenDev();
      return;
    }

    case "api-keys": {
      await runApiKeys();
      return;
    }

    case "plugin": {
      await runPluginCommand(Deno.args.slice(1));
      return;
    }

    default:
      console.error(`Comando desconocido: ${cmd}`);
      console.log(HELP);
      Deno.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[zenith] Error fatal: ${err.message ?? err}`);
    Deno.exit(1);
  });
}
