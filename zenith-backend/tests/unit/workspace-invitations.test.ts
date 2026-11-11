import { assert, assertEquals, assertRejects } from "@std/assert";
import { sha256Hex } from "../../src/core/crypto.ts";
import { WorkspaceTrait } from "../../src/traits/workspace/workspace.trait.ts";

/** In-memory db with the subset of the adapter the trait uses. */
function fakeDb() {
  const rows: Record<string, Record<string, any>[]> = {};
  const matches = (r: Record<string, any>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => r[k] === v);
  return {
    rows,
    create: async (c: string, o: Record<string, any>) => {
      const row = { objectId: crypto.randomUUID(), ...o };
      (rows[c] ??= []).push(row);
      return { ...row };
    },
    find: async (c: string, where: Record<string, unknown>) =>
      (rows[c] ?? []).filter((r) => matches(r, where)).map((r) => ({ ...r })),
    read: async (c: string, id: string) => (rows[c] ?? []).find((r) => r.objectId === id) ?? null,
    update: async (c: string, where: Record<string, unknown>, patch: Record<string, unknown>) => {
      for (const r of (rows[c] ?? []).filter((x) => matches(x, where))) Object.assign(r, patch);
    },
    delete: async () => {},
  };
}

const setup = () => {
  const db = fakeDb();
  const { workspace, workspace_routes } = (WorkspaceTrait as any).create({ traits: { db } });
  return { db, api: workspace, routes: workspace_routes as Array<{ path: string }> };
};

Deno.test("workspace: the invitation token is returned once and stored only as its SHA-256", async () => {
  const { db, api } = setup();
  const inv = await api.invite("ws1", "ana@example.com", "member", {});
  const token = new URL(inv.inviteUrl, "http://x").searchParams.get("token")!;
  assertEquals(token.length, 64);
  assertEquals(inv.tokenHash, undefined, "not in the response");
  const [row] = db.rows.WorkspaceInvitation;
  assertEquals(row.token, undefined, "not stored in clear");
  assertEquals(row.tokenHash, await sha256Hex(token));
});

Deno.test("workspace: only the right token accepts an invitation, and only once", async () => {
  const { api } = setup();
  const inv = await api.invite("ws1", "ana@example.com", "admin", {});
  const token = new URL(inv.inviteUrl, "http://x").searchParams.get("token")!;
  await assertRejects(() => api.acceptInvitation("f".repeat(64), "u1"));
  await assertRejects(() => api.acceptInvitation(undefined, "u1"));
  const member = await api.acceptInvitation(token, "u1");
  assertEquals(member.role, "admin");
  assertEquals(member.workspaceId, "ws1");
  await assertRejects(
    () => api.acceptInvitation(token, "u2"),
    Error,
    undefined,
    "already accepted",
  );
});

Deno.test("workspace: API keys are not served here (one system: /zen/api-keys, ADR-015)", () => {
  const { api, routes } = setup();
  assert(!routes.some((r) => r.path.startsWith("/zen/apikeys")));
  assertEquals(api.createApiKey, undefined);
});
