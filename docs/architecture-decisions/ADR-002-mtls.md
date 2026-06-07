# ADR-002: mTLS with SPKI Pinning for Inter-Node Federation

**Status:** Accepted (Phase 0.C)
**Date:** 2026-06-06
**Deciders:** Zenith Security Audit Team

## Context

The gRPC transport between Zenith nodes (`src/traits/cluster/grpc.trait.ts`)
was using `grpc.ServerCredentials.createInsecure()` and
`grpc.ChannelCredentials.createInsecure()`. This means:

- All inter-node RPCs (federation, replication, job queue dispatch) traversed
  the network in cleartext.
- Any attacker with network access to the cluster (e.g., compromised pod
  sidecar, malicious CNI plugin, lateral movement after a perimeter breach)
  could read and modify cluster traffic.
- Any compromised cert from any CA in the trust store could impersonate
  any node — there was no peer authentication.

This violates the CWE-300 (Cleartext Transmission of Sensitive Information)
and CWE-295 (Improper Certificate Validation) requirements expected of a
Fortune 500 BaaS.

## Decision

We adopt **mTLS (mutual TLS) with SPKI pinning** as the default transport
security for all inter-node gRPC communication.

### 1. Certificate provisioning

Production deployments use a real private CA:
- HashiCorp Vault PKI engine (preferred for self-hosted)
- cert-manager (preferred for Kubernetes)
- AWS Private CA (preferred for AWS-native)
- Smallstep step-ca (lightweight alternative)

Each node receives a server cert + client cert, both signed by the same CA.
Certs are mounted at:
- `ZENITH_TLS_CA_PATH`    (default: `/etc/zenith/tls/ca.pem`)
- `ZENITH_TLS_CERT_PATH`  (default: `/etc/zenith/tls/node.pem`)
- `ZENITH_TLS_KEY_PATH`   (default: `/etc/zenith/tls/node.key`)

The CA file is shared across all nodes; per-node certs are unique.

### 2. TLS configuration

| Setting | Value | Rationale |
|---|---|---|
| Minimum TLS version | 1.3 | Disables 1.0/1.1 ciphers; PFS mandatory |
| Client cert required | `true` | mTLS (mutual authentication) |
| Server cert chain validation | `rejectUnauthorized: true` | Refuse self-signed or untrusted CAs |
| Cipher suites | OS default for TLS 1.3 | AES-256-GCM + ChaCha20-Poly1305 |

### 3. SPKI pinning (defense vs. compromised CA)

Each peer (server) has its SPKI hash pre-distributed via
`ZENITH_PEER_SPKI_PINS` — a comma-separated list of
`sha256-<base64>` SPKI fingerprints of trusted peers.

**Client-side enforcement** (handshake-time, strongest):
Implemented via `grpc.credentials.createSsl(rootCerts, key, cert, {
checkServerIdentity })`. After the standard chain validation, the callback
hashes the peer's `PeerCertificate.pubkey` (PKCS#1 RSAPublicKey DER) and
compares against the allowlist. A mismatch aborts the handshake.

**Server-side enforcement** (post-handshake, best-effort):
The `@grpc/grpc-js` library's `ServerCredentials.createSsl()` only accepts a
**boolean** for `checkClientCertificate` — it has no callback hook for
custom verification. This is a library limitation, not a protocol limitation.

Workarounds, in order of preference:
1. **Deploy behind an Envoy/Istio sidecar** that enforces SPKI pinning via
   `verify_certificate_spki` filter. This is the production recommendation.
2. **Use the secondary auth factor**: the `Call` handler already requires a
   signed JWT in the `auth-header` metadata. A compromised cert alone is
   insufficient to authenticate.
3. **Future**: when `@grpc/grpc-js` adds a `verifyClientCert` callback (the
   Node.js native `tls.createSecureServer` API supports it; the gRPC JS
   binding does not yet), upgrade to handshake-time enforcement.

### 4. Dev mode

`zenith mtls:gen-dev` generates a private CA + server cert + client cert
using the system `openssl` CLI. Certs are valid for 30 days, with SANs
covering `localhost`, `127.0.0.1`, `::1`. The command prints the server
SPKI pin so it can be exported as `ZENITH_PEER_SPKI_PINS`.

In dev only, if no certs are provisioned, the gRPC server falls back to
insecure mode with a loud warning. Production (`--mode=production`) refuses
to start without mTLS.

## Consequences

### Positive
- Inter-node traffic is encrypted and authenticated.
- A compromised node cert only works until its next rotation (90 days).
- A compromised CA cannot impersonate a peer whose SPKI is pinned.
- All mTLS config is fail-closed (CWE-798 regression: no `unsafe_default_`).

### Negative / Risks
- Cert rotation requires updating `ZENITH_PEER_SPKI_PINS` on every node.
  Mitigated by short cert lifetimes (90 days) and the `mtls:gen-dev` script.
- Server-side SPKI pinning requires a sidecar in production. The audit log
  records any client cert that fails the chain validation.
- Dev experience is slightly more involved (must run `mtls:gen-dev` once).

### Operational
- Cert rotation is manual today. A future ADR will introduce a rotation
  controller that watches the CA and updates `ZENITH_PEER_SPKI_PINS` via
  a config map reload.
- All mTLS events (handshake success/failure, cert expiry warnings) emit
  structured logs to the existing observability trait.

## Alternatives Considered

| Alternative | Rejected because |
|---|---|
| TLS only (no mTLS) | Doesn't authenticate the client; node impersonation still possible |
| IP allowlists | Breaks dynamic infra (k8s pods come and go) |
| Service mesh only (Istio/Linkerd) | Doesn't solve the case of two Zenith nodes in the same pod |
| WireGuard mesh | Operationally complex; doesn't help if the host is compromised |
| Custom PKI in Deno | Reinventing the wheel; Vault/cert-manager exist |

## References

- RFC 5246 (TLS 1.2) and RFC 8446 (TLS 1.3)
- RFC 7469 (Public Key Pinning Extension for HTTP, expired but SPKI pin format reused)
- OWASP Transport Layer Protection Cheat Sheet
- NIST SP 800-52 Rev. 2 (Guidelines for the Selection, Configuration, and Use of TLS Implementations)
