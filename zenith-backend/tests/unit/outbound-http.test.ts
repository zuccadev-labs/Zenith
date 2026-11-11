import { assert, assertEquals, assertRejects } from "@std/assert";
import { isPublicAddress } from "../../src/core/net.ts";
import { checkOutboundUrl, OutboundBlockedError, safeFetch } from "../../src/security/outbound-http.ts";

Deno.test("net: only Internet-routable addresses are public", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert(isPublicAddress(ip), ip);
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "fe80::1", "fc00::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "2001:db8::1", "not-an-ip",
  ]) assert(!isPublicAddress(ip), ip);
});

Deno.test("outbound: https only, no credentials, no private or metadata destinations", async () => {
  const resolve = (host: string) => Promise.resolve(({ "public.example": ["93.184.216.34"], "internal.example": ["10.0.0.5"], "mixed.example": ["93.184.216.34", "127.0.0.1"] } as Record<string, string[]>)[host] ?? []);
  assertEquals((await checkOutboundUrl("https://public.example/hook", { resolve })).hostname, "public.example");
  await assertRejects(() => checkOutboundUrl("http://public.example/hook", { resolve }), OutboundBlockedError, "https");
  await assertRejects(() => checkOutboundUrl("https://user:pw@public.example/", { resolve }), OutboundBlockedError, "credentials");
  await assertRejects(() => checkOutboundUrl("https://internal.example/", { resolve }), OutboundBlockedError, "non-public");
  await assertRejects(() => checkOutboundUrl("https://mixed.example/", { resolve }), OutboundBlockedError, "127.0.0.1", "every address must be public");
  await assertRejects(() => checkOutboundUrl("https://169.254.169.254/latest/meta-data/", { resolve }), OutboundBlockedError, "non-public");
  await assertRejects(() => checkOutboundUrl("https://[::1]/", { resolve }), OutboundBlockedError, "non-public");
  await assertRejects(() => checkOutboundUrl("https://nowhere.example/", { resolve }), OutboundBlockedError, "does not resolve");
  await assertRejects(() => checkOutboundUrl("file:///etc/passwd"), OutboundBlockedError, "https");
  await assertRejects(() => checkOutboundUrl("not a url"), OutboundBlockedError, "valid URL");
});

Deno.test({ name: "outbound: redirects are not followed and slow receivers time out", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const ac = new AbortController();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    await new Promise((r) => setTimeout(r, 500));
    return new Response("late");
  });
  const base = `http://127.0.0.1:${server.addr.port}`;
  const dev = { allowHttp: true, allowPrivate: true };
  try {
    const res = await safeFetch(`${base}/redirect`, {}, dev);
    assertEquals(res.status, 302, "the 3xx comes back as is; the Location is never fetched");
    await res.body?.cancel();
    await assertRejects(() => safeFetch(`${base}/slow`, {}, { ...dev, timeoutMs: 50 }), Error);
    await assertRejects(() => safeFetch(`${base}/x`), OutboundBlockedError, "https", "the default policy refuses http and loopback");
  } finally {
    ac.abort();
    await server.finished;
  }
} });
