import { Zen } from "@zuccadev-labs/zenith";

// ─── Database Triggers for _User ──────────────────────────────────────────

/**
 * Trigger `afterSave` en la clase base _User.
 * Reacciona de forma asíncrona a la creación de cualquier usuario
 * (ya sea por Auth Clásica, Web3, o cualquier otro provider).
 */
Zen.Cloud.afterSave("_User", async (request) => {
  const user = request.object;
  const original = request.original;

  // Si 'original' no existe, significa que el usuario acaba de ser creado (Insert)
  if (!original) {
    const db = Zen.DB.getAdapter();

    console.log(`[Zenith Cloud] Ejecutando afterSave para nuevo usuario: ${user.objectId || user._id}`);

    // Insertar un formulario de bienvenida automáticamente
    // usando la API completa de Parse-Server con Punteros correctos
    try {
      await db.insert("FormEntry", {
        title: "¡Bienvenido a Zenith Enterprise!",
        description: "Este es un formulario generado automáticamente por el Trigger afterSave del backend al detectar tu primer registro.",
        owner: { __type: "Pointer", className: "_User", objectId: user.objectId || user._id },
        // Implementación estricta de seguridad ACL: Solo el dueño puede leer/escribir
        _rperm: [user.objectId || user._id],
        _wperm: [user.objectId || user._id],
        status: "welcome_generated",
        createdAt: new Date(),
        updatedAt: new Date()
      });
    } catch (err) {
      console.error("[Zenith Cloud] Error en afterSave _User:", err);
    }
  }
});
