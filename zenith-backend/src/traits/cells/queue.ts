/**
 * @module @zenith/traits/cells/queue
 *
 * Queue bindings (Cloudflare's `Queue` producer and `queue()` consumer) over Zenith's durable job queue
 * (`ZenithJobQueue`, `_Job` in the database): `send()` enqueues a job of type `cells.queue:<name>`, and
 * the consumer receives each job as a batch of one message. A message that is not acked (the consumer
 * throws or calls `retry()`) goes back to the job queue with its exponential backoff and, after
 * `maxAttempts`, to its dead-letter state (`failed`).
 *
 * Differences from Cloudflare: batches have one message (`max_batch_size: 1`), `attempts` is not known
 * to the consumer (always 1), and `contentType` other than JSON-compatible values is not supported.
 */

/** Options of `send()`. */
export interface QueueSendOptions {
  /** Delay before the message is delivered. */
  delaySeconds?: number;
}

/** `env.MY_QUEUE`: the producer side. */
export interface Queue<Body = unknown> {
  /** Sends one message. */
  send(body: Body, options?: QueueSendOptions): Promise<void>;
  /** Sends several messages. */
  sendBatch(
    messages: Iterable<{ body: Body; delaySeconds?: number }>,
    options?: QueueSendOptions,
  ): Promise<void>;
}

/** One delivered message. */
export interface QueueMessage<Body = unknown> {
  /** Job id. */
  readonly id: string;
  /** When it was sent. */
  readonly timestamp: Date;
  /** The body as sent. */
  readonly body: Body;
  /** Delivery attempts (always 1 on this binding). */
  readonly attempts: number;
  /** Marks it as processed. */
  ack(): void;
  /** Asks for a later redelivery. */
  retry(options?: { delaySeconds?: number }): void;
}

/** What a consumer receives. */
export interface MessageBatch<Body = unknown> {
  /** The queue name. */
  readonly queue: string;
  /** The messages (one on this binding). */
  readonly messages: readonly QueueMessage<Body>[];
  /** Acks every message. */
  ackAll(): void;
  /** Retries every message. */
  retryAll(options?: { delaySeconds?: number }): void;
}

/** A consumer: `queue(batch, env)` of a Worker. */
export type QueueConsumer<Body = unknown> = (
  batch: MessageBatch<Body>,
  env: Record<string, unknown>,
) => void | Promise<void>;

/** The part of the `queue` capability (ZenithJobQueue) a binding uses. */
export interface JobQueueLike {
  /** Enqueues a job. */
  enqueue(type: string, data: unknown, opts?: { delayMs?: number }): Promise<unknown>;
  /** Registers who processes a job type. */
  registerWorker(type: string, handler: (data: any) => unknown | Promise<unknown>): unknown;
}

/** The job type of queue `name`. */
export const queueJobType = (name: string): string => `cells.queue:${name}`;

/** The producer binding of queue `name`. */
export function queueBinding<Body = unknown>(jobs: JobQueueLike, name: string): Queue<Body> {
  const type = queueJobType(name);
  const send = async (body: Body, delaySeconds?: number) => {
    structuredClone(body); // fails here, not in the consumer, when the body cannot be stored
    await jobs.enqueue(type, { body, sentAt: Date.now() }, {
      delayMs: delaySeconds ? Math.max(0, delaySeconds * 1000) : undefined,
    });
  };
  return {
    send: (body, options) => send(body, options?.delaySeconds),
    async sendBatch(messages, options) {
      for (const m of messages) await send(m.body, m.delaySeconds ?? options?.delaySeconds);
    },
  };
}

/** Registers `consumer` for queue `name` on the job queue. */
export function registerQueueConsumer<Body = unknown>(
  jobs: JobQueueLike,
  name: string,
  consumer: QueueConsumer<Body>,
  env: () => Record<string, unknown>,
): void {
  jobs.registerWorker(queueJobType(name), async (data: { body: Body; sentAt?: number }) => {
    const done = { state: "pending" as "pending" | "ack" | "retry" };
    const message: QueueMessage<Body> = {
      id: crypto.randomUUID(),
      timestamp: new Date(data?.sentAt ?? Date.now()),
      body: data?.body,
      attempts: 1,
      ack: () => {
        if (done.state === "pending") done.state = "ack";
      },
      retry: () => {
        if (done.state === "pending") done.state = "retry";
      },
    };
    const batch: MessageBatch<Body> = {
      queue: name,
      messages: [message],
      ackAll: () => message.ack(),
      retryAll: () => message.retry(),
    };
    await consumer(batch, env());
    if (done.state === "retry") {
      throw new Error(`queue ${name}: message ${message.id} asked for a retry`);
    }
  });
}
