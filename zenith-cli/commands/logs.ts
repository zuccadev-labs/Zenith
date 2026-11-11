/**
 * zen logs — Streaming de logs del servidor en tiempo real.
 *
 * Uso:
 *   zen logs                    → últimos 100 logs
 *   zen logs --follow           → stream en tiempo real (SSE)
 *   zen logs --level error      → filtrar por nivel
 *   zen logs --service crm      → filtrar por servicio
 *   zen logs --tail 50          → últimas N líneas
 */
import { parseArgs } from "@std/cli/parse-args";
import { loadZenConfig } from "./_utils.ts";

const LEVEL_COLORS: Record<string, string> = {
  debug: "\x1b[37m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[35m",
};
const RESET = "\x1b[0m";

function formatLog(entry: any): string {
  const ts = new Date(entry.timestamp ?? entry.createdAt ?? Date.now()).toISOString();
  const level = (entry.level ?? "info").toLowerCase();
  const color = LEVEL_COLORS[level] ?? "";
  const service = entry.service ? `[${entry.service}] ` : "";
  const msg = entry.message ?? entry.msg ?? JSON.stringify(entry);
  return `${color}${ts} ${level.toUpperCase().padEnd(5)} ${service}${msg}${RESET}`;
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    string: ["level", "service", "tail"],
    boolean: ["follow", "json"],
  });
  // @std/cli has no number options: --tail is read as text and checked here.
  const tail = parsed.tail === undefined ? 100 : Number(parsed.tail);
  if (!Number.isInteger(tail) || tail < 1 || tail > 10_000) {
    throw new Error("--tail: un entero de 1 a 10000.");
  }

  const cfg = await loadZenConfig();
  const q = new URLSearchParams();
  if (parsed.level) q.set("level", parsed.level);
  if (parsed.service) q.set("service", parsed.service);
  q.set("limit", String(tail));

  if (parsed.follow) {
    // ── Modo streaming SSE ─────────────────────────────────────────────────
    console.log("📡 Conectando al stream de logs (Ctrl+C para salir)...\n");
    const ctl = new AbortController();
    Deno.addSignalListener("SIGINT", () => {
      ctl.abort();
      Deno.exit(0);
    });

    try {
      const res = await fetch(`${cfg.serverURL}/zen/logs/stream?${q}`, {
        headers: {
          "accept": "text/event-stream",
          "x-parse-application-id": cfg.appId,
          "x-parse-master-key": cfg.masterKey,
        },
        signal: ctl.signal,
      });

      if (!res.body) {
        console.error("❌ El servidor no soporta log streaming.");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const entry = JSON.parse(line.slice(6));
            console.log(parsed.json ? JSON.stringify(entry) : formatLog(entry));
          } catch {
            console.log(line.slice(6));
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") console.error("❌ Error:", e.message);
    }
    return;
  }

  // ── Modo histórico (últimas N líneas) ─────────────────────────────────────

  const res = await fetch(`${cfg.serverURL}/zen/logs?${q}`, {
    headers: {
      "x-parse-application-id": cfg.appId,
      "x-parse-master-key": cfg.masterKey,
    },
  });

  if (!res.ok) {
    // Si el endpoint de logs no existe aún, mostrar instrucción para ver logs del proceso
    console.log("ℹ️  Endpoint /zen/logs no disponible en este servidor.");
    console.log("   Para ver logs en desarrollo: zen dev (muestra stdout del proceso)");
    console.log("   Para logs de Kubernetes: kubectl logs -l app=zenith -n zenith --follow");
    return;
  }

  const data = await res.json();
  const logs = data.results ?? data.logs ?? [];

  if (!logs.length) {
    console.log("(sin logs)");
    return;
  }

  for (const entry of logs) {
    console.log(parsed.json ? JSON.stringify(entry) : formatLog(entry));
  }
}

/**
 * zen migrate — Ejecuta migraciones de esquema de base de datos.
 *
 * Uso:
 *   zen migrate run          → ejecuta migraciones pendientes
 *   zen migrate status       → muestra estado de migraciones
 *   zen migrate rollback     → revierte la última migración
 *   zen migrate create <name> → crea un nuevo archivo de migración
 */
