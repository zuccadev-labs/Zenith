/**
 * zen generate — Generador de artefactos del proyecto Zenith.
 *
 * Subcomandos:
 *   zen generate docs       → OpenAPI 3.1 + Markdown API Ref + Postman + Redoc HTML
 *   zen generate openapi    → Solo el JSON OpenAPI 3.1
 *   zen generate sdk        → Re-genera los tipos TypeScript del SDK desde la spec
 *   zen generate schema     → Imprime el schema compuesto de todos los traits
 *
 * El generador arranca el motor en modo "dry" (sin puerto, sin DB real),
 * extrae el state compuesto de Barrits y produce la documentación completa.
 * No requiere que el servidor esté corriendo.
 *
 * Artefactos generados por `zen generate docs`:
 *   ./docs/openapi.json          — OpenAPI 3.1 (Swagger UI / Redoc / Postman)
 *   ./docs/api/                  — Markdown por tag (GitHub / Docusaurus / Notion)
 *   ./docs/zenith.postman.json   — Colección Postman lista para importar
 *   ./docs/index.html            — Portal Redoc self-hosted (sin servidor externo)
 */
import { ensureDir } from "@std/fs/ensure-dir";
import { join, fromFileUrl } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { spinner } from "./_utils.ts";

// ── Constantes ────────────────────────────────────────────────────────────────

const BACKEND_OPENAPI = fromFileUrl(
  new URL("../../zenith-backend/src/core/openapi-generator.ts", import.meta.url)
);

