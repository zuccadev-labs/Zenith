# @zuccadev-labs/create-zenith

```bash
npm create @zuccadev-labs/zenith myapp
```

Creates a Zenith **server** project (the `zen init` structure: `zen.config.ts`, `cloud/`, `plugins/`,
`.env`, `deno.json`). Zenith's server runs on Deno, so this package only checks that Deno 2.4+ is
installed and runs `zen init` from JSR (`jsr:@zuccadev-labs/zenith-cli/zen`). If Deno is missing it
explains how to install it; it never runs an installer by itself.

For an app that talks to a Zenith server, install the client SDK instead:
`npm install @zuccadev-labs/zenith-client`.

## License

MIT
