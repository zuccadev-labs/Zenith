/**
 * ZenithEmail — SDK client for /zen/email
 * Channel management + threads + send
 */
import type { Zenith } from "../core/Zenith.ts";

export interface EmailChannel  { objectId: string; name: string; email: string; provider: string; status: string; syncInterval: number; lastSyncAt?: string; }
export interface MessageThread { objectId: string; subject: string; channelId: string; targetClassName: string; targetId: string; participants: string[]; messageCount: number; status: string; isRead: boolean; lastMessageAt: string; assignedTo?: any; }
export interface EmailMessage  { objectId: string; threadId: string; from: string; to: string[]; subject: string; bodyText: string; bodyHtml?: string; direction: "inbound" | "outbound"; sentAt: string; isRead: boolean; attachments: any[]; }

export class ZenithEmail {
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

  // ── Channels ───────────────────────────────────────────────────────────────
  async listChannels(): Promise<{ results: EmailChannel[] }> {
    return (await fetch(`${this.base}/zen/email/channels`, { headers: this.h() })).json();
  }

  async createChannel(data: { name: string; email: string; provider: "imap" | "gmail" | "outlook" | "sendgrid" | "ses" | "mailgun"; imapHost?: string; imapPort?: number; smtpHost?: string; smtpPort?: number; syncInterval?: number }): Promise<EmailChannel> {
    return (await fetch(`${this.base}/zen/email/channels`, { method: "POST", headers: this.h(), body: JSON.stringify(data) })).json();
  }

  async updateChannel(objectId: string, data: Partial<EmailChannel>): Promise<EmailChannel> {
    return (await fetch(`${this.base}/zen/email/channels/${objectId}`, { method: "PUT", headers: this.h(), body: JSON.stringify(data) })).json();
  }

  async deleteChannel(objectId: string): Promise<void> {
    await fetch(`${this.base}/zen/email/channels/${objectId}`, { method: "DELETE", headers: this.h() });
  }

  /** Forzar sync inmediato de un canal */
  async sync(channelId: string): Promise<{ synced: number; threads: number }> {
    return (await fetch(`${this.base}/zen/email/channels/${channelId}/sync`, { method: "POST", headers: this.h() })).json();
  }

