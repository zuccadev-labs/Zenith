/**
 * Tests del mod.ts público de observability (re-exports).
 */
import { assertEquals } from "@std/assert";
import * as obs from "../../src/observability/mod.ts";

Deno.test("observability mod: re-exports MetricRegistry", () => {
  assertEquals(typeof obs.MetricRegistry, "function");
  assertEquals(typeof obs.PrometheusRemoteWriter, "function");
  assertEquals(typeof obs.LokiShipper, "function");
  assertEquals(typeof obs.serializeToJson, "function");
  assertEquals(typeof obs.serializeToLokiJson, "function");
  assertEquals(typeof obs.labelKey, "function");
  assertEquals(typeof obs.validateLabelName, "function");
});
