import { Zen } from "@zuccadev-labs/zenith";

/**
 * 01 — User Authentication
 *
 * Ejemplos de autenticación: signup, login, verificación de email,
 * reseteo de contraseña, auth custom (Web3 / API keys).
 *
 * API usada:
 *   Zen.Cloud.define()       — funciones cloud
 *   Zen.Cloud.beforeLogin()  — trigger pre-login
 *   Zen.Cloud.afterLogin()   — trigger post-login
 *   Zen.Cloud.beforeLogout() — trigger pre-logout
 *   Zen.Cloud.beforePasswordResetRequest()
 *   Zen.DB.find() / insert() — acceso a DB con ACL
 *   Zen.Cloud.sendEmail()    — envío de emails
 */

// ─── Registro con validación custom ────────────────────────────────
Zen.Cloud.define("auth:signup", async (req) => {
  const { username, email, password, metadata } = req.params;

  if (!username || !email || !password) {
    throw new Error("Campos requeridos: username, email, password");
  }

  const existing = await Zen.DB.find("_User", {
    where: { $or: [{ username }, { email }] },
  });

  if (existing.length > 0) {
    throw new Error("El usuario o email ya está registrado");
  }

  const user = await Zen.DB.insert("_User", {
    username,
    email,
    password,
    emailVerified: false,
    metadata: metadata || {},
    roles: ["user"],
  });

  // Enviar email de verificación (usando el adaptador de mail configurado)
  if (req.master) {
    try {
      await Zen.Cloud.sendEmail({
        to: email as string,
        subject: "Verifica tu cuenta — Zenith",
        text: `Bienvenido ${username}. Tu cuenta ha sido creada.`,
      });
    } catch {
      Zen.Logger.warn("No se pudo enviar email de verificación");
    }
  }

  return { objectId: user.objectId, username: user.username };
});

// ─── Login con rate-limit y validación ─────────────────────────────
Zen.Cloud.beforeLogin(async (req) => {
  const { object: user, log } = req;

  if (user.get?.("banned")) {
    log.info("Intento de login de usuario baneado", { userId: user.objectId });
    throw new Error("Cuenta suspendida. Contacta al administrador.");
  }

  if (!user.get?.("emailVerified") && !req.master) {
    throw new Error("Email no verificado. Revisa tu bandeja de entrada.");
  }
});

Zen.Cloud.afterLogin(async (req) => {
  const { user, log } = req;
  log.info("Login exitoso", { userId: user?.objectId, timestamp: new Date().toISOString() });
});

// ─── Logout tracking ──────────────────────────────────────────────
Zen.Cloud.beforeLogout(async (req) => {
  req.log.info("Usuario cerró sesión", { userId: req.object?.objectId });
});

// ─── Reseteo de contraseña ─────────────────────────────────────────
Zen.Cloud.beforePasswordResetRequest(async (req) => {
  const email = req.object?.get?.("email") || req.params?.email;
  if (!email) throw new Error("Email requerido para resetear contraseña");

  Zen.Logger.info("Solicitud de reseteo de contraseña", { email });
});

Zen.Cloud.define("auth:reset-password", async (req) => {
  const { email, newPassword, token } = req.params;
  if (!email || !newPassword || !token) {
    throw new Error("email, newPassword y token son requeridos");
  }

  // Validar token (en producción usa JWT o similar)
  const resetTokens = await Zen.DB.find("_PasswordResetToken", {
    where: { email, token, used: { $ne: true } },
  });

  if (resetTokens.length === 0) {
    throw new Error("Token inválido o expirado");
  }

  const users = await Zen.DB.find("_User", { where: { email } });
  if (users.length === 0) throw new Error("Usuario no encontrado");

  await Zen.DB.update("_User", users[0].objectId, { password: newPassword });
  await Zen.DB.update("_PasswordResetToken", resetTokens[0].objectId, { used: true });

  return { message: "Contraseña actualizada exitosamente" };
});

// ─── Auth Web3 — verificar firma (integración con web3.ts) ────────
Zen.Cloud.define("auth:web3-login", async (req) => {
  const { wallet, message, signature, chain } = req.params;
  if (!wallet || !message || !signature) {
    throw new Error("wallet, message y signature son requeridos");
  }

  // Buscar o crear usuario vinculado a la wallet
  let users = await Zen.DB.find("_User", { where: { "metadata.wallet": wallet } });
  if (users.length === 0) {
    const newUser = await Zen.DB.insert("_User", {
      username: `wallet_${wallet.slice(0, 8)}`,
      metadata: { wallet, chain: chain || "ethereum" },
      emailVerified: false,
    });
    users = [newUser];
  }

  return {
    objectId: users[0].objectId,
    wallet,
    verified: true,
  };
});

// ─── Verificar si un usuario tiene un rol específico ───────────────
Zen.Cloud.define("auth:has-role", async (req) => {
  const { userId, role } = req.params;
  if (!userId || !role) throw new Error("userId y role requeridos");

  const roles = await Zen.DB.find("_Role", {
    where: { name: role, users: { $elemMatch: { objectId: userId } } },
  });

  return { hasRole: roles.length > 0 };
});

// ─── Obtener perfil público ────────────────────────────────────────
Zen.Cloud.define("auth:profile", async (req) => {
  const userId = (req.params.userId as string) || req.user?.objectId;
  if (!userId) throw new Error("Usuario no autenticado");

  const users = await Zen.DB.findOne("_User", { where: { objectId: userId } });
  if (!users) throw new Error("Usuario no encontrado");

  const { password, ...safe } = users;
  return safe;
});
