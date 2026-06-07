// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const CircuitBreakerTrait = createTraitDescriptor({
  name: "ZenithCircuitBreaker",
  provides: ["circuit-breaker", "circuitBreaker", "resilience"],
  consumes: ["telemetry"],
  state: ["breakers"],
  runtimes: ["deno"],
  summary: "Circuit breaker pattern: fail-fast when downstream services are unhealthy, automatic recovery probes, configurable thresholds, fallback handlers.",
  create: (deps: Record<string, any>) => {
    const traitApi: any = {
      breakers: new Map<string, { state: "closed" | "open" | "half-open"; failureCount: number; successCount: number; lastFailure?: number; threshold: number; resetTimeoutMs: number }>(),

      getOrCreate: (name: string, options: { threshold?: number; resetTimeoutMs?: number } = {}) => {
        if (!traitApi.breakers.has(name)) {
          traitApi.breakers.set(name, { state: "closed", failureCount: 0, successCount: 0, threshold: options.threshold || 5, resetTimeoutMs: options.resetTimeoutMs || 30000 });
        }
        return traitApi.breakers.get(name)!;
      },

      execute: async <T>(name: string, fn: () => Promise<T>, options: { threshold?: number; resetTimeoutMs?: number; fallback?: (e: Error) => T } = {}): Promise<T> => {
        const breaker = traitApi.getOrCreate(name, options);
        if (breaker.state === "open") {
          if (Date.now() - (breaker.lastFailure || 0) > breaker.resetTimeoutMs) {
            breaker.state = "half-open";
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
            breaker.state = "closed";
            breaker.failureCount = 0;
          }
          return result;
        } catch (e: any) {
          breaker.failureCount++;
          breaker.lastFailure = Date.now();
          if (breaker.failureCount >= breaker.threshold) breaker.state = "open";
          if (options.fallback) return options.fallback(e);
          throw e;
        }
      },

      getState: (name: string) => {
        const b = traitApi.breakers.get(name);
        return b ? { state: b.state, failureCount: b.failureCount, successCount: b.successCount } : null;
      },
    };

    return {
      "circuit-breaker": traitApi,
      "circuitBreaker": traitApi,
      "resilience": traitApi,
    };
  },
});
