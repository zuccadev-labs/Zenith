// deno-lint-ignore-file no-unused-vars
/**
 * Automation Rules Engine — Motor de automatización de negocio.
 *
 * Permite definir reglas tipo IF-THEN que reaccionan a eventos del sistema:
 *
 *   IF  Lead.score > 80 AND Lead.stage == "qualified"
 *   THEN create_task("Follow up call", assignTo: "sales_manager")
 *        send_notification(userId, "Hot lead detected!")
 *        update_record(Deal, stage: "negotiation")
 *        run_agent("lead_scorer", input: lead)
 *        send_webhook(url, payload)
 *        send_email(channelId, to: contact.email, template: "hot_lead")
 *        add_tag(tagId)
 *        wait(hours: 2)
 *        run_sequence([...actions])
 *
 * Patrón: cada Action es un handler pluggable (patrón adaptador).
 *         Proyectos registran acciones custom via registerAction().
 *
 * @barrits-trait
 * @barrits-summary ZenithAutomation
 * @barrits-provides automation_routes, automation
 * @barrits-consumes db, emailSync, notifications
 * @barrits-tags uses:adkAgents, uses:events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import {
  jsonRes, errRes, NO_CONTENT, pathParams, queryParams,
  parsePage, sortResults, ptr, now,
  parseFilterParam, applyFilter,
} from "../../core/trait-utils.ts";

// ── Tipos del motor ───────────────────────────────────────────────────────────

export type ConditionOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn" | "contains" | "is" | "isNot";

export interface AutoCondition {
  field: string;
  op:    ConditionOp;
  value: unknown;
}

export interface AutoConditionGroup {
  and?: Array<AutoCondition | AutoConditionGroup>;
  or?:  Array<AutoCondition | AutoConditionGroup>;
}

export type ActionType =
  | "create_task"
  | "update_record"
  | "send_notification"
  | "send_email"
  | "send_webhook"
  | "run_agent"
  | "add_tag"
  | "remove_tag"
  | "assign_record"
  | "create_note"
  | "wait"
  | "run_sequence"
  | "custom";

export interface AutoAction {
  type:   ActionType;
  params: Record<string, unknown>;
}

export interface AutomationRule {
  objectId:   string;
  name:       string;
  description?: string;
  isActive:   boolean;
  trigger:    {
    event:        string;          // "Contact.created" | "Deal.*" | "Lead.scoreChanged" | "cron:0 9 * * 1"
    className?:   string;          // filtra solo cierta clase
    conditions?:  AutoConditionGroup;
  };
  actions:    AutoAction[];
  runCount:   number;
  lastRunAt?: string;
  errorCount: number;
  lastError?: string;
  createdAt:  string;
  updatedAt:  string;
}

export interface AutomationLog {
  objectId:     string;
  ruleId:       string;
  triggerEvent: string;
  recordId?:    string;
  status:       "success" | "error" | "partial";
  actionsRun:   number;
  durationMs:   number;
  error?:       string;
  createdAt:    string;
}

/** Registro de acciones custom pluggables */
const ACTION_REGISTRY = new Map<string, (params: Record<string, unknown>, ctx: ActionCtx) => Promise<unknown>>();

interface ActionCtx {
  db:            any;
  events?:       any;
  deps:          Record<string, any>;
  record?:       Record<string, unknown>;
  triggerEvent:  string;
}

// ── Evaluador de condiciones ──────────────────────────────────────────────────

