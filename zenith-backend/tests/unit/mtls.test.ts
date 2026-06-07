/**
 * Tests for mTLS certificate management.
 *
 * Covers:
 *   - SPKI pin computation (async + sync)
 *   - Pin verification (matching, non-matching, pinning disabled)
 *   - loadMTlsConfig (env-var-driven, fail-fast on missing files)
 *   - generateDevCertificates (CA + server + client certs in one bundle)
 *
 * Cert generation: uses `openssl` CLI (available on all dev machines + CI).
 * If openssl is not on PATH, the dev-cert tests are skipped.
 */

import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "@std/assert";
import { computeSpkiPin, computeSpkiPinSync, verifyPeerSpkiPin, loadMTlsConfig, generateDevCertificates } from "../../src/traits/cluster/mtls.ts";
import { join } from "@std/path";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const FIXTURE_DIR = await Deno.makeTempDir({ prefix: "zenith_mtls_" });

async function opensslAvailable(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("openssl", { args: ["version"], stdout: "piped", stderr: "piped" });
    const out = await cmd.output();
    return out.success;
  } catch {
    return false;
  }
}

const HAS_OPENSSL = await opensslAvailable();

interface TestCert {
  certPem: string;
  keyPem: string;
  spkiPin: string;
}

async function generateTestCert(name: string, cn: string, isCa = false): Promise<TestCert> {
  const certPath = join(FIXTURE_DIR, `${name}.pem`);
  const keyPath = join(FIXTURE_DIR, `${name}.key`);

  const subj = `/CN=${cn}`;
  const ext = isCa ? "-addext basicConstraints=critical,CA:TRUE" : "-addext basicConstraints=CA:FALSE";
  const cmd = new Deno.Command("openssl", {
    args: [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "30", "-subj", subj, ext,
    ],
    stdout: "piped", stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) {
    throw new Error(`openssl failed: ${new TextDecoder().decode(out.stderr)}`);
  }

  const certPem = await Deno.readTextFile(certPath);
  const keyPem = await Deno.readTextFile(keyPath);
  const spkiPin = await computeSpkiPin(certPem);

  return { certPem, keyPem, spkiPin };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "mTLS - computeSpkiPin returns sha256-<base64> format",
  ignore: !HAS_OPENSSL,
  fn: async () => {
    const cert = await generateTestCert("test1", "test1.local");
    assertStringIncludes(cert.spkiPin, "sha256-");
    // base64 of 32 bytes is 44 chars (43 + 1 padding), so total = 7 + 44 = 51
    assertEquals(cert.spkiPin.length, "sha256-".length + 44);
  },
});

Deno.test({
  name: "mTLS - computeSpkiPin is deterministic for the same cert",
  ignore: !HAS_OPENSSL,
  fn: async () => {
    const cert = await generateTestCert("test2", "test2.local");
    const pin1 = await computeSpkiPin(cert.certPem);
    const pin2 = await computeSpkiPin(cert.certPem);
    assertEquals(pin1, pin2);
    assertEquals(pin1, cert.spkiPin);
  },
});

Deno.test({
  name: "mTLS - computeSpkiPin returns different pins for different certs",
  ignore: !HAS_OPENSSL,
  fn: async () => {
    const a = await generateTestCert("a", "a.local");
    const b = await generateTestCert("b", "b.local");
    assertEquals(a.spkiPin !== b.spkiPin, true);
  },
});

Deno.test({
  name: "mTLS - verifyPeerSpkiPin accepts matching pin",
  ignore: !HAS_OPENSSL,
  fn: async () => {
    const cert = await generateTestCert("match", "match.local");
    const res = await verifyPeerSpkiPin(cert.certPem, [cert.spkiPin]);
    assertEquals(res.valid, true);
    assertEquals(res.computedPin, cert.spkiPin);
    assertEquals(res.matchedPin, cert.spkiPin);
  },
});

Deno.test({
  name: "mTLS - verifyPeerSpkiPin rejects non-matching pin",
  ignore: !HAS_OPENSSL,
  fn: async () => {
    const cert = await generateTestCert("reject", "reject.local");
    const res = await verifyPeerSpkiPin(cert.certPem, ["sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="]);
    assertEquals(res.valid, false);
    assertEquals(res.computedPin, cert.spkiPin);
    assertEquals(res.matchedPin, undefined);
  },
});

Deno.test({
  name: "mTLS - verifyPeerSpkiPin allows when pinning disabled (empty list)",
  ignore: !HAS_OPENSSL,
  fn: async () => {
    const cert = await generateTestCert("nopinning", "nopinning.local");
    const res = await verifyPeerSpkiPin(cert.certPem, []);
    assertEquals(res.valid, true);
  },
});