  // ── Threads ────────────────────────────────────────────────────────────────
  async listThreads(opts?: { channelId?: string; targetClassName?: string; targetId?: string; status?: string; limit?: number; skip?: number }): Promise<{ results: MessageThread[]; total: number }> {
    const q = new URLSearchParams(Object.entries(opts ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return (await fetch(`${this.base}/zen/email/threads?${q}`, { headers: this.h() })).json();
  }

  async getThread(objectId: string): Promise<MessageThread> {
    return (await fetch(`${this.base}/zen/email/threads/${objectId}`, { headers: this.h() })).json();
  }

  async closeThread(objectId: string): Promise<MessageThread> {
    return (await fetch(`${this.base}/zen/email/threads/${objectId}/close`, { method: "POST", headers: this.h() })).json();
  }

  async assignThread(objectId: string, userId: string): Promise<MessageThread> {
    return (await fetch(`${this.base}/zen/email/threads/${objectId}/assign`, {
      method: "POST", headers: this.h(), body: JSON.stringify({ userId }),
    })).json();
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  async listMessages(threadId: string, opts?: { limit?: number; skip?: number }): Promise<{ results: EmailMessage[]; total: number }> {
    const q = new URLSearchParams(Object.entries(opts ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return (await fetch(`${this.base}/zen/email/threads/${threadId}/messages?${q}`, { headers: this.h() })).json();
  }

  /** Enviar email outbound */
  async send(data: { channelId: string; to: string[]; subject: string; body: string; html?: string; threadId?: string }): Promise<EmailMessage> {
    return (await fetch(`${this.base}/zen/email/send`, {
      method: "POST", headers: this.h(), body: JSON.stringify(data),
    })).json();
  }
}

/**
 * ZenithCalendar — SDK client for /zen/calendar
 * Channel management + events + slots/booking + iCal feeds
 */
export interface CalendarChannel { objectId: string; name: string; email: string; provider: string; status: string; timezone: string; lastSyncAt?: string; }
export interface CalendarEvent   { objectId: string; channelId: string; externalId: string; title: string; startAt: string; endAt: string; isAllDay: boolean; status: string; attendees: any[]; targetClassName?: string; targetId?: string; meetingUrl?: string; conflicts?: number; }
export interface CalendarSlot    { objectId: string; channelId: string; startAt: string; endAt: string; duration: number; title: string; isBooked: boolean; bookedBy?: string; }

export class ZenithCalendar {
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

  // ── Channels ───────────────────────────────────────────────────────────────
  async listChannels(): Promise<{ results: CalendarChannel[] }> {
    return (await fetch(`${this.base}/zen/calendar/channels`, { headers: this.h() })).json();
  }

  async createChannel(data: { name: string; email: string; provider: "google" | "outlook" | "caldav" | "ical"; timezone?: string; syncInterval?: number }): Promise<CalendarChannel> {
    return (await fetch(`${this.base}/zen/calendar/channels`, { method: "POST", headers: this.h(), body: JSON.stringify(data) })).json();
  }

  async deleteChannel(objectId: string): Promise<void> {
    await fetch(`${this.base}/zen/calendar/channels/${objectId}`, { method: "DELETE", headers: this.h() });
  }

  async sync(channelId: string): Promise<{ synced: number; created: number; updated: number }> {
    return (await fetch(`${this.base}/zen/calendar/channels/${channelId}/sync`, { method: "POST", headers: this.h() })).json();
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  async listEvents(opts?: { channelId?: string; from?: string; to?: string; targetId?: string; status?: string; limit?: number }): Promise<{ results: CalendarEvent[]; total: number }> {
    const q = new URLSearchParams(Object.entries(opts ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return (await fetch(`${this.base}/zen/calendar/events?${q}`, { headers: this.h() })).json();
  }

  async getEvent(objectId: string): Promise<CalendarEvent> {
    return (await fetch(`${this.base}/zen/calendar/events/${objectId}`, { headers: this.h() })).json();
  }

  async createEvent(data: { channelId: string; title: string; startAt: string; endAt: string; description?: string; location?: string; attendees?: any[]; isAllDay?: boolean; recurrence?: string }): Promise<CalendarEvent> {
    return (await fetch(`${this.base}/zen/calendar/events`, { method: "POST", headers: this.h(), body: JSON.stringify(data) })).json();
  }

  async updateEvent(objectId: string, data: Partial<CalendarEvent>): Promise<CalendarEvent> {
    return (await fetch(`${this.base}/zen/calendar/events/${objectId}`, { method: "PUT", headers: this.h(), body: JSON.stringify(data) })).json();
  }

  async cancelEvent(objectId: string): Promise<{ success: boolean }> {
    return (await fetch(`${this.base}/zen/calendar/events/${objectId}`, { method: "DELETE", headers: this.h() })).json();
  }

  async checkConflicts(channelId: string, startAt: string, endAt: string): Promise<{ hasConflicts: boolean; conflicts: CalendarEvent[] }> {
    return (await fetch(`${this.base}/zen/calendar/conflicts`, {
      method: "POST", headers: this.h(), body: JSON.stringify({ channelId, startAt, endAt }),
    })).json();
  }

  // ── Slots / Booking ────────────────────────────────────────────────────────
  async listSlots(channelId: string): Promise<{ results: CalendarSlot[] }> {
    return (await fetch(`${this.base}/zen/calendar/channels/${channelId}/slots`, { headers: this.h() })).json();
  }

  async createSlot(channelId: string, data: { startAt: string; endAt: string; title?: string; duration?: number; bufferMins?: number }): Promise<CalendarSlot> {
    return (await fetch(`${this.base}/zen/calendar/channels/${channelId}/slots`, {
      method: "POST", headers: this.h(), body: JSON.stringify(data),
    })).json();
  }

  async bookSlot(objectId: string, email: string, name?: string): Promise<{ slot: CalendarSlot; event: CalendarEvent }> {
    return (await fetch(`${this.base}/zen/calendar/slots/${objectId}/book`, {
      method: "POST", headers: this.h(), body: JSON.stringify({ email, name }),
    })).json();
  }

  // ── iCal feeds ────────────────────────────────────────────────────────────
  /** URL del feed iCal (.ics) para un record CRM — para suscribir en Google Calendar */
  icsUrlForRecord(targetClassName: string, targetId: string): string {
    return `${this.base}/zen/calendar/ics/record/${targetClassName}/${targetId}`;
  }

  icsUrlForChannel(channelId: string): string {
    return `${this.base}/zen/calendar/ics/channel/${channelId}`;
  }
}
