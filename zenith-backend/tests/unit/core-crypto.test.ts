import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  fromBase64Url,
  hmacSha256Hex,
  randomHex,
  randomString,
  sha256Hex,
  signingKey,
  timingSafeEqual,
  timingSafeEqualString,
  toBase64Url,
  toHex,
} from "../../src/core/crypto.ts";

Deno.test("core/crypto: sha256Hex matches the FIPS 180-2 test vector", async () => {
  assertEquals(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

Deno.test("core/crypto: hmacSha256Hex matches RFC 4231 test case 2", async () => {
  assertEquals(
    await hmacSha256Hex("Jefe", "what do ya want for nothing?"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});

Deno.test("core/crypto: randomHex has 2n hex characters and does not repeat", () => {
  const a = randomHex(32);
  assertEquals(a.length, 64);
  assert(/^[0-9a-f]+$/.test(a));
  assertNotEquals(a, randomHex(32));
});

Deno.test("core/crypto: randomString uses only the alphabet and is not biased", () => {
  // 62 does not divide 256: with `byte % 62` the first 8 characters come out 25 % more often.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const counts = new Map<string, number>();
  const s = randomString(200_000, alphabet);
  assertEquals(s.length, 200_000);
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  assertEquals(counts.size, alphabet.length);
  const expected = s.length / alphabet.length;
  const firstEight = [...alphabet.slice(0, 8)].reduce((n, c) => n + counts.get(c)!, 0) / 8;
  const rest = [...alphabet.slice(8)].reduce((n, c) => n + counts.get(c)!, 0) / (alphabet.length - 8);
  assert(Math.abs(firstEight - rest) / expected < 0.06, `bias: ${firstEight} vs ${rest}`);
  assertThrows(() => randomString(4, "a"), RangeError);
});

Deno.test("core/crypto: base64url round trip without padding", () => {
  const bytes = new Uint8Array([251, 255, 0, 1, 2]);
  const s = toBase64Url(bytes);
  assert(!/[+/=]/.test(s));
  assertEquals(fromBase64Url(s), bytes);
  assertEquals(fromBase64Url(s + "="), bytes);
  assertEquals(toHex(bytes), "fbff000102");
});

Deno.test("core/crypto: timing-safe comparisons", async () => {
  assert(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])));
  assert(!timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])));
  assert(!timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])));
  assert(await timingSafeEqualString("secret", "secret"));
  assert(!(await timingSafeEqualString("secret", "secreT")));
  assert(!(await timingSafeEqualString("secret", "secret-longer")));
});

Deno.test("core/crypto: signingKey never falls back to a fixed key", () => {
  const name = "ZENITH_TEST_SIGNING_KEY_UNSET";
  Deno.env.delete(name);
  const warnings: string[] = [];
  const a = signingKey(name, (m) => warnings.push(m));
  const b = signingKey(name, (m) => warnings.push(m));
  assertEquals(a, b, "stable within the process");
  assertEquals(a.length, 64);
  assertNotEquals(a, "default");
  assertEquals(warnings.length, 1, "warns once");
  Deno.env.set(name, "from-env");
  try {
    assertEquals(signingKey(name), "from-env");
  } finally {
    Deno.env.delete(name);
  }
});
