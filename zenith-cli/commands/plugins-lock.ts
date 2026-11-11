/**
 * @cli zen plugins-lock [dir]   (alias: plugins:lock)
 *
 * Genera o actualiza `plugins.lock.json` en la raíz del proyecto: el SHA-256 de cada plugin.
 * En producción, el motor solo carga plugins cuyo hash coincide (prevención de ejecución de
 * código arbitrario). Ejecutarlo después de añadir o cambiar un plugin, antes del despliegue.
 *
 * Antes este módulo hacía todo al ser importado: el dispatcher lo importaba siempre, así que
 * cualquier comando escaneaba plugins y escribía el lockfile (o salía con error).
 */
import { join } from "@std/path";

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

export async function run(args: string[]): Promise<void> {
  const pluginsDir = args[0] ?? "./plugins";
  const lockfilePath = join(Deno.cwd(), "plugins.lock.json");
  console.log(`[plugins-lock] Escaneando ${pluginsDir}`);

  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(await Deno.readTextFile(lockfilePath));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw new Error(`plugins.lock.json no es JSON válido: ${(e as Error).message}`);
    }
  }

  const lockfile: Record<string, string> = {};
  let added = 0, updated = 0, unchanged = 0;
  try {
    const names: string[] = [];
    for await (const entry of Deno.readDir(pluginsDir)) {
      if (entry.isFile && /\.(ts|js)$/.test(entry.name)) names.push(entry.name);
    }
    for (const name of names.sort()) {
      const hash = await sha256Hex(
        await Deno.readFile(await Deno.realPath(join(pluginsDir, name))),
      );
      lockfile[name] = hash;
      const mark = !existing[name]
        ? (added++, "+")
        : existing[name] !== hash
        ? (updated++, "~")
        : (unchanged++, "=");
      console.log(`  [${mark}] ${name} → ${hash.slice(0, 16)}…`);
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`No existe el directorio de plugins: ${pluginsDir}`);
    }
    throw e;
  }

  await Deno.writeTextFile(lockfilePath, JSON.stringify(lockfile, null, 2) + "\n");
  console.log(
    `\n✅ ${lockfilePath}: ${
      Object.keys(lockfile).length
    } plugins (${added} nuevos, ${updated} cambiados, ${unchanged} iguales)`,
  );
  console.log("   Haz commit de plugins.lock.json: producción solo carga plugins que coinciden.");
}
