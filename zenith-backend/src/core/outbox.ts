/**
 * @module @zenith/core/outbox
 *
 * Trabajo pendiente en la base de datos que varias instancias se reparten sin duplicarlo. Lo usan la
 * cola de trabajos (`queue/job.queue.trait.ts`) y la entrega de webhooks (`webhooks/webhook.delivery.ts`).
 *
 * Cada registro tiene `status: "pending"`, `attempts`, `nextAttemptAt` y `leaseUntil`. Una instancia lo
 * **reclama** con `updateIf`, poniendo como condición los valores que leyó de `attempts`, `status` y
 * `leaseUntil`, y fija una concesión (`leaseUntil` = ahora + `leaseMs`). Si otra instancia lo tomó antes,
 * la condición ya no se cumple y lo omite. Si la instancia que lo tenía se cae sin terminar, al vencer la
 * concesión otra lo vuelve a reclamar: el trabajo no se pierde. Por eso el procesamiento es
 * *al menos una vez*, y quien lo consume debe ser idempotente (los webhooks llevan `webhook-id` para eso).
 */

export interface OutboxRecord {
  objectId: string;
  status: string;
  attempts?: number;
  nextAttemptAt?: string | null;
  leaseUntil?: string | null;
}

export interface ClaimOptions<T extends OutboxRecord> {
  /** Ahora, en ms (inyectable en pruebas). */
  readonly now: number;
  /** Cuántos reclamar como mucho. */
  readonly limit: number;
  /** Duración de la concesión: tiempo máximo que una instancia puede tardar antes de que otra lo retome. */
  readonly leaseMs: number;
  /** Filtro extra para la consulta (por ejemplo, `{ type }`). */
  readonly where?: Record<string, unknown>;
  /** Orden entre los vencidos. Por defecto, el que vence antes. */
  readonly order?: (a: T, b: T) => number;
  /** Última comprobación antes de reclamar (por ejemplo, que el endpoint no esté pausado). */
  readonly accept?: (record: T) => boolean | Promise<boolean>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Si un registro pendiente toca ya y nadie lo tiene. */
export function isDue(r: OutboxRecord, now: number): boolean {
  return r.status === "pending" &&
    (!r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= now) &&
    (!r.leaseUntil || Date.parse(r.leaseUntil) <= now);
}

/** Si una instancia lo tiene ahora mismo. */
export const isLeased = (r: OutboxRecord, now: number): boolean =>
  !!r.leaseUntil && Date.parse(r.leaseUntil) > now;

/**
 * Reclama hasta `limit` registros vencidos de `cls`. Devuelve los que esta instancia ganó, con la
 * concesión ya puesta: el llamador los procesa y después los cierra o los reprograma (dejando
 * `leaseUntil: null`).
 */
export async function claimDue<T extends OutboxRecord>(
  db: any,
  cls: string,
  opts: ClaimOptions<T>,
): Promise<T[]> {
  const order = opts.order ??
    ((a: T, b: T) => String(a.nextAttemptAt ?? "").localeCompare(String(b.nextAttemptAt ?? "")));
  const due = ((await db.find(cls, { status: "pending", ...(opts.where ?? {}) })) as T[])
    .filter((r) => isDue(r, opts.now))
    .sort(order);
  const claimed: T[] = [];
  for (const r of due) {
    if (claimed.length >= opts.limit) break;
    if (opts.accept && !(await opts.accept(r))) continue;
    const won = await db.updateIf(cls, r.objectId, {
      attempts: r.attempts ?? 0,
      status: "pending",
      leaseUntil: r.leaseUntil ?? null,
    }, {
      leaseUntil: iso(opts.now + opts.leaseMs),
    });
    if (won) claimed.push({ ...r, ...won });
  }
  return claimed;
}
