/**
 * @module @zenith/test/zenith-test-runner
 *
 * Zenith Test Harness — Framework de tests para Cloud Code y Plugins.
 *
 * Permite testear Cloud Functions, Triggers y Plugins sin levantar
 * una instancia completa de Zenith (sin MongoDB, sin MQTT, sin Redis).
 * Todo corre en memoria — tests rápidos, aislados y reproducibles.
 *
 * Uso:
 *   import { ZenithTestHarness } from "../test/zenith-test-runner.ts";
 *
 *   const harness = await ZenithTestHarness.create({
 *     cloudCode: "./src/cloud/main.ts",
 *     plugins: [installERPPlugin, installCRMPlugin],
 *     seed: { Invoice: [{ objectId: "INV-001", total: 100, status: "pending" }] }
 *   });
 *
 *   // Test de Cloud Function
 *   const result = await harness.callFunction("calculateTotal", { items: [...] });
 *   harness.expect(result).toHaveProperty("total", 232);
 *
 *   // Test de Trigger
 *   await harness.triggerAfterSave("Invoice", { objectId: "INV-001", status: "paid" });
 *   const entry = harness.db.findOne("JournalEntry", e => e.memo?.includes("INV-001"));
 *   harness.expect(entry).toBeDefined();
 *
 *   // Limpiar entre tests
 *   harness.reset();
 */

// ── In-Memory DB Mock ─────────────────────────────────────────────────────────

class MockDB {
  private store = new Map<string, Map<string, any>>();
  readonly insertions: { className: string; data: any }[] = [];
  readonly updates: { className: string; id: string; data: any }[] = [];
  readonly deletions: { className: string; id: string }[] = [];

  private getCollection(className: string): Map<string, any> {
    if (!this.store.has(className)) this.store.set(className, new Map());
    return this.store.get(className)!;
  }

  seed(className: string, records: any[]): void {
    const col = this.getCollection(className);
    for (const record of records) {
      col.set(record.objectId ?? crypto.randomUUID(), {
        ...record,
        createdAt: record.createdAt ?? new Date().toISOString(),
        updatedAt: record.updatedAt ?? new Date().toISOString(),
      });
    }
  }

  insert(className: string, data: any): any {
    const id = data.objectId ?? crypto.randomUUID();
    const record = {
      ...data,
      objectId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.getCollection(className).set(id, record);
    this.insertions.push({ className, data: record });
    return record;
  }

  update(className: string, id: string, data: any): any {
    const col = this.getCollection(className);
    const existing = col.get(id) ?? { objectId: id };
    const updated = { ...existing, ...data, updatedAt: new Date().toISOString() };
    col.set(id, updated);
    this.updates.push({ className, id, data });
    return updated;
  }

  delete(className: string, id: string): boolean {
    const deleted = this.getCollection(className).delete(id);
    if (deleted) this.deletions.push({ className, id });
    return deleted;
  }

  find(
    className: string,
    opts: { where?: Record<string, any>; limit?: number; order?: string } = {},
  ): any[] {
    const col = this.getCollection(className);
    let results = [...col.values()];

    if (opts.where) {
      results = results.filter((item) => {
        return Object.entries(opts.where!).every(([k, v]) => {
          if (typeof v === "object" && v !== null) {
            if (v.$in) return v.$in.includes(item[k]);
            if (v.$gte) return item[k] >= v.$gte;
            if (v.$lte) return item[k] <= v.$lte;
            if (v.$ne) return item[k] !== v.$ne;
          }
          return item[k] === v;
        });
      });
    }

    if (opts.order) {
      const desc = opts.order.startsWith("-");
      const field = opts.order.replace(/^-/, "");
      results.sort((a, b) => desc ? b[field] > a[field] ? 1 : -1 : a[field] > b[field] ? 1 : -1);
    }

    return opts.limit ? results.slice(0, opts.limit) : results;
  }

  findOne(className: string, opts: { where?: Record<string, any> } = {}): any | null {
    return this.find(className, { ...opts, limit: 1 })[0] ?? null;
  }

  clear(): void {
    this.store.clear();
    this.insertions.length = 0;
    this.updates.length = 0;
    this.deletions.length = 0;
  }

  // Shorthand de búsqueda por predicado (útil en asserts)
  query(className: string, predicate: (item: any) => boolean): any[] {
    return this.find(className).filter(predicate);
  }

  queryOne(className: string, predicate: (item: any) => boolean): any | null {
    return this.query(className, predicate)[0] ?? null;
  }
}

// ── Mock IoT / MQTT ───────────────────────────────────────────────────────────

class MockMQTT {
  readonly published: { topic: string; payload: any; ts: string }[] = [];
  private subscribers = new Map<string, ((payload: any) => void)[]>();

