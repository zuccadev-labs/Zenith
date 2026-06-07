/**
 * @hook useZenithQuery
 *
 * Enterprise-grade React hook for querying Zenith classes with optional LiveQuery.
 *
 * Accepts two calling conventions:
 *   1. (query: ZenithQuery, live?: boolean)               — Parse-style DX
 *   2. (className: string, options?: QueryOptions)         — config-style DX
 *
 * Design principles (corporate best practices):
 * - Stable effect dependencies: serializes query to a consistent key, avoiding
 *   infinite loops caused by passing `new ZenithQuery()` inline in JSX.
 * - Single subscription per mount: creates exactly one LiveQuery subscription
 *   and unsubscribes on cleanup with no dangling listeners.
 * - Graceful error handling: sets error state without crashing the component tree.
 * - Returns both `loading` and `isLoading` for API compatibility.
 */

import { useState, useEffect, useRef, useMemo, startTransition } from "react";
import type { RefObject } from "react";
import { ZenithQuery } from "../objects/ZenithQuery.js";
import { ZenithObject } from "../objects/ZenithObject.js";
import { LiveQueryClient } from "../livequery/livequery.js";
import type { ZenithLiveQuerySubscription } from "../livequery/livequery.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ZenithQueryOptions {
  /** Enable real-time LiveQuery updates */
  live?: boolean;
  /** Filter conditions: { field: value } pairs (all treated as equalTo) */
  where?: Record<string, unknown>;
  /** Sort field (prefix with "-" for descending, e.g. "-createdAt") */
  order?: string;
  /** Max number of results (default 100) */
  limit?: number;
  /** Number of results to skip */
  skip?: number;
  /** Fields to include (pointer resolution) */
  include?: string | string[];
}

export interface ZenithQueryResult<T extends ZenithObject = ZenithObject> {
  /** The query results */
  data: T[];
  /** True while the initial fetch is in progress */
  loading: boolean;
  /** Alias for `loading` (Parse SDK parity) */
  isLoading: boolean;
  /** Error from the last failed fetch or LiveQuery error */
  error: Error | null;
  /** Manually re-fetch the query */
  refetch: () => void;
}

// ─── Stable Query Key ─────────────────────────────────────────────────────────

/**
 * Produces a stable string key from a ZenithQuery so React's useEffect
 * dependency array doesn't re-run when a new query instance with the same
 * logical content is created (e.g. `new ZenithQuery("Message")` on every render).
 */
function buildQueryKey(query: ZenithQuery): string {
  try {
    const q = query as any;
    return JSON.stringify({
      className: q.className,     // public field
      where: q._where,
      order: q._order,
      limit: q._limit,
      skip: q._skip,
      include: q._include,
      keys: q._keys,
    });
  } catch {
    // Fallback: className is always public
    return (query as any).className ?? "unknown";
  }
}

// ─── Internal: build a ZenithQuery from className + options ───────────────────

function buildQuery(className: string, opts?: ZenithQueryOptions): ZenithQuery {
  const q = new ZenithQuery(className);
  if (opts?.where) {
    for (const [key, val] of Object.entries(opts.where)) {
      q.equalTo(key, val as any);
    }
  }
  if (opts?.order) {
    if (opts.order.startsWith("-")) q.descending(opts.order.slice(1));
    else q.ascending(opts.order);
  }
  if (opts?.limit !== undefined) q.limit(opts.limit);
  if (opts?.skip !== undefined) q.skip(opts.skip);
  if (opts?.include) {
    const includes = Array.isArray(opts.include) ? opts.include : [opts.include];
    for (const inc of includes) q.include(inc);
  }
  return q;
}

// ─── Overloads ────────────────────────────────────────────────────────────────

export function useZenithQuery<T extends ZenithObject = ZenithObject>(
  queryOrClassName: ZenithQuery | string,
  liveOrOptions?: boolean | ZenithQueryOptions
): ZenithQueryResult<T> {

  // Normalize arguments into (query, live)
  const isQueryObject = queryOrClassName instanceof ZenithQuery;
  const live = isQueryObject
    ? (liveOrOptions as boolean | undefined) ?? false
    : (liveOrOptions as ZenithQueryOptions | undefined)?.live ?? false;

  // Build the normalized ZenithQuery
  const resolvedQuery = useMemo(() => {
    if (isQueryObject) return queryOrClassName as ZenithQuery;
    return buildQuery(
      queryOrClassName as string,
      liveOrOptions as ZenithQueryOptions | undefined
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isQueryObject ? buildQueryKey(queryOrClassName as ZenithQuery) : queryOrClassName,
    // For className mode: serialize options to a stable key
    isQueryObject ? "" : JSON.stringify(liveOrOptions),
  ]);

  // Stable key for the query — prevents effect re-runs on same logical query
  const queryKey = buildQueryKey(resolvedQuery);

  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refetchTokenRef = useRef(0);
  const [refetchTick, setRefetchTick] = useState(0);

  const refetch = () => setRefetchTick((t: number) => t + 1);

  useEffect(() => {
    let cancelled = false;
    let sub: ZenithLiveQuerySubscription | null = null;

    setLoading(true);
    setError(null);

    resolvedQuery.find()
      .then((results: any[]) => {
        if (cancelled) return;
        setData(results);
        setLoading(false);

        if (live) {
          sub = LiveQueryClient.subscribe(resolvedQuery);

          sub.on("create", (obj: ZenithObject) => {
            if (cancelled) return;
            // startTransition: incoming LiveQuery events are non-urgent.
            // React processes them during idle time, so keystrokes/clicks
            // are never blocked → eliminates 'message handler' Violation.
            startTransition(() => {
              setData((prev: T[]) => {
                const objId = (obj as any).id ?? (obj as any).get?.('objectId');
                if (objId && prev.some((p: T) => p.id === objId || (p as any).get?.('objectId') === objId)) return prev;
                return [...prev, obj as T];
              });
            });
          });

          sub.on("update", (obj: ZenithObject) => {
            if (cancelled) return;
            startTransition(() => {
              setData((prev: T[]) => prev.map((p: T) => p.id === obj.id ? obj as T : p));
            });
          });

          sub.on("delete", (obj: ZenithObject) => {
            if (cancelled) return;
            startTransition(() => {
              setData((prev: T[]) => prev.filter((p: T) => p.id !== obj.id));
            });
          });

          sub.on("error", (code: number, message: string) => {
            if (cancelled) return;
            setError(new Error(`[${code}] LiveQuery error: ${message}`));
          });
        }
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (sub) {
        LiveQueryClient.unsubscribe(sub);
        sub = null;
      }
    };
    // queryKey is a stable serialized string — safe as a dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, live, refetchTick]);

  return { data, loading, isLoading: loading, error, refetch };
}
