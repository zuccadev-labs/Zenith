/**
 * @module @zenith/cli
 *
 * `zenith` and `zen` are the same CLI: one table of commands (`commands/registry.ts`, barrits
 * traits) behind both names. Old spellings still work: `plugins:lock`, `mtls:gen-dev`.
 *
 *   deno compile -A --output zenith mod.ts
 */
import { main } from "./zen.ts";

export { main, VERSION } from "./zen.ts";
export { commandTable, COMMANDS, helpText } from "./commands/registry.ts";

if (import.meta.main) Deno.exit(await main(Deno.args, "zenith"));
