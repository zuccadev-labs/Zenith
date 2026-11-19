/**
 * @module @zenith/traits/cells/registry
 *
 * The bridge between Cloud Code and the `cells` capability. Cloud Code (`cloud/main.ts`) declares its
 * cell classes with `Zen.Cells.define()` before or after the engine boots; every app's `cells`
 * capability picks them up. `Zen.Cells.namespace()` resolves the app of the current request.
 */
import type { CellClass, CellEnv, DurableObjectNamespace, DurableObjectStub } from "./types.ts";
import type { CellClassOptions } from "./local.ts";

/** A cell class declared from Cloud Code. */
export interface CellDefinition {
  /** Class name (stable: part of the ids). */
  className: string;
  /** The class. */
  cls: CellClass;
  /** Binding and extra env. */
  options: CellClassOptions;
}

/** What the registry needs from an app's `cells` capability. */
export interface CellsHandle {
  /** Registers a class. */
  define(className: string, cls: CellClass, options?: CellClassOptions): DurableObjectNamespace;
  /** A namespace by binding or class name. */
  namespace(binding: string): DurableObjectNamespace;
  /** The env cells receive. */
  env(className?: string): CellEnv;
}

const definitions = new Map<string, CellDefinition>();
const listeners = new Set<(d: CellDefinition) => void>();
const apps = new Map<string, CellsHandle>();

/** Declares a cell class for every app (and the ones that boot later). */
export function defineCellClass(
  className: string,
  cls: CellClass,
  options: CellClassOptions = {},
): void {
  const d = { className, cls, options };
  definitions.set(className, d);
  for (const l of listeners) l(d);
}

/** The classes declared so far. */
export function cellDefinitions(): CellDefinition[] {
  return [...definitions.values()];
}

/** Calls `fn` for each class declared from now on; returns the unsubscribe function. */
export function onCellDefinition(fn: (d: CellDefinition) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Makes `handle` the cells of `appId` (the trait does it when configured). */
export function registerCellsApp(appId: string, handle: CellsHandle): void {
  apps.set(appId, handle);
}

/** Forgets the cells of `appId`. */
export function unregisterCellsApp(appId: string, handle?: CellsHandle): void {
  if (!handle || apps.get(appId) === handle) apps.delete(appId);
}

/** The cells of `appId`, or of the only app when there is one. */
export function cellsOf(appId?: string): CellsHandle {
  if (appId && apps.has(appId)) return apps.get(appId)!;
  if (apps.size === 1) return [...apps.values()][0];
  throw new Error(
    apps.size
      ? `cells: no app "${appId ?? "?"}" (call inside a request or name the app)`
      : "cells: the cells capability is not active",
  );
}

/** `Zen.Cells`: cells from Cloud Code. */
export interface ZenCellsAPI {
  /** Declares a cell class (binding defaults to the class name). */
  define(className: string, cls: CellClass, options?: CellClassOptions): void;
  /** The namespace of a binding in the current app. */
  namespace<T = unknown>(binding: string, appId?: string): DurableObjectNamespace<T>;
  /** `namespace(binding).getByName(name)`. */
  get<T = unknown>(binding: string, name: string, appId?: string): DurableObjectStub<T>;
  /** The env (bindings and variables) of the current app's cells. */
  env(appId?: string): CellEnv;
}

/** Builds `Zen.Cells`; `currentAppId` tells the app of the running request. */
export function createZenCells(currentAppId: () => string | undefined): ZenCellsAPI {
  return {
    define: (className, cls, options) => defineCellClass(className, cls, options),
    namespace: <T = unknown>(binding: string, appId?: string) =>
      cellsOf(appId ?? currentAppId()).namespace(binding) as DurableObjectNamespace<T>,
    get: <T = unknown>(binding: string, name: string, appId?: string) =>
      cellsOf(appId ?? currentAppId()).namespace(binding).getByName(name) as DurableObjectStub<T>,
    env: (appId) => cellsOf(appId ?? currentAppId()).env(),
  };
}
