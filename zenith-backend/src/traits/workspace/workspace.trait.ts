// deno-lint-ignore-file no-unused-vars
/**
 * Workspace Trait — Gestión de miembros, roles, invitaciones y API Keys.
 *
 * Equivalente al sistema de Workspace Members de Twenty CRM.
 * Roles: admin | member | guest
 * API Keys: sk_live_* | sk_test_* con scopes y última vez usado.
 *
 * @barrits-trait
 * @barrits-summary ZenithWorkspace
 * @barrits-provides workspace_routes, workspace
 * @barrits-consumes cloud, db
 * @barrits-tags uses:events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import { jsonRes, errRes, NO_CONTENT, pathParams, queryParams, parsePage, ptr, now } from "../../core/trait-utils.ts";

const WORKSPACE_SCHEMAS = {
  WorkspaceMember: {
    user:        { type: "Pointer", targetClass: "_User", required: true },
    workspaceId: { type: "String", required: true },
    role:        { type: "String", defaultValue: "member" }, // admin|member|guest
    status:      { type: "String", defaultValue: "active"  }, // active|inactive|suspended
    invitedBy:   { type: "Pointer", targetClass: "_User" },
    joinedAt:    { type: "Date" },
    avatarUrl:   { type: "String" },
  },
  WorkspaceInvitation: {
    email:       { type: "String", required: true },
    role:        { type: "String", defaultValue: "member" },
    workspaceId: { type: "String", required: true },
    token:       { type: "String", required: true },
    invitedBy:   { type: "Pointer", targetClass: "_User" },
    expiresAt:   { type: "Date", required: true },
    acceptedAt:  { type: "Date" },
    status:      { type: "String", defaultValue: "pending" }, // pending|accepted|expired|revoked
  },
  ZenithApiKey: {
    name:        { type: "String", required: true },
    prefix:      { type: "String", required: true }, // sk_live | sk_test
    keyHash:     { type: "String", required: true }, // SHA-256 del key — nunca se almacena el key completo
    scopes:      { type: "Array",  defaultValue: ["read", "write"] },
    workspaceId: { type: "String" },
    owner:       { type: "Pointer", targetClass: "_User" },
    lastUsedAt:  { type: "Date" },
    expiresAt:   { type: "Date" },
    revokedAt:   { type: "Date" },
    status:      { type: "String", defaultValue: "active" }, // active|revoked|expired
  },
} as const;

export const WorkspaceTrait = createTraitDescriptor({
  name: "ZenithWorkspace",
  provides: ["workspace_routes", "workspace"],
  consumes: ["cloud", "db"],
  tags: ["uses:events"],
  state: [],
  runtimes: ["deno"],

  summary: "Workspace Members (roles Admin/Member/Guest), Invitations by email with token, API Key CRUD (HMAC-hashed, never stored plain).",

  create: (deps: Record<string, any>) => {
    const db     = deps.traits["db"];
    const cloud  = deps.traits["cloud"];
    const events = deps.traits["events"];

    if (cloud?.defineSchema) {
      for (const [name, fields] of Object.entries(WORKSPACE_SCHEMAS)) {
        cloud.defineSchema(name, fields, {});
      }
    }

    // ── API Key generation ─────────────────────────────────────────────────────

    async function generateApiKey(env: "live" | "test"): Promise<{ key: string; prefix: string; hash: string }> {
      const raw    = crypto.getRandomValues(new Uint8Array(32));
      const hex    = Array.from(raw).map(b => b.toString(16).padStart(2, "0")).join("");
      const prefix = `sk_${env}_`;
      const key    = `${prefix}${hex}`;
      const encoder = new TextEncoder();
      const hashBuf = await crypto.subtle.digest("SHA-256", encoder.encode(key));
      const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
      return { key, prefix, hash };
    }

    async function generateInviteToken(): Promise<string> {
      const raw = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(raw).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    // ── traitApi ──────────────────────────────────────────────────────────────

    const api = {
      // ── Members ──────────────────────────────────────────────────────────────

      async listMembers(workspaceId: string) {
        const results = await db.find("WorkspaceMember", { workspaceId });
        return { results };
      },
      async getMember(objectId: string) {
        const m = await db.read("WorkspaceMember", objectId);
        if (!m) throw ZenithErrors.notFound("WorkspaceMember", objectId);
        return m;
      },
      async updateMember(objectId: string, data: { role?: string; status?: string }, ctx: any) {
        const existing = await db.read("WorkspaceMember", objectId);
        if (!existing) throw ZenithErrors.notFound("WorkspaceMember", objectId);
        // Solo admin puede cambiar roles
        const allowed = ["role", "status", "avatarUrl"];
        const patch = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));
        return db.update("WorkspaceMember", { objectId }, { ...patch, updatedAt: now() });
      },
      async removeMember(objectId: string, ctx: any) {
        const existing = await db.read("WorkspaceMember", objectId);
        if (!existing) throw ZenithErrors.notFound("WorkspaceMember", objectId);
        await db.delete("WorkspaceMember", { objectId });
        if (events) events.emit("Workspace.memberRemoved", { objectId, workspaceId: existing.workspaceId });
        return { success: true };
      },

      // ── Invitations ───────────────────────────────────────────────────────────

      async invite(workspaceId: string, email: string, role: string, ctx: any) {
        if (!email) throw ZenithErrors.validationFailed("email es obligatorio para invitar.");
        const token = await generateInviteToken();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 días
        const invitation = await db.create("WorkspaceInvitation", {
          email, role: role ?? "member", workspaceId,
          token, expiresAt, status: "pending",
          invitedBy: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(), updatedAt: now(),
        });
        if (events) events.emit("Workspace.invited", { email, role, workspaceId, token });
        // token se retorna SOLO en la respuesta inicial — nunca más
        return { ...invitation, inviteUrl: `/zen/workspace/invitations/accept?token=${token}` };
      },
      async acceptInvitation(token: string, userId: string) {
        const invitations = await db.find("WorkspaceInvitation", { token, status: "pending" });
        const inv = invitations[0];
        if (!inv) throw ZenithErrors.notFound("WorkspaceInvitation");
        if (new Date(inv.expiresAt) < new Date()) {
          await db.update("WorkspaceInvitation", { objectId: inv.objectId }, { status: "expired" });
          throw ZenithErrors.invalidRequest("La invitación ha expirado.");
        }
        const member = await db.create("WorkspaceMember", {
          user: ptr("_User", userId), workspaceId: inv.workspaceId,
          role: inv.role, status: "active", invitedBy: inv.invitedBy,
          joinedAt: now(), createdAt: now(), updatedAt: now(),
        });
        await db.update("WorkspaceInvitation", { objectId: inv.objectId }, { status: "accepted", acceptedAt: now() });
        if (events) events.emit("Workspace.memberJoined", member);
        return member;
      },

      // ── API Keys ──────────────────────────────────────────────────────────────

      async listApiKeys(ctx: any) {
        const where: Record<string, any> = {};
        if (ctx.user) where["owner.objectId"] = ctx.user.objectId;
        const results = (await db.find("ZenithApiKey", where)).map((k: any) => {
          const { keyHash, ...safe } = k; // nunca exponer el hash
          return { ...safe, prefix: k.prefix };
        });
        return { results };
      },
      async createApiKey(name: string, scopes: string[], env: "live" | "test" = "live", ctx: any) {
        if (!name) throw ZenithErrors.validationFailed("name es obligatorio para crear una API Key.");
        const { key, prefix, hash } = await generateApiKey(env);
        const record = await db.create("ZenithApiKey", {
          name, prefix, keyHash: hash, scopes: scopes ?? ["read", "write"],
          owner: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          status: "active", createdAt: now(), updatedAt: now(),
        });
        // key solo se retorna UNA VEZ — nunca más visible
        return { ...record, key, keyHash: undefined, _warning: "Guarda este key de forma segura. No se mostrará de nuevo." };
      },
      async revokeApiKey(objectId: string, ctx: any) {
        const existing = await db.read("ZenithApiKey", objectId);
        if (!existing) throw ZenithErrors.notFound("ZenithApiKey", objectId);
        if (!ctx.master && existing.owner?.objectId !== ctx.user?.objectId) throw ZenithErrors.forbidden();
        await db.update("ZenithApiKey", { objectId }, { status: "revoked", revokedAt: now(), updatedAt: now() });
        return { success: true };
      },
    };

    // ── Rutas ─────────────────────────────────────────────────────────────────

    const workspace_routes = [
      // Members
      { method: "GET"    as const, path: "/zen/workspace/:workspaceId/members",      _openapi: { summary: "Listar Miembros del Workspace",   tags: ["Workspace"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/workspace/:workspaceId/members", req.url)!; return jsonRes(await api.listMembers(p.workspaceId)); } catch(e) { return errRes(e); } } },
      { method: "GET"    as const, path: "/zen/workspace/members/:objectId",         _openapi: { summary: "Obtener Miembro por ID",           tags: ["Workspace"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/workspace/members/:objectId", req.url)!; return jsonRes(await api.getMember(p.objectId)); } catch(e) { return errRes(e); } } },
      { method: "PUT"    as const, path: "/zen/workspace/members/:objectId",         _openapi: { summary: "Actualizar rol/estado del Miembro", tags: ["Workspace"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/workspace/members/:objectId", req.url)!; return jsonRes(await api.updateMember(p.objectId, await req.json(), ctx)); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/workspace/members/:objectId",         _openapi: { summary: "Eliminar Miembro del Workspace",   tags: ["Workspace"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/workspace/members/:objectId", req.url)!; await api.removeMember(p.objectId, ctx); return NO_CONTENT; } catch(e) { return errRes(e); } } },
      // Invitations
      { method: "POST"   as const, path: "/zen/workspace/:workspaceId/invitations",  _openapi: { summary: "Invitar Miembro al Workspace",     tags: ["Workspace"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/workspace/:workspaceId/invitations", req.url)!; const b = await req.json(); return jsonRes(await api.invite(p.workspaceId, b.email, b.role, ctx), 201); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/workspace/invitations/accept",        _openapi: { summary: "Aceptar Invitación",               tags: ["Workspace"] }, handler: async (req: Request, ctx: any) => { try { const b = await req.json(); return jsonRes(await api.acceptInvitation(b.token, b.userId ?? ctx.user?.objectId)); } catch(e) { return errRes(e); } } },
      // API Keys
      { method: "GET"    as const, path: "/zen/apikeys",                             _openapi: { summary: "Listar API Keys",                  tags: ["Workspace"] }, handler: async (req: Request, ctx: any) => { try { return jsonRes(await api.listApiKeys(ctx)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/apikeys",                             _openapi: { summary: "Crear API Key (retorna key UNA VEZ)", tags: ["Workspace"] }, handler: async (req: Request, ctx: any) => { try { const b = await req.json(); return jsonRes(await api.createApiKey(b.name, b.scopes, b.env, ctx), 201); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/apikeys/:objectId",                   _openapi: { summary: "Revocar API Key",                  tags: ["Workspace"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/apikeys/:objectId", req.url)!; return jsonRes(await api.revokeApiKey(p.objectId, ctx)); } catch(e) { return errRes(e); } } },
    ];

    return { workspace_routes, workspace: api };
  },
});