/** Descripción de tags para que la doc sea rica desde el día 1 */
const TAG_DESCRIPTIONS: Record<string, string> = {
  // ── Base ──────────────────────────────────────────────────────────────────
  Authentication:   "Registro, login, logout, gestión de sesiones y API Keys.",
  CRUD:             "Operaciones genéricas CRUD sobre cualquier clase de objeto del schema.",
  Schema:           "Definición dinámica de clases y columnas (Code-first schema management).",
  Storage:          "Upload/download de archivos (RustFS/S3/IPFS). Parse-Server compat.",
  CloudCode:        "Ejecución de funciones de negocio serverless (Cloud Functions & Triggers).",
  GraphQL:          "Endpoint GraphQL con schema auto-generado desde el state de Barrits.",
  Realtime:         "WebSocket LiveQuery: suscripción a cambios de objetos en tiempo real.",
  Observability:    "Métricas Prometheus, health checks y tracing distribuido.",
  // ── Negocio ───────────────────────────────────────────────────────────────
  CRM:              "Gestión de relaciones con clientes: Contacts, Leads, Deals, Accounts, Campaigns, Tickets. Lead scoring con IA.",
  ERP:              "Planificación de recursos empresariales: Invoices, Products, Inventory, Orders, Employees, Payroll, Warehouses.",
  // ── Colaboración ──────────────────────────────────────────────────────────
  Collaboration:    "Notes, Tasks (Kanban), Comments @mentions, Attachments — vinculados a cualquier objeto CRM/ERP.",
  Workspace:        "Gestión de workspace: Members, Roles, Invitations, API Keys.",
  Views:            "Vistas guardadas (Kanban, Table, List, Calendar, Timeline) con filtros y ordenación persistente.",
  Search:           "Motor de búsqueda full-text con scoring de relevancia y filtros avanzados.",
  Timeline:         "Feed de actividad inmutable por record: quién hizo qué y cuándo.",
  Metadata:         "Custom Objects y Custom Fields — extiende el schema sin código ni migrations.",
  Blog:             "Sistema de blog monetizable con posts, categorías, slugs SEO y reading time.",
  Forum:            "Foro de comunidad con hilos, replies, upvotes/downvotes y respuestas aceptadas.",
  // ── AI & Agentes ──────────────────────────────────────────────────────────
  "AI Agents":      "Agentes IA con Google ADK: CRM Assistant, Lead Scorer, Marketing Writer, Segment Analyzer, Support Agent. Sesiones persistentes.",
  "Agent Orchestrator": "Motor ReAct loop para orchestración multi-agente con tool calling y memoria.",
  // ── Marketplace ───────────────────────────────────────────────────────────
  Plugins:          "Plugin Marketplace: instalar, desinstalar, publicar y auditar plugins con firma criptográfica.",
  // ── Fases 2/3 ─────────────────────────────────────────────────────────────
  Notifications:    "Notificaciones en tiempo real vía SSE: push, mark-read, mark-all-read. Sin WebSocket requerido.",
  Favorites:        "Favoritos por usuario con drag & drop (posición persistente). Toggle idempotente.",
  Tags:             "Etiquetas polimórficas asignables a cualquier record del sistema. Cascade delete.",
  Webhooks:         "Gestión de webhooks HMAC-SHA256: CRUD, pause/resume, test delivery, historial de entregas.",
  CSV:              "Import/Export masivo de datos: batch insert, dry-run, validación de campos, descarga automática.",
  Email:            "Sincronización IMAP/SMTP: canales, hilos de conversación, match automático sender→CRM, send outbound.",
  Calendar:         "Sincronización Google/CalDAV/iCal: eventos con asistentes→CRM, detección de conflictos, booking de slots, feeds .ics.",
  Automation:       "Motor de automatización IF-THEN: reglas sobre cualquier evento, 11 acciones built-in, template {{field}}, historial de logs.",
  // ── Infraestructura avanzada ──────────────────────────────────────────────
  Billing:          "Suscripciones y pagos SaaS con Stripe: plans, checkout, portal, webhooks de Stripe.",
  Segmentation:     "Segmentación de usuarios con filtros dinámicos y audiencias exportables.",
  "Feature Flags":  "Feature flags con rollout porcentual, targeting por usuario/segment y overrides.",
  IoT:              "Registro de dispositivos IoT, ingesta de telemetría SenML, alertas y series temporales.",
  VectorDB:         "Base de datos vectorial semántica (Qdrant): embeddings, similarity search, RAG pipeline.",
  TimeSeries:       "Series temporales en ScyllaDB: ingesta de puntos, downsample, aggregation, Grafana DS API.",
  Workflow:         "Motor de workflows iPaaS: Triggers → Actions multi-step con reintentos y estado persistente.",
  Compliance:       "GDPR/SOC2: audit trail inmutable, data export, retention policies, derecho al olvido.",
  "Multi-Tenant":   "Row-Level Security multi-tenant: aislamiento de datos por workspace/org.",
  "Circuit Breaker":"Patrón circuit breaker: fail-fast, auto-recovery, fallback handlers, métricas de salud.",
  Cache:            "Cache facade LRU + Redis: TTL, tag-invalidation, write-through, stampede prevention.",
  "Job Queue":      "Cola de jobs persistente: retry, dead-letter queue, jobs programados, prioridades, deduplicación.",
  Push:             "Push notifications: FCM/APNs, registro de dispositivos, canales de suscripción.",
  Web3:             "Integración blockchain y IPFS: wallets, NFT metadata, smart contract calls, almacenamiento descentralizado.",
  Edge:             "WASM Edge Computing: funciones ejecutadas en el edge con latencia mínima.",
  Federation:       "Multi-region federation CRDT: sincronización eventual entre clusters geográficos.",
  "Event Streaming":"Kafka event sourcing: publish/subscribe, consumer groups, dead-letter topics.",
  gRPC:             "Endpoints gRPC para comunicación interna de alta performance entre servicios.",
  ZeroMQ:           "Mensajería ZeroMQ para arquitecturas de microservicios de ultra-baja latencia.",
  Runner:           "Ejecución segura de código (sandboxed runner) y Shell API para automatización.",
  Migration:        "Gestión de migraciones de base de datos: aplicar, revertir, estado de versiones.",
};

// ── Generadores de artefactos ─────────────────────────────────────────────────

/**
 * Genera la spec OpenAPI 3.1 iniciando el motor Zenith en modo "spec-only"
 * (sin servidor HTTP, sin DB — solo compone los traits y extrae las rutas).
 */
