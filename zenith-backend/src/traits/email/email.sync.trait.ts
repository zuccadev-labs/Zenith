/**
 * Email Sync Trait — Sincronización IMAP/SMTP con hilos CRM.
 *
 * Arquitectura:
 *   EmailChannel → credenciales IMAP/SMTP por cuenta
 *   MessageThread → hilo de conversación vinculado a Contact/Lead/Deal/Account
 *   Message       → email individual dentro del hilo
 *
 * Patrón adaptador: el trait define el contrato; el adaptador real (imap.adapter.ts)
 * puede ser sustituido por SendGrid, Mailgun, AWS SES, Postmark, etc.
 * zen plugin install @zenith/imap-adapter
 *
 * Flujo de sync:
 *   1. El usuario crea un EmailChannel con credenciales
 *   2. El job de sync busca emails nuevos en IMAP
 *   3. Matchea sender/receiver con Contacts existentes
 *   4. Crea o actualiza MessageThreads y Messages
 *   5. Emite eventos para Webhooks y Notificaciones
 *
 * @barrits-trait
 * @barrits-summary ZenithEmailSync
 * @barrits-provides email_routes, emailSync
 * @barrits-consumes cloud, db
 * @barrits-tags uses:events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import {
  errRes,
  jsonRes,
  NO_CONTENT,
  now,
  parsePage,
  pathParams,
  ptr,
  queryParams,
  sortResults,
} from "../../core/trait-utils.ts";

// ── Tipos públicos ─────────────────────────────────────────────────────────────

/**
 * A mailbox connected to Zenith for synchronization (`EmailChannel` class). Credentials are
 * never stored in plain text on this record; only the connection endpoints are kept here.
 */
export interface EmailChannel {
  /** Unique identifier of the channel record. */
  objectId: string;
  /** Human-readable name of the mailbox, e.g. "Sales Inbox" or "Support". */
  name: string;
  /** Address of the mailbox, e.g. `sales@company.com`. */
  email: string;
  /** Provider that serves the mailbox; selects the registered {@linkcode EmailAdapterDef}. */
  provider: "imap" | "gmail" | "outlook" | "sendgrid" | "ses" | "mailgun" | "custom";
  /**
   * Sync state: `active` is synchronized, `paused` is skipped by the sync job and `error`
   * means the last fetch failed (see {@linkcode EmailChannel.errorMsg}).
   */
  status: "active" | "error" | "paused";
  /** IMAP server host used to fetch incoming mail. */
  imapHost?: string;
  /** IMAP server port. */
  imapPort?: number;
  /** SMTP server host used to send outgoing mail. */
  smtpHost?: string;
  /** SMTP server port. */
  smtpPort?: number;
  /** ISO timestamp of the last completed sync; the next sync fetches messages since then. */
  lastSyncAt?: string;
  /** Error message of the last failed fetch, cleared by the next successful sync. */
  errorMsg?: string;
  /** Seconds between syncs of this channel (300 by default). */
  syncInterval: number;
}

/**
 * A conversation of email messages linked to a CRM record (`MessageThread` class). Messages
 * are grouped by channel and subject.
 */
export interface MessageThread {
  /** Unique identifier of the thread record. */
  objectId: string;
  /** Subject shared by the messages of the thread. */
  subject: string;
  /** Class of the linked CRM record: `Contact`, `Lead`, `Deal` or `Account`. */
  targetClassName: string;
  /** `objectId` of the linked CRM record. */
  targetId: string;
  /** `objectId` of the {@linkcode EmailChannel} the thread belongs to. */
  channelId: string;
  /** Email addresses taking part in the conversation. */
  participants: string[];
  /** Number of messages in the thread. */
  messageCount: number;
  /** ISO timestamp of the most recent message. */
  lastMessageAt: string;
  /** Workflow state of the conversation. */
  status: "open" | "closed" | "snoozed";
  /** Pointer to the `_User` the thread is assigned to, if any. */
  assignedTo?: { objectId: string };
  /** Whether every message in the thread has been read; a new inbound message clears it. */
  isRead: boolean;
}

