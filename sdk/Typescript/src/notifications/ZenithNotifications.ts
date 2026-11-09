/**
 * ZenithNotifications — SDK client for /zen/notifications
 * SSE real-time stream + CRUD mark-read/delete.
 */
import type { Zenith } from "../core/Zenith.ts";

export interface ZenithNotification {
  objectId:  string;
  userId:    string;
  type:      "info" | "success" | "warning" | "error" | "mention" | "task" | "comment";
  title?:    string;
  body:      string;
  link?:     string;
  isRead:    boolean;
  readAt?:   string;
  source?:   string;
  createdAt: string;
}

export class ZenithNotifications {
  private readonly base: string;
  private readonly headers: () => Record<string, string>;

  constructor(zenith: typeof Zenith) {
    this.base    = (zenith as any)._serverURL;
    this.headers = () => ({
      "content-type": "application/json",
      "x-parse-application-id": (zenith as any)._applicationId,
      "x-parse-session-token":  (zenith as any).User?.current()?.getSessionToken() ?? "",
    });
  }

  /** Listar todas las notificaciones del usuario */
  async list(opts?: { limit?: number; skip?: number; unreadOnly?: boolean }): Promise<{ results: ZenithNotification[]; unreadCount: number }> {
    const q = new URLSearchParams();
    if (opts?.limit)      q.set("limit", String(opts.limit));
    if (opts?.skip)       q.set("skip",  String(opts.skip));
    if (opts?.unreadOnly) q.set("unreadOnly", "true");
    const res = await fetch(`${this.base}/zen/notifications?${q}`, { headers: this.headers() });
    return res.json();
  }

  /** Marcar una notificación como leída */
  async markRead(objectId: string): Promise<ZenithNotification> {
    const res = await fetch(`${this.base}/zen/notifications/${objectId}/read`, {
      method: "POST", headers: this.headers(),
    });
    return res.json();
  }

  /** Marcar todas como leídas */
  async markAllRead(): Promise<{ updated: number }> {
    const res = await fetch(`${this.base}/zen/notifications/read-all`, {
      method: "POST", headers: this.headers(),
    });
    return res.json();
  }

  /** Eliminar notificación */
  async delete(objectId: string): Promise<void> {
    await fetch(`${this.base}/zen/notifications/${objectId}`, {
      method: "DELETE", headers: this.headers(),
    });
  }

  /**
   * Suscribirse a notificaciones en tiempo real vía SSE.
   * @param onNotification Callback que se llama con cada notificación.
   * @returns AbortController para cancelar la suscripción.
   *
   * @example
   * const ctl = notifications.subscribe(n => console.log(n));
   * // Cuando quieras desconectar:
   * ctl.abort();
   */
  subscribe(onNotification: (n: ZenithNotification) => void): AbortController {
    const ctl = new AbortController();
    (async () => {
      const res = await fetch(`${this.base}/zen/notifications/stream`, {
        headers: { ...this.headers(), accept: "text/event-stream" },
        signal: ctl.signal,
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const dataLine = part.split("\n").find(l => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const notif = JSON.parse(dataLine.slice(6));
            if (notif.type !== "heartbeat") onNotification(notif);
          } catch { /* ignore parse errors */ }
        }
      }
    })().catch(() => {});
    return ctl;
  }
}
