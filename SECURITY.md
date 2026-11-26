# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub:
**Security → Report a vulnerability** in this repository (private vulnerability reporting).

Include what is affected (package and version: `@zuccadev-labs/zenith`, `@zuccadev-labs/zenith-cli`,
`@zuccadev-labs/zenith-client`, `@zuccadev-labs/create-zenith`, or the server image), how to reproduce it and its
impact. You will get an answer within 7 days; a fix and an advisory follow once it is confirmed.

## Supported versions

Only the latest release of each package receives security fixes while the project is below 1.0.

## Supply chain

Releases are built by CI from this repository. The server image is signed with cosign (`zenith-backend/cosign.pub`)
and carries SLSA provenance and a CycloneDX SBOM; see `docs/development/05-cadena-de-suministro.md`.