/** A single email inside a {@linkcode MessageThread} (`EmailMessage` class). */
export interface EmailMessage {
  /** Unique identifier of the message record. */
  objectId: string;
  /** `objectId` of the thread the message belongs to. */
  threadId: string;
  /** `objectId` of the channel the message was received on or sent from. */
  channelId: string;
  /** Sender address. */
  from: string;
  /** Recipient addresses. */
  to: string[];
  /** Carbon-copy recipient addresses. */
  cc: string[];
  /** Subject line. */
  subject: string;
  /** Plain-text body. */
  bodyText: string;
  /** HTML body, when the message has one. */
  bodyHtml?: string;
  /** RFC 2822 `Message-ID` header, or the id the provider returned when sending. */
  messageId: string;
  /** `inbound` for messages fetched by the sync job, `outbound` for messages sent through Zenith. */
  direction: "inbound" | "outbound";
  /** ISO timestamp the message was sent. */
  sentAt: string;
  /** Whether the message has been read; outbound messages are created as read. */
  isRead: boolean;
  /** Attached files with their name, size in bytes, MIME type and download URL. */
  attachments: Array<{ name: string; size: number; mimeType: string; url: string }>;
}

/** Registry of pluggable email adapters, keyed by provider. */
const EMAIL_ADAPTERS = new Map<string, EmailAdapterDef>();

/**
 * Contract of an email provider adapter (IMAP, Gmail, SendGrid, SES, ...). Register one with
 * `emailSync.registerAdapter`; channels whose `provider` matches use it to fetch and send mail.
 * Without a registered adapter, sync only touches `lastSyncAt` and sends are recorded locally.
 */
export interface EmailAdapterDef {
  /** Provider name this adapter serves; matched against {@linkcode EmailChannel.provider}. */
  provider: string;
  /** Fetches the messages received on `channel` since `since`. */
  fetchMessages: (channel: EmailChannel, since: Date) => Promise<Partial<EmailMessage>[]>;
  /** Sends a message through `channel` and resolves to the provider's message id. */
  sendMessage: (
    channel: EmailChannel,
    to: string[],
    subject: string,
    body: string,
    html?: string,
  ) => Promise<{ messageId: string }>;
}

const EMAIL_SCHEMA = {
  EmailChannel: {
    name: "String",
    email: "String",
    provider: "String",
    status: "String",
    syncInterval: "Number",
    lastSyncAt: "Date",
  },
  MessageThread: {
    subject: "String",
    targetClassName: "String",
    targetId: "String",
    channelId: "String",
    participants: "Array",
    messageCount: "Number",
    status: "String",
    isRead: "Boolean",
  },
  EmailMessage: {
    threadId: "String",
    channelId: "String",
    from: "String",
    to: "Array",
    subject: "String",
    bodyText: "String",
    messageId: "String",
    direction: "String",
    sentAt: "Date",
    isRead: "Boolean",
  },
};

/**
 * Email sync trait: connects mailboxes ({@linkcode EmailChannel}), fetches new mail through the
 * registered {@linkcode EmailAdapterDef}, matches senders to CRM records and files messages into
 * {@linkcode MessageThread}s. Provides the `emailSync` API (adapters, channels, threads, send,
 * sync) and the `/zen/email/*` routes (channels CRUD and manual sync, threads list/detail/close/
 * assign, thread messages and send).
 */