export async function runMigrate(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const sub = String(parsed._[0] ?? "run");
  const migName = String(parsed._[1] ?? "");
  const cfg = await loadZenConfig();

  switch (sub) {
    case "run": {
      console.log("🔄 Ejecutando migraciones pendientes...");
      const res = await fetch(`${cfg.serverURL}/zen/migrations/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-parse-application-id": cfg.appId,
          "x-parse-master-key": cfg.masterKey,
        },
      });
      if (!res.ok) {
        const text = await res.text();
        console.log(
          "ℹ️  Migraciones no disponibles en este servidor.\n   Estado HTTP:",
          res.status,
          text.slice(0, 200),
        );
        return;
      }
      const data = await res.json();
      console.log(`✅ ${data.applied ?? 0} migración(es) aplicada(s).`);
      if (data.migrations?.length) {
        for (const m of data.migrations) console.log(`   • ${m.name} — ${m.status}`);
      }
      break;
    }
    case "status": {
      const res = await fetch(`${cfg.serverURL}/zen/migrations/status`, {
        headers: {
          "x-parse-application-id": cfg.appId,
          "x-parse-master-key": cfg.masterKey,
        },
      });
      if (!res.ok) {
        console.log("ℹ️  Endpoint de migraciones no disponible.");
        return;
      }
      const data = await res.json();
      console.log(`\n📊 Estado de migraciones (${data.total ?? 0} total):`);
      for (const m of data.migrations ?? []) {
        const icon = m.status === "applied" ? "✅" : "⏳";
        console.log(
          `  ${icon} [${m.version}] ${m.name} — ${m.status} ${
            m.appliedAt ? "@ " + m.appliedAt : ""
          }`,
        );
      }
      break;
    }
    case "rollback": {
      console.log("⚠️  Revirtiendo última migración...");
      const res = await fetch(`${cfg.serverURL}/zen/migrations/rollback`, {
        method: "POST",
        headers: {
          "x-parse-application-id": cfg.appId,
          "x-parse-master-key": cfg.masterKey,
        },
      });
      if (res.ok) {
        const data = await res.json();
        console.log(`✅ Revertida: ${data.rolled_back?.name ?? "última migración"}`);
      } else {
        console.error("❌ Rollback fallido. Verifica el estado del servidor.");
      }
      break;
    }
    case "create": {
      if (!migName) {
        console.error("❌ Proporciona un nombre para la migración");
        Deno.exit(1);
      }
      const ts = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
      const filename = `${ts}_${migName.toLowerCase().replace(/\s+/g, "_")}.ts`;
      const content = `/**
 * Migration: ${migName}
 * Created: ${new Date().toISOString()}
 */
export async function up(db: any): Promise<void> {
  // Aplica los cambios aquí
  // await db.create("NuevaClase", { campo: "valor" });
}

export async function down(db: any): Promise<void> {
  // Revierte los cambios aquí
}
`;
      await Deno.mkdir("migrations", { recursive: true });
      await Deno.writeTextFile(`migrations/${filename}`, content);
      console.log(`✅ Migración creada: migrations/${filename}`);
      break;
    }
    default:
      console.log(`
zen migrate — Gestión de migraciones de base de datos

Uso:
  zen migrate run            → ejecuta migraciones pendientes
  zen migrate status         → muestra estado de todas las migraciones
  zen migrate rollback       → revierte la última migración aplicada
  zen migrate create <name>  → crea un nuevo archivo de migración
      `);
  }
}

/**
 * zen test — Ejecuta los tests E2E del proyecto.
 *
 * Uso:
 *   zen test              → todos los tests
 *   zen test phase1       → solo la suite phase1
 *   zen test --watch      → modo watch
 *   zen test --coverage   → con reporte de cobertura
 */
export async function runTest(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ["watch", "coverage", "json"],
    string: ["filter"],
  });
  const suite = String(parsed._[0] ?? "");
  const pattern = suite ? `tests/e2e/${suite}.test.ts` : "tests/e2e/";

  const denoArgs = [
    "test",
    "-A",
    ...(parsed.watch ? ["--watch"] : []),
    ...(parsed.coverage ? ["--coverage=.zenith_coverage"] : []),
    "--no-check",
    pattern,
  ];

  console.log(`\n🧪 Ejecutando: deno test ${denoArgs.slice(1).join(" ")}\n`);

  const proc = new Deno.Command(Deno.execPath(), {
    args: denoArgs,
    cwd: Deno.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });

  const result = await proc.output();

  if (parsed.coverage) {
    console.log("\n📊 Generando reporte de cobertura...");
    await new Deno.Command(Deno.execPath(), {
      args: ["coverage", ".zenith_coverage", "--lcov", "--output=.zenith_coverage/lcov.info"],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    console.log("   Reporte: .zenith_coverage/lcov.info");
  }

  Deno.exit(result.code);
}
