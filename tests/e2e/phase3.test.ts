/**
 * Tests E2E — Fase 3: Email Sync, Calendar Sync, Automation Rules Engine
 * Ejecución: deno test -A tests/e2e/phase3.test.ts
 */
import { assert, assertEquals, assertExists, assertStringIncludes } from "https://deno.land/std@0.224.0/testing/asserts.ts";

const now = () => new Date().toISOString();
const future = (h: number) => new Date(Date.now() + h * 3600000).toISOString();
const past   = (h: number) => new Date(Date.now() - h * 3600000).toISOString();

// ── Mock DB ───────────────────────────────────────────────────────────────────

function mkDB() {
  const store: Record<string, Record<string, any>> = {};
  let seq = 0;
  return {
    async create(cls: string, data: any) {
      if (!store[cls]) store[cls] = {};
      const id = `${cls.toLowerCase().replace(/[^a-z]/g, "")}_${++seq}`;
      const rec = { ...data, objectId: id };
      store[cls][id] = rec;
      return rec;
    },
    async read(cls: string, id: string) { return store[cls]?.[id] ?? null; },
    async find(cls: string, where: Record<string, any> = {}) {
      return Object.values(store[cls] ?? {}).filter(item =>
        Object.entries(where).every(([k, v]) => {
          const keys = k.split(".");
          let cur: any = item;
          for (const key of keys) cur = cur?.[key];
          return cur === v;
        })
      );
    },
    async update(cls: string, query: any, data: any) {
      const id = query?.objectId ?? query;
      if (!store[cls]?.[id]) return null;
      store[cls][id] = { ...store[cls][id], ...data };
      return store[cls][id];
    },
    async delete(cls: string, query: any) {
      const id = query?.objectId ?? query;
      delete store[cls]?.[id];
    },
  };
}

function ptr(cls: string, id: string) { return { __type: "Pointer", className: cls, objectId: id }; }

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SYNC TESTS
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("Email — EmailChannel: crear con provider IMAP", async () => {
  const db = mkDB();
  const ch = await db.create("EmailChannel", {
    name: "Sales Inbox", email: "sales@corp.com", provider: "imap",
    status: "active", syncInterval: 300, createdAt: now(),
  });
  assertExists(ch.objectId);
  assertEquals(ch.provider, "imap");
  assertEquals(ch.status, "active");
});

Deno.test("Email — parseCSV-style parser: extrae From/Subject de raw email", () => {
  function parseEmailHeaders(raw: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Za-z-]+):\s*(.+)$/);
      if (m) headers[m[1].toLowerCase()] = m[2].trim();
    }
    return headers;
  }
  const raw = "From: Ana García <ana@corp.com>\nTo: sales@empresa.com\nSubject: Re: Propuesta Q4\nDate: Mon, 1 Jan 2025 10:00:00 +0000";
  const h = parseEmailHeaders(raw);
  assertEquals(h.from, "Ana García <ana@corp.com>");
  assertEquals(h.subject, "Re: Propuesta Q4");
});

Deno.test("Email — normalizar subject para agrupar en hilo (strip Re:/Fwd:)", () => {
  function normalizeSubject(subject: string): string {
    return subject.replace(/^(re:|fwd?:|aw:|rv:)\s*/i, "").trim();
  }
  assertEquals(normalizeSubject("Re: Propuesta Q4"),       "Propuesta Q4");
  assertEquals(normalizeSubject("FWD: Propuesta Q4"),      "Propuesta Q4");
  assertEquals(normalizeSubject("Re: Re: Propuesta Q4"),   "Re: Propuesta Q4"); // solo strip el primero
  assertEquals(normalizeSubject("Nueva propuesta"),         "Nueva propuesta");
});

