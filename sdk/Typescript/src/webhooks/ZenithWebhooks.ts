/**
 * ZenithWebhooks — the app's outgoing webhook endpoints (`/zen/webhooks`).
 *
 * Server-side only: the server manages webhooks with the master key, which it accepts only from
 * localhost, like `ZenithAPIKey` and Parse Server's `/hooks`. Deliveries follow Standard Webhooks:
 * verify them in your receiver with the official `standardwebhooks` library and the endpoint secret.
 *
 * @example
 * const hooks = new ZenithWebhooks();
 * const ep = await hooks.create({ name: "crm", url: "https://example.com/hook", events: ["Contact.*"] });
 * console.log(ep.secret); // shown once: give it to the receiver
 */
import { RESTController } from "../rest/RESTController.js";
import { Zenith } from "../core/Zenith.js";

export interface ZenithWebhook {
  objectId: string;
  name: string;
  url: string;
  description?: string;
  /** Event types or patterns: "Contact.created", "Deal.*", "*". */
  events: string[];
  status: "active" | "paused" | "disabled";
  headers?: Record<string, string>;
  /** Signing secrets currently in use (2 during a rotation). The secrets themselves are never returned. */
  secretCount: number;
  exhaustedCount?: number;
  lastError?: string;
  disabledReason?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ZenithWebhookMessage {
  objectId: string;
  /** The `webhook-id` header: the same on every retry. */
  messageId: string;
  endpointId: string;
  type: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  nextAttemptAt?: string;
  lastStatusCode?: number;
  lastError?: string;
  deliveredAt?: string;
  createdAt: string;
}

export interface ZenithWebhookAttempt {
  messageId: string;
  attempt: number;
  statusCode: number;
  durationMs: number;
  error?: string;
  response?: string;
  at: string;
}

/** @deprecated Use ZenithWebhookAttempt. */
export type ZenithWebhookDelivery = ZenithWebhookAttempt;

type EndpointInput = { name: string; url: string; events: string[]; description?: string; headers?: Record<string, string> };

export class ZenithWebhooks {
  private master() {
    if (!Zenith.getConfig().masterKey) {
      throw new Error("ZenithWebhooks needs the master key (server-side only): Zenith.initialize(appId, { masterKey }).");
    }
    return { useMasterKey: true };
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return RESTController.request(method, `/zen/webhooks${path}`, body, this.master());
  }

  list(): Promise<{ results: ZenithWebhook[] }> {
    return this.call("GET", "");
  }

  get(objectId: string): Promise<ZenithWebhook> {
    return this.call("GET", `/${encodeURIComponent(objectId)}`);
  }

  /** Creates an endpoint. `secret` (whsec_…) is returned only here. */
  create(data: EndpointInput): Promise<ZenithWebhook & { secret: string }> {
    return this.call("POST", "", data);
  }

  update(objectId: string, data: Partial<EndpointInput>): Promise<ZenithWebhook> {
    return this.call("PUT", `/${encodeURIComponent(objectId)}`, data);
  }

  async delete(objectId: string): Promise<void> {
    await this.call("DELETE", `/${encodeURIComponent(objectId)}`);
  }

  pause(objectId: string): Promise<ZenithWebhook> {
    return this.call("POST", `/${encodeURIComponent(objectId)}/pause`);
  }

  /** Resumes a paused endpoint, or re-enables one disabled after repeated failures. */
  resume(objectId: string): Promise<ZenithWebhook> {
    return this.call("POST", `/${encodeURIComponent(objectId)}/resume`);
  }

  /** Queues a `webhook.test` message. */
  test(objectId: string): Promise<{ messageId: string; status: "pending" }> {
    return this.call("POST", `/${encodeURIComponent(objectId)}/test`);
  }

  /** New secret, returned once. The previous one keeps signing for `graceHours` (default 24). */
  rotateSecret(objectId: string, graceHours?: number): Promise<{ id: string; secret: string; previousValidUntil: string | null }> {
    return this.call("POST", `/${encodeURIComponent(objectId)}/rotate-secret`, graceHours === undefined ? {} : { graceHours });
  }

  messages(objectId: string, status?: ZenithWebhookMessage["status"]): Promise<{ results: ZenithWebhookMessage[] }> {
    return this.call("GET", `/${encodeURIComponent(objectId)}/messages${status ? `?status=${status}` : ""}`);
  }

  attempts(objectId: string, messageId: string): Promise<{ results: ZenithWebhookAttempt[] }> {
    return this.call("GET", `/${encodeURIComponent(objectId)}/messages/${encodeURIComponent(messageId)}/attempts`);
  }

  /** Delivers a message again, with the same `webhook-id`. */
  redeliver(objectId: string, messageId: string): Promise<{ messageId: string; status: "pending" }> {
    return this.call("POST", `/${encodeURIComponent(objectId)}/messages/${encodeURIComponent(messageId)}/redeliver`);
  }

  /** Requeues the failed messages created since `since` (ISO 8601). */
  recover(objectId: string, since: string): Promise<{ requeued: number }> {
    return this.call("POST", `/${encodeURIComponent(objectId)}/recover`, { since });
  }
}
