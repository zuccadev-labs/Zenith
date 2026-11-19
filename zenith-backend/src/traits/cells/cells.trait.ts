/**
 * Cells: Zenith's standard unit of stateful work (ADR-019). A cell is a single-threaded actor with
 * its own SQLite database, addressed by name or id, with the Cloudflare Durable Objects API (which
 * celld implements too): `DurableObjectNamespace`/`Id`/`Stub`, `ctx.storage` (key-value, `sql.exec`,
 * transactions, alarms), `blockConcurrencyWhile`, plus KV and Queue bindings.
 *
 * - **Providers:** `local` (default; this process, one SQLite file per cell, hibernation, alarms,
 *   limits) and `celld` (experimental; cells deployed to a celld fleet and reached over HTTP).
 * - **Configured** after composition with `config.cells` (mod.ts). Until then the local provider uses
 *   `ZENITH_CELLS_DIR` (or `.zenith/cells`) and touches the disk only when a cell runs.
 * - **Cloud Code:** `Zen.Cells.define(className, Class, { binding })`, `Zen.Cells.get(binding, name)`.
 * - **Admin API** (master key only): `GET /zen/cells`, `GET /zen/cells/:binding`,
 *   `POST /zen/cells/:binding/:name/rpc/:method` (`{ args }`) and
 *   `POST /zen/cells/:binding/:name/hibernate`.
 *
 * @barrits-trait
 * @barrits-summary ZenithCells
 * @barrits-provides cells-routes, cells
 * @barrits-consumes
 * @barrits-tags uses:queue
 * @barrits-state cellsConfig
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { errRes, jsonRes, pathParams } from "../../core/trait-utils.ts";
import { type CellsApi, createCellsApi } from "./api.ts";
import type { JobQueueLike } from "./queue.ts";
import { CellError } from "./types.ts";

const STATUS: Record<string, number> = {
  not_found: 404,
  bad_id: 400,
  bad_request: 400,
  capacity: 503,
  storage_limit: 507,
  timeout: 504,
  unsupported: 501,
  closed: 503,
  reset: 503,
  remote: 502,
};

function cellErr(e: unknown): Response {
  if (e instanceof CellError) {
    return jsonRes({ code: e.code, error: e.message }, STATUS[e.code] ?? 500);
  }
  if (e instanceof TypeError || e instanceof SyntaxError) {
    return jsonRes({ code: "bad_request", error: e.message }, 400);
  }
  return errRes(e);
}

/** The admin routes of `cells` (master key only). */
export function cellsRoutes(cells: CellsApi): unknown[] {
  const tags = ["Cells"];
  return [
    {
      method: "GET" as const,
      path: "/zen/cells",
      _openapi: { summary: "Cells provider, classes and counters", tags },
      handler: () => {
        try {
          return jsonRes(cells.stats());
        } catch (e) {
          return cellErr(e);
        }
      },
    },
    {
      method: "GET" as const,
      path: "/zen/cells/:binding",
      _openapi: { summary: "Cells of a class that exist (local provider)", tags },
      handler: (req: Request) => {
        try {
          const p = pathParams("/zen/cells/:binding", req.url)!;
          const local = cells.local();
          if (!local) throw new CellError("unsupported", "listing needs the local provider");
          local.namespace(p.binding); // 404 if unknown
          const cls = local.stats().classes.find((c) =>
            c.binding === p.binding || c.className === p.binding
          )!;
          return jsonRes({ className: cls.className, cells: local.list(cls.className) });
        } catch (e) {
          return cellErr(e);
        }
      },
    },
    {
      method: "POST" as const,
      path: "/zen/cells/:binding/:name/rpc/:method",
      _openapi: {
        summary: "Call a method of the cell called :name",
        tags,
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { args: { type: "array" } } },
            },
          },
        },
      },
      handler: async (req: Request) => {
        try {
          const p = pathParams("/zen/cells/:binding/:name/rpc/:method", req.url)!;
          const body = await req.json().catch(() => ({}));
          const args = Array.isArray(body?.args) ? body.args : [];
          const stub = cells.namespace(p.binding).getByName(
            decodeURIComponent(p.name),
          ) as unknown as Record<
            string,
            (...a: unknown[]) => Promise<unknown>
          >;
          const value = await stub[p.method](...args);
          return jsonRes({ value: value === undefined ? null : value });
        } catch (e) {
          return cellErr(e);
        }
      },
    },
    {
      method: "POST" as const,
      path: "/zen/cells/:binding/:name/hibernate",
      _openapi: { summary: "Hibernate the cell called :name now, if idle", tags },
      handler: (req: Request) => {
        try {
          const p = pathParams("/zen/cells/:binding/:name/hibernate", req.url)!;
          const local = cells.local();
          if (!local) throw new CellError("unsupported", "hibernate needs the local provider");
          const ns = local.namespace(p.binding);
          const cls = local.stats().classes.find((c) =>
            c.binding === p.binding || c.className === p.binding
          )!;
          const id = ns.idFromName(decodeURIComponent(p.name));
          return jsonRes({ hibernated: local.hibernate(cls.className, id) });
        } catch (e) {
          return cellErr(e);
        }
      },
    },
  ];
}

/** The `cells` feature: the capability, its admin routes and the local/celld providers. */
export const CellsTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithCells",
  provides: ["cells-routes", "cells"],
  consumes: [],
  tags: ["uses:queue"],
  state: ["cellsConfig"],
  runtimes: ["deno"],
  summary:
    "Cells (Durable Objects): single-threaded actors with their own SQLite, alarms and hibernation; Cloudflare-compatible bindings; local provider and experimental celld provider.",
  create: (deps: Record<string, any>) => {
    const cells = createCellsApi({}, {
      jobs: () => deps.traits?.["queue"] as JobQueueLike | undefined,
    });
    return { cells, "cells-routes": cellsRoutes(cells) };
  },
});