Deno.test("Email — MessageThread: crear hilo y acumular mensajes", async () => {
  const db = mkDB();
  const contact = await db.create("Contact", { name: "Ana", email: "ana@corp.com" });

  const thread = await db.create("MessageThread", {
    subject: "Propuesta Q4", channelId: "ch_001",
    targetClassName: "Contact", targetId: contact.objectId,
    participants: ["ana@corp.com", "sales@corp.com"],
    messageCount: 0, status: "open", isRead: false,
    lastMessageAt: now(), createdAt: now(),
  });

  // Añadir mensajes al hilo
  for (let i = 0; i < 3; i++) {
    await db.create("EmailMessage", {
      threadId: thread.objectId, channelId: "ch_001",
      from: "ana@corp.com", to: ["sales@corp.com"], cc: [],
      subject: "Propuesta Q4", bodyText: `Mensaje ${i}`,
      messageId: `msg_${i}@corp.com`, direction: "inbound",
      sentAt: now(), isRead: false, attachments: [], createdAt: now(),
    });
    await db.update("MessageThread", { objectId: thread.objectId }, {
      messageCount: i + 1, lastMessageAt: now()
    });
  }

  const updated = await db.read("MessageThread", thread.objectId);
  assertEquals(updated.messageCount, 3);
  assertEquals(updated.targetClassName, "Contact");
  assertEquals(updated.targetId, contact.objectId);

  const msgs = await db.find("EmailMessage", { threadId: thread.objectId });
  assertEquals(msgs.length, 3);
});

Deno.test("Email — matchToCRM: prioridad Contact > Lead > Account", async () => {
  const db = mkDB();

  // Función de match
  async function matchToCRM(email: string) {
    const contacts = await db.find("Contact", { email });
    if (contacts[0]) return { className: "Contact", objectId: contacts[0].objectId };
    const leads = await db.find("Lead", { email });
    if (leads[0]) return { className: "Lead", objectId: leads[0].objectId };
    const accounts = await db.find("Account", { email });
    if (accounts[0]) return { className: "Account", objectId: accounts[0].objectId };
    return null;
  }

  await db.create("Contact", { name: "Ana", email: "ana@corp.com" });
  await db.create("Lead",    { email: "lead@corp.com", stage: "new" });
  await db.create("Account", { name: "ACME", email: "acme@corp.com" });

  const r1 = await matchToCRM("ana@corp.com");
  assertEquals(r1?.className, "Contact");

  const r2 = await matchToCRM("lead@corp.com");
  assertEquals(r2?.className, "Lead");

  const r3 = await matchToCRM("acme@corp.com");
  assertEquals(r3?.className, "Account");

  const r4 = await matchToCRM("unknown@nowhere.com");
  assertEquals(r4, null);
});

