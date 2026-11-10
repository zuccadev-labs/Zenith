#!/usr/bin/env node
/**
 * npm create @zuccadev-labs/zenith <name>
 *
 * Zenith's server runs on Deno (Deno.serve, Deno.Kv), so this only checks that Deno is there and
 * hands over to `zen init` from JSR. It never installs Deno by itself: running a remote installer
 * on the user's machine is their call, so it says how instead.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CLI = "jsr:@zuccadev-labs/zenith-cli/zen";
export const MIN_DENO = [2, 4, 0];

/** "deno 2.9.8 (stable…)" → [2, 9, 8], or null. */
export function parseDenoVersion(text) {
  const m = /^deno (\d+)\.(\d+)\.(\d+)/m.exec(text ?? "");
  return m ? m.slice(1, 4).map(Number) : null;
}

export function atLeast(v, min) {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

const HOW_TO_INSTALL = `Instala Deno ${MIN_DENO.join(".")} o posterior: https://docs.deno.com/runtime/getting_started/installation/
  Linux / macOS:  curl -fsSL https://deno.land/install.sh | sh
  Windows:        irm https://deno.land/install.ps1 | iex
Luego vuelve a ejecutar este comando.`;

export function main(argv, run = spawnSync, log = console) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    log.log("Uso: npm create @zuccadev-labs/zenith <nombre>\nCrea un proyecto Zenith (servidor) con zen init. Requiere Deno.");
    return 0;
  }
  const probe = run("deno", ["--version"], { encoding: "utf8" });
  const version = probe.error ? null : parseDenoVersion(probe.stdout);
  if (!version) {
    log.error(`Zenith necesita Deno y no lo encuentro en el PATH.\n${HOW_TO_INSTALL}`);
    return 1;
  }
  if (!atLeast(version, MIN_DENO)) {
    log.error(`Tienes Deno ${version.join(".")}; Zenith necesita ${MIN_DENO.join(".")} o posterior.\n  deno upgrade`);
    return 1;
  }
  const init = run("deno", ["run", "-A", "--unstable-kv", CLI, "init", ...args], { stdio: "inherit" });
  if (init.status !== 0) return init.status ?? 1;
  log.log(`\nPara los demás comandos, instala zen una vez:\n  deno install -g -A --unstable-kv -n zen ${CLI}`);
  return 0;
}

// Run when executed (npm links the bin through a symlink), not when imported by the tests.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
