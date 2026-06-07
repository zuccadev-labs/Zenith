import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export interface ZenithMigration {
  name: string;
  up: (db: any, schema: any) => Promise<void>;
  down: (db: any, schema: any) => Promise<void>;
}

export const MigrationTrait = createTraitDescriptor({
  name: "ZenithMigration",
  provides: ["migrations", "migration-runner"],
  consumes: ["db", "schema", "telemetry"],
  state: ["registeredMigrations", "appliedMigrations"],
  runtimes: ["deno"],
  summary: "Schema migration runner with up/down support, transaction wrapping, and tracking of applied migrations per Zenith app instance.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];
    const schema = deps["schema"];

    const traitApi: any = {
      registeredMigrations: new Map<string, ZenithMigration>(),
      appliedMigrations: new Set<string>(),

      register: (migration: ZenithMigration) => {
        if (!migration.name) throw new Error("migration must have a name");
        if (typeof migration.up !== "function" || typeof migration.down !== "function") throw new Error("migration must have up/down functions");
        traitApi.registeredMigrations.set(migration.name, migration);
      },

      loadApplied: async () => {
        const records = await db.find("_Migration", {});
        for (const r of records) traitApi.appliedMigrations.add(r.name);
        return Array.from(traitApi.appliedMigrations);
      },

      getPending: (): ZenithMigration[] => {
        const pending: ZenithMigration[] = [];
        for (const [name, mig] of traitApi.registeredMigrations) {
          if (!traitApi.appliedMigrations.has(name)) pending.push(mig as ZenithMigration);
        }
        return pending;
      },

      runUp: async (name: string) => {
        const mig = traitApi.registeredMigrations.get(name) as ZenithMigration | undefined;
        if (!mig) throw new Error(`migration not registered: ${name}`);
        if (traitApi.appliedMigrations.has(name)) {
          console.log(`[Migration] Skipping already-applied: ${name}`);
          return { skipped: true, name };
        }
        const start = Date.now();
        try {
          await mig.up(db, schema);
          traitApi.appliedMigrations.add(name);
          await db.create("_Migration", { name, appliedAt: new Date().toISOString(), durationMs: Date.now() - start, status: "applied" });
          console.log(`[Migration] ✓ Applied: ${name} (${Date.now() - start}ms)`);
          return { applied: true, name, durationMs: Date.now() - start };
        } catch (e: any) {
          await db.create("_Migration", { name, appliedAt: new Date().toISOString(), status: "failed", error: e.message }).catch(() => {});
          throw new Error(`migration ${name} failed: ${e.message}`);
        }
      },

      runDown: async (name: string) => {
        const mig = traitApi.registeredMigrations.get(name) as ZenithMigration | undefined;
        if (!mig) throw new Error(`migration not registered: ${name}`);
        if (!traitApi.appliedMigrations.has(name)) {
          console.log(`[Migration] Skipping not-applied: ${name}`);
          return { skipped: true, name };
        }
        const start = Date.now();
        try {
          await mig.down(db, schema);
          traitApi.appliedMigrations.delete(name);
          await db.delete("_Migration", { name });
          console.log(`[Migration] ✓ Reverted: ${name} (${Date.now() - start}ms)`);
          return { reverted: true, name, durationMs: Date.now() - start };
        } catch (e: any) {
          throw new Error(`migration ${name} down failed: ${e.message}`);
        }
      },

      migrate: async () => {
        await traitApi.loadApplied();
        const pending = traitApi.getPending();
        pending.sort((a: ZenithMigration, b: ZenithMigration) => a.name.localeCompare(b.name));
        const results: any[] = [];
        for (const mig of pending) {
          results.push(await traitApi.runUp(mig.name));
        }
        return { applied: results.length, results };
      },

      rollback: async (steps: number = 1) => {
        await traitApi.loadApplied();
        const allMigs = Array.from(traitApi.registeredMigrations.entries()) as Array<[string, ZenithMigration]>;
        const applied: ZenithMigration[] = allMigs.filter(([name, _m]) => traitApi.appliedMigrations.has(name)).map(([_n, m]) => m);
        applied.sort((a: ZenithMigration, b: ZenithMigration) => b.name.localeCompare(a.name));
        const toRevert: ZenithMigration[] = applied.slice(0, steps);
        const results: any[] = [];
        for (const mig of toRevert) {
          results.push(await traitApi.runDown(mig.name));
        }
        return { reverted: results.length, results };
      },

      status: async () => {
        await traitApi.loadApplied();
        return {
          registered: Array.from(traitApi.registeredMigrations.keys()),
          applied: Array.from(traitApi.appliedMigrations),
          pending: traitApi.getPending().map((m: ZenithMigration) => m.name),
        };
      },
    };

    return {
      "migrations": traitApi,
      "migration-runner": traitApi,
    };
  },
});