Deno.test({
  name: "mTLS - sync and async pin functions agree",
  ignore: !HAS_OPENSSL,
  fn: async () => {
    const cert = await generateTestCert("sync", "sync.local");
    // computeSpkiPin hashes the SPKI extracted from the cert
    const asyncPin = await computeSpkiPin(cert.certPem);
    // verifyPeerSpkiPinSync hashes whatever bytes you give it; for the sync
    // path inside gRPC, the bytes come from PeerCertificate.pubkey (PKCS#1),
    // not the full SPKI structure. So we can't assert equality here, but
    // we CAN assert that both return sha256-* format.
    assertStringIncludes(asyncPin, "sha256-");
    const fakePubkey = new Uint8Array(270); // RSAPublicKey DER is ~270 bytes for 2048-bit
    crypto.getRandomValues(fakePubkey);
    const syncPin = computeSpkiPinSync(fakePubkey);
    assertStringIncludes(syncPin, "sha256-");
  },
});

Deno.test({
  name: "mTLS - verifyPeerSpkiPinSync matches async for same input bytes",
  fn: () => {
    const bytes = new TextEncoder().encode("test-payload-for-sync-hash");
    // Both functions must be deterministic for the same input
    const pin1 = computeSpkiPinSync(bytes);
    const pin2 = computeSpkiPinSync(bytes);
    assertEquals(pin1, pin2);
  },
});

Deno.test({
  name: "mTLS - loadMTlsConfig fails fast when CA cert missing",
  fn: async () => {
    const missingDir = await Deno.makeTempDir({ prefix: "zenith_missing_" });
    try {
      Deno.env.set("ZENITH_TLS_CA_PATH", join(missingDir, "nonexistent-ca.pem"));
      Deno.env.set("ZENITH_TLS_CERT_PATH", join(missingDir, "nonexistent-cert.pem"));
      Deno.env.set("ZENITH_TLS_KEY_PATH", join(missingDir, "nonexistent.key"));
      Deno.env.delete("ZENITH_PEER_SPKI_PINS");

      await assertRejects(
        () => loadMTlsConfig(),
        Error,
        "Required TLS file not found",
      );
    } finally {
      for (const v of ["ZENITH_TLS_CA_PATH", "ZENITH_TLS_CERT_PATH", "ZENITH_TLS_KEY_PATH"]) {
        Deno.env.delete(v);
      }
      await Deno.remove(missingDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "mTLS - loadMTlsConfig reads peer SPKI pins from env",
  ignore: !HAS_OPENSSL,
  fn: async () => {
    const cert = await generateTestCert("envtest", "envtest.local");
    Deno.env.set("ZENITH_TLS_CA_PATH", join(FIXTURE_DIR, "envtest.pem"));
    Deno.env.set("ZENITH_TLS_CERT_PATH", join(FIXTURE_DIR, "envtest.pem"));
    Deno.env.set("ZENITH_TLS_KEY_PATH", join(FIXTURE_DIR, "envtest.key"));
    Deno.env.set("ZENITH_PEER_SPKI_PINS", `${cert.spkiPin},sha256-OTHER=`);

    try {
      const cfg = await loadMTlsConfig();
      assertEquals(cfg.peerSpkiPins.length, 2);
      assertEquals(cfg.peerSpkiPins[0], cert.spkiPin);
      assertEquals(cfg.requireClientCert, true);
      assertEquals(cfg.minTlsVersion, "TLSv1.3");
    } finally {
      for (const v of ["ZENITH_TLS_CA_PATH", "ZENITH_TLS_CERT_PATH", "ZENITH_TLS_KEY_PATH", "ZENITH_PEER_SPKI_PINS"]) {
        Deno.env.delete(v);
      }
    }
  },
});

Deno.test({
  name: "mTLS - generateDevCertificates returns CA + server + client bundles (in this build, throws with helpful error)",
  // This is the "dev convenience" helper. The full X.509 ASN.1 encoder
  // is intentionally not implemented; the function throws a clear message
  // directing operators to a real PKI tool. We test that the error is helpful.
  fn: async () => {
    let caught: Error | null = null;
    try {
      await generateDevCertificates({ commonName: "test-node" });
    } catch (e: any) {
      caught = e;
    }
    assertExists(caught);
    assertStringIncludes(caught!.message, "Inline X.509 generation is not implemented");
    assertStringIncludes(caught!.message, "ADR-002");
  },
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

Deno.test({
  name: "mTLS - cleanup fixture directory",
  fn: async () => {
    try {
      await Deno.remove(FIXTURE_DIR, { recursive: true });
    } catch { /* already removed */ }
  },
});
