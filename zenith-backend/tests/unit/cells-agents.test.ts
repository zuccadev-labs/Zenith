/**
 * ADK agent sessions as cells (ADR-019): history in the session cell, carried into the next turn,
 * one turn at a time, surviving hibernation and a restart; the `ADKSession` mirror and the result
 * shape of `run()` stay; without `cells`, the previous path is unchanged.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { composeZenith } from "../../src/core/compose.ts";
import { fakeDb } from "./_fake_db.ts";
import { ADKAgentsTrait, AGENT_SESSION_CELL } from "../../src/traits/agents/adk.agents.trait.ts";
import { CellsTrait } from "../../src/traits/cells/cells.trait.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A model that answers with what it saw: the number of messages and the last user message. */
function fakeAi(delayMs = 0) {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  let active = 0;
  let maxActive = 0;
  return {
    calls,
    get maxActive() {
      return maxActive;
    },
    chat: async (_model: string, messages: Array<{ role: string; content: string }>) => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push(structuredClone(messages));
      await sleep(delayMs);
      active--;
      const last = messages[messages.length - 1].content;
      return { content: [{ type: "text", text: `seen ${messages.length}: ${last}` }] };
    },
  };
}

async function boot(opts: { cells?: boolean; delayMs?: number; dir?: string } = {}) {
  const db = fakeDb();
  const ai = fakeAi(opts.delayMs);
  const traits: unknown[] = [
    createTraitDescriptor({
      name: "Deps",
      provides: ["db", "ai"],
      consumes: [],
      state: [],
      runtimes: ["deno"],
      create: () => ({ db, ai }),
    }),
    ADKAgentsTrait,
  ];
  const dir = opts.dir ?? await Deno.makeTempDir({ prefix: "zenith-agent-cells-" });
  if (opts.cells !== false) traits.unshift(CellsTrait);
  const engine = composeZenith(traits).traits as Record<string, any>;
  engine.cells?.configure({ appId: "app1", dir, hibernateAfterMs: 0 });
  return {
    engine,
    db,
    ai,
    dir,
    async close(keepDir = false) {
      await engine.cells?.close();
      if (!keepDir) await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test("agents as cells: the session cell keeps the history and the model sees it", async () => {
  const z = await boot();
  try {
    const adk = z.engine.adkAgents;
    assertEquals(adk.sessionBackend, "cells");
    const session = await adk.createSession("crm_assistant", {});
    const sid = session.objectId;
    const r1 = await adk.run("crm_assistant", "hola", {}, sid);
    assertEquals(r1.agentId, "crm_assistant");
    assertEquals(r1.sessionId, sid);
    assertEquals(r1.turn, 1);
    assertEquals(r1.backend, "cells");
    assert(typeof r1.durationMs === "number" && Array.isArray(r1.iterations));
    assertEquals(r1.finalAnswer, "seen 2: hola"); // system + user
    const r2 = await adk.run("crm_assistant", "¿y ahora?", {}, sid);
    assertEquals(r2.turn, 2);
    // system + (user, assistant) of turn 1 + user
    assertEquals(r2.finalAnswer, "seen 4: ¿y ahora?");
    assertEquals(z.ai.calls[1].map((m) => m.role), ["system", "user", "assistant", "user"]);
    assertEquals(z.ai.calls[1][2].content, "seen 2: hola");
    // The DB mirror holds the whole conversation, as the API had it.
    const row = z.db.rows.ADKSession.find((r) => r.objectId === sid)!;
    assertEquals(row.messages.map((m: any) => m.role), ["user", "assistant", "user", "assistant"]);
    const h = await adk.history("crm_assistant", sid);
    assertEquals(h.turns, 2);
    assertEquals(h.history.length, 4);
    assertEquals(h.interrupted, null);
    // The cell is the one the cells capability serves, by name = session id.
    const cell = z.engine.cells.namespace(AGENT_SESSION_CELL.binding).getByName(sid);
    assertEquals((await cell.info()).agentId, "crm_assistant");
  } finally {
    await z.close();
  }
});

Deno.test("agents as cells: turns of one session run one at a time, sessions run in parallel", async () => {
  const z = await boot({ delayMs: 30 });
  try {
    const adk = z.engine.adkAgents;
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((x) => adk.run("support_agent", x, {}, "s-serial")),
    );
    assertEquals(results.map((r: any) => r.turn), [1, 2, 3, 4]);
    // Each turn saw every earlier turn: 2, 4, 6, 8 messages.
    assertEquals(results.map((r: any) => r.finalAnswer), [
      "seen 2: a",
      "seen 4: b",
      "seen 6: c",
      "seen 8: d",
    ]);
    assertEquals(z.ai.maxActive, 1);
    const parallel = await Promise.all(
      ["p1", "p2", "p3"].map((s) => adk.run("support_agent", "x", {}, s)),
    );
    assertEquals(parallel.map((r: any) => r.turn), [1, 1, 1]);
    assert(z.ai.maxActive > 1, "different sessions should not wait for each other");
  } finally {
    await z.close();
  }
});

Deno.test("agents as cells: a session survives hibernation and a restart; it is bound to its agent", async () => {
  const z = await boot();
  const dir = z.dir;
  try {
    const adk = z.engine.adkAgents;
    await adk.run("lead_scorer", "uno", {}, "s-persist");
    assertEquals(z.engine.cells.local().hibernateIdle(0), 1);
    const r = await adk.run("lead_scorer", "dos", {}, "s-persist");
    assertEquals(r.turn, 2);
    assertEquals(r.finalAnswer, "seen 4: dos");
    await assertRejects(
      () => adk.run("crm_assistant", "intruso", {}, "s-persist"),
      Error,
      'belongs to agent "lead_scorer"',
    );
    await assertRejects(() => adk.history("crm_assistant", "s-persist"));
  } finally {
    await z.close(true);
  }
  const z2 = await boot({ dir });
  try {
    const r = await z2.engine.adkAgents.run("lead_scorer", "tres", {}, "s-persist");
    assertEquals(r.turn, 3);
    assertEquals(r.finalAnswer, "seen 6: tres");
  } finally {
    await z2.close();
  }
});

Deno.test("agents as cells: tool handlers get the caller's context through the cell", async () => {
  const z = await boot();
  try {
    const adk = z.engine.adkAgents;
    let seen: unknown = null;
    adk.registerTool({
      name: "whoami",
      description: "",
      parameters: {},
      handler: async (_p: unknown, ctx: any) => {
        seen = ctx.user?.objectId;
        return { ok: true };
      },
    });
    let first = true;
    z.engine.ai.chat = async () => {
      if (first) {
        first = false;
        return { content: [{ type: "tool_use", name: "whoami", input: {} }] };
      }
      return { content: [{ type: "text", text: "listo" }] };
    };
    const ctx = { user: { objectId: "u1" }, fn: () => {} }; // not cloneable: it must not cross RPC
    const r = await adk.run("crm_assistant", "x", ctx, "s-tools");
    assertEquals(r.finalAnswer, "listo");
    assertEquals(seen, "u1");
  } finally {
    await z.close();
  }
});

Deno.test("agents without cells: the previous path is unchanged", async () => {
  const z = await boot({ cells: false });
  try {
    const adk = z.engine.adkAgents;
    assertEquals(adk.sessionBackend, "db");
    const s = await adk.createSession("crm_assistant", {});
    const r1 = await adk.run("crm_assistant", "hola", {}, s.objectId);
    assertEquals(Object.keys(r1).sort(), [
      "agentId",
      "durationMs",
      "finalAnswer",
      "iterations",
      "sessionId",
    ]);
    await adk.run("crm_assistant", "otra", {}, s.objectId);
    // No earlier history reaches the model on this path.
    assertEquals(z.ai.calls[1].length, 2);
  } finally {
    await z.close();
  }
});
