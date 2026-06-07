/**
 * Tests para keys.ts — Ed25519 keypair management.
 *
 * Cubre:
 *   - generateKeyPair produce claves válidas
 *   - import/export roundtrip (public + private)
 *   - sign/verify happy path
 *   - verify detecta tampering
 *   - fingerprint y fingerprintShort son determinísticos
 *   - buildKeyId y isValidKeyId
 */

import { assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import {
  buildKeyId,
  exportPrivateRaw,
  exportPublicRaw,
  fingerprint,
  fingerprintShort,
  generateKeyPair,
  importPrivateRaw,
  importPublicRaw,
  isValidKeyId,
  sign,
  verify,
} from "../../src/security/plugin-signing/keys.ts";

// ─── Key generation ─────────────────────────────────────────────────────────

Deno.test("keys - generateKeyPair returns valid base64 keys", async () => {
  const kp = await generateKeyPair();
  assertEquals(typeof kp.publicKey, "string");
  assertEquals(typeof kp.privateKey, "string");
  assertEquals(kp.publicKey.length > 0, true);
  assertEquals(kp.privateKey.length > 0, true);
});

Deno.test("keys - two generated keys are different (non-deterministic)", async () => {
  const kp1 = await generateKeyPair();
  const kp2 = await generateKeyPair();
  assertNotEquals(kp1.publicKey, kp2.publicKey);
  assertNotEquals(kp1.privateKey, kp2.privateKey);
});

// ─── Import/export roundtrip ────────────────────────────────────────────────

Deno.test("keys - public key roundtrip preserves bytes", async () => {
  const kp = await generateKeyPair();
  const pubKey = await importPublicRaw(kp.publicKey);
  const exported = await exportPublicRaw(pubKey);
  assertEquals(exported, kp.publicKey);
});

Deno.test("keys - private key roundtrip preserves bytes", async () => {
  const kp = await generateKeyPair();
  const privKey = await importPrivateRaw(kp.privateKey);
  const exported = await exportPrivateRaw(privKey);
  assertEquals(exported, kp.privateKey);
});

// ─── sign/verify happy path ─────────────────────────────────────────────────

Deno.test("keys - sign then verify returns true", async () => {
  const kp = await generateKeyPair();
  const privKey = await importPrivateRaw(kp.privateKey);
  const pubKey = await importPublicRaw(kp.publicKey);
  const data = new TextEncoder().encode("hello world");
  const sig = await sign(privKey, data);
  const ok = await verify(pubKey, data, sig);
  assertEquals(ok, true);
});

Deno.test("keys - verify detects tampered data", async () => {
  const kp = await generateKeyPair();
  const privKey = await importPrivateRaw(kp.privateKey);
  const pubKey = await importPublicRaw(kp.publicKey);
  const data = new TextEncoder().encode("hello world");
  const sig = await sign(privKey, data);
  const tampered = new TextEncoder().encode("hello WORLD");
  const ok = await verify(pubKey, tampered, sig);
  assertEquals(ok, false);
});

Deno.test("keys - verify detects wrong key", async () => {
  const kp1 = await generateKeyPair();
  const kp2 = await generateKeyPair();
  const privKey = await importPrivateRaw(kp1.privateKey);
  const pubKey2 = await importPublicRaw(kp2.publicKey);
  const data = new TextEncoder().encode("hello");
  const sig = await sign(privKey, data);
  const ok = await verify(pubKey2, data, sig);
  assertEquals(ok, false);
});

Deno.test("keys - verify rejects wrong-length signature", async () => {
  const kp = await generateKeyPair();
  const pubKey = await importPublicRaw(kp.publicKey);
  const data = new TextEncoder().encode("hi");
  await assertRejects(
    () => verify(pubKey, data, "AAAA"),
    Error,
    "Ed25519 signature must be 64 bytes",
  );
});

// ─── fingerprint ────────────────────────────────────────────────────────────

Deno.test("keys - fingerprint is deterministic", async () => {
  const kp = await generateKeyPair();
  assertEquals(fingerprint(kp.publicKey), fingerprint(kp.publicKey));
});

Deno.test("keys - fingerprint has ed25519:XX:XX:XX:XX format", async () => {
  const kp = await generateKeyPair();
  const fp = fingerprint(kp.publicKey);
  assertEquals(/^ed25519:[0-9A-F]{2}(:[0-9A-F]{2}){3}$/.test(fp), true);
});

Deno.test("keys - fingerprintShort is 8 hex chars", async () => {
  const kp = await generateKeyPair();
  const short = fingerprintShort(kp.publicKey);
  assertEquals(short.length, 8);
  assertEquals(/^[0-9A-F]{8}$/.test(short), true);
});

Deno.test("keys - two different keys have different fingerprints", async () => {
  const kp1 = await generateKeyPair();
  const kp2 = await generateKeyPair();
  assertNotEquals(fingerprintShort(kp1.publicKey), fingerprintShort(kp2.publicKey));
});

// ─── buildKeyId / isValidKeyId ──────────────────────────────────────────────

Deno.test("buildKeyId - format is <author>-ed25519-<8hex>", async () => {
  const kp = await generateKeyPair();
  const keyId = buildKeyId("acme", kp.publicKey);
  assertEquals(isValidKeyId(keyId), true);
});

Deno.test("buildKeyId - sanitizes authorId (uppercase → lowercase, invalid → -)", async () => {
  const kp = await generateKeyPair();
  const keyId = buildKeyId("ACME Corp!", kp.publicKey);
  // "ACME Corp!" → lowercase "acme corp!" → each non-[a-z0-9-] replaced with "-"
  // Result: "acme-corp-" (space → -, ! → -)
  // Final: "acme-corp-" + "-ed25519-" + fingerprint = "acme-corp--ed25519-XXXXXXXX"
  assertEquals(keyId.startsWith("acme-corp--ed25519-"), true);
  assertEquals(/^[a-z0-9-]+-ed25519-[A-F0-9]{8}$/.test(keyId), true);
});

Deno.test("isValidKeyId - rejects wrong format", () => {
  assertEquals(isValidKeyId("not-a-key-id"), false);
  assertEquals(isValidKeyId("acme-ed25519-XX"), false); // too short
  assertEquals(isValidKeyId("acme-ed25519-AB12CD34XX"), false); // too long
  assertEquals(isValidKeyId("acme-rsa-AB12CD34"), false); // wrong alg
  assertEquals(isValidKeyId(""), false);
});

Deno.test("isValidKeyId - accepts well-formed keyId", () => {
  assertEquals(isValidKeyId("acme-ed25519-AB12CD34"), true);
  assertEquals(isValidKeyId("vendor-1-ed25519-00000000"), true);
});