export const EmailSyncTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithEmailSync",
  provides: ["email_routes", "emailSync"],
  consumes: ["cloud", "db"],
  tags: ["uses:events"],
  state: [],
  runtimes: ["deno"],
  summary:
    "IMAP/SMTP email sync with CRM threads. Adapter pattern: swap provider (Gmail, Outlook, SES) without changing API. Threads linked to Contact/Lead/Deal via polymorphic Target.",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const events = deps.traits["events"];

    if (deps.traits["cloud"]?.defineSchema) {
      for (const [n, f] of Object.entries(EMAIL_SCHEMA)) {
        deps.traits["cloud"].defineSchema(n, f as any, {});
      }
    }

    // ── Match email → CRM record ─────────────────────────────────────────────

    async function matchToCRM(
      email: string,
    ): Promise<{ className: string; objectId: string } | null> {
      const contacts = await db.find("Contact", { email }).catch(() => []);
      if (contacts[0]) return { className: "Contact", objectId: contacts[0].objectId };
      const leads = await db.find("Lead", {}).then((r: any[]) =>
        r.filter((l) => l.contact?.email === email || l.email === email)
      ).catch(() => []);
      if (leads[0]) return { className: "Lead", objectId: leads[0].objectId };
      const accounts = await db.find("Account", { email }).catch(() => []);
      if (accounts[0]) return { className: "Account", objectId: accounts[0].objectId };
      return null;
    }

    // ── Obtener o crear hilo ──────────────────────────────────────────────────

    async function getOrCreateThread(
      channelId: string,
      subject: string,
      participants: string[],
      target: { className: string; objectId: string } | null,
    ): Promise<MessageThread> {
      const baseSubject = subject.replace(/^(re:|fwd?:)\s*/i, "").trim();
      const existing = await db.find("MessageThread", { channelId, subject: baseSubject });
      if (existing[0]) return existing[0];
      return db.create("MessageThread", {
        subject: baseSubject,
        channelId,
        targetClassName: target?.className ?? "Contact",
        targetId: target?.objectId ?? "unknown",
        participants,
        messageCount: 0,
        status: "open",
        isRead: false,
        lastMessageAt: now(),
        createdAt: now(),
        updatedAt: now(),
      });
    }

    // ── Sync job ──────────────────────────────────────────────────────────────

    async function syncChannel(channelId: string): Promise<{ synced: number; threads: number }> {
      const channel = await db.read("EmailChannel", channelId);
      if (!channel) throw ZenithErrors.notFound("EmailChannel", channelId);
      if (channel.status === "paused") return { synced: 0, threads: 0 };

      const adapter = EMAIL_ADAPTERS.get(channel.provider);
      if (!adapter) {
        // Sin adaptador real: retorna estado de simulación
        await db.update("EmailChannel", { objectId: channelId }, {
          lastSyncAt: now(),
          updatedAt: now(),
        });
        return { synced: 0, threads: 0 };
      }

      const since = channel.lastSyncAt
        ? new Date(channel.lastSyncAt)
        : new Date(Date.now() - 7 * 86400000);
      const messages = await adapter.fetchMessages(channel, since).catch((e: Error) => {
        db.update("EmailChannel", { objectId: channelId }, {
          status: "error",
          errorMsg: e.message,
          updatedAt: now(),
        });
        return [];
      });

      let synced = 0, newThreads = 0;
      for (const msg of messages) {
        if (!msg.from || !msg.subject) continue;
        const crmRecord = await matchToCRM(msg.from!);
        const thread = await getOrCreateThread(channelId, msg.subject, [
          msg.from!,
          ...(msg.to ?? []),
        ], crmRecord);
        const isNewThread = thread.messageCount === 0;

        const created = await db.create("EmailMessage", {
          threadId: thread.objectId,
          channelId,
          from: msg.from,
          to: msg.to ?? [],
          cc: msg.cc ?? [],
          subject: msg.subject,
          bodyText: msg.bodyText ?? "",
          bodyHtml: msg.bodyHtml,
          messageId: msg.messageId ?? `auto_${Date.now()}`,
          direction: "inbound",
          sentAt: msg.sentAt ?? now(),
          isRead: false,
          attachments: msg.attachments ?? [],
          createdAt: now(),
        });

        await db.update("MessageThread", { objectId: thread.objectId }, {
          messageCount: thread.messageCount + 1,
          lastMessageAt: created.sentAt,
          isRead: false,
          updatedAt: now(),
        });

        if (events) {
          events.emit("Email.received", {
            channel: channelId,
            thread: thread.objectId,
            message: created.objectId,
            from: msg.from,
          });
          if (isNewThread && crmRecord) {
            events.emit("CRM.emailReceived", {
              targetClassName: crmRecord.className,
              targetId: crmRecord.objectId,
              email: msg.from,
              subject: msg.subject,
            });
          }
        }
        synced++;
        if (isNewThread) newThreads++;
      }

      await db.update("EmailChannel", { objectId: channelId }, {
        lastSyncAt: now(),
        status: "active",
        errorMsg: null,
        updatedAt: now(),
      });
      return { synced, threads: newThreads };
    }

    const api = {
      // Adaptadores
      registerAdapter: (def: EmailAdapterDef) => {
        EMAIL_ADAPTERS.set(def.provider, def);
        return def;
      },

      // Channels
      async listChannels() {
        return { results: await db.find("EmailChannel", {}) };
      },
      async createChannel(data: Record<string, any>, ctx: any) {
        if (!data.email || !data.provider) {
          throw ZenithErrors.validationFailed("email y provider son obligatorios.");
        }
        return db.create("EmailChannel", {
          ...data,
          status: "active",
          messageCount: 0,
          syncInterval: data.syncInterval ?? 300,
          createdBy: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(),
          updatedAt: now(),
        });
      },
      async updateChannel(objectId: string, data: Record<string, any>) {
        if (!await db.read("EmailChannel", objectId)) {
          throw ZenithErrors.notFound("EmailChannel", objectId);
        }
        return db.update("EmailChannel", { objectId }, { ...data, updatedAt: now() });
      },
      async deleteChannel(objectId: string) {
        if (!await db.read("EmailChannel", objectId)) {
          throw ZenithErrors.notFound("EmailChannel", objectId);
        }
        await db.delete("EmailChannel", { objectId });
        return { success: true };
      },
      syncChannel,

      // Threads
      async listThreads(q: Record<string, any>) {
        const where: Record<string, any> = {};
        if (q.channelId) where.channelId = q.channelId;
        if (q.targetClassName) where.targetClassName = q.targetClassName;
        if (q.targetId) where.targetId = q.targetId;
        if (q.status) where.status = q.status;
        if (q.isRead) where.isRead = q.isRead === "true";
        const { limit, skip } = parsePage(q);
        const all = await db.find("MessageThread", where);
        return {
          results: sortResults(all, "-lastMessageAt").slice(skip, skip + limit),
          total: all.length,
        };
      },
      async getThread(objectId: string) {
        const t = await db.read("MessageThread", objectId);
        if (!t) throw ZenithErrors.notFound("MessageThread", objectId);
        return t;
      },
      async closeThread(objectId: string) {
        if (!await db.read("MessageThread", objectId)) {
          throw ZenithErrors.notFound("MessageThread", objectId);
        }
        return db.update("MessageThread", { objectId }, { status: "closed", updatedAt: now() });
      },
      async assignThread(objectId: string, userId: string) {
        if (!await db.read("MessageThread", objectId)) {
          throw ZenithErrors.notFound("MessageThread", objectId);
        }
        return db.update("MessageThread", { objectId }, {
          assignedTo: ptr("_User", userId),
          updatedAt: now(),
        });
      },

      // Messages
      async listMessages(threadId: string, q: Record<string, any>) {
        const { limit, skip } = parsePage(q);
        const all = await db.find("EmailMessage", { threadId });
        return { results: sortResults(all, "sentAt").slice(skip, skip + limit), total: all.length };
      },

      // Enviar email
      async sendEmail(
        channelId: string,
        to: string[],
        subject: string,
        body: string,
        html?: string,
        threadId?: string,
      ) {
        const channel = await db.read("EmailChannel", channelId);
        if (!channel) throw ZenithErrors.notFound("EmailChannel", channelId);

        let messageId = `zenith_${Date.now()}`;
        const adapter = EMAIL_ADAPTERS.get(channel.provider);
        if (adapter) {
          const res = await adapter.sendMessage(channel, to, subject, body, html);
          messageId = res.messageId;
        }

        let resolvedThreadId = threadId;
        if (!resolvedThreadId) {
          const crmRecord = await matchToCRM(to[0]);
          const thread = await getOrCreateThread(
            channelId,
            subject,
            [channel.email, ...to],
            crmRecord,
          );
          resolvedThreadId = thread.objectId;
          await db.update("MessageThread", { objectId: resolvedThreadId }, {
            messageCount: thread.messageCount + 1,
            lastMessageAt: now(),
            updatedAt: now(),
          });
        }

        const message = await db.create("EmailMessage", {
          threadId: resolvedThreadId,
          channelId,
          from: channel.email,
          to,
          cc: [],
          subject,
          bodyText: body,
          bodyHtml: html,
          messageId,
          direction: "outbound",
          sentAt: now(),
          isRead: true,
          attachments: [],
          createdAt: now(),
        });

        if (events) {
          events.emit("Email.sent", { channelId, threadId: resolvedThreadId, to, subject });
        }
        return message;
      },
    };

    const email_routes = [
      // Channels
      {
        method: "GET" as const,
        path: "/zen/email/channels",
        _openapi: { summary: "Listar canales de email", tags: ["Email"] },
        handler: async (_r: Request, _c: any) => {
          try {
            return jsonRes(await api.listChannels());
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/email/channels",
        _openapi: { summary: "Crear canal IMAP/SMTP", tags: ["Email"] },
        handler: async (r: Request, c: any) => {
          try {
            return jsonRes(await api.createChannel(await r.json(), c), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "PUT" as const,
        path: "/zen/email/channels/:objectId",
        _openapi: { summary: "Actualizar canal", tags: ["Email"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/email/channels/:objectId", r.url)!;
            return jsonRes(await api.updateChannel(p.objectId, await r.json()));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "DELETE" as const,
        path: "/zen/email/channels/:objectId",
        _openapi: { summary: "Eliminar canal", tags: ["Email"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/email/channels/:objectId", r.url)!;
            await api.deleteChannel(p.objectId);
            return NO_CONTENT;
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/email/channels/:objectId/sync",
        _openapi: { summary: "Forzar sync de canal", tags: ["Email"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/email/channels/:objectId/sync", r.url)!;
            return jsonRes(await api.syncChannel(p.objectId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      // Threads
      {
        method: "GET" as const,
        path: "/zen/email/threads",
        _openapi: { summary: "Listar hilos de email", tags: ["Email"] },
        handler: async (r: Request, _c: any) => {
          try {
            return jsonRes(await api.listThreads(queryParams(new URL(r.url))));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/email/threads/:objectId",
        _openapi: { summary: "Obtener hilo", tags: ["Email"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/email/threads/:objectId", r.url)!;
            return jsonRes(await api.getThread(p.objectId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/email/threads/:objectId/close",
        _openapi: { summary: "Cerrar hilo", tags: ["Email"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/email/threads/:objectId/close", r.url)!;
            return jsonRes(await api.closeThread(p.objectId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/email/threads/:objectId/assign",
        _openapi: { summary: "Asignar hilo a usuario", tags: ["Email"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/email/threads/:objectId/assign", r.url)!;
            const b = await r.json();
            return jsonRes(await api.assignThread(p.objectId, b.userId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      // Messages
      {
        method: "GET" as const,
        path: "/zen/email/threads/:threadId/messages",
        _openapi: { summary: "Mensajes de un hilo", tags: ["Email"] },
        handler: async (r: Request, _c: any) => {
          try {
            const p = pathParams("/zen/email/threads/:threadId/messages", r.url)!;
            return jsonRes(await api.listMessages(p.threadId, queryParams(new URL(r.url))));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/email/send",
        _openapi: { summary: "Enviar email outbound", tags: ["Email"] },
        handler: async (r: Request, _c: any) => {
          try {
            const b = await r.json();
            return jsonRes(
              await api.sendEmail(b.channelId, b.to, b.subject, b.body, b.html, b.threadId),
              201,
            );
          } catch (e) {
            return errRes(e);
          }
        },
      },
    ];

    return { email_routes, emailSync: api };
  },
});
