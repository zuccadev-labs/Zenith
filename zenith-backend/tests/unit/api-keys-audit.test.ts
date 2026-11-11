/**
 * Tests para audit.ts — log de API keys en formato ECS.
 *
 * Cubre:
 *   - Cada tipo de evento produce una línea JSON válida
 *   - Nivel de log correcto (info / warn / error)
 *   - Privacidad: el plaintext de la key NUNCA aparece en el log
 *   - Campos requeridos según el tipo de evento
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { audit } from "../../src/security/api-keys/audit.ts";
import type { ApiKeyRecord } from "../../src/security/api-keys/types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: "aB3xY9zK",
    prefix: "sk",
    env: "live",
    appId: "app_test_001",
    name: "test-key",
    hash: "$argon2id$v=19$m=65536,t=3,p=4$...$...",
    scopes: ["data:read", "data:write"],
    rateLimit: { requestsPerMinute: 1000 },
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    createdBy: "test",
    metadata: {},
    ...overrides,
  } as ApiKeyRecord;
}

interface CapturedLog {
  level: "info" | "warn" | "error";
  method: "log" | "warn" | "error";
  line: string;
}

function captureLogs(): { logs: CapturedLog[]; restore: () => void } {
  const logs: CapturedLog[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (line: string) => logs.push({ level: "info", method: "log", line });
  console.warn = (line: string) => logs.push({ level: "warn", method: "warn", line });
  console.error = (line: string) => logs.push({ level: "error", method: "error", line });
  return {
    logs,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

function parseLastEntry(logs: CapturedLog[]): Record<string, unknown> {
  const last = logs[logs.length - 1];
  return JSON.parse(last.line);
}

// ─── Event: key.created ─────────────────────────────────────────────────────

Deno.test("audit.created - emits key.created event with info level", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.created(makeRecord(), "actor:admin");
    assertEquals(logs.length, 1);
    assertEquals(logs[0].level, "info");
    const entry = parseLastEntry(logs);
    assertEquals(entry["event.action"], "key.created");
    assertEquals(entry["event.outcome"], "success");
    assertEquals(entry["event.dataset"], "zenith.api_keys");
    assertEquals(entry["key.id"], "aB3xY9zK");
    assertEquals(entry["key.prefix"], "sk");
    assertEquals(entry["key.env"], "live");
    assertEquals(entry["key.app_id"], "app_test_001");
    assertEquals(entry["key.name"], "test-key");
    assertEquals(entry["actor.id"], "actor:admin");
    assertStringIncludes(entry["message"] as string, "test-key");
    assertStringIncludes(entry["message"] as string, "app_test_001");
  } finally {
    restore();
  }
});

Deno.test("audit.created - never logs plaintext secret", async () => {
  const { logs, restore } = captureLogs();
  try {
    const record = makeRecord({ hash: "PLAINTEXT_SECRET_SHOULD_NOT_APPEAR" });
    await audit.created(record, "actor:admin");
    const line = logs[0].line;
    assertEquals(
      line.includes("PLAINTEXT_SECRET_SHOULD_NOT_APPEAR"),
      false,
      "Audit log must not contain plaintext secret",
    );
  } finally {
    restore();
  }
});

// ─── Event: key.verified ────────────────────────────────────────────────────

Deno.test("audit.verified - emits key.verified event with client IP", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.verified(makeRecord(), "192.168.1.42");
    const entry = parseLastEntry(logs);
    assertEquals(entry["event.action"], "key.verified");
    assertEquals(entry["event.outcome"], "success");
    assertEquals(entry["event.category"], "authentication");
    assertEquals(entry["client.ip"], "192.168.1.42");
  } finally {
    restore();
  }
});

Deno.test("audit.verified - works without client IP", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.verified(makeRecord());
    const entry = parseLastEntry(logs);
    assertEquals(entry["event.action"], "key.verified");
    assertEquals(entry["client.ip"], undefined);
  } finally {
    restore();
  }
});

// ─── Event: key.rejected ────────────────────────────────────────────────────

Deno.test("audit.rejected - emits key.rejected with reason", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.rejected("wrong_secret", "aB3xY9zK", "10.0.0.1");
    const entry = parseLastEntry(logs);
    assertEquals(entry["event.action"], "key.rejected");
    assertEquals(entry["event.outcome"], "failure");
    assertEquals(logs[0].level, "warn");
    assertEquals(entry["key.id"], "aB3xY9zK");
    assertEquals(entry["client.ip"], "10.0.0.1");
    assertEquals(entry["reason"], "wrong_secret");
  } finally {
    restore();
  }
});

Deno.test("audit.rejected - scope_denied is recorded as scope_denied:scope", async () => {
  const { logs, restore } = captureLogs();
  try {
    // Cast required: source accepts a wider set than ApiKeyInvalidReason
    await audit.rejected("wrong_secret" as any, "aB3xY9zK", undefined, "users:write");
    const entry = parseLastEntry(logs);
    assertEquals(entry["reason"], "scope_denied:users:write");
  } finally {
    restore();
  }
});

Deno.test("audit.rejected - handles missing keyId", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.rejected("malformed", undefined);
    const entry = parseLastEntry(logs);
    assertEquals(entry["key.id"], undefined);
    assertEquals(entry["reason"], "malformed");
  } finally {
    restore();
  }
});

// ─── Event: key.revoked ─────────────────────────────────────────────────────

Deno.test("audit.revoked - emits key.revoked with actor and reason", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.revoked(makeRecord(), "actor:admin", "compromise");
    const entry = parseLastEntry(logs);
    assertEquals(entry["event.action"], "key.revoked");
    assertEquals(logs[0].level, "warn");
    assertEquals(entry["actor.id"], "actor:admin");
    assertEquals(entry["reason"], "compromise");
  } finally {
    restore();
  }
});

// ─── Event: key.rotated ─────────────────────────────────────────────────────

Deno.test("audit.rotated - records old → new mapping", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.rotated("OLDid12", "NEWid34", "actor:admin");
    const entry = parseLastEntry(logs);
    assertEquals(entry["event.action"], "key.rotated");
    assertEquals(entry["key.id"], "NEWid34");
    assertEquals(entry["key.rotated_from"], "OLDid12");
    assertStringIncludes(entry["message"] as string, "OLDid12");
    assertStringIncludes(entry["message"] as string, "NEWid34");
  } finally {
    restore();
  }
});

// ─── Event: key.rate_limited ────────────────────────────────────────────────

Deno.test("audit.rateLimited - emits key.rate_limited", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.rateLimited(makeRecord(), "10.0.0.1");
    const entry = parseLastEntry(logs);
    assertEquals(entry["event.action"], "key.rate_limited");
    assertEquals(entry["event.outcome"], "failure");
    assertEquals(logs[0].level, "warn");
    assertEquals(entry["client.ip"], "10.0.0.1");
    assertStringIncludes(entry["message"] as string, "1000");
  } finally {
    restore();
  }
});

// ─── Event: key.scope_denied ────────────────────────────────────────────────

Deno.test("audit.scopeDenied - records missing scope", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.scopeDenied(makeRecord(), "admin:write", "10.0.0.1");
    const entry = parseLastEntry(logs);
    assertEquals(entry["event.action"], "key.scope_denied");
    assertEquals(entry["reason"], "missing_scope:admin:write");
    assertEquals(entry["key.scopes"], ["data:read", "data:write"]);
  } finally {
    restore();
  }
});

// ─── Schema invariants ──────────────────────────────────────────────────────

Deno.test("audit - all entries have @timestamp and event.dataset", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.created(makeRecord(), "actor:admin");
    await audit.verified(makeRecord());
    await audit.rejected("wrong_secret", "id");
    await audit.revoked(makeRecord(), "actor", "r");
    await audit.rotated("a", "b", "actor");
    await audit.rateLimited(makeRecord());
    await audit.scopeDenied(makeRecord(), "x:y");

    for (const captured of logs) {
      const entry = JSON.parse(captured.line);
      assertExists(entry["@timestamp"]);
      assertEquals(entry["event.dataset"], "zenith.api_keys");
      assertExists(entry["event.action"]);
      assertExists(entry["event.outcome"]);
    }
  } finally {
    restore();
  }
});

Deno.test("audit - @timestamp is valid ISO 8601", async () => {
  const { logs, restore } = captureLogs();
  try {
    await audit.created(makeRecord(), "actor");
    const entry = parseLastEntry(logs);
    const ts = entry["@timestamp"] as string;
    const parsed = new Date(ts);
    assertEquals(Number.isNaN(parsed.getTime()), false);
    assertStringIncludes(ts, "T");
  } finally {
    restore();
  }
});