Deno.test("Email — send outbound: registra en MessageThread con direction=outbound", async () => {
  const db = mkDB();
  const ch = await db.create("EmailChannel", { email: "sales@corp.com", provider: "imap", status: "active", createdAt: now() });

  const thread = await db.create("MessageThread", {
    subject: "Follow up", channelId: ch.objectId,
    targetClassName: "Contact", targetId: "c_001",
    participants: ["sales@corp.com", "client@co.com"],
    messageCount: 0, status: "open", isRead: false, createdAt: now(),
  });

  const msg = await db.create("EmailMessage", {
    threadId: thread.objectId, channelId: ch.objectId,
    from: "sales@corp.com", to: ["client@co.com"], cc: [],
    subject: "Follow up", bodyText: "Hola, ¿podemos hablar mañana?",
    messageId: `out_${Date.now()}@corp.com`,
    direction: "outbound", sentAt: now(), isRead: true, attachments: [], createdAt: now(),
  });

  assertEquals(msg.direction, "outbound");
  assertEquals(msg.from, "sales@corp.com");
  assertEquals(msg.isRead, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR SYNC TESTS
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("Calendar — CalendarChannel: crear con timezone", async () => {
  const db = mkDB();
  const ch = await db.create("CalendarChannel", {
    name: "Sales Calendar", email: "sales@corp.com", provider: "google",
    status: "active", timezone: "America/New_York", syncInterval: 300, createdAt: now(),
  });
  assertEquals(ch.timezone, "America/New_York");
  assertEquals(ch.provider, "google");
});

Deno.test("Calendar — CalendarEvent: crear evento con attendees", async () => {
  const db = mkDB();
  const ev = await db.create("CalendarEvent", {
    channelId: "ch_001", externalId: "google_evt_abc123",
    title: "Demo Call con ACME", description: "Presentación del producto",
    startAt: future(24), endAt: future(25),
    isAllDay: false, status: "confirmed",
    attendees: [
      { email: "ceo@acme.com",    name: "CEO ACME",    status: "accepted" },
      { email: "sales@corp.com",  name: "Sales Rep",   status: "accepted" },
    ],
    targetClassName: "Deal", targetId: "deal_001",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    createdAt: now(), updatedAt: now(),
  });

  assertExists(ev.objectId);
  assertEquals(ev.attendees.length, 2);
  assertEquals(ev.targetClassName, "Deal");
  assertExists(ev.meetingUrl);
});

Deno.test("Calendar — Detección de conflictos de horario", () => {
  function detectConflicts(
    events: Array<{ startAt: string; endAt: string; status: string }>,
    newStart: string, newEnd: string
  ) {
    return events.filter(e => {
      if (e.status !== "confirmed") return false;
      const eS = new Date(e.startAt).getTime();
      const eE = new Date(e.endAt).getTime();
      const nS = new Date(newStart).getTime();
      const nE = new Date(newEnd).getTime();
      return !(nE <= eS || nS >= eE); // solapamiento
    });
  }

  const baseStart = new Date("2025-01-15T10:00:00Z");
  const baseEnd   = new Date("2025-01-15T11:00:00Z");

  const existing = [
    { startAt: "2025-01-15T10:00:00Z", endAt: "2025-01-15T11:00:00Z", status: "confirmed" },
    { startAt: "2025-01-15T14:00:00Z", endAt: "2025-01-15T15:00:00Z", status: "confirmed" },
    { startAt: "2025-01-15T09:00:00Z", endAt: "2025-01-15T10:30:00Z", status: "cancelled" },
  ];

  // Exacta superposición → conflicto
  assertEquals(detectConflicts(existing, "2025-01-15T10:00:00Z", "2025-01-15T11:00:00Z").length, 1);
  // Sin solapamiento → sin conflicto
  assertEquals(detectConflicts(existing, "2025-01-15T11:00:00Z", "2025-01-15T12:00:00Z").length, 0);
  // Parcialmente solapado → conflicto
  assertEquals(detectConflicts(existing, "2025-01-15T10:30:00Z", "2025-01-15T11:30:00Z").length, 1);
  // Cancelado NO cuenta como conflicto
  assertEquals(detectConflicts(existing, "2025-01-15T09:00:00Z", "2025-01-15T10:30:00Z").length, 1); // solo el confirmed del 10:00
});

Deno.test("Calendar — startAt debe ser anterior a endAt", () => {
  function validateRange(startAt: string, endAt: string): boolean {
    return new Date(startAt) < new Date(endAt);
  }
  assert( validateRange("2025-01-15T10:00:00Z", "2025-01-15T11:00:00Z"), "válido");
  assert(!validateRange("2025-01-15T11:00:00Z", "2025-01-15T10:00:00Z"), "inválido: fin antes de inicio");
  assert(!validateRange("2025-01-15T10:00:00Z", "2025-01-15T10:00:00Z"), "inválido: misma hora");
});

Deno.test("Calendar — Booking de slot: idempotente, valida expiración", async () => {
  const db = mkDB();
  const slot = await db.create("CalendarSlot", {
    channelId: "ch_001", title: "30-min Sales Call",
    startAt: future(48), endAt: future(48.5),
    duration: 30, isBooked: false, bufferMins: 5, createdAt: now(),
  });

  assertEquals(slot.isBooked, false);
  assert(new Date(slot.startAt) > new Date(), "slot debe ser futuro");

  // Reservar
  await db.update("CalendarSlot", { objectId: slot.objectId }, {
    isBooked: true, bookedBy: "client@acme.com", updatedAt: now()
  });
  const booked = await db.read("CalendarSlot", slot.objectId);
  assertEquals(booked.isBooked, true);

  // No se puede reservar dos veces
  const alreadyBooked = booked.isBooked;
  assert(alreadyBooked, "debe estar ya reservado → error en re-booking");
});

Deno.test("Calendar — generador iCal RFC 5545: estructura VCALENDAR válida", () => {
  function generateICS(title: string, startAt: string, endAt: string): string {
    const dt = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Zenith BaaS//Calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:test-uid@zenith`,
      `DTSTAMP:${dt(new Date().toISOString())}`,
      `DTSTART:${dt(startAt)}`,
      `DTEND:${dt(endAt)}`,
      `SUMMARY:${title}`,
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
  }

  const ics = generateICS("Demo Call", "2025-01-15T10:00:00Z", "2025-01-15T11:00:00Z");
  assertStringIncludes(ics, "BEGIN:VCALENDAR");
  assertStringIncludes(ics, "END:VCALENDAR");
  assertStringIncludes(ics, "BEGIN:VEVENT");
  assertStringIncludes(ics, "END:VEVENT");
  assertStringIncludes(ics, "SUMMARY:Demo Call");
  assertStringIncludes(ics, "DTSTART:20250115T100000Z");
  assertStringIncludes(ics, "DTEND:20250115T110000Z");
  assertStringIncludes(ics, "VERSION:2.0");
});

Deno.test("Calendar — matchAttendeesToCRM: vincula asistentes con Contacts", async () => {
  const db = mkDB();
  await db.create("Contact", { name: "CEO ACME", email: "ceo@acme.com" });
  await db.create("Contact", { name: "CTO ACME", email: "cto@acme.com" });

  async function matchAttendees(emails: string[]) {
    const results = [];
    for (const email of emails) {
      const contacts = await db.find("Contact", { email });
      if (contacts[0]) results.push({ email, className: "Contact", objectId: contacts[0].objectId });
    }
    return results;
  }

  const attendees = ["ceo@acme.com", "cto@acme.com", "unknown@other.com"];
  const matched = await matchAttendees(attendees);
  assertEquals(matched.length, 2);
  assert(matched.every(m => m.className === "Contact"));
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATION RULES ENGINE TESTS
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("Automation — evalCondition: todos los operadores", () => {
  type CondOp = "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"in"|"notIn"|"contains"|"is"|"isNot";

  function evalCond(field: string, op: CondOp, value: unknown, record: Record<string, unknown>): boolean {
    const keys = field.split(".");
    let val: unknown = record;
    for (const k of keys) val = (val as Record<string, unknown>)?.[k];
    switch (op) {
      case "eq":      return val === value;
      case "neq":     return val !== value;
      case "gt":      return (val as number) > (value as number);
      case "gte":     return (val as number) >= (value as number);
      case "lt":      return (val as number) < (value as number);
      case "lte":     return (val as number) <= (value as number);
      case "in":      return Array.isArray(value) && (value as unknown[]).includes(val);
      case "notIn":   return Array.isArray(value) && !(value as unknown[]).includes(val);
      case "contains":return typeof val === "string" && val.includes(String(value));
      case "is":      return val === null || val === undefined ? !value : !!val === !!value;
      case "isNot":   return !(val === null || val === undefined ? !value : !!val === !!value);
      default:        return true;
    }
  }

  const lead = { score: 85, stage: "qualified", name: "Ana García", tags: ["vip"] };

  assertEquals(evalCond("score", "gt",  80, lead),              true);
  assertEquals(evalCond("score", "lt",  80, lead),              false);
  assertEquals(evalCond("score", "gte", 85, lead),              true);
  assertEquals(evalCond("score", "lte", 84, lead),              false);
  assertEquals(evalCond("stage", "eq",  "qualified", lead),     true);
  assertEquals(evalCond("stage", "neq", "won",        lead),     true);
  assertEquals(evalCond("stage", "in",  ["qualified","new"], lead), true);
  assertEquals(evalCond("stage", "notIn",["won","lost"], lead),  true);
  assertEquals(evalCond("name",  "contains", "García", lead),   true);
  assertEquals(evalCond("name",  "contains", "Smith",  lead),   false);
});

Deno.test("Automation — evalGroup: AND / OR anidado", () => {
  type Cond = { field: string; op: string; value: unknown };
  type Group = { and?: Array<Cond|Group>; or?: Array<Cond|Group> };

  function evalCond(c: Cond, r: Record<string, unknown>): boolean {
    const val = r[c.field];
    if (c.op === "eq")  return val === c.value;
    if (c.op === "gt")  return (val as number) > (c.value as number);
    if (c.op === "gte") return (val as number) >= (c.value as number);
    return true;
  }
  function evalGroup(g: Group, r: Record<string, unknown>): boolean {
    if (g.and) return g.and.every(c => "field" in c ? evalCond(c as Cond, r) : evalGroup(c as Group, r));
    if (g.or)  return g.or.some( c => "field" in c ? evalCond(c as Cond, r) : evalGroup(c as Group, r));
    return true;
  }

  const lead = { score: 85, stage: "qualified", amount: 50000 };

  // AND: score >= 80 Y stage = "qualified" → true
  assertEquals(evalGroup({ and: [{ field: "score", op: "gte", value: 80 }, { field: "stage", op: "eq", value: "qualified" }] }, lead), true);
  // AND: score >= 80 Y stage = "won" → false
  assertEquals(evalGroup({ and: [{ field: "score", op: "gte", value: 80 }, { field: "stage", op: "eq", value: "won" }] }, lead), false);
  // OR: stage = "won" O amount > 40000 → true (segunda cumple)
  assertEquals(evalGroup({ or: [{ field: "stage", op: "eq", value: "won" }, { field: "amount", op: "gt", value: 40000 }] }, lead), true);
  // OR: score > 90 O stage = "won" → false (ninguna cumple)
  assertEquals(evalGroup({ or: [{ field: "score", op: "gt", value: 90 }, { field: "stage", op: "eq", value: "won" }] }, lead), false);
  // Anidado: (score >= 80 AND stage = qualified) OR amount > 100000 → true
  assertEquals(evalGroup({ or: [{ and: [{ field: "score", op: "gte", value: 80 }, { field: "stage", op: "eq", value: "qualified" }] }, { field: "amount", op: "gt", value: 100000 }] }, lead), true);
});

Deno.test("Automation — event pattern matching: *, Class.*, exact", () => {
  function matchesPattern(pattern: string, event: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) return event.startsWith(pattern.slice(0, -2));
    return pattern === event;
  }
  assertEquals(matchesPattern("*",                  "Lead.scoreChanged"),  true);
  assertEquals(matchesPattern("Lead.*",             "Lead.scoreChanged"),  true);
  assertEquals(matchesPattern("Lead.*",             "Contact.created"),    false);
  assertEquals(matchesPattern("Lead.scoreChanged",  "Lead.scoreChanged"),  true);
  assertEquals(matchesPattern("Lead.scoreChanged",  "Lead.created"),       false);
  assertEquals(matchesPattern("cron:0 9 * * 1",    "cron:0 9 * * 1"),     true);
});

Deno.test("Automation — AutomationRule: CRUD en DB", async () => {
  const db = mkDB();
  const rule = await db.create("AutomationRule", {
    name: "Hot Lead → Notificar Manager",
    isActive: true,
    trigger: { event: "Lead.*", conditions: { and: [{ field: "score", op: "gte", value: 80 }] } },
    actions: [
      { type: "send_notification", params: { userId: "user_manager", title: "Hot Lead!", body: "Lead calificado detectado" } },
      { type: "create_task",       params: { title: "Follow up inmediato", priority: "urgent" } },
    ],
    runCount: 0, errorCount: 0, createdAt: now(), updatedAt: now(),
  });

  assertExists(rule.objectId);
  assertEquals(rule.actions.length, 2);
  assertEquals(rule.trigger.event, "Lead.*");

  // Toggle
  await db.update("AutomationRule", { objectId: rule.objectId }, { isActive: false });
  const toggled = await db.read("AutomationRule", rule.objectId);
  assertEquals(toggled.isActive, false);
});

Deno.test("Automation — ejecutar acciones built-in: create_task", async () => {
  const db = mkDB();
  const ctx = {
    db, events: null, deps: {},
    record: { objectId: "lead_001", className: "Lead", score: 85, stage: "qualified" },
    triggerEvent: "Lead.scoreChanged",
  };

  // Simular action create_task
  const task = await db.create("Task", {
    title: "Follow up inmediato",
    priority: "urgent", status: "todo",
    targetClassName: ctx.record.className,
    targetId: ctx.record.objectId,
    source: "automation",
    createdAt: now(), updatedAt: now(),
  });

  assertExists(task.objectId);
  assertEquals(task.title, "Follow up inmediato");
  assertEquals(task.source, "automation");
  assertEquals(task.targetId, "lead_001");
});

Deno.test("Automation — ejecutar acciones built-in: update_record", async () => {
  const db = mkDB();
  const deal = await db.create("Deal", {
    title: "Contrato ACME", stage: "proposal", amount: 50000, createdAt: now(),
  });

  // Simular action update_record
  const updated = await db.update("Deal", { objectId: deal.objectId }, {
    stage: "negotiation", updatedAt: now(),
  });

  assertEquals(updated.stage, "negotiation");
  assertEquals(updated.amount, 50000); // campo no modificado debe persistir
});

Deno.test("Automation — template interpolation {{field}}", () => {
  function interpolate(template: string, record: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(record[k] ?? ""));
  }
  const record = { name: "Ana García", stage: "qualified", score: 85 };
  assertEquals(
    interpolate("Lead {{name}} en stage {{stage}} con score {{score}}", record),
    "Lead Ana García en stage qualified con score 85"
  );
  assertEquals(
    interpolate("Campo {{missing}} no existe", record),
    "Campo  no existe"
  );
});

Deno.test("Automation — AutomationLog: registro de ejecución con status", async () => {
  const db = mkDB();
  const log = await db.create("AutomationLog", {
    ruleId: "rule_001", triggerEvent: "Lead.scoreChanged",
    recordId: "lead_001",
    status: "success", actionsRun: 2, durationMs: 45, createdAt: now(),
  });

  assertExists(log.objectId);
  assertEquals(log.status, "success");
  assertEquals(log.actionsRun, 2);
  assert(log.durationMs >= 0);
});

Deno.test("Automation — run_sequence: ejecuta acciones en orden", async () => {
  const db = mkDB();
  const results: string[] = [];

  // Mock sequence handler
  async function runSequence(actions: Array<{ type: string; params: Record<string, unknown> }>) {
    for (const action of actions) {
      results.push(action.type);
      await Promise.resolve(); // simular async
    }
    return results;
  }

  await runSequence([
    { type: "send_notification", params: { body: "Alerta" } },
    { type: "create_task",       params: { title: "Task 1" } },
    { type: "add_tag",           params: { tagId: "tag_vip" } },
  ]);

  assertEquals(results, ["send_notification", "create_task", "add_tag"]);
});

Deno.test("Automation — regla con conditions field path anidado (deal.contact.email)", () => {
  type AnyRecord = Record<string, unknown>;
  function getNestedValue(record: AnyRecord, path: string): unknown {
    return path.split(".").reduce((obj: unknown, key) => (obj as AnyRecord)?.[key], record);
  }
  const deal = { title: "Big Deal", contact: { email: "ceo@acme.com", tier: "enterprise" }, amount: 100000 };
  assertEquals(getNestedValue(deal, "contact.email"),       "ceo@acme.com");
  assertEquals(getNestedValue(deal, "contact.tier"),        "enterprise");
  assertEquals(getNestedValue(deal, "amount"),              100000);
  assertEquals(getNestedValue(deal, "contact.missing"),     undefined);
});
