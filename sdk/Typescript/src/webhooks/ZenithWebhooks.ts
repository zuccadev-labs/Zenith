/**
 * ZenithWebhooks — SDK client for /zen/webhooks
 * CRUD + pause/resume + test delivery + delivery history
 */
import type { Zenith } from "../core/Zenith.ts";

export interface ZenithWebhook {
  objectId:       string;
  name:           string;
  url:            string;
  events:         string[];      // ["Contact.*", "Deal.created", "*"]
  secret?:        string;        // Solo visible en CREATE
  status:         "active" | "paused" | "failed";
  failureCount:   number;
  lastTriggeredAt?: string;
  lastError?:     string;
  headers?:       Record<string, string>;
  retryPolicy?:   { maxRetries: number; backoffMs: number };
  createdAt:      string;
}

export interface ZenithWebhookDelivery {
  objectId:    string;
  webhook:     { objectId: string };
  event:       string;
  statusCode:  number;
  success:     boolean;
  attempt:     number;
  durationMs:  number;
  error?:      string;
  deliveredAt: string;
}

export class ZenithWebhooks {
  private readonly base: string;
  private readonly h: () => Record<string, string>;

  constructor(z: Zenith) {
    this.base = (z as any)._serverURL;
    this.h    = () => ({
      "content-type": "application/json",
      "x-parse-application-id": (z as any)._applicationId,
      "x-parse-session-token":  (z as any).User?.current()?.getSessionToken() ?? "",
    });
  }

  async list(): Promise<{ results: ZenithWebhook[] }> {
    return (await fetch(`${this.base}/zen/webhooks`, { headers: this.h() })).json();
  }

  async get(objectId: string): Promise<ZenithWebhook> {
    return (await fetch(`${this.base}/zen/webhooks/${objectId}`, { headers: this.h() })).json();
  }

  /**
   * Crear webhook. El secret se retorna completo SOLO en la creación.
   * Guarda el secret de inmediato — no se mostrará de nuevo.
   */
  async create(data: { name: string; url: string; events: string[]; secret?: string; headers?: Record<string, string>; retryPolicy?: object }): Promise<ZenithWebhook & { _secretWarning: string }> {
    return (await fetch(`${this.base}/zen/webhooks`, {
      method: "POST", headers: this.h(), body: JSON.stringify(data),
    })).json();
  }

  async update(objectId: string, data: Partial<Pick<ZenithWebhook, "name" | "url" | "events" | "headers" | "retryPolicy" | "status">>): Promise<ZenithWebhook> {
    return (await fetch(`${this.base}/zen/webhooks/${objectId}`, {
      method: "PUT", headers: this.h(), body: JSON.stringify(data),
    })).json();
  }

  async pause(objectId: string): Promise<ZenithWebhook> {
    return (await fetch(`${this.base}/zen/webhooks/${objectId}/pause`, { method: "POST", headers: this.h() })).json();
  }

  async resume(objectId: string): Promise<ZenithWebhook> {
    return (await fetch(`${this.base}/zen/webhooks/${objectId}/resume`, { method: "POST", headers: this.h() })).json();
  }

  /** Enviar una entrega de prueba al endpoint del webhook */
  async test(objectId: string): Promise<{ success: boolean; message: string }> {
    return (await fetch(`${this.base}/zen/webhooks/${objectId}/test`, { method: "POST", headers: this.h() })).json();
  }

  async deliveries(objectId: string): Promise<{ results: ZenithWebhookDelivery[] }> {
    return (await fetch(`${this.base}/zen/webhooks/${objectId}/deliveries`, { headers: this.h() })).json();
  }

  async delete(objectId: string): Promise<void> {
    await fetch(`${this.base}/zen/webhooks/${objectId}`, { method: "DELETE", headers: this.h() });
  }
}