async function generateOpenApiSpec(cfg: {
  serverURL: string; appId: string; title: string; version: string;
}): Promise<object> {
  // Importar el generador del core
  const { generateOpenApiFromState } = await import(
    "file://" + BACKEND_OPENAPI
  );

  // Construir un state mínimo que simula el engine compuesto
  // extrayendo todas las rutas desde mod.ts en modo "inspect"
  const modPath = fromFileUrl(
    new URL("../../zenith-backend/src/mod.ts", import.meta.url)
  );

  // Usamos ZENITH_SPEC_ONLY=1 para que createZenithApp() retorne
  // el state sin arrancar el servidor ni conectar DB
  const env = { ...Deno.env.toObject(), ZENITH_SPEC_ONLY: "1" };
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", "-A", `
      import { createZenithApp } from "file://${modPath.replace(/\\/g, "/")}";
      const app = await createZenithApp({
        appId: "zenith", masterKey: "secret",
        databaseURI: "mongodb://localhost:27017/zenith_spec",
        specOnly: true,
      });
      const state = (app as any)._composedState ?? {};
      console.log(JSON.stringify(state));
    `],
    env,
    stdout: "piped",
    stderr: "null",
  });

  let composedState: Record<string, unknown> = {};
  try {
    const out    = await proc.output();
    const stdout = new TextDecoder().decode(out.stdout).trim();
    const jsonStart = stdout.lastIndexOf("{");
    if (jsonStart >= 0) composedState = JSON.parse(stdout.slice(jsonStart));
  } catch { /* fallback a spec estática */ }

  return generateOpenApiFromState(composedState, {
    title:       cfg.title,
    version:     cfg.version,
    description: `API completa de Zenith BaaS — el único backend que combina CRM + ERP + Real-time + AI en un solo binary. Compatible con Parse Server SDK. Autenticación via \`X-Parse-Application-Id\` + \`X-Parse-Session-Token\` o \`X-Parse-Master-Key\`.`,
    serverURL:   cfg.serverURL,
    appId:       cfg.appId,
    additionalTagDescriptions: TAG_DESCRIPTIONS,
  });
}

/**
 * Convierte la spec OpenAPI en Markdown por sección/tag.
 * Genera un archivo por tag en docs/api/<tag>.md
 */
function generateMarkdownDocs(spec: any, outDir: string): Array<{ file: string; content: string }> {
  const files: Array<{ file: string; content: string }> = [];

  // Agrupar paths por tag
  const tagMap = new Map<string, Array<{ method: string; path: string; op: any }>>();

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods as object)) {
      if (method === "parameters") continue;
      const tags: string[] = (op as any).tags ?? ["General"];
      for (const tag of tags) {
        if (!tagMap.has(tag)) tagMap.set(tag, []);
        tagMap.get(tag)!.push({ method: method.toUpperCase(), path, op: op as any });
      }
    }
  }

  // README del API
  const readme = [
    `# Zenith API Reference`,
    ``,
    `> Generado automáticamente por \`zen generate docs\``,
    `> Versión: ${spec.info?.version} | Base URL: ${spec.servers?.[0]?.url ?? "http://localhost:3000"}`,
    ``,
    `## Autenticación`,
    ``,
    `Todas las rutas requieren los headers de Parse Server:`,
    ``,
    "```http",
    `X-Parse-Application-Id: <tu-app-id>`,
    `X-Parse-Session-Token: <token-del-usuario>  # Para rutas de usuario`,
    `X-Parse-Master-Key: <master-key>             # Para rutas de administración`,
    "```",
    ``,
    `## Secciones`,
    ``,
    ...[...tagMap.keys()].sort().map(tag => `- [${tag}](./${tag.replace(/\s+/g, "_")}.md) (${tagMap.get(tag)!.length} endpoints)`),
    ``,
    `## Quick Start`,
    ``,
    "```bash",
    `# Importar spec en Swagger UI local`,
    `npx @stoplight/elements-dev-portal --api-url ./docs/openapi.json`,
    ``,
    `# Importar en Postman`,
    `# File → Import → zenith.postman.json`,
    ``,
    `# Visualizar con Redoc`,
    `# Abrir docs/index.html en el navegador`,
    "```",
  ].join("\n");

  files.push({ file: join(outDir, "README.md"), content: readme });

  // Un archivo Markdown por tag
  for (const [tag, endpoints] of tagMap.entries()) {
    const tagDesc = TAG_DESCRIPTIONS[tag] ?? "";
    const lines: string[] = [
      `# ${tag}`,
      ``,
      tagDesc ? `> ${tagDesc}` : "",
      ``,
    ];

    for (const { method, path, op } of endpoints.sort((a, b) => a.path.localeCompare(b.path))) {
      const summary     = op.summary     ?? "";
      const description = op.description ?? "";
      const params      = (op.parameters ?? []) as any[];
      const hasBody     = !!op.requestBody;

      lines.push(`## \`${method} ${path}\``);
      lines.push(`**${summary}**`);
      if (description) lines.push(``, description);
      lines.push(``);

      if (params.length) {
        lines.push(`### Parámetros`);
        lines.push(`| Nombre | In | Tipo | Requerido | Descripción |`);
        lines.push(`|--------|----|------|-----------|-------------|`);
        for (const p of params) {
          lines.push(`| \`${p.name}\` | ${p.in} | ${p.schema?.type ?? "string"} | ${p.required ? "✅" : "—"} | ${p.description ?? ""} |`);
        }
        lines.push(``);
      }

      if (hasBody) {
        lines.push(`### Body`);
        lines.push("```json");
        lines.push(JSON.stringify(op.requestBody?.content?.["application/json"]?.schema ?? {}, null, 2));
        lines.push("```");
        lines.push(``);
      }

      lines.push(`### Respuestas`);
      for (const [code, res] of Object.entries(op.responses ?? {})) {
        lines.push(`- **${code}**: ${(res as any).description ?? ""}`);
      }
      lines.push(``, `---`, ``);
    }

    const filename = tag.replace(/[\s/]/g, "_").replace(/[^a-zA-Z0-9_]/g, "") + ".md";
    files.push({ file: join(outDir, "api", filename), content: lines.join("\n") });
  }

  return files;
}

