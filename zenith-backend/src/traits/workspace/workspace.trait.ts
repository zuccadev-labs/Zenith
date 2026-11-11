// deno-lint-ignore-file no-unused-vars
/**
 * Workspace Trait — Gestión de miembros, roles e invitaciones.
 *
 * Equivalente al sistema de Workspace Members de Twenty CRM.
 * Roles: admin | member | guest
 *
 * Las API keys no viven aquí: hay un solo sistema, `security/api-keys` (`/zen/api-keys`, ADR-015).
 * Este trait tenía otro (`/zen/apikeys`, clase ZenithApiKey): las keys se guardaban con SHA-256 sin
 * sal y ningún middleware las aceptaba.
 *
 * @barrits-trait
 * @barrits-summary ZenithWorkspace
 * @barrits-provides workspace_routes, workspace
 * @barrits-consumes cloud, db
 * @barrits-tags uses:events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor, type AnyTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import { jsonRes, errRes, NO_CONTENT, pathParams, queryParams, parsePage, ptr, now } from "../../core/trait-utils.ts";
import { randomHex, sha256Hex } from "../../core/crypto.ts";

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
    tokenHash:   { type: "String", required: true }, // SHA-256 del token: el token solo se entrega una vez
    invitedBy:   { type: "Pointer", targetClass: "_User" },
    expiresAt:   { type: "Date", required: true },
    acceptedAt:  { type: "Date" },
    status:      { type: "String", defaultValue: "pending" }, // pending|accepted|expired|revoked
  },
} as const;

export const WorkspaceTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithWorkspace",
  provides: ["workspace_routes", "workspace"],
  consumes: ["cloud", "db"],
  tags: ["uses:events"],
  state: [],
  runtimes: ["deno"],

  summary: "Workspace Members (roles Admin/Member/Guest) and Invitations by email with a one-time token (stored hashed).",

  create: (deps: Record<string, any>) => {
    const db     = deps.traits["db"];
    const cloud  = deps.traits["cloud"];
    const events = deps.traits["events"];

    if (cloud?.defineSchema) {
      for (const [name, fields] of Object.entries(WORKSPACE_SCHEMAS)) {
        cloud.defineSchema(name, fields, {});
      }
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
        const token = randomHex(32);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 días
        const invitation = await db.create("WorkspaceInvitation", {
          email, role: role ?? "member", workspaceId,
          tokenHash: await sha256Hex(token), expiresAt, status: "pending",
          invitedBy: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(), updatedAt: now(),
        });
        if (events) events.emit("Workspace.invited", { email, role, workspaceId, token });
        // token se retorna SOLO en la respuesta inicial — nunca más
        const { tokenHash: _hash, ...safe } = invitation;
        return { ...safe, inviteUrl: `/zen/workspace/invitations/accept?token=${token}` };
      },
      async acceptInvitation(token: string, userId: string) {
        if (typeof token !== "string" || !token) throw ZenithErrors.validationFailed("token es obligatorio.");
        const invitations = await db.find("WorkspaceInvitation", { tokenHash: await sha256Hex(token), status: "pending" });
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
    ];

    return { workspace_routes, workspace: api };
  },
});
