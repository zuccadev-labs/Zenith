/**
 * ZenithAutomation — SDK client for /zen/automation
 * Rules CRUD + test + execution logs
 *
 * ZenithCSV — SDK client for /zen/csv
 * Import (File upload / raw text) + Export (download)
 */
import type { Zenith } from "../core/Zenith.ts";

// ── Automation Types ──────────────────────────────────────────────────────────

export type ConditionOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn" | "contains" | "is" | "isNot";
export type ActionType  = "create_task" | "update_record" | "send_notification" | "send_email" | "send_webhook" | "run_agent" | "add_tag" | "remove_tag" | "assign_record" | "create_note" | "wait" | "run_sequence" | "custom";

export interface AutoCondition      { field: string; op: ConditionOp; value: unknown; }
export interface AutoConditionGroup { and?: Array<AutoCondition | AutoConditionGroup>; or?: Array<AutoCondition | AutoConditionGroup>; }
export interface AutoAction         { type: ActionType; params: Record<string, unknown>; }

export interface AutomationRule {
  objectId:     string;
  name:         string;
  description?: string;
  isActive:     boolean;
  trigger:      { event: string; className?: string; conditions?: AutoConditionGroup };
  actions:      AutoAction[];
  runCount:     number;
  errorCount:   number;
  lastRunAt?:   string;
  lastError?:   string;
  createdAt:    string;
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

export class ZenithAutomation {
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

  async listRules(opts?: { isActive?: boolean; limit?: number; skip?: number }): Promise<{ results: AutomationRule[]; total: number }> {
    const q = new URLSearchParams(Object.entries(opts ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return (await fetch(`${this.base}/zen/automation/rules?${q}`, { headers: this.h() })).json();
  }

  async getRule(objectId: string): Promise<AutomationRule> {
    return (await fetch(`${this.base}/zen/automation/rules/${objectId}`, { headers: this.h() })).json();
  }

  async createRule(data: { name: string; trigger: AutomationRule["trigger"]; actions: AutoAction[]; description?: string; isActive?: boolean }): Promise<AutomationRule> {
    return (await fetch(`${this.base}/zen/automation/rules`, {
      method: "POST", headers: this.h(), body: JSON.stringify(data),
    })).json();
  }

  async updateRule(objectId: string, data: Partial<AutomationRule>): Promise<AutomationRule> {
    return (await fetch(`${this.base}/zen/automation/rules/${objectId}`, {
      method: "PUT", headers: this.h(), body: JSON.stringify(data),
    })).json();
  }

  /** Activar / desactivar sin modificar la regla */
  async toggleRule(objectId: string): Promise<AutomationRule> {
    return (await fetch(`${this.base}/zen/automation/rules/${objectId}/toggle`, {
      method: "POST", headers: this.h(),
    })).json();
  }

  /** Ejecutar la regla con datos de muestra y ver qué haría */
  async testRule(objectId: string, sampleData: Record<string, unknown>): Promise<{ log: AutomationLog; message: string }> {
    return (await fetch(`${this.base}/zen/automation/rules/${objectId}/test`, {
      method: "POST", headers: this.h(), body: JSON.stringify(sampleData),
    })).json();
  }

  async getLogs(ruleId: string, opts?: { limit?: number; skip?: number }): Promise<{ results: AutomationLog[]; total: number }> {
    const q = new URLSearchParams(Object.entries(opts ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return (await fetch(`${this.base}/zen/automation/rules/${ruleId}/logs?${q}`, { headers: this.h() })).json();
  }

  async deleteRule(objectId: string): Promise<void> {
    await fetch(`${this.base}/zen/automation/rules/${objectId}`, { method: "DELETE", headers: this.h() });
  }

  async listActions(): Promise<{ actions: string[] }> {
    return (await fetch(`${this.base}/zen/automation/actions`, { headers: this.h() })).json();
  }
}

// ── CSV Types ─────────────────────────────────────────────────────────────────

export type CSVSupportedClass = "Contact" | "Lead" | "Deal" | "Account" | "Product" | "Employee" | "Invoice";

export interface CSVImportResult {
  dryRun?:    boolean;
  totalRows:  number;
  inserted:   number;
  skipped?:   number;
  valid?:     number;
  errors:     Array<{ row: number; field: string; message: string }>;
}

export class ZenithCSV {
  private readonly base: string;
  private readonly h: () => Record<string, string>;

  constructor(z: Zenith) {
    this.base = (z as any)._serverURL;
    this.h    = () => ({
      "x-parse-application-id": (z as any)._applicationId,
      "x-parse-session-token":  (z as any).User?.current()?.getSessionToken() ?? "",
    });
  }

  /** Esquema de clases y campos disponibles para Import/Export */
  async schema(): Promise<{ classes: Array<{ name: string; fields: string[]; required: string[] }> }> {
    return (await fetch(`${this.base}/zen/csv/schema`, { headers: this.h() })).json();
  }

  /**
   * Importar un CSV. Acepta File (browser) o string (Node/Deno).
   * @param dryRun Si es true, valida sin insertar — útil para previsualizar errores.
   */
  async import(
    className: CSVSupportedClass,
    csv: File | string,
    opts?: { dryRun?: boolean; batchSize?: number }
  ): Promise<CSVImportResult> {
    const q = new URLSearchParams();
    if (opts?.dryRun)    q.set("dryRun",    "true");
    if (opts?.batchSize) q.set("batchSize", String(opts.batchSize));

    let body: BodyInit;
    let headers = this.h();

    if (csv instanceof File) {
      const form = new FormData();
      form.append("file", csv);
      body    = form;
      // FormData sets its own content-type with boundary
      const { "content-type": _, ...rest } = headers as Record<string, string>;
      headers = rest;
    } else {
      body    = csv;
      headers = { ...headers, "content-type": "text/plain" };
    }

    return (await fetch(`${this.base}/zen/csv/import/${className}?${q}`, {
      method: "POST", headers, body,
    })).json();
  }

  /**
   * Exportar registros como CSV y descargar el blob.
   * En browser, dispara descarga automática. En Node/Deno retorna el texto.
   */
  async export(
    className: CSVSupportedClass,
    opts?: { filter?: object; fields?: string[]; filename?: string }
  ): Promise<string> {
    const q = new URLSearchParams();
    if (opts?.filter) q.set("filter", JSON.stringify(opts.filter));
    if (opts?.fields) q.set("fields", opts.fields.join(","));

    const res = await fetch(`${this.base}/zen/csv/export/${className}?${q}`, { headers: this.h() });
    const text = await res.text();

    // Browser: disparar descarga
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      const blob = new Blob([text], { type: "text/csv" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = opts?.filename ?? `${className.toLowerCase()}_export.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }

    return text;
  }
}
