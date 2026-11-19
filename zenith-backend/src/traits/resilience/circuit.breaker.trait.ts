/**
 * Circuit breaker pattern: fail-fast when downstream services are unhealthy, automatic recovery probes, configurable thresholds, fallback handlers.
 *
 * @barrits-trait
 * @barrits-summary ZenithCircuitBreaker
 * @barrits-provides circuit-breaker, circuitBreaker, resilience
 * @barrits-consumes
 * @barrits-state breakers
 * @barrits-stability experimental
 * @barrits-runtime deno
 * @barrits-tags uses:metric-registry
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";

/**
 * Circuit breaker trait: named breakers that fail fast while a downstream service is unhealthy,
 * probe it to recover, and run a fallback when open.
 */
export const CircuitBreakerTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithCircuitBreaker",
  provides: ["circuit-breaker", "circuitBreaker", "resilience"],
  consumes: [],
  state: ["breakers"],
  runtimes: ["deno"],
  summary:
    "Circuit breaker pattern: fail-fast when downstream services are unhealthy, automatic recovery probes, configurable thresholds, fallback handlers.",
  tags: ["uses:metric-registry"],
  create: (deps: Record<string, any>) => {
    const STATES = ["closed", "open", "half-open"] as const;
    /** `zenith_circuit_breaker_state{circuit, state}`: 1 for the current state, 0 for the others. */
    const report = (name: string, state: string) => {
      const metrics = deps.traits?.["metric-registry"];
      if (!metrics) return;
      for (const s of STATES) {
        metrics.gauge("zenith_circuit_breaker_state", s === state ? 1 : 0, {
          circuit: name,
          state: s.toUpperCase().replace("-", "_"),
        });
      }
    };
    const setState = (
      name: string,
      b: { state: string },
      state: "closed" | "open" | "half-open",
    ) => {
      if (b.state === state) return;
      b.state = state;
      report(name, state);
    };
    const traitApi: any = {
      breakers: new Map<
        string,
        {
          state: "closed" | "open" | "half-open";
          failureCount: number;
          successCount: number;
          lastFailure?: number;
          threshold: number;
          resetTimeoutMs: number;
        }
      >(),

      getOrCreate: (
        name: string,
        options: { threshold?: number; resetTimeoutMs?: number } = {},
      ) => {
        if (!traitApi.breakers.has(name)) {
          traitApi.breakers.set(name, {
            state: "closed",
            failureCount: 0,
            successCount: 0,
            threshold: options.threshold || 5,
            resetTimeoutMs: options.resetTimeoutMs || 30000,
          });
          report(name, "closed");
        }
        return traitApi.breakers.get(name)!;
      },

      execute: async <T>(
        name: string,
        fn: () => Promise<T>,
        options: { threshold?: number; resetTimeoutMs?: number; fallback?: (e: Error) => T } = {},
      ): Promise<T> => {
        const breaker = traitApi.getOrCreate(name, options);
        if (breaker.state === "open") {
          if (Date.now() - (breaker.lastFailure || 0) > breaker.resetTimeoutMs) {
            setState(name, breaker, "half-open");
            breaker.successCount = 0;
          } else {
            if (options.fallback) return options.fallback(new Error("circuit breaker open"));
            throw new Error(`circuit breaker open: ${name}`);
          }
        }
        try {
          const result = await fn();
          breaker.successCount++;
          if (breaker.state === "half-open" && breaker.successCount >= 2) {
            setState(name, breaker, "closed");
            breaker.failureCount = 0;
          } else if (breaker.state === "closed") {
            breaker.failureCount = 0; // the threshold counts consecutive failures, not failures ever
          }
          return result;
        } catch (e: any) {
          breaker.failureCount++;
          breaker.lastFailure = Date.now();
          // A failed probe in half-open reopens at once.
          if (breaker.state === "half-open" || breaker.failureCount >= breaker.threshold) {
            setState(name, breaker, "open");
          }
          if (options.fallback) return options.fallback(e);
          throw e;
        }
      },

      getState: (name: string) => {
        const b = traitApi.breakers.get(name);
        return b
          ? { state: b.state, failureCount: b.failureCount, successCount: b.successCount }
          : null;
      },
    };

    return {
      "circuit-breaker": traitApi,
      "circuitBreaker": traitApi,
      "resilience": traitApi,
    };
  },
});
