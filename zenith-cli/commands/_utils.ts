/**
 * _utils.ts — Utilidades compartidas para todos los comandos CLI.
 *
 * Responsabilidades:
 *  - loadZenConfig(): lee zen.config.ts + .env del directorio actual
 *  - zenApiCall(): fetch autenticado con master key
 *  - printTable(): tabla formateada en consola
 *  - printJson(): salida JSON indentado
 *  - spinner: indicador de carga simple
 */
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

export interface ZenCLIConfig {
  serverURL:  string;
  appId:      string;
  masterKey:  string;
}

/** Carga la configuración desde variables de entorno o .env del directorio actual */
export async function loadZenConfig(): Promise<ZenCLIConfig> {
  // Intentar cargar .env
  const envPath = join(Deno.cwd(), ".env");
  try {
    const raw = await Deno.readTextFile(envPath);
    for (const line of raw.split("\n")) {
      const [k, ...v] = line.split("=");
      if (k?.trim() && !k.startsWith("#")) {
        Deno.env.set(k.trim(), v.join("=").trim());
      }
    }
  } catch { /* .env opcional */ }

  const port      = Deno.env.get("ZENITH_PORT")       ?? "3000";
  const serverURL = Deno.env.get("ZENITH_SERVER_URL")  ?? `http://localhost:${port}`;
  const appId     = Deno.env.get("ZENITH_APP_ID")      ?? "my_app";
  const masterKey = Deno.env.get("ZENITH_MASTER_KEY")  ?? "secret";

  return { serverURL, appId, masterKey };
}

/** Fetch autenticado con master key */
export async function zenApiCall(
  cfg:    ZenCLIConfig,
  method: string,
  path:   string,
  body?:  unknown,
): Promise<any> {
  const headers: Record<string, string> = {
    "content-type":           "application/json",
    "x-parse-application-id": cfg.appId,
    "x-parse-master-key":     cfg.masterKey,
  };

  const res = await fetch(`${cfg.serverURL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return {};

  const data = await res.json();
  if (!res.ok) {
    console.error(`❌ Error ${res.status}: ${data?.error ?? JSON.stringify(data)}`);
    Deno.exit(1);
  }
  return data;
}

/** Imprime un array de objetos como tabla en consola */
export function printTable(rows: any[], columns?: string[]): void {
  if (!rows?.length) { console.log("(sin resultados)"); return; }
  const cols = columns ?? Object.keys(rows[0]);
  // Calcular anchos
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? "").slice(0, 40).length)));
  const fmt = (v: unknown, w: number) => String(v ?? "").slice(0, 40).padEnd(w);
  const sep = widths.map(w => "─".repeat(w + 2)).join("┼");
  console.log("┌" + sep + "┐");
  console.log("│ " + cols.map((c, i) => fmt(c, widths[i])).join(" │ ") + " │");
  console.log("├" + sep + "┤");
  for (const row of rows) {
    console.log("│ " + cols.map((c, i) => fmt(row[c], widths[i])).join(" │ ") + " │");
  }
  console.log("└" + sep + "┘");
  console.log(`${rows.length} resultado(s)`);
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/** Spinner simple para operaciones asíncronas */
export function spinner(msg: string): { stop: (ok?: boolean) => void } {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  const timer = setInterval(() => {
    Deno.stdout.writeSync(new TextEncoder().encode(`\r${frames[i++ % frames.length]} ${msg}`));
  }, 80);
  return {
    stop(ok = true) {
      clearInterval(timer);
      Deno.stdout.writeSync(new TextEncoder().encode(`\r${ok ? "✅" : "❌"} ${msg}\n`));
    },
  };
}
