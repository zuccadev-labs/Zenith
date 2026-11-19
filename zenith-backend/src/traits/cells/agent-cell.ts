/**
 * @module @zenith/traits/cells/agent-cell
 *
 * An AI agent conversation as a cell (ADR-019): the session's history and counters live in the cell's
 * own SQLite, and turns run one at a time, in arrival order, without blocking reads of the history.
 * The model and the tools are not in the cell: `env.AGENT_RUNTIME` runs one ReAct turn over the
 * history the cell hands it, so the same class runs wherever that binding exists (in Zenith it is the
 * ADK agents trait; on celld it would be a service binding back to Zenith, which is pending).
 *
 * Self-contained on purpose (only type imports): it can be bundled for celld as it is.
 */
import type { CellEnv, DurableObjectState } from "./types.ts";

/** One message of a conversation. */
export interface AgentMessage {
  /** `user`, `assistant`, `system` or `tool`. */
  role: string;
  /** Text of the message. */
  content: string;
  /** ISO 8601 time it was recorded. */
  timestamp?: string;
}

/** What one turn produced. */
export interface AgentTurnOutput {
  /** The answer of the agent. */
  finalAnswer: string;
  /** The reasoning steps (thought, action, observation). */
  iterations: unknown[];
}

/** `env.AGENT_RUNTIME`: runs one turn of an agent over a history. */
export interface AgentRuntime {
  /**
   * Runs agent `agentId` on `input`, with `history` as the earlier messages of the conversation.
   * `contextRef` identifies the caller's request context inside the runtime (opaque to the cell).
   */
  turn(
    agentId: string,
    history: AgentMessage[],
    input: string,
    contextRef: string | null,
  ): Promise<AgentTurnOutput>;
}

/** The result of `turn()`. */
export interface AgentCellTurnResult extends AgentTurnOutput {
  /** The agent of the session. */
  agentId: string;
  /** Number of this turn in the session (1-based). */
  turn: number;
  /** Time spent, in ms, waiting included. */
  durationMs: number;
}

/** The counters of a session. */
export interface AgentSessionInfo {
  /** The agent, or `null` before the first turn. */
  agentId: string | null;
  /** Turns completed. */
  turns: number;
  /** Messages stored. */
  messages: number;
  /** Input of a turn that started and never finished (the process stopped), if any. */
  interrupted: string | null;
}

/** Options of `turn()`. */
export interface AgentTurnOptions {
  /** How many earlier messages the model sees (default 50). */
  maxHistory?: number;
  /** Opaque reference to the caller's context, passed to the runtime. */
  contextRef?: string | null;
}

/** The conversation cell. Bind it with `env.AGENT_RUNTIME`. */
export class AgentSessionCell {
  #ctx: DurableObjectState;
  #env: CellEnv;
  #queue: Promise<unknown> = Promise.resolve();

  /** Creates the history table. */
  constructor(ctx: DurableObjectState, env: CellEnv) {
    this.#ctx = ctx;
    this.#env = env;
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL," +
        " content TEXT NOT NULL, at TEXT NOT NULL)",
    );
  }

  /**
   * Runs one turn. Turns of the same session queue behind each other (an in-memory chain, since a
   * model call can outlast the 30 s of `blockConcurrencyWhile`); reads of the history do not wait.
   */
  turn(
    agentId: string,
    input: string,
    options: AgentTurnOptions = {},
  ): Promise<AgentCellTurnResult> {
    const start = Date.now();
    const run = this.#queue.then(() => this.#turn(agentId, input, options, start));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #turn(
    agentId: string,
    input: string,
    options: AgentTurnOptions,
    start: number,
  ): Promise<AgentCellTurnResult> {
    if (typeof agentId !== "string" || !agentId) throw new TypeError("turn() needs an agentId");
    if (typeof input !== "string") throw new TypeError("turn() needs a text input");
    const kv = this.#ctx.storage.kv;
    const owner = kv.get<string>("agentId");
    if (owner !== undefined && owner !== agentId) {
      throw new Error(`this session belongs to agent "${owner}", not "${agentId}"`);
    }
    const runtime = this.#env.AGENT_RUNTIME as AgentRuntime | undefined;
    if (!runtime || typeof runtime.turn !== "function") {
      throw new Error("AgentSessionCell needs env.AGENT_RUNTIME");
    }
    const history = this.history(options.maxHistory ?? 50);
    kv.put("pending", input);
    let out: AgentTurnOutput;
    try {
      out = await runtime.turn(agentId, history, input, options.contextRef ?? null);
    } catch (e) {
      kv.delete("pending");
      throw e;
    }
    const finalAnswer = typeof out?.finalAnswer === "string" ? out.finalAnswer : "";
    const iterations = Array.isArray(out?.iterations) ? out.iterations : [];
    const turn = this.#ctx.storage.transactionSync(() => {
      const at = new Date().toISOString();
      const sql = this.#ctx.storage.sql;
      sql.exec("INSERT INTO messages (role, content, at) VALUES ('user', ?, ?)", input, at);
      sql.exec(
        "INSERT INTO messages (role, content, at) VALUES ('assistant', ?, ?)",
        finalAnswer,
        at,
      );
      const n = (kv.get<number>("turns") ?? 0) + 1;
      kv.put("turns", n);
      if (owner === undefined) kv.put("agentId", agentId);
      kv.delete("pending");
      return n;
    });
    return { agentId, turn, finalAnswer, iterations, durationMs: Date.now() - start };
  }

  /** The last `limit` messages (all when omitted), oldest first. */
  history(limit?: number): AgentMessage[] {
    const rows = limit !== undefined
      ? this.#ctx.storage.sql.exec(
        "SELECT role, content, at FROM (SELECT * FROM messages ORDER BY seq DESC LIMIT ?) ORDER BY seq",
        Math.max(0, Math.floor(limit)),
      ).toArray()
      : this.#ctx.storage.sql.exec("SELECT role, content, at FROM messages ORDER BY seq").toArray();
    return rows.map((r) => ({
      role: String(r.role),
      content: String(r.content),
      timestamp: String(r.at),
    }));
  }

  /** Counters of the session. */
  info(): AgentSessionInfo {
    const kv = this.#ctx.storage.kv;
    return {
      agentId: kv.get<string>("agentId") ?? null,
      turns: kv.get<number>("turns") ?? 0,
      messages: Number(this.#ctx.storage.sql.exec("SELECT count(*) AS n FROM messages").one().n),
      interrupted: kv.get<string>("pending") ?? null,
    };
  }

  /** HTTP surface: `GET /messages`, `GET /info`, `POST /turn` `{agentId, input}`. */
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/messages") return Response.json(this.history());
    if (request.method === "GET" && path === "/info") return Response.json(this.info());
    if (request.method === "POST" && path === "/turn") {
      const b = await request.json().catch(() => ({}));
      try {
        return Response.json(await this.turn(b.agentId, b.input));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}