function evalCondition(cond: AutoCondition, record: Record<string, unknown>): boolean {
  const keys = cond.field.split(".");
  let val: unknown = record;
  for (const k of keys) val = (val as Record<string, unknown>)?.[k];

  switch (cond.op) {
    case "eq":       return val === cond.value;
    case "neq":      return val !== cond.value;
    case "gt":       return (val as number) > (cond.value as number);
    case "gte":      return (val as number) >= (cond.value as number);
    case "lt":       return (val as number) < (cond.value as number);
    case "lte":      return (val as number) <= (cond.value as number);
    case "in":       return Array.isArray(cond.value) && (cond.value as unknown[]).includes(val);
    case "notIn":    return Array.isArray(cond.value) && !(cond.value as unknown[]).includes(val);
    case "contains": return typeof val === "string" && val.includes(String(cond.value));
    case "is":       return val === null || val === undefined ? !cond.value : !!val === !!cond.value;
    case "isNot":    return !(val === null || val === undefined ? !cond.value : !!val === !!cond.value);
    default:         return true;
  }
}

function evalGroup(group: AutoConditionGroup, record: Record<string, unknown>): boolean {
  if (group.and) return group.and.every(c => "field" in c ? evalCondition(c as AutoCondition, record) : evalGroup(c as AutoConditionGroup, record));
  if (group.or)  return group.or.some (c => "field" in c ? evalCondition(c as AutoCondition, record) : evalGroup(c as AutoConditionGroup, record));
  return true;
}

// ── Acciones built-in ─────────────────────────────────────────────────────────

function registerBuiltinActions(db: any, events: any, deps: Record<string, any>) {

  ACTION_REGISTRY.set("create_task", async ({ title, targetClassName, targetId, assignTo, priority, dueInDays }: any, ctx) => {
    const dueAt = dueInDays ? new Date(Date.now() + Number(dueInDays) * 86400000).toISOString() : undefined;
    return db.create("Task", {
      title, priority: priority ?? "medium", status: "todo",
      targetClassName: targetClassName ?? ctx.record?.className,
      targetId:        targetId        ?? ctx.record?.objectId,
      assignee: assignTo ? ptr("_User", String(assignTo)) : null,
      dueAt, source: "automation", createdAt: now(), updatedAt: now(),
    });
  });

  ACTION_REGISTRY.set("update_record", async ({ className, recordId, fields }: any, ctx) => {
    const id  = recordId ?? ctx.record?.objectId;
    const cls = className ?? ctx.record?.className ?? "Contact";
    return db.update(cls, { objectId: id }, { ...(fields as object), updatedAt: now() });
  });

  ACTION_REGISTRY.set("send_notification", async ({ userId, title, body, type, link }: any, _ctx) => {
    const notificationsApi = deps.traits["notifications"];
    if (notificationsApi) return notificationsApi.create(userId, { title, body, type: type ?? "info", link, source: "automation" });
    return db.create("Notification", { userId, title, body, type: type ?? "info", link, source: "automation", isRead: false, createdAt: now() });
  });

  ACTION_REGISTRY.set("send_email", async ({ channelId, to, subject, body, html }: any, _ctx) => {
    const emailApi = deps.traits["emailSync"];
    if (emailApi) return emailApi.sendEmail(channelId, Array.isArray(to) ? to : [to], subject, body, html);
    if (events) events.emit("Email.send", { channelId, to, subject, body });
    return { queued: true };
  });

  ACTION_REGISTRY.set("send_webhook", async ({ url, payload, method }: any, ctx) => {
    const body = JSON.stringify({ ...payload, triggerEvent: ctx.triggerEvent, timestamp: now() });
    await fetch(url, {
      method: method ?? "POST",
      headers: { "content-type": "application/json" },
      body,
    }).catch(() => {});
    return { sent: true };
  });

  ACTION_REGISTRY.set("run_agent", async ({ agentId, inputTemplate }: any, ctx) => {
    const agentsApi = deps.traits["adkAgents"];
    if (!agentsApi) return { skipped: "ADK agents not configured" };
    const input = inputTemplate
      ? String(inputTemplate).replace(/\{\{(\w+)\}\}/g, (_, k) => String(ctx.record?.[k] ?? ""))
      : JSON.stringify(ctx.record);
    return agentsApi.run(agentId, input, ctx);
  });

  ACTION_REGISTRY.set("add_tag", async ({ tagId, targetClassName, targetId }: any, ctx) => {
    const cls = targetClassName ?? ctx.record?.className ?? "Contact";
    const id  = targetId        ?? ctx.record?.objectId;
    return db.create("TagAssignment", {
      tag: ptr("Tag", tagId), targetClassName: cls, targetId: id,
      assignedBy: null, createdAt: now(),
    }).catch(() => ({ skipped: "tag already assigned" }));
  });

  ACTION_REGISTRY.set("remove_tag", async ({ tagId, targetClassName, targetId }: any, ctx) => {
    const cls = targetClassName ?? ctx.record?.className ?? "Contact";
    const id  = targetId        ?? ctx.record?.objectId;
    const existing = await db.find("TagAssignment", { "tag.objectId": tagId, targetClassName: cls, targetId: id });
    if (existing[0]) await db.delete("TagAssignment", { objectId: existing[0].objectId });
    return { removed: existing.length > 0 };
  });

  ACTION_REGISTRY.set("assign_record", async ({ className, recordId, userId }: any, ctx) => {
    const cls = className ?? ctx.record?.className ?? "Contact";
    const id  = recordId  ?? ctx.record?.objectId;
    return db.update(cls, { objectId: id }, { assignedTo: ptr("_User", userId), updatedAt: now() });
  });

  ACTION_REGISTRY.set("create_note", async ({ title, body, targetClassName, targetId }: any, ctx) => {
    return db.create("Note", {
      title, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] },
      bodyText: body,
      targetClassName: targetClassName ?? ctx.record?.className,
      targetId:        targetId        ?? ctx.record?.objectId,
      isPinned: false, source: "automation",
      createdAt: now(), updatedAt: now(),
    });
  });

  ACTION_REGISTRY.set("wait", async ({ hours, minutes, seconds }: any) => {
    const ms = (Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000;
    if (ms > 0 && ms <= 30000) await new Promise(r => setTimeout(r, ms)); // max 30s en sync, largas → queue
    return { waited: ms };
  });

  ACTION_REGISTRY.set("run_sequence", async ({ actions }: any, ctx) => {
    const results = [];
    for (const action of actions ?? []) {
      const handler = ACTION_REGISTRY.get(action.type);
      if (handler) results.push(await handler(action.params ?? {}, ctx).catch(e => ({ error: e.message })));
    }
    return { results };
  });
}

