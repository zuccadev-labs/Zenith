/**
 * Runs the triggers registered with `Zen.Cloud.*` (the global registry of core/cloud.ts), with their validators.
 *
 * The registry existed, but nothing read it: `Zen.Cloud.beforeSave`, `beforeLogin`, `beforeSaveFile`… never ran.
 * The traits that own each moment call this (cloud code for classes and files, engine-auth for login and logout).
 * It works the same in `zen dev` and in a compiled app: no copying at load time.
 */
import { _cloudCodeRegistry, type CloudValidator } from "../../core/cloud.ts";
import { checkValidator } from "./validator.ts";

// deno-lint-ignore no-explicit-any
export type TriggerRequest = Record<string, any>;

/** Triggers whose validator checks `fields` on `request.object` (on an update, with `request.original`). */
const SAVES = new Set(["beforeSave", "beforeSaveFile"]);

/** The caller as validators see it, from a trigger request (`user` with `roles`, `master`). */
export function callerOfRequest(r: TriggerRequest) {
  return {
    master: r.master === true,
    user: r.user?.objectId
      ? { objectId: String(r.user.objectId), roles: (r.user.roles ?? []).map(String) }
      : undefined,
  };
}

/** Applies a trigger's validator. Throws CloudValidationError. */
export async function validateTrigger(
  v: CloudValidator | undefined,
  category: string,
  r: TriggerRequest,
): Promise<void> {
  if (!v) return;
  if (SAVES.has(category) && r.object && typeof r.object === "object") {
    await checkValidator(v, callerOfRequest(r), r.object, r.original);
  } else {
    await checkValidator({ ...v, fields: undefined }, callerOfRequest(r), {});
  }
}

/**
 * Runs the registry's trigger for `category` and `key` (a class name, `_User`, `_Session`, `_File`…), if there is
 * one. Returns whether it ran and what it returned. Errors propagate: the caller decides whether they block.
 */
export async function runRegistryTrigger(
  category: string,
  key: string,
  r: TriggerRequest,
): Promise<{ ran: boolean; out?: unknown }> {
  const entry = _cloudCodeRegistry.getTrigger(category as never, key);
  if (!entry) return { ran: false };
  await validateTrigger(entry.validator, category, r);
  const request = {
    className: key,
    context: r.context ?? {},
    log: {
      info: (...a: unknown[]) => console.log(`[Cloud:${category}:${key}]`, ...a),
      error: (...a: unknown[]) => console.error(`[Cloud:${category}:${key}]`, ...a),
    },
    ...r,
  };
  // deno-lint-ignore no-explicit-any
  return { ran: true, out: await (entry.handler as any)(request) };
}
