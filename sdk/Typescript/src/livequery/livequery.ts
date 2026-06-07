import { Zenith } from "../core/Zenith.js";
import { ZenithQuery } from "../objects/ZenithQuery.js";
import { ZenithObject } from "../objects/ZenithObject.js";
import { ZenithErrorCode } from "../core/ZenithError.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LiveQueryEvent = "create" | "enter" | "update" | "leave" | "delete";
export type LiveQueryErrorCallback = (code: number, message: string) => void;
export type SubscriptionCallback<T extends ZenithObject = ZenithObject> = (object: T) => void;

interface LiveQueryMessage {
  op: string;
  clientId?: string;
  requestId?: number;
  object?: any;
  code?: number;
  error?: string;
}

/**
 * @class ZenithLiveQuerySubscription
 * Represents an active subscription to a query.
 *
 * @example
 * const query = new ZenithQuery("Message").equalTo("room", roomId);
 * const sub = LiveQueryClient.subscribe(query);
 * sub.on("create", (msg) => console.log("New message:", msg.get("text")));
 * sub.on("error", (code, msg) => console.error(`[${code}] ${msg}`));
 */
export class ZenithLiveQuerySubscription<T extends ZenithObject = ZenithObject> {
  private _className: string;
  private _where: any;
  readonly requestId: number;
  private _eventListeners: Map<LiveQueryEvent | "error" | "close" | "open", Set<Function>> = new Map();

  constructor(className: string, where: any, requestId: number) {
    this._className = className;
    this._where = where;
    this.requestId = requestId;
  }

  public get classNameStr() { return this._className; }
  public get whereClause() { return this._where; }

  /**
   * Register a callback for a data event or lifecycle event.
   */
  public on(event: LiveQueryEvent | "error" | "close" | "open", callback: Function): this {
    if (!this._eventListeners.has(event)) {
      this._eventListeners.set(event, new Set());
    }
    this._eventListeners.get(event)!.add(callback);
    return this;
  }

  /** Remove a specific listener */
  public off(event: LiveQueryEvent | "error" | "close" | "open", callback: Function): this {
    this._eventListeners.get(event)?.delete(callback);
    return this;
  }

  /** @internal — called by ZenithLiveQueryClient */
  _emit(event: LiveQueryEvent, data: any): void {
    const object = new ZenithObject(this._className, data) as T;
    this._eventListeners.get(event)?.forEach(cb => cb(object));
  }

  /** @internal — emit error event */
  _emitError(code: number, message: string): void {
    this._eventListeners.get("error")?.forEach(cb => (cb as LiveQueryErrorCallback)(code, message));
  }

  /** @internal — emit lifecycle events */
  _emitLifecycle(event: "close" | "open"): void {
    this._eventListeners.get(event)?.forEach(cb => (cb as () => void)());
  }
}

// ─── Client ───────────────────────────────────────────────────────────────────

const DATA_EVENTS = new Set<string>(["create", "enter", "update", "leave", "delete"]);
let _requestIdCounter = 1;

/**
 * @class ZenithLiveQueryClient
 * Manages a single WebSocket connection to the Zenith LiveQuery server.
 * Handles reconnection with exponential backoff, subscription tracking,
 * and full Parse Server LiveQuery protocol compliance.
 */
export class ZenithLiveQueryClient {
  private _ws: WebSocket | null = null;
  private _subscriptions: Map<number, ZenithLiveQuerySubscription> = new Map();
  private _reconnectDelay = 1000;
  private _isConnected = false;
  private _pendingSubscriptions: ZenithLiveQuerySubscription[] = [];

  /**
   * Opens the WebSocket connection. Called automatically by subscribe().
   */
  public open(): void {
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return;

    const config = Zenith.getConfig();
    const wsUrl = config.serverURL.replace(/^http/, "ws") + "/livequery?appId=" + config.appId;

    this._ws = new WebSocket(wsUrl);

    this._ws.onopen = () => {
      this._reconnectDelay = 1000;
      // Send connect handshake
      this._ws!.send(JSON.stringify({
        op: "connect",
        applicationId: config.appId,
        sessionToken: Zenith.sessionToken,
        clientVersion: "1.0.0",
      }));
    };

    this._ws.onmessage = (evt: MessageEvent) => {
      try {
        const msg: LiveQueryMessage = JSON.parse(evt.data);
        this._handleMessage(msg);
      } catch (e) {
        console.error("[ZenithLiveQuery] Failed to parse message:", e);
      }
    };

    this._ws.onclose = () => {
      this._isConnected = false;
      // Notify all subs
      this._subscriptions.forEach(sub => sub._emitLifecycle("close"));
      // Exponential backoff reconnect
      setTimeout(() => {
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30_000);
        this.open();
      }, this._reconnectDelay);
    };