export const AutomationTrait = createTraitDescriptor({
  name: "ZenithAutomation",
  provides: ["automation_routes", "automation"],
  consumes: ["db", "emailSync", "notifications"],
  tags: ["uses:adkAgents", "uses:events"],
  state: [],
  runtimes: ["deno"],
  summary: "Automation Rules Engine: IF-THEN rules on any event. Built-in actions: create_task, update_record, send_notification, send_email, send_webhook, run_agent, add/remove_tag, assign, create_note, wait, run_sequence. Pluggable custom actions.",

  create: (deps: Record<string, any>) => {
    const db     = deps.traits["db"];
    const events = deps.traits["events"];

    registerBuiltinActions(db, events, deps);

    // ── Motor de ejecución ────────────────────────────────────────────────────

    async function executeRule(rule: AutomationRule, record: Record<string, unknown>, triggerEvent: string): Promise<AutomationLog> {
      const start = Date.now();
      let actionsRun = 0, lastError: string | undefined;
      let status: "success" | "error" | "partial" = "success";

      const ctx: ActionCtx = { db, events, deps, record, triggerEvent };

      for (const action of rule.actions) {
        const handler = ACTION_REGISTRY.get(action.type);
        if (!handler) { lastError = `Acción '${action.type}' no registrada.`; status = "partial"; continue; }
        try {
          await handler(action.params as Record<string, unknown>, ctx);
          actionsRun++;
        } catch(e: any) {
          lastError = e.message;
          status = actionsRun > 0 ? "partial" : "error";
        }
      }

      const log: Omit<AutomationLog, "objectId"> = {
        ruleId: rule.objectId, triggerEvent,
        recordId: record?.objectId as string | undefined,
        status, actionsRun, durationMs: Date.now() - start,
        error: lastError, createdAt: now(),
      };

      const createdLog = await db.create("AutomationLog", log).catch(() => ({ ...log, objectId: "none" }));

      await db.update("AutomationRule", { objectId: rule.objectId }, {
        runCount: rule.runCount + 1, lastRunAt: now(),
        errorCount: status === "error" ? rule.errorCount + 1 : rule.errorCount,
        lastError: lastError ?? null, updatedAt: now(),
      }).catch(() => {});

      return createdLog as AutomationLog;
    }

    // ── Conectar al bus de eventos ────────────────────────────────────────────

    async function dispatchEvent(eventName: string, data: Record<string, unknown>) {
      const allRules = await db.find("AutomationRule", { isActive: true }).catch(() => []);
      for (const rule of allRules) {
        const pattern = rule.trigger?.event;
        if (!pattern) continue;

        const matches = pattern === "*"
          ? true
          : pattern.endsWith(".*") ? eventName.startsWith(pattern.slice(0, -2))
          : pattern === eventName;
        if (!matches) continue;

        // Filtro de clase
        if (rule.trigger.className && data?.className && data.className !== rule.trigger.className) continue;

        // Evaluar condiciones
        if (rule.trigger.conditions) {
          const conditionsMatch = evalGroup(rule.trigger.conditions, data);
          if (!conditionsMatch) continue;
        }

        // Ejecutar en background (no bloquea el request)
        executeRule(rule, data, eventName).catch(() => {});
      }
    }

    // Monkey-patch del bus de eventos para interceptar todos los eventos
    if (events?.emit) {
      const _originalEmit = events.emit.bind(events);
      events.emit = (eventName: string, data: unknown) => {
        _originalEmit(eventName, data);
        // Programar dispatch en el siguiente tick para no bloquear
        if (typeof data === "object" && data !== null) {
          Promise.resolve().then(() => dispatchEvent(eventName, data as Record<string, unknown>)).catch(() => {});
        }
      };
    }

    const api = {
      registerAction: (type: string, handler: (params: Record<string, unknown>, ctx: ActionCtx) => Promise<unknown>) => {
        ACTION_REGISTRY.set(type, handler);
        return { registered: true, type };
      },
      listActions: () => ({ actions: Array.from(ACTION_REGISTRY.keys()) }),

      async list(q: Record<string, any>) {
        const { limit, skip } = parsePage(q);
        const all = await db.find("AutomationRule", {});
        let res = all;
        if (q.isActive !== undefined) res = res.filter((r: any) => r.isActive === (q.isActive === "true"));
        return { results: sortResults(res, "-createdAt").slice(skip, skip + limit), total: res.length };
      },

      async get(objectId: string) {
        const r = await db.read("AutomationRule", objectId);
        if (!r) throw ZenithErrors.notFound("AutomationRule", objectId);
        return r;
      },

      async create(data: Record<string, any>, ctx: any) {
        if (!data.name || !data.trigger?.event || !data.actions?.length)
          throw ZenithErrors.validationFailed("name, trigger.event y actions[] son obligatorios.");
        return db.create("AutomationRule", {
          ...data, isActive: data.isActive ?? true,
          runCount: 0, errorCount: 0,
          createdBy: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(), updatedAt: now(),
        });
      },

      async update(objectId: string, data: Record<string, any>) {
        if (!await db.read("AutomationRule", objectId)) throw ZenithErrors.notFound("AutomationRule", objectId);
        return db.update("AutomationRule", { objectId }, { ...data, updatedAt: now() });
      },

      async toggle(objectId: string) {
        const rule = await db.read("AutomationRule", objectId);
        if (!rule) throw ZenithErrors.notFound("AutomationRule", objectId);
        return db.update("AutomationRule", { objectId }, { isActive: !rule.isActive, updatedAt: now() });
      },

      async delete(objectId: string) {
        if (!await db.read("AutomationRule", objectId)) throw ZenithErrors.notFound("AutomationRule", objectId);
        await db.delete("AutomationRule", { objectId });
        return { success: true };
      },

      async testRule(objectId: string, sampleData: Record<string, unknown>) {
        const rule = await api.get(objectId);
        const log  = await executeRule(rule as AutomationRule, sampleData, "__test__");
        return { log, message: `Rule tested: ${log.status}` };
      },

      async logs(ruleId: string, q: Record<string, any>) {
        const { limit, skip } = parsePage(q);
        const all = await db.find("AutomationLog", { ruleId });
        return { results: sortResults(all, "-createdAt").slice(skip, skip + limit), total: all.length };
      },
    };

    const automation_routes = [
      { method: "GET"    as const, path: "/zen/automation/rules",                      _openapi: { summary: "Listar reglas de automatización",        tags: ["Automation"] }, handler: async (r: Request, _c: any) => { try { return jsonRes(await api.list(queryParams(new URL(r.url)))); } catch(e) { return errRes(e); } } },
      { method: "GET"    as const, path: "/zen/automation/rules/:objectId",            _openapi: { summary: "Obtener regla",                          tags: ["Automation"] }, handler: async (r: Request, _c: any) => { try { const p = pathParams("/zen/automation/rules/:objectId", r.url)!; return jsonRes(await api.get(p.objectId)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/automation/rules",                      _openapi: { summary: "Crear regla IF-THEN",                    tags: ["Automation"] }, handler: async (r: Request, c: any) => { try { return jsonRes(await api.create(await r.json(), c), 201); } catch(e) { return errRes(e); } } },
      { method: "PUT"    as const, path: "/zen/automation/rules/:objectId",            _openapi: { summary: "Actualizar regla",                       tags: ["Automation"] }, handler: async (r: Request, _c: any) => { try { const p = pathParams("/zen/automation/rules/:objectId", r.url)!; return jsonRes(await api.update(p.objectId, await r.json())); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/automation/rules/:objectId/toggle",    _openapi: { summary: "Activar / desactivar regla",             tags: ["Automation"] }, handler: async (r: Request, _c: any) => { try { const p = pathParams("/zen/automation/rules/:objectId/toggle", r.url)!; return jsonRes(await api.toggle(p.objectId)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/automation/rules/:objectId/test",      _openapi: { summary: "Probar regla con datos de muestra",      tags: ["Automation"] }, handler: async (r: Request, _c: any) => { try { const p = pathParams("/zen/automation/rules/:objectId/test", r.url)!; return jsonRes(await api.testRule(p.objectId, await r.json())); } catch(e) { return errRes(e); } } },
      { method: "GET"    as const, path: "/zen/automation/rules/:objectId/logs",      _openapi: { summary: "Historial de ejecuciones de la regla",   tags: ["Automation"] }, handler: async (r: Request, _c: any) => { try { const p = pathParams("/zen/automation/rules/:objectId/logs", r.url)!; return jsonRes(await api.logs(p.objectId, queryParams(new URL(r.url)))); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/automation/rules/:objectId",            _openapi: { summary: "Eliminar regla",                         tags: ["Automation"] }, handler: async (r: Request, _c: any) => { try { const p = pathParams("/zen/automation/rules/:objectId", r.url)!; await api.delete(p.objectId); return NO_CONTENT; } catch(e) { return errRes(e); } } },
      { method: "GET"    as const, path: "/zen/automation/actions",                    _openapi: { summary: "Listar acciones disponibles",            tags: ["Automation"] }, handler: async (_r: Request, _c: any) => jsonRes(api.listActions()) },
    ];

    return { automation_routes, automation: api };
  },
});