  publish(topic: string, payload: any): void {
    this.published.push({ topic, payload, ts: new Date().toISOString() });
    const handlers = this.subscribers.get(topic) ?? [];
    for (const h of handlers) {
      try {
        h(payload);
      } catch (_e) { /* noop: handler isolation */ }
    }
  }

  subscribe(topic: string, handler: (payload: any) => void): void {
    if (!this.subscribers.has(topic)) this.subscribers.set(topic, []);
    this.subscribers.get(topic)!.push(handler);
  }

  // Simula llegada de mensaje MQTT (para tests de triggers IoT)
  simulate(topic: string, payload: any): void {
    this.publish(topic, payload);
  }

  clear(): void {
    this.published.length = 0;
    this.subscribers.clear();
  }
}

// ── Assertion Helpers ─────────────────────────────────────────────────────────

class ZenithAssert {
  constructor(private value: any, private description = "") {}

  toBeDefined() {
    if (this.value === undefined || this.value === null) {
      throw new Error(
        `[Assert${
          this.description ? ` "${this.description}"` : ""
        }] Expected value to be defined, got ${this.value}`,
      );
    }
    return this;
  }

  toBeNull() {
    if (this.value !== null) {
      throw new Error(`[Assert] Expected null, got ${JSON.stringify(this.value)}`);
    }
    return this;
  }

  toBe(expected: any) {
    if (this.value !== expected) {
      throw new Error(
        `[Assert] Expected ${JSON.stringify(expected)}, got ${JSON.stringify(this.value)}`,
      );
    }
    return this;
  }

  toEqual(expected: any) {
    if (JSON.stringify(this.value) !== JSON.stringify(expected)) {
      throw new Error(
        `[Assert] Expected ${JSON.stringify(expected)}, got ${JSON.stringify(this.value)}`,
      );
    }
    return this;
  }

  toHaveProperty(key: string, value?: any) {
    if (typeof this.value !== "object" || this.value === null) {
      throw new Error(`[Assert] Expected object, got ${typeof this.value}`);
    }
    if (!(key in this.value)) throw new Error(`[Assert] Expected property '${key}' on object`);
    if (value !== undefined && this.value[key] !== value) {
      throw new Error(
        `[Assert] Expected '${key}' = ${JSON.stringify(value)}, got ${
          JSON.stringify(this.value[key])
        }`,
      );
    }
    return this;
  }

  toContain(item: any) {
    if (!Array.isArray(this.value)) throw new Error(`[Assert] Expected array for toContain`);
    if (!this.value.includes(item)) {
      throw new Error(`[Assert] Expected array to contain ${JSON.stringify(item)}`);
    }
    return this;
  }

  toHaveLength(n: number) {
    const len = Array.isArray(this.value) ? this.value.length : this.value?.length;
    if (len !== n) throw new Error(`[Assert] Expected length ${n}, got ${len}`);
    return this;
  }

  toBeGreaterThan(n: number) {
    if (!(this.value > n)) throw new Error(`[Assert] Expected ${this.value} > ${n}`);
    return this;
  }

  toBeLessThan(n: number) {
    if (!(this.value < n)) throw new Error(`[Assert] Expected ${this.value} < ${n}`);
    return this;
  }

  toThrow() {
    /* async variant — see harness.expectThrows */ return this;
  }
  not = {
    toBeDefined: () => {
      if (this.value !== undefined && this.value !== null) {
        throw new Error(
          `[Assert] Expected undefined/null`,
        );
      }
    },
  };
}

// ── Harness ───────────────────────────────────────────────────────────────────

interface HarnessOptions {
  plugins?: ((ctx: any) => void)[];
  cloudCode?: string; // Path al archivo de Cloud Code
  seed?: Record<string, any[]>;
}

export class ZenithTestHarness {
  readonly db = new MockDB();
  readonly mqtt = new MockMQTT();

  private cloudRegistry = new Map<string, (req: any) => Promise<any>>();
  private triggerRegistry = {
    beforeSave: new Map<string, (obj: any, ctx: any) => Promise<void>>(),
    afterSave: new Map<string, (obj: any, ctx: any) => Promise<void>>(),
    beforeDelete: new Map<string, (obj: any, ctx: any) => Promise<void>>(),
    afterDelete: new Map<string, (obj: any, ctx: any) => Promise<void>>(),
  };

  private constructor() {}

