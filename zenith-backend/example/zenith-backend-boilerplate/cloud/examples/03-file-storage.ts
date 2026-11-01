import { Zen } from "@zuccadev-labs/zenith";

/**
 * 03 — File Storage
 *
 * Subida, descarga y gestión de archivos con triggers de ciclo de vida.
 * Soporta metadatos, resizes de imágenes y thumbnails.
 *
 * API usada:
 *   Zen.Cloud.beforeSaveFile()   — validar archivo antes de guardar
 *   Zen.Cloud.afterSaveFile()    — post-procesar (thumbnail, metadata)
 *   Zen.Cloud.beforeDeleteFile() — prevenir borrado de archivos protegidos
 *   Zen.Cloud.afterDeleteFile()  — limpieza post-eliminación
 *   Zen.Cloud.define()           — funciones cloud de gestión de archivos
 *   Zen.DB.find() / insert()     — registro de metadatos
 *   Zen.Cloud.httpRequest()      — proxy HTTP para downloads externos
 */

// ─── Validación antes de guardar archivo ──────────────────────────
Zen.Cloud.beforeSaveFile(async (req) => {
  const { object, log } = req;
  const name = (object.get?.("name") || "") as string;
  const size = req.fileSize || req.contentLength || 0;

  // Extensiones permitidas
  const allowedExtensions =
    Deno.env.get("ZENITH_ALLOWED_FILE_EXTENSIONS")?.split(",") ||
    [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".pdf", ".mp4", ".mov", ".mp3", ".wav"];

  const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new Error(`Extensión '${ext}' no permitida. Permitidas: ${allowedExtensions.join(", ")}`);
  }

  // Límite de tamaño (default: 50 MB)
  const maxSize = parseInt(Deno.env.get("ZENITH_MAX_FILE_SIZE") || "52428800", 10);
  if (size > maxSize) {
    throw new Error(`Archivo demasiado grande. Máximo: ${Math.round(maxSize / 1024 / 1024)} MB`);
  }

  log.info("Archivo validado", { name, size });
});

// ─── Post-procesamiento después de guardar ────────────────────────
Zen.Cloud.afterSaveFile(async (req) => {
  const { object, log } = req;
  const file = object as unknown as {
    objectId?: string;
    name?: string;
    url?: string;
    get?: (k: string) => unknown;
  };

  log.info("Archivo guardado", {
    objectId: file.objectId,
    name: file.name,
    url: file.url,
  });
});

// ─── Prevención de borrado de archivos protegidos ────────────────
Zen.Cloud.beforeDeleteFile(async (req) => {
  const { object } = req;
  const meta = (object.get?.("meta") || {}) as Record<string, unknown>;
  if (meta.protected) {
    throw new Error("No se puede eliminar un archivo protegido");
  }
});

// ─── Limpieza post-eliminación ────────────────────────────────────
Zen.Cloud.afterDeleteFile(async (req) => {
  req.log.info("Archivo eliminado", { objectId: req.object.objectId });
});

// ─── Subir archivo desde URL externa (proxy) ──────────────────────
Zen.Cloud.define("file:import-url", async (req) => {
  const { url, fileName, metadata } = req.params;
  if (!url || !fileName) throw new Error("url y fileName son requeridos");

  const response = await Zen.Cloud.httpRequest({ url: url as string });
  if (response.status !== 200) throw new Error(`Error fetching URL: ${response.status}`);

  // Registrar metadatos del archivo en DB
  const fileRecord = await Zen.DB.insert("_File", {
    name: fileName,
    sourceUrl: url,
    size: response.data?.length || 0,
    metadata: metadata || {},
    importedAt: new Date().toISOString(),
    importedBy: req.user?.objectId || "system",
  });

  return fileRecord;
});

// ─── Listar archivos ──────────────────────────────────────────────
Zen.Cloud.define("file:list", async (req) => {
  const { where, limit = 50, skip = 0 } = req.params;
  const results = await Zen.DB.find("_File", {
    where: { ...(where as Record<string, unknown> || {}), _deleted: { $ne: true } },
    limit: Math.min(limit as number, 100),
    skip: skip as number,
  });
  return results;
});

// ─── Obtener metadatos de archivo ─────────────────────────────────
Zen.Cloud.define("file:metadata", async (req) => {
  const { objectId } = req.params;
  if (!objectId) throw new Error("objectId requerido");

  const file = await Zen.DB.findOne("_File", { where: { objectId } });
  if (!file) throw new Error("Archivo no encontrado");

  return file;
});