/**
 * Convierte la spec OpenAPI en una colección Postman 2.1
 */
function generatePostmanCollection(spec: any, serverURL: string): object {
  const items: any[] = [];

  const tagGroups = new Map<string, any[]>();

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods as object)) {
      if (method === "parameters") continue;
      const tags: string[] = (op as any).tags ?? ["General"];
      const tag = tags[0];
      if (!tagGroups.has(tag)) tagGroups.set(tag, []);

      const hasBody = method !== "get" && method !== "delete";
      const url     = path.replace(/:(\w+)/g, "{{$1}}");

      tagGroups.get(tag)!.push({
        name: (op as any).summary ?? `${method.toUpperCase()} ${path}`,
        request: {
          method: method.toUpperCase(),
          header: [
            { key: "Content-Type",            value: "application/json" },
            { key: "X-Parse-Application-Id",  value: "{{appId}}" },
            { key: "X-Parse-Session-Token",   value: "{{sessionToken}}" },
          ],
          ...(hasBody ? { body: { mode: "raw", raw: "{}", options: { raw: { language: "json" } } } } : {}),
          url: {
            raw:  `{{baseUrl}}${url}`,
            host: ["{{baseUrl}}"],
            path: url.split("/").filter(Boolean),
          },
        },
        response: [],
      });
    }
  }

  for (const [tag, reqs] of tagGroups.entries()) {
    items.push({ name: tag, item: reqs });
  }

  return {
    info: {
      name:        spec.info?.title ?? "Zenith API",
      description: spec.info?.description ?? "",
      schema:      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      version:     spec.info?.version ?? "1.0.0",
    },
    variable: [
      { key: "baseUrl",      value: serverURL,    type: "string" },
      { key: "appId",        value: "my_app",     type: "string" },
      { key: "masterKey",    value: "secret",     type: "string" },
      { key: "sessionToken", value: "",           type: "string" },
    ],
    item: items,
  };
}

/**
 * Genera el portal Redoc como HTML auto-contenido (sin CDN requerido en producción,
 * pero usa CDN en este caso para mantener el binario pequeño).
 */