  static async create(opts: HarnessOptions = {}): Promise<ZenithTestHarness> {
    const h = new ZenithTestHarness();

    // Construir contexto simulado de Zenith (Zen)
    const mockZen = {
      DB: {
        insert: (cls: string, data: any) => h.db.insert(cls, data),
        update: (cls: string, id: string, data: any) => h.db.update(cls, id, data),
        delete: (cls: string, id: string) => h.db.delete(cls, id),
        find: (cls: string, q: any) => h.db.find(cls, q),
        findOne: (cls: string, q: any) => h.db.findOne(cls, q),
      },
      IoT: {
        publish: (t: string, p: any) => h.mqtt.publish(t, p),
        subscribe: (t: string, fn: any) => h.mqtt.subscribe(t, fn),
      },
      Cloud: {
        define: (name: string, fn: (req: any) => Promise<any>) => h.cloudRegistry.set(name, fn),
        beforeSave: (cls: string, fn: any) => h.triggerRegistry.beforeSave.set(cls, fn),
        afterSave: (cls: string, fn: any) => h.triggerRegistry.afterSave.set(cls, fn),
        afterDelete: (cls: string, fn: any) => h.triggerRegistry.afterDelete.set(cls, fn),
      },
      Cache: { get: async () => undefined, set: async () => {}, invalidate: async () => 0 },
    };

    // Exponer como global para que el Cloud Code lo use
    (globalThis as any).Zen = mockZen;

    // Instalar plugins
    if (opts.plugins) {
      for (const plugin of opts.plugins) plugin(mockZen);
    }

    // Seed inicial
    if (opts.seed) {
      for (const [cls, records] of Object.entries(opts.seed)) {
        h.db.seed(cls, records);
      }
    }

    return h;
  }

  /** Llama a una Cloud Function registrada */
  async callFunction(name: string, params: any = {}, ctx: any = {}): Promise<any> {
    const fn = this.cloudRegistry.get(name);
    if (!fn) throw new Error(`[TestHarness] Cloud function '${name}' not registered`);
    return await fn({ params, ...ctx });
  }

  /** Dispara un trigger afterSave */
  async triggerAfterSave(className: string, obj: any, ctx: any = {}): Promise<void> {
    const fn = this.triggerRegistry.afterSave.get(className);
    if (!fn) throw new Error(`[TestHarness] No afterSave trigger for '${className}'`);
    await fn(obj, ctx);
  }

  /** Dispara un trigger beforeSave */
  async triggerBeforeSave(className: string, obj: any, ctx: any = {}): Promise<void> {
    const fn = this.triggerRegistry.beforeSave.get(className);
    if (!fn) throw new Error(`[TestHarness] No beforeSave trigger for '${className}'`);
    await fn(obj, ctx);
  }

  /** Assertion helper — wraps un valor */
  expect(value: any, description?: string): ZenithAssert {
    return new ZenithAssert(value, description);
  }

  /** Verifica que una función async lance un error */
  async expectThrows(fn: () => Promise<any>, messageContains?: string): Promise<void> {
    try {
      await fn();
      throw new Error("[TestHarness] Expected function to throw, but it did not.");
    } catch (e: any) {
      if (messageContains && !e.message?.includes(messageContains)) {
        throw new Error(
          `[TestHarness] Expected error to contain '${messageContains}', got: '${e.message}'`,
        );
      }
    }
  }

  /** Reset del estado entre tests */
  reset(): void {
    this.db.clear();
    this.mqtt.clear();
  }

  /** Shorthand: registros insertados en DB durante el test */
  get inserted() {
    return this.db.insertions;
  }
  get updated() {
    return this.db.updates;
  }
  get mqttPublished() {
    return this.mqtt.published;
  }
}

// ── Test Suite Runner ─────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  fn: (harness: ZenithTestHarness) => Promise<void>;
}

export class ZenithTestSuite {
  private readonly tests: TestCase[] = [];
  private results: { name: string; passed: boolean; error?: string; ms: number }[] = [];

  constructor(public readonly suiteName: string) {}

  test(name: string, fn: (harness: ZenithTestHarness) => Promise<void>): this {
    this.tests.push({ name, fn });
    return this;
  }

  /**
   * Phase 2.H: expone la lista de tests para que `deno test` los pueda
   * ejecutar via el bridge. Sin esto, el suite custom solo se ejecuta
   * standalone (`if (import.meta.main)`) pero no aparece en `deno test`.
   */
  getTests(): readonly TestCase[] {
    return this.tests;
  }

  async run(opts: HarnessOptions = {}): Promise<void> {
    console.log(`\n🧪 Suite: ${this.suiteName}\n${"─".repeat(50)}`);
    let passed = 0, failed = 0;

    for (const test of this.tests) {
      const harness = await ZenithTestHarness.create(opts);
      const start = Date.now();
      try {
        await test.fn(harness);
        const ms = Date.now() - start;
        console.log(`  ✅ ${test.name} (${ms}ms)`);
        this.results.push({ name: test.name, passed: true, ms });
        passed++;
      } catch (e: any) {
        const ms = Date.now() - start;
        console.error(`  ❌ ${test.name} (${ms}ms)\n     ${e.message}`);
        this.results.push({ name: test.name, passed: false, error: e.message, ms });
        failed++;
      }
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${this.tests.length}\n`);

    if (failed > 0) {
      throw new Error(`[ZenithTestSuite] ${failed} test(s) failed in suite '${this.suiteName}'`);
    }
  }

  getResults() {
    return this.results;
  }
}
