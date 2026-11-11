/**
 * @module @zenith/core/lifecycle
 *
 * Arranque del trabajo en segundo plano. Una capacidad que trabaja fuera de las peticiones (la entrega
 * de webhooks, por ejemplo) expone `startBackground()`. `createZenithApp` la llama una sola vez, con
 * la base de datos ya conectada. Componer el motor sin servidor (OpenAPI, pruebas) no arranca nada.
 */

export interface Background {
  startBackground(): void | Promise<void>;
}

const hasBackground = (v: unknown): v is Background =>
  typeof v === "object" && v !== null && typeof (v as Background).startBackground === "function";

/**
 * Llama a `startBackground()` de cada capacidad que lo tenga, una vez por objeto: un trait puede
 * publicar el mismo objeto con dos nombres. Devuelve cuántos arrancó. Un fallo se avisa y no detiene
 * a los demás.
 */
export function startBackground(capabilities: Record<string, unknown>, warn: (m: string) => void = console.warn): number {
  const started = new Set<unknown>();
  for (const [name, value] of Object.entries(capabilities)) {
    if (!hasBackground(value) || started.has(value)) continue;
    started.add(value);
    Promise.resolve()
      .then(() => value.startBackground())
      .catch((e) => warn(`[lifecycle] ${name}: background work failed to start: ${(e as Error).message}`));
  }
  return started.size;
}
