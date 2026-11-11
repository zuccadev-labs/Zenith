/**
 * @module @zenith/cli/commands/mtls-gen-dev
 *
 * Generate ephemeral mTLS certs for local development.
 *
 * Generates a private CA + a server cert + a client cert, all signed by the CA,
 * and prints the SPKI pin of the server cert (so it can be set in
 * ZENITH_PEER_SPKI_PINS for SPKI pinning).
 *
 * ⚠️  NEVER USE THESE CERTS IN PRODUCTION. They are self-signed, 30-day
 * validity, and offer no revocation path. For production, use:
 *   - HashiCorp Vault PKI engine
 *   - cert-manager (Kubernetes)
 *   - AWS Private CA
 *   - Smallstep step-ca
 *
 * Usage:
 *   zenith mtls:gen-dev [--out <dir>] [--cn <name>] [--days <N>]
 *
 * Output:
 *   <out>/ca.pem       CA cert (PEM)
 *   <out>/server.pem   Server cert (PEM)
 *   <out>/server.key   Server private key (PEM)
 *   <out>/client.pem   Client cert (PEM)
 *   <out>/client.key   Client private key (PEM)
 *   stdout:            "SPKI pin of server cert: sha256-..."
 */

import { join } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";

async function runOpenssl(args: string[]): Promise<string> {
  const cmd = new Deno.Command("openssl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr);
    throw new Error(`openssl ${args[0]} ${args[1]} failed: ${stderr}`);
  }
  return new TextDecoder().decode(out.stdout);
}

async function opensslAvailable(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("openssl", { args: ["version"], stdout: "null", stderr: "null" });
    const out = await cmd.output();
    return out.success;
  } catch {
    return false;
  }
}

async function extractSpkiPin(certPath: string): Promise<string> {
  // openssl x509 -pubkey -noout produces a PEM-encoded public key (SPKI).
  // Then we hash it with openssl dgst -sha256 -binary | base64.
  const pubkey = await runOpenssl(["x509", "-in", certPath, "-pubkey", "-noout"]);
  const spkiPem = pubkey.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/)?.[0];
  if (!spkiPem) throw new Error("Could not extract public key from cert");

  const tmpKey = await Deno.makeTempFile({ suffix: ".pub" });
  try {
    await Deno.writeTextFile(tmpKey, spkiPem);
    const hashB64 = await runOpenssl(["dgst", "-sha256", "-binary", tmpKey]);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(new TextEncoder().encode(hashB64))));
    return `sha256-${b64}`;
  } finally {
    await Deno.remove(tmpKey);
  }
}

export async function runMtlsGenDev(argv: string[] = Deno.args): Promise<void> {
  if (!(await opensslAvailable())) {
    console.error("❌ openssl not found on PATH.");
    console.error("");
    console.error("Install OpenSSL:");
    console.error(
      "  Windows:  choco install openssl   OR   download from https://slproweb.com/products/Win32OpenSSL.html",
    );
    console.error("  macOS:    brew install openssl");
    console.error("  Linux:    sudo apt install openssl  (Debian/Ubuntu)");
    console.error("            sudo dnf install openssl  (Fedora)");
    console.error("");
    console.error("Or use a real PKI for development:");
    console.error("  - mkcert (https://github.com/FiloSottile/mkcert)");
    console.error("  - step-ca (https://smallstep.com/certificates/)");
    Deno.exit(1);
  }

  const args = parseArgs(argv, {
    string: ["out", "cn", "days"],
    default: { out: "./.zenith-tls", cn: "zenith-dev-node", days: "30" },
  });

  const outDir = args.out!;
  const cn = args.cn!;
  const days = args.days!;

  await Deno.mkdir(outDir, { recursive: true });

  const caKey = join(outDir, "ca.key");
  const caPem = join(outDir, "ca.pem");
  const serverKey = join(outDir, "server.key");
  const serverPem = join(outDir, "server.pem");
  const serverCsr = join(outDir, "server.csr");
  const serverExt = join(outDir, "server.ext");
  const clientKey = join(outDir, "client.key");
  const clientPem = join(outDir, "client.pem");
  const clientCsr = join(outDir, "client.csr");
  const clientExt = join(outDir, "client.ext");

  // Step 1: CA key + self-signed CA cert
  await runOpenssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:4096",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caPem,
    "-days",
    "365",
    "-subj",
    "/CN=Zenith Dev CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE,pathlen:0",
  ]);
  console.log(`✅ CA cert:           ${caPem}`);

  // Step 2: Server key + CSR
  await runOpenssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    serverKey,
    "-out",
    serverCsr,
    "-subj",
    `/CN=${cn}`,
  ]);

  // Server SAN config (localhost, 127.0.0.1, ::1)
  await Deno.writeTextFile(
    serverExt,
    `authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${cn}
DNS.2 = localhost
IP.1  = 127.0.0.1
IP.2  = ::1
`,
  );

  // Step 3: Sign server cert with CA
  await runOpenssl([
    "x509",
    "-req",
    "-in",
    serverCsr,
    "-CA",
    caPem,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    serverPem,
    "-days",
    days,
    "-extfile",
    serverExt,
  ]);
  console.log(`✅ Server cert:       ${serverPem}`);
  console.log(`✅ Server key:        ${serverKey}`);

  // Step 4: Client key + CSR
  await runOpenssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    clientKey,
    "-out",
    clientCsr,
    "-subj",
    `/CN=${cn}-client`,
  ]);

  await Deno.writeTextFile(
    clientExt,
    `authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
subjectAltName = DNS:${cn}-client
`,
  );

  // Step 5: Sign client cert with CA
  await runOpenssl([
    "x509",
    "-req",
    "-in",
    clientCsr,
    "-CA",
    caPem,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    clientPem,
    "-days",
    days,
    "-extfile",
    clientExt,
  ]);
  console.log(`✅ Client cert:       ${clientPem}`);
  console.log(`✅ Client key:        ${clientKey}`);

  // Step 6: Compute and print server SPKI pin
  const serverPin = await extractSpkiPin(serverPem);
  console.log("");
  console.log("🔐 Server SPKI pin (set as ZENITH_PEER_SPKI_PINS):");
  console.log(`   ${serverPin}`);
  console.log("");
  console.log("📋 Env vars to set:");
  console.log(`   export ZENITH_TLS_CA_PATH="${caPem.replace(/\\/g, "/")}"`);
  console.log(`   export ZENITH_TLS_CERT_PATH="${serverPem.replace(/\\/g, "/")}"`);
  console.log(`   export ZENITH_TLS_KEY_PATH="${serverKey.replace(/\\/g, "/")}"`);
  console.log(`   export ZENITH_PEER_SPKI_PINS="${serverPin}"`);
  console.log("");
  console.log("⚠️  DEV ONLY. These certs are self-signed and have no revocation path.");

  // Cleanup CSR + ext files
  for (const f of [serverCsr, serverExt, clientCsr, clientExt, `${caPem}.srl`]) {
    try {
      await Deno.remove(f);
    } catch { /* ignore */ }
  }
}

if (import.meta.main) {
  await runMtlsGenDev();
}

/** Registry entry point (args after "mtls-gen-dev"). */
export const run = (args: string[]) => runMtlsGenDev(args);
