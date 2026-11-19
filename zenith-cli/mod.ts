/**
 * @module @zenith/cli
 *
 * `zenith` and `zen` are the same CLI: one table of commands (`commands/registry.ts`, barrits
 * traits) behind both names. Old spellings still work: `plugins:lock`, `mtls:gen-dev`.
 *
 *   deno compile -A --output zenith mod.ts
 *
 * @example Run the CLI from code
 * ```ts
 * import { main } from "@zuccadev-labs/zenith-cli";
 *
 * const code = await main(["--help"], "zenith");
 * Deno.exit(code);
 * ```
 *
 * @example List the commands
 * ```ts
 * import { commandTable } from "@zuccadev-labs/zenith-cli";
 *
 * for (const [name, cmd] of commandTable()) console.log(name, cmd.summary);
 * ```
 */
import { main } from "./zen.ts";

export { main, VERSION } from "./zen.ts";
export { COMMANDS, commandTable, helpText } from "./commands/registry.ts";
export type { ZenCommand } from "./commands/registry.ts";

if (import.meta.main) Deno.exit(await main(Deno.args, "zenith"));
