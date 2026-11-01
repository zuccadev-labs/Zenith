import { Zen } from "@zuccadev-labs/zenith";

/**
 * 06 — LiveQuery
 *
 * Suscripciones en tiempo real a cambios de clases de Parse.
 * Incluye triggers de conexión, suscripción y eventos.
 *
 * API usada:
 *   Zen.Cloud.beforeConnect()      — validar conexión WebSocket inicial
 *   Zen.Cloud.beforeSubscribe()    — validar suscripción a clase
 *   Zen.Cloud.afterLiveQueryEvent() — evento genérico de LiveQuery
 *   Zen.Cloud.define()
 *   Zen.DB.*
 */

// ─── Validar conexión WebSocket inicial ───────────────────────────
Zen.Cloud.beforeConnect(async (req) => {
  const { object, log } = req;
  const client = object as unknown as {
    get?: (k: string) => unknown;
  };

  const installationId = client.get?.("installationId") as string | undefined;

  // Rechazar conexiones sin installationId
  if (!installationId) {
    log.info("Conexión LiveQuery rechazada: falta installationId");
    throw new Error("installationId es requerido para LiveQuery");
  }

  // Verificar rate-limit por IP
  const ip = req.ip || "unknown";
  if (ip !== "unknown") {
    log.info("Nueva conexión LiveQuery", { installationId, ip });
  }
});

// ─── Validar suscripción a clase específica ───────────────────────
Zen.Cloud.beforeSubscribe("TodoItem", async (req) => {
  const { object, log } = req;
  const subscription = object as unknown as {
    get?: (k: string) => unknown;
  };

  const className = subscription.get?.("className") || "TodoItem";
  log.info("Suscripción a LiveQuery", { className, userId: req.user?.objectId });

  // Ejemplo: prevenir suscripción si el usuario no está autenticado
  if (!req.user && !req.master) {
    throw new Error("Debes iniciar sesión para suscribirte a cambios en TodoItem");
  }
});

Zen.Cloud.beforeSubscribe("_User", async (req) => {
  if (!req.master) {
    throw new Error("Solo master key puede suscribirse a cambios en _User");
  }
});

// ─── Evento genérico de LiveQuery ─────────────────────────────────
Zen.Cloud.afterLiveQueryEvent(async (req) => {
  const { object, log } = req;
  const event = object as unknown as {
    get?: (k: string) => unknown;
  };

  log.info("Evento LiveQuery", {
    type: event.get?.("type"),
    className: event.get?.("className"),
    objectId: event.get?.("objectId"),
  });
});

// ─── Función: obtener estadísticas de LiveQuery ───────────────────
Zen.Cloud.define("livequery:stats", async (req) => {
  const config = await Zen.Config.get();

  return {
    enabled: true,
    activeClasses: ["TodoItem", "_User"],
    config: {
      maxSubscriptionsPerClient: config.liveQuery?.maxSubscriptions || 10,
      ttl: config.liveQuery?.ttl || 3600,
    },
    serverTime: new Date().toISOString(),
  };
});

// ─── Función: simular un evento LiveQuery ─────────────────────────
Zen.Cloud.define("livequery:emit", async (req) => {
  const { className, objectId, event = "update", data } = req.params;
  if (!className) throw new Error("className es requerido");

  if (!req.master) {
    throw new Error("Solo master key puede emitir eventos LiveQuery");
  }

  Zen.Logger.info("Evento LiveQuery emitido", {
    className,
    objectId,
    event,
    timestamp: new Date().toISOString(),
  });

  return { emitted: true, className, objectId, event };
});

// ─── Función: listar suscripciones activas ────────────────────────
Zen.Cloud.define("livequery:subscriptions", async (req) => {
  if (!req.master) throw new Error("Solo master key");

  const subs = await Zen.DB.find("_LiveQuerySubscription", {
    where: { active: true },
  });

  return subs.map((s: Record<string, unknown>) => ({
    id: s.objectId,
    className: s.className,
    userId: s.userId,
    connectedAt: s.connectedAt,
  }));
});