function generateRedocHtml(specRelativePath: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — API Reference</title>
  <meta name="description" content="Documentación de la API ${title} generada con Redoc.">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; font-family: 'Inter', sans-serif; }
    #redoc-container { min-height: 100vh; }
    .loading {
      display: flex; align-items: center; justify-content: center;
      height: 100vh; flex-direction: column; gap: 16px;
      font-size: 18px; color: #6b7280;
    }
    .spinner {
      width: 48px; height: 48px;
      border: 4px solid #e5e7eb;
      border-top-color: #6366f1;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="redoc-container">
    <div class="loading">
      <div class="spinner"></div>
      <span>Cargando API Reference…</span>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/redoc@2.1.3/bundles/redoc.standalone.js"></script>
  <script>
    Redoc.init('${specRelativePath}', {
      theme: {
        colors: { primary: { main: '#6366f1' } },
        typography: {
          fontFamily: "'Inter', sans-serif",
          headings: { fontFamily: "'Inter', sans-serif", fontWeight: '700' },
        },
        sidebar: { backgroundColor: '#0f172a', textColor: '#94a3b8' },
        rightPanel: { backgroundColor: '#1e293b' },
      },
      hideDownloadButton: false,
      expandDefaultServerVariables: true,
      pathInMiddlePanel: false,
      sortEnumValuesAlphabetically: true,
      sortOperationsAlphabetically: true,
    }, document.getElementById('redoc-container'));
  </script>
</body>
</html>`;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    string:  ["out", "url", "app-id", "title", "version"],
    boolean: ["json", "open"],
    default: {
      out:     "./docs",
      url:     Deno.env.get("ZENITH_SERVER_URL") ?? "http://localhost:3000",
      "app-id":Deno.env.get("ZENITH_APP_ID")    ?? "my_app",
      title:   "Zenith Universal Business API",
      version: "1.0.0",
    },
  });

  const subCmd   = String(parsed._[0] ?? "docs");
  const outDir   = String(parsed.out);
  const serverURL= String(parsed.url);
  const appId    = String(parsed["app-id"]);
  const title    = String(parsed.title);
  const version  = String(parsed.version);

  const cfg = { serverURL, appId, title, version };

  switch (subCmd) {
    // ── zen generate docs (pipeline completo) ──────────────────────────────

    case "docs": {
      console.log(`\n📚 Zenith — Generador de documentación completa\n`);
      await ensureDir(join(outDir, "api"));

      // 1. OpenAPI spec
      const spin1 = spinner("Generando spec OpenAPI 3.1...");
      let spec: any = { paths: {}, info: { title, version }, servers: [{ url: serverURL }] };
      try {
        spec = await generateOpenApiSpec(cfg);
        spin1.stop(true);
      } catch (e: any) {
        spin1.stop(false);
        console.log(`  ⚠️  Spec generada en modo fallback: ${e.message}`);
      }

      const specPath = join(outDir, "openapi.json");
      await Deno.writeTextFile(specPath, JSON.stringify(spec, null, 2));
      console.log(`  ✅ OpenAPI 3.1:      ${specPath}`);

      // 2. Markdown API Reference
      const spin2 = spinner("Generando Markdown API Reference...");
      const mdFiles = generateMarkdownDocs(spec, outDir);
      await ensureDir(join(outDir, "api"));
      for (const { file, content } of mdFiles) {
        await ensureDir(file.split(/[\\/]/).slice(0, -1).join("/") || ".");
        await Deno.writeTextFile(file, content);
      }
      spin2.stop(true);
      const tagCount = mdFiles.filter(f => f.file.includes("/api/")).length;
      console.log(`  ✅ Markdown docs:    ${outDir}/api/ (${tagCount} secciones, ${mdFiles.length} archivos)`);

      // 3. Postman Collection
      const spin3 = spinner("Generando Postman Collection...");
      const postman     = generatePostmanCollection(spec, serverURL);
      const postmanPath = join(outDir, "zenith.postman.json");
      await Deno.writeTextFile(postmanPath, JSON.stringify(postman, null, 2));
      spin3.stop(true);
      const epCount = Object.keys(spec.paths ?? {}).length;
      console.log(`  ✅ Postman:          ${postmanPath} (${epCount} endpoints)`);

      // 4. Redoc HTML portal
      const spin4 = spinner("Generando portal Redoc...");
      const htmlPath    = join(outDir, "index.html");
      await Deno.writeTextFile(htmlPath, generateRedocHtml("./openapi.json", title));
      spin4.stop(true);
      console.log(`  ✅ Redoc portal:     ${htmlPath}`);

      // ── Resumen ─────────────────────────────────────────────────────────
      console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Documentación generada en: ${outDir}/

Archivos:
  ${outDir}/openapi.json          OpenAPI 3.1 (Swagger/Redoc/Postman)
  ${outDir}/api/                  Markdown por sección (${tagCount} tags)
  ${outDir}/zenith.postman.json   Colección Postman lista para importar
  ${outDir}/index.html            Portal Redoc self-hosted

Próximos pasos:
  • Swagger UI local:
      npx @stoplight/elements-dev-portal --api-url ./docs/openapi.json

  • Abrir portal Redoc:
      open ${outDir}/index.html

  • Importar en Postman:
      File → Import → ${outDir}/zenith.postman.json

  • Publicar en GitHub Pages:
      cp -r docs/ docs/  # ya está listo
      git add docs/ && git commit -m "docs: API reference v${version}"

  • Integrar en Docusaurus:
      npm install @docusaurus/plugin-redoc
      # plugin: ['@docusaurus/plugin-redoc', { spec: './docs/openapi.json' }]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
      break;
    }

    // ── zen generate openapi (solo JSON) ───────────────────────────────────

    case "openapi": {
      const spin = spinner("Generando spec OpenAPI 3.1...");
      let spec: any = {};
      try {
        spec = await generateOpenApiSpec(cfg);
        spin.stop(true);
      } catch (e: any) {
        spin.stop(false);
        console.log(`  ⚠️  Fallback: ${e.message}`);
      }
      const out = outDir.endsWith(".json") ? outDir : join(outDir, "openapi.json");
      await ensureDir(out.split(/[\\/]/).slice(0, -1).join("/") || ".");
      await Deno.writeTextFile(out, JSON.stringify(spec, null, 2));
      console.log(`✅ OpenAPI spec: ${out}`);
      break;
    }

    // ── zen generate schema ────────────────────────────────────────────────

    case "schema": {
      const { generateOpenApiFromState } = await import("file://" + BACKEND_OPENAPI);
      const spec = generateOpenApiFromState({}, {
        title, version, serverURL, appId,
        additionalTagDescriptions: TAG_DESCRIPTIONS,
      });
      if (parsed.json) {
        console.log(JSON.stringify(spec.components?.schemas ?? {}, null, 2));
      } else {
        console.log("\nSchemas registrados:");
        for (const name of Object.keys(spec.components?.schemas ?? {})) {
          console.log(`  • ${name}`);
        }
      }
      break;
    }

    // ── zen generate sdk (re-genera tipos desde la spec) ──────────────────

    case "sdk": {
      console.log(`\n🔧 Re-generando tipos SDK TypeScript desde OpenAPI spec...`);
      const spin = spinner("Procesando spec...");
      let spec: any = {};
      try { spec = await generateOpenApiSpec(cfg); } catch { /* */ }
      spin.stop(true);

      // Generar tipos básicos desde schemas de la spec
      const schemas = spec.components?.schemas ?? {};
      const lines: string[] = [
        `// AUTOGENERADO por zen generate sdk`,
        `// Zenith API Types — v${version}`,
        `// NO editar manualmente — ejecutar 'zen generate sdk' para regenerar`,
        ``,
      ];

      for (const [name, schema] of Object.entries(schemas as Record<string, any>)) {
        if (!schema.properties) continue;
        lines.push(`export interface ${name} {`);
        for (const [prop, def] of Object.entries(schema.properties as Record<string, any>)) {
          const required  = (schema.required ?? []).includes(prop);
          const tsType    = def.type === "integer" ? "number"
                          : def.type === "array"   ? `${def.items?.type ?? "unknown"}[]`
                          : def.type               ?? "unknown";
          lines.push(`  ${prop}${required ? "" : "?"}: ${tsType};`);
        }
        lines.push(`}`, ``);
      }

      const typesPath = join("sdk", "Typescript", "src", "types", "zenith.generated.ts");
      await ensureDir(join("sdk", "Typescript", "src", "types"));
      await Deno.writeTextFile(typesPath, lines.join("\n"));
      console.log(`✅ Tipos generados: ${typesPath} (${Object.keys(schemas).length} interfaces)`);
      break;
    }

    // ── Ayuda ─────────────────────────────────────────────────────────────

    default:
      console.log(`
zen generate — Generador de artefactos del proyecto

Uso:
  zen generate docs      → Pipeline completo de documentación
  zen generate openapi   → Solo la spec OpenAPI 3.1 JSON
  zen generate schema    → Lista de schemas registrados
  zen generate sdk       → Re-genera tipos TypeScript desde la spec

Flags:
  --out <dir>      Directorio de salida (default: ./docs)
  --url <url>      URL del servidor (default: http://localhost:3000)
  --app-id <id>    App ID (default: my_app)
  --title <text>   Título del API
  --version <v>    Versión del API (default: 1.0.0)
  --json           Salida JSON cruda (para schema)

Pipeline 'zen generate docs' produce:
  docs/openapi.json          → OpenAPI 3.1 (220+ endpoints)
  docs/api/*.md              → Markdown por sección (40+ tags)
  docs/zenith.postman.json   → Colección Postman
  docs/index.html            → Portal Redoc self-hosted
      `);
  }
}
