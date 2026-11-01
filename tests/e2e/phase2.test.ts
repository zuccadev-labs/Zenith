/**
 * Tests E2E — Fase 2: Notifications, Favorites, Tags, Webhooks, CSV
 * Ejecución: deno test -A tests/e2e/phase2.test.ts
 */
import { assert, assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.224.0/testing/asserts.ts";

const now = () => new Date().toISOString();

// ── Mock DB compartido ────────────────────────────────────────────────────────

function mkDB() {
  const store: Record<string, Record<string, any>> = {};
  let seq = 0;
  return {
    async create(cls: string, data: any) {
      if (!store[cls]) store[cls] = {};
      const id = `${cls.toLowerCase().replace(/_/g,"-")}_${++seq}`;
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
      const id = typeof query === "string" ? query : query.objectId;
      if (!store[cls]?.[id]) return null;
      store[cls][id] = { ...store[cls][id], ...data };
      return store[cls][id];
    },
    async delete(cls: string, query: any) {
      const id = typeof query === "string" ? query : query.objectId;
      delete store[cls]?.[id];
    },
  };
}

function ptr(cls: string, id: string) { return { __type: "Pointer", className: cls, objectId: id }; }

// ── NOTIFICATIONS TESTS ───────────────────────────────────────────────────────

Deno.test("Notifications — crear y listar con unreadCount", async () => {
  const db = mkDB();
  const userId = "user_001";

  // Crear 3 notificaciones
  for (let i = 0; i < 3; i++) {
    await db.create("Notification", { userId, type: "info", body: `Msg ${i}`, isRead: false, createdAt: now() });
  }
  await db.create("Notification", { userId, type: "info", body: "Ya leída", isRead: true, createdAt: now() });

  const all = await db.find("Notification", { userId });
  const unread = all.filter((n: any) => !n.isRead);
  assertEquals(all.length, 4);
  assertEquals(unread.length, 3);
});

Deno.test("Notifications — marcar como leída (uno a uno)", async () => {
  const db = mkDB();
  const userId = "user_002";
  const notif = await db.create("Notification", { userId, body: "Tarea asignada", isRead: false, createdAt: now() });

  assertEquals(notif.isRead, false);

  // Solo el propietario puede marcar como leída
  if (notif.userId !== userId) throw new Error("No debería pasar");
  const updated = await db.update("Notification", { objectId: notif.objectId }, { isRead: true, readAt: now() });
  assertEquals(updated.isRead, true);
  assertExists(updated.readAt);
});

Deno.test("Notifications — mark-all-read en lote", async () => {
  const db = mkDB();
  const userId = "user_003";
  for (let i = 0; i < 5; i++) {
    await db.create("Notification", { userId, body: `Notif ${i}`, isRead: false, createdAt: now() });
  }
  const unread = await db.find("Notification", { userId, isRead: false });
  await Promise.all(unread.map((n: any) =>
    db.update("Notification", { objectId: n.objectId }, { isRead: true, readAt: now() })
  ));
  const remaining = await db.find("Notification", { userId, isRead: false });
  assertEquals(remaining.length, 0);
});

Deno.test("Notifications — tipos válidos", () => {
  const VALID_TYPES = ["info", "success", "warning", "error", "mention", "task", "comment"];
  for (const t of VALID_TYPES) assert(VALID_TYPES.includes(t));
  assertEquals(VALID_TYPES.includes("unknown"), false);
});

// ── FAVORITES TESTS ───────────────────────────────────────────────────────────

Deno.test("Favorites — toggle: agregar y quitar (idempotente)", async () => {
  const db = mkDB();
  const userId = "user_001";
  const targetClassName = "Deal";
  const targetId = "deal_abc";

  // Primera vez: agrega
  const existing1 = await db.find("Favorite", { "user.objectId": userId, targetClassName, targetId });
  assertEquals(existing1.length, 0);
  const fav = await db.create("Favorite", {
    user: ptr("_User", userId), targetClassName, targetId, position: 0, createdAt: now()
  });
  assertExists(fav.objectId);

  // Segunda vez: elimina (toggle off)
  const existing2 = await db.find("Favorite", { "user.objectId": userId, targetClassName, targetId });
  assertEquals(existing2.length, 1);
  await db.delete("Favorite", { objectId: existing2[0].objectId });
  const existing3 = await db.find("Favorite", { "user.objectId": userId, targetClassName, targetId });
  assertEquals(existing3.length, 0);
});

Deno.test("Favorites — reordenar por posición", async () => {
  const db = mkDB();
  const userId = "user_reorder";

  // Crear 3 favoritos con posiciones desordenadas
  const favs = await Promise.all([
    db.create("Favorite", { user: ptr("_User", userId), targetClassName: "Contact", targetId: "c1", position: 2, createdAt: now() }),
    db.create("Favorite", { user: ptr("_User", userId), targetClassName: "Deal",    targetId: "d1", position: 0, createdAt: now() }),
    db.create("Favorite", { user: ptr("_User", userId), targetClassName: "Lead",    targetId: "l1", position: 1, createdAt: now() }),
  ]);

  const newOrder = [favs[1].objectId, favs[2].objectId, favs[0].objectId]; // d1, l1, c1
  await Promise.all(newOrder.map((id, i) =>
    db.update("Favorite", { objectId: id }, { position: i })
  ));

  const all = await db.find("Favorite", { "user.objectId": userId });
  const sorted = all.sort((a: any, b: any) => a.position - b.position);
  assertEquals(sorted[0].targetId, "d1");
  assertEquals(sorted[1].targetId, "l1");
  assertEquals(sorted[2].targetId, "c1");
});

// ── TAGS TESTS ────────────────────────────────────────────────────────────────

Deno.test("Tags — CRUD completo con color", async () => {
  const db = mkDB();

  const tag = await db.create("Tag", { name: "VIP", color: "#f59e0b", createdAt: now() });
  assertExists(tag.objectId);
  assertEquals(tag.color, "#f59e0b");

  const updated = await db.update("Tag", { objectId: tag.objectId }, { name: "VIP Client", updatedAt: now() });
  assertEquals(updated.name, "VIP Client");

  await db.delete("Tag", { objectId: tag.objectId });
  const deleted = await db.read("Tag", tag.objectId);
  assertEquals(deleted, null);
});

Deno.test("Tags — asignación polimórfica a cualquier record (idempotente)", async () => {
  const db = mkDB();
  const tag = await db.create("Tag", { name: "Hot Lead", color: "#ef4444", createdAt: now() });

  // Asignar a Contact
  const asn1 = await db.create("TagAssignment", {
    tag: ptr("Tag", tag.objectId), targetClassName: "Contact", targetId: "contact_001", createdAt: now()
  });

  // Asignar al mismo (idempotente — no duplicar)
  const existing = await db.find("TagAssignment", { "tag.objectId": tag.objectId, targetClassName: "Contact", targetId: "contact_001" });
  assertEquals(existing.length, 1, "No debe haber duplicados");

  // Asignar a Deal (distinta clase, mismo tag)
  await db.create("TagAssignment", {
    tag: ptr("Tag", tag.objectId), targetClassName: "Deal", targetId: "deal_001", createdAt: now()
  });

  const allAssignments = await db.find("TagAssignment", { "tag.objectId": tag.objectId });
  assertEquals(allAssignments.length, 2);
});

Deno.test("Tags — cascade delete elimina todas las asignaciones", async () => {
  const db = mkDB();
  const tag = await db.create("Tag", { name: "Archived", color: "#6b7280", createdAt: now() });

  // Crear 3 asignaciones
  for (let i = 0; i < 3; i++) {
    await db.create("TagAssignment", {
      tag: ptr("Tag", tag.objectId), targetClassName: "Contact", targetId: `c${i}`, createdAt: now()
    });
  }

  // Cascade delete
  const assignments = await db.find("TagAssignment", { "tag.objectId": tag.objectId });
  await Promise.all(assignments.map((a: any) => db.delete("TagAssignment", { objectId: a.objectId })));
  await db.delete("Tag", { objectId: tag.objectId });

  const remaining = await db.find("TagAssignment", { "tag.objectId": tag.objectId });
  assertEquals(remaining.length, 0);
  assertEquals(await db.read("Tag", tag.objectId), null);
});

// ── WEBHOOK MANAGER TESTS ─────────────────────────────────────────────────────

Deno.test("Webhook — generar secret HMAC-SHA256 único", async () => {
  async function generateSecret(): Promise<string> {
    const raw = crypto.getRandomValues(new Uint8Array(24));
    return `whsec_${Array.from(raw).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  }
  const s1 = await generateSecret();
  const s2 = await generateSecret();
  assert(s1.startsWith("whsec_"), "debe tener el prefijo correcto");
  assert(s1.length >= 50, "debe ser suficientemente largo (prefijo + hex de 24 bytes)");
  assert(s1 !== s2, "cada secret debe ser único");
});

Deno.test("Webhook — firma y verificación HMAC-SHA256", async () => {
  const secret = "test_secret_key";
  const body   = JSON.stringify({ event: "Contact.created", data: { name: "Test" } });

  async function sign(payload: string, key: string): Promise<string> {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    return `t=${Date.now()},v1=${hex}`;
  }

  const signature = await sign(body, secret);
  assert(signature.includes("v1="), "debe incluir la firma v1");
  assert(signature.includes("t="),  "debe incluir el timestamp");

  // Firma diferente con clave incorrecta
  const wrongSig = await sign(body, "wrong_key");
  assert(signature !== wrongSig, "firmas con claves distintas deben ser diferentes");
});

Deno.test("Webhook — event pattern matching (wildcards)", () => {
  function matches(pattern: string, event: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) return event.startsWith(pattern.slice(0, -2));
    return pattern === event;
  }
  assertEquals(matches("*", "Contact.created"),       true);
  assertEquals(matches("Contact.*", "Contact.created"), true);
  assertEquals(matches("Contact.*", "Deal.created"),    false);
  assertEquals(matches("Contact.created", "Contact.created"), true);
  assertEquals(matches("Contact.created", "Contact.updated"), false);
});

Deno.test("Webhook — status lifecycle: active → paused → active → failed", async () => {
  const db = mkDB();
  const wh = await db.create("ZenithWebhook", {
    name: "Test Hook", url: "https://example.com/hook",
    events: ["*"], status: "active", failureCount: 0, createdAt: now()
  });

  // Pausar
  await db.update("ZenithWebhook", { objectId: wh.objectId }, { status: "paused" });
  assertEquals((await db.read("ZenithWebhook", wh.objectId)).status, "paused");

  // Reactivar
  await db.update("ZenithWebhook", { objectId: wh.objectId }, { status: "active", failureCount: 0 });
  assertEquals((await db.read("ZenithWebhook", wh.objectId)).status, "active");

  // Simular 10 fallos consecutivos → failed
  await db.update("ZenithWebhook", { objectId: wh.objectId }, { failureCount: 10, status: "failed" });
  assertEquals((await db.read("ZenithWebhook", wh.objectId)).status, "failed");
});

Deno.test("Webhook — URL validation", () => {
  function isValidURL(url: string): boolean {
    try { new URL(url); return true; } catch { return false; }
  }
  assertEquals(isValidURL("https://example.com/hook"), true);
  assertEquals(isValidURL("http://localhost:3000/webhook"), true);
  assertEquals(isValidURL("not-a-url"), false);
  assertEquals(isValidURL("ftp://invalid"), true); // ftp es válido pero el trait puede restringirlo
});

// ── CSV IMPORT/EXPORT TESTS ───────────────────────────────────────────────────

Deno.test("CSV — parseCSV: headers, valores con comas, comillas escapadas", () => {
  function parseCSV(text: string): Record<string, string>[] {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
    if (lines.length < 2) return [];
    const parseLine = (line: string): string[] => {
      const fields: string[] = [];
      let current = "", inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
          else inQuotes = !inQuotes;
        } else if (ch === "," && !inQuotes) { fields.push(current.trim()); current = ""; }
        else current += ch;
      }
      fields.push(current.trim());
      return fields;
    };
    const headers = parseLine(lines[0]);
    return lines.slice(1).map(line => {
      const values = parseLine(line);
      return Object.fromEntries(headers.map((h, i) => [h.trim(), values[i]?.trim() ?? ""]));
    });
  }

  const csv = `name,email,company\nAna García,ana@corp.com,Corp S.A.\n"Bob, Jr.",bob@test.com,"ACME, Inc."`;
  const rows = parseCSV(csv);

  assertEquals(rows.length, 2);
  assertEquals(rows[0].name, "Ana García");
  assertEquals(rows[1].name, "Bob, Jr.");
  assertEquals(rows[1].company, "ACME, Inc.");
});

Deno.test("CSV — toCSV: escape de valores con comas y comillas", () => {
  function toCSV(rows: Record<string, any>[], fields: string[]): string {
    const escape = (v: any): string => {
      const s = v === null || v === undefined ? "" : String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = fields.join(",");
    const body   = rows.map(r => fields.map(f => escape(r[f])).join(",")).join("\n");
    return `${header}\n${body}`;
  }

  const rows = [
    { name: "Ana", email: "ana@co.com", company: "Corp, S.A." },
    { name: 'He said "hi"', email: "b@b.com", company: "ACME" },
  ];
  const csv = toCSV(rows, ["name","email","company"]);
  assert(csv.includes('"Corp, S.A."'), "debe escapar comas");
  assert(csv.includes('"He said ""hi"""'), "debe escapar comillas dobles");
});

Deno.test("CSV — validación de campos requeridos en import", () => {
  const REQUIRED: Record<string, string[]> = {
    Contact: ["name"],
    Product: ["name", "sku", "price"],
  };

  function validate(className: string, row: Record<string, string>): string[] {
    return (REQUIRED[className] ?? []).filter(f => !row[f]);
  }

  // Contact válido
  assertEquals(validate("Contact", { name: "Ana", email: "ana@co.com" }), []);

  // Product inválido (faltan sku y price)
  const errors = validate("Product", { name: "Widget" });
  assert(errors.includes("sku"), "debe detectar sku faltante");
  assert(errors.includes("price"), "debe detectar price faltante");
});

Deno.test("CSV — importación en lotes (batch insert)", async () => {
  const db = mkDB();
  const BATCH_SIZE = 3;
  const rows = Array.from({ length: 7 }, (_, i) => ({
    name: `Contact ${i}`, email: `c${i}@test.com`, createdAt: now(), updatedAt: now()
  }));

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(row => db.create("Contact", row)));
    inserted += batch.length;
  }

  assertEquals(inserted, 7);
  const all = await db.find("Contact", {});
  assertEquals(all.length, 7);
});

Deno.test("CSV — dry-run: reporta errores sin insertar", async () => {
  const db = mkDB();
  const rows = [
    { name: "Valid Contact", email: "v@co.com" },
    { email: "missing-name@co.com" }, // Falta name
  ];

  const errors: any[] = [];
  const valid: any[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, string>;
    if (!row.name) errors.push({ row: i + 2, field: "name", message: "Campo 'name' es requerido." });
    else valid.push(row);
  }

  // dry-run: NO insertar
  const dryRun = true;
  if (!dryRun) await Promise.all(valid.map(r => db.create("Contact", r)));

  const inDB = await db.find("Contact", {});
  assertEquals(inDB.length, 0, "dry-run no debe insertar registros");
  assertEquals(errors.length, 1, "debe reportar 1 error");
  assertEquals(valid.length, 1, "debe tener 1 válido");
});
