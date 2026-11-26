# Zenith Plugin Marketplace — Design

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../../users/README.md).

> **Status:** Phase 4.0 design, not yet implemented.
> **Owner:** Platform lead, Product lead.

## 1. Goals

- **Discoverability:** customers can find vetted, high-quality plugins.
- **Trust:** every plugin is cryptographically signed and reviewed.
- **Versioning:** semantic versioning; clean upgrade paths.
- **Distribution:** no customer should ever `npm install` from a random
  registry; plugins ship through the marketplace.

## 2. Plugin package format

A plugin is a single tarball:

```
zenith-plugin-ecommerce-1.4.2.tpz
├── manifest.json       # signed by author (Ed25519)
├── signature.sig       # Ed25519 signature over manifest + code
├── code/
│   ├── plugin.ts
│   └── lib/
│       └── ...
├── README.md
├── LICENSE
├── CHANGELOG.md
├── icon.svg
└── screenshots/
    └── dashboard.png
```

`manifest.json` (signed portion, JCS canonical JSON):

```json
{
  "name": "ecommerce",
  "version": "1.4.2",
  "author": {
    "name": "ACME Corp",
    "publicKey": "ed25519:MCowBQYDK2VwAyEA...",
    "contact": "security@acme.com"
  },
  "permissions": [
    "data:read",
    "data:write:Order",
    "data:write:Cart",
    "files:read",
    "files:write",
    "email:send"
  ],
  "endpoints": [
    { "method": "POST", "path": "/cart/add", "scope": "data:write:Cart" },
    { "method": "POST", "path": "/checkout", "scope": "data:write:Order" }
  ],
  "runtime": "deno-v1",
  "engines": { "zenith": ">=1.0.0 <2.0.0" },
  "dependencies": [
    { "name": "@zenith/sdk-typescript", "version": "^1.0.0" }
  ],
  "size": 245760
}
```

## 3. Submission flow

```
1. Author builds the plugin
   zenith-cli plugin build --sign
   → produces ecommerce-1.4.2.tpz

2. Author submits to marketplace
   zenith-cli plugin publish --file ecommerce-1.4.2.tpz
   → uploads to https://marketplace.zenith.io/upload
   → triggers security scan (Trivy, Semgrep, custom)
   → runs in sandbox for 1 hour with synthetic data

3. Automated review (passes 90 % of submissions)
   - SBOM generated
   - No CRITICAL CVEs in dependencies
   - No disallowed imports (npm: blocked)
   - Manifest signature valid
   - Endpoints match scopes requested
   - Memory < 256 MB; CPU < 1 vCPU
   - No file system access outside /tmp
   - No network calls outside the allow-list

4. Human review (for paid plugins or first submission)
   - Security team reviews code
   - Product team reviews UX
   - Legal team reviews license + data handling

5. Approval
   - Plugin signed by Zenith root key (cosign)
   - Listed in marketplace with metadata

6. Customer installs
   zenith-cli plugin install ecommerce
   → downloads from marketplace
   → verifies Zenith signature
   → verifies author's signature
   → mounts in tenant's plugin runtime
```

## 4. Marketplace UI

A web app at `https://marketplace.zenith.io`:

- **Browse** by category (commerce, analytics, AI, dev tools, etc.).
- **Search** with full-text + faceted search.
- **Plugin page:** description, screenshots, permissions, pricing, reviews.
- **Install button:** one-click to install in a tenant.
- **Versioning:** show changelog per version.
- **Security:** show SBOM + last-scan date.

## 5. Trust tiers

| Tier           | Requirements                                          | Visibility |
| -------------- | ----------------------------------------------------- | ---------- |
| **Community**  | Author signed, automated review passed                | public     |
| **Verified**   | Community + human code review                         | featured   |
| **Certified**  | Verified + SOC 2 + signed SLA + 99.9 % uptime         | top        |
| **Enterprise** | Custom plugins, private to one tenant                 | private    |

## 6. Revenue sharing (planned)

- Author gets 70 % of the license fee.
- Zenith gets 30 % (covers hosting, review, support).
- Paid out monthly via Stripe Connect.

## 7. Phased rollout

| Phase | Scope                                                   |
| ----- | ------------------------------------------------------- |
| 4.0   | Internal-only marketplace; 5 plugins                    |
| 4.1   | Public marketplace; 20 vetted plugins                    |
| 4.2   | Paid plugins + revenue share                            |
| 4.3   | Enterprise private marketplaces                          |

## 8. Open questions

- How do we handle plugin dependency conflicts?
- Can a plugin depend on another plugin?
- How do we monetize free plugins (data, support, hosting)?
- How do we handle breaking changes in plugin dependencies?
