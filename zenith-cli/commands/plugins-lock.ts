/**
 * @cli zenith plugins:lock
 *
 * Genera o actualiza `plugins.lock.json` en la raíz del proyecto.
 * Debe ejecutarse después de agregar o modificar cualquier plugin
 * antes de hacer deploy a producción.
 *
 * Uso:
 *   zenith plugins:lock
 *   zenith plugins:lock ./plugins
 *
 * Implementa un patrón SecOps militar: previene la ejecución arbitraria
 * de código (ACE — Arbitrary Code Execution) verificando la integridad
 * SHA-256 de cada plugin contra el lockfile firmado.
 */

const pluginsDir = Deno.args[0] || "./plugins";
const lockfilePath = `${Deno.cwd()}/plugins.lock.json`;

const crypto = await import("node:crypto");

console.log(`[zenith plugins:lock] Escaneando plugins en: ${pluginsDir}`);

let existing: Record<string, string> = {};
try {
  const content = await Deno.readTextFile(lockfilePath);
  existing = JSON.parse(content);
  console.log(`[zenith plugins:lock] Lockfile existente cargado con ${Object.keys(existing).length} entradas.`);
} catch (_e) {
  console.log(`[zenith plugins:lock] Creando nuevo plugins.lock.json...`);
}

const lockfile: Record<string, string> = {};
let added = 0;
let updated = 0;
let unchanged = 0;

try {
  for await (const entry of Deno.readDir(pluginsDir)) {
    if (entry.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      const absPath = await Deno.realPath(`${pluginsDir}/${entry.name}`);
      const fileContent = await Deno.readFile(absPath);
      const hash = crypto.createHash("sha256").update(fileContent).digest("hex");

      lockfile[entry.name] = hash;

      if (!existing[entry.name]) {
        console.log(`  [+] ${entry.name} → ${hash.substring(0, 16)}... (nuevo)`);
        added++;
      } else if (existing[entry.name] !== hash) {
        console.log(`  [~] ${entry.name} → ${hash.substring(0, 16)}... (actualizado)`);
        updated++;
      } else {
        console.log(`  [=] ${entry.name} → ${hash.substring(0, 16)}... (sin cambios)`);
        unchanged++;
      }
    }
  }
} catch (err: any) {
  if (err instanceof Deno.errors.NotFound) {
    console.error(`[Error] Directorio de plugins no encontrado: ${pluginsDir}`);
    Deno.exit(1);
  }
  throw err;
}

// Escribir lockfile en raíz del proyecto (fuera del directorio de plugins)
await Deno.writeTextFile(lockfilePath, JSON.stringify(lockfile, null, 2));

console.log(`\n[zenith plugins:lock] ✅ plugins.lock.json generado en ${lockfilePath}`);
console.log(`  Plugins: ${Object.keys(lockfile).length} total (${added} nuevos, ${updated} actualizados, ${unchanged} sin cambios)`);
console.log(`\n  ⚠️  Commitea plugins.lock.json en tu repositorio para garantizar integridad en producción.`);
