import { test } from "node:test";
import assert from "node:assert/strict";
import { atLeast, CLI, main, parseDenoVersion } from "../index.mjs";

const quiet = () => {
  const out = { log: [], error: [] };
  return { out, log: { log: (m) => out.log.push(m), error: (m) => out.error.push(m) } };
};

test("parses deno --version", () => {
  assert.deepEqual(parseDenoVersion("deno 2.9.8 (stable, release, x86_64)\nv8 14"), [2, 9, 8]);
  assert.equal(parseDenoVersion("bash: deno: not found"), null);
  assert.ok(atLeast([2, 4, 0], [2, 4, 0]));
  assert.ok(!atLeast([1, 46, 3], [2, 4, 0]));
});

test("without Deno: explains how to install it and runs nothing else", () => {
  const calls = [];
  const run = (cmd, args) => (calls.push([cmd, ...args]), { error: new Error("ENOENT") });
  const { out, log } = quiet();
  assert.equal(main(["node", "create-zenith", "miapp"], run, log), 1);
  assert.match(out.error.join("\n"), /deno\.land\/install\.sh/);
  assert.deepEqual(calls, [["deno", "--version"]]);
});

test("old Deno is refused", () => {
  const run = () => ({ status: 0, stdout: "deno 1.46.3 (stable)" });
  const { out, log } = quiet();
  assert.equal(main(["node", "create-zenith", "miapp"], run, log), 1);
  assert.match(out.error.join("\n"), /deno upgrade/);
});

test("with Deno: delegates to zen init from JSR with the arguments", () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    return args[0] === "--version" ? { status: 0, stdout: "deno 2.9.8 (stable)" } : { status: 0 };
  };
  const { log } = quiet();
  assert.equal(main(["node", "create-zenith", "miapp"], run, log), 0);
  assert.deepEqual(calls[1], ["deno", "run", "-A", "--unstable-kv", CLI, "init", "miapp"]);
});