    this._ws.onerror = (e: Event) => {
      console.error("[ZenithLiveQuery] WebSocket error:", e);
    };
  }

  private _handleMessage(msg: LiveQueryMessage): void {
    switch (msg.op) {
      case "connected":
        this._isConnected = true;
        // Send all pending subscriptions
        this._subscriptions.forEach(sub => this._sendSubscribe(sub));
        this._pendingSubscriptions.forEach(sub => this._sendSubscribe(sub));
        this._pendingSubscriptions = [];
        break;

      case "subscribed":
        // Server acknowledged subscription
        if (msg.requestId !== undefined && this._subscriptions.has(msg.requestId)) {
          this._subscriptions.get(msg.requestId)!._emitLifecycle("open");
        }
        break;

      case "unsubscribed":
        // Acknowledged unsubscribe
        break;

      case "error": {
        const code = msg.code ?? ZenithErrorCode.INTERNAL_SERVER_ERROR;
        const error = msg.error ?? "Unknown LiveQuery error";
        // Route to specific subscription if requestId given
        if (msg.requestId && this._subscriptions.has(msg.requestId)) {
          this._subscriptions.get(msg.requestId)!._emitError(code, error);
        } else {
          // Global error — notify all
          this._subscriptions.forEach(sub => sub._emitError(code, error));
          console.error(`[ZenithLiveQuery] Error ${code}: ${error}`);
        }
        break;
      }

      default:
        // Data events: create, enter, update, leave, delete
        if (DATA_EVENTS.has(msg.op) && msg.object) {
          if (msg.requestId !== undefined && this._subscriptions.has(msg.requestId)) {
            this._subscriptions.get(msg.requestId)!._emit(msg.op as LiveQueryEvent, msg.object);
          } else {
            // Broadcast to className-matching subs
            this._subscriptions.forEach(sub => {
              if (sub.classNameStr === msg.object?.className) {
                sub._emit(msg.op as LiveQueryEvent, msg.object);
              }
            });
          }
        }
    }
  }

  /**
   * Subscribes to a query and returns a subscription object.
   * Automatically opens the connection if needed.
   */
  public subscribe<T extends ZenithObject = ZenithObject>(
    query: ZenithQuery<T>
  ): ZenithLiveQuerySubscription<T> {
    const requestId = _requestIdCounter++;
    const sub = new ZenithLiveQuerySubscription<T>(
      query.className,
      query._whereClause,
      requestId
    );
    this._subscriptions.set(requestId, sub as any);

    if (!this._ws || this._ws.readyState === WebSocket.CLOSED || this._ws.readyState === WebSocket.CLOSING) {
      this.open();
      this._pendingSubscriptions.push(sub as any);
    } else if (this._isConnected) {
      this._sendSubscribe(sub as any);
    } else {
      // Connecting — will be sent when "connected" arrives
      this._pendingSubscriptions.push(sub as any);
    }

    return sub;
  }

  /**
   * Unsubscribes from a subscription and stops receiving events.
   */
  public unsubscribe(sub: ZenithLiveQuerySubscription): void {
    this._subscriptions.delete(sub.requestId);
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        op: "unsubscribe",
        requestId: sub.requestId,
      }));
    }
  }

  /**
   * Closes the WebSocket connection entirely.
   */
  public close(): void {
    this._ws?.close();
    this._ws = null;
    this._isConnected = false;
  }

  private _sendSubscribe(sub: ZenithLiveQuerySubscription): void {
    if (this._ws?.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({
      op: "subscribe",
      requestId: sub.requestId,
      query: {
        className: sub.classNameStr,
        where: sub.whereClause,
      },
      sessionToken: Zenith.sessionToken,
    }));
  }
}

/** Singleton client — use across the app. */
export const LiveQueryClient = new ZenithLiveQueryClient();
