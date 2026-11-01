import { Zen } from "@zuccadev-labs/zenith";

/**
 * 04 — Media Streaming
 *
 * Streaming de video/audio en vivo y bajo demanda (VoD).
 * Soporta WebRTC, HLS, transcodificación, y control de acceso
 * basado en roles y tokens.
 *
 * API usada:
 *   Zen.Cloud.beforePublish() — validar antes de publicar un stream
 *   Zen.Cloud.beforeWatch()   — validar antes de ver un stream
 *   Zen.Cloud.onStreamEvent() — eventos del ciclo de vida del stream
 *   Zen.Cloud.define()         — funciones cloud para gestión de streams
 *   Zen.DB.*                   — persistencia de metadatos
 *   Zen.Config.get()           — leer configuración global
 *   Zen.Logger                 — logging estructurado
 */

const STREAM_CLASS = "MediaStream";

// ─── Validación antes de publicar un stream ───────────────────────
Zen.Cloud.beforePublish(async (req) => {
  const { object, log } = req;
  const stream = object as unknown as {
    get?: (k: string) => unknown;
    set?: (k: string, v: unknown) => void;
  };

  const bitrate = stream.get?.("bitrate") || 0;
  const resolution = stream.get?.("resolution") as string | undefined;
  const roomSize = parseInt(Deno.env.get("ZENITH_MAX_ROOM_SIZE") || "50", 10);

  // Validar bitrate máximo
  if (bitrate as number > 50_000_000) {
    throw new Error("Bitrate excede el máximo permitido (50 Mbps)");
  }

  // Validar resolución
  const validResolutions = ["480p", "720p", "1080p", "4K"];
  if (resolution && !validResolutions.includes(resolution)) {
    throw new Error(`Resolución inválida. Válidas: ${validResolutions.join(", ")}`);
  }

  // Asignar sala automática si no tiene
  if (!stream.get?.("roomId")) {
    stream.set?.("roomId", `room_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`);
  }

  log.info("Stream autorizado para publicación", {
    userId: req.user?.objectId,
    bitrate,
    resolution,
  });
});

// ─── Control de acceso antes de ver ───────────────────────────────
Zen.Cloud.beforeWatch(async (req) => {
  const { object, log } = req;
  const stream = object as unknown as { get?: (k: string) => unknown };

  // Verificar si el stream es privado (requiere token)
  const isPrivate = stream.get?.("accessMode") === "private";
  if (isPrivate && !req.master) {
    throw new Error("Este stream es privado. Se requiere token de acceso.");
  }

  log.info("Visualización autorizada", {
    streamId: stream.get?.("objectId"),
    userId: req.user?.objectId,
  });
});

// ─── Eventos del ciclo de vida del stream ─────────────────────────
Zen.Cloud.onStreamEvent(async (req) => {
  const { object, log } = req;
  const event = object as unknown as {
    get?: (k: string) => unknown;
  };

  log.info("Evento de stream", {
    type: event.get?.("type"),
    streamId: event.get?.("streamId"),
    timestamp: event.get?.("timestamp"),
    bitrate: event.get?.("bitrate"),
  });
});

// ─── Iniciar stream en vivo ───────────────────────────────────────
Zen.Cloud.define("media:start-stream", async (req) => {
  const { title, description, resolution, accessMode = "public", maxViewers } = req.params;
  if (!title) throw new Error("title es requerido");

  const stream = await Zen.DB.insert(STREAM_CLASS, {
    title,
    description: description || "",
    resolution: resolution || "720p",
    accessMode,
    maxViewers: maxViewers || 50,
    status: "live",
    publisherId: req.user?.objectId || "system",
    startedAt: new Date().toISOString(),
    roomId: `room_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    viewerCount: 0,
    recording: Deno.env.get("ZENITH_AUTO_RECORD") === "true",
  });

  return stream;
});

// ─── Detener stream ───────────────────────────────────────────────
Zen.Cloud.define("media:stop-stream", async (req) => {
  const { streamId } = req.params;
  if (!streamId) throw new Error("streamId requerido");

  const streams = await Zen.DB.find(STREAM_CLASS, {
    where: { objectId: streamId },
  });

  if (streams.length === 0) throw new Error("Stream no encontrado");

  const stream = streams[0];
  if (stream.publisherId !== req.user?.objectId && !req.master) {
    throw new Error("No tienes permiso para detener este stream");
  }

  await Zen.DB.update(STREAM_CLASS, stream.objectId, {
    status: "ended",
    endedAt: new Date().toISOString(),
  });

  return { stopped: true, streamId };
});

// ─── Listar streams activos ───────────────────────────────────────
Zen.Cloud.define("media:active-streams", async () => {
  const streams = await Zen.DB.find(STREAM_CLASS, {
    where: { status: "live" },
  });

  return streams.map((s: Record<string, unknown>) => ({
    id: s.objectId,
    title: s.title,
    resolution: s.resolution,
    viewerCount: s.viewerCount,
    startedAt: s.startedAt,
    accessMode: s.accessMode,
  }));
});

// ─── Generar token de acceso para stream privado ──────────────────
Zen.Cloud.define("media:generate-token", async (req) => {
  const { streamId, expiresInSeconds = 3600 } = req.params;
  if (!streamId) throw new Error("streamId requerido");

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + (expiresInSeconds as number) * 1000).toISOString();

  await Zen.DB.insert("MediaAccessToken", {
    streamId,
    token,
    userId: req.user?.objectId,
    expiresAt,
    used: false,
  });

  return { token, expiresAt };
});

// ─── Obtener estadísticas de streaming ────────────────────────────
Zen.Cloud.define("media:stats", async (req) => {
  const { streamId } = req.params;
  if (!streamId) throw new Error("streamId requerido");

  const config = await Zen.Config.get();
  const streams = await Zen.DB.find(STREAM_CLASS, {
    where: { objectId: streamId },
  });

  if (streams.length === 0) throw new Error("Stream no encontrado");

  return {
    stream: streams[0],
    config: {
      maxRoomSize: config.maxRoomSize || 50,
      autoRecord: config.autoRecord || false,
      maxBitrate: config.maxBitrate || 50_000_000,
    },
  };
});
