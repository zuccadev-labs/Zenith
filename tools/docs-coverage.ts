/**
 * Compares what Zenith has with what its documentation says.
 *
 * Fails (exit code 1) when:
 *   - the API reference in site/static/reference is not the one the engine would generate today
 *     (routes added or removed without running `zen generate docs`);
 *   - an engine error code is not in docs/users/09-errores.md, or the access breakdown of
 *     docs/users/08-referencia-de-la-api.md is not the real one;
 *   - a current document gives a route count ("241 rutas") that is not the real one;
 *   - a `zen` command is not in the CLI reference (docs/users/12-cli-zen.md), or the reference lists one that
 *     does not exist;
 *   - a feature of the catalog (`src/traits/catalog.ts`) is not in docs/users/05-piezas-y-motores.md, or that
 *     document gives a feature id that does not exist;
 *   - an export of a published package is not named in its README or in the user docs;
 *   - the version of a published package is not the one docs/package/README.md gives;
 *   - a relative link of a README, AGENTS.md, SECURITY.md or CHANGELOG.md points to a file that does not exist
 *     (the links inside docs/ are checked by `zudocs verify`);
 *   - a versioned document or the site config carries an absolute local path.
 *
 * Usage: deno run -A --unstable-kv --config zenith-backend/deno.json tools/docs-coverage.ts
 */
import { generateProjectOpenApi } from "../zenith-backend/src/openapi.ts";
import { FEATURE_CATALOG } from "../zenith-backend/src/traits/catalog.ts";
import { commandTable } from "../zenith-cli/commands/registry.ts";

const root = new URL("..", import.meta.url);
const path = (p: string) => new URL(p, root);
const read = (p: string) => Deno.readTextFileSync(path(p));
const exists = (p: string | URL) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of Deno.readDirSync(path(dir))) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) walk(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
};
const escapeRe = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
const word = (name: string) => new RegExp(`(^|[^\\w-])${escapeRe(name)}(?![\\w-])`);

const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

/** Documents presented as current. Archives, investigations, ADRs and changelogs tell the past. */
const allDocs = walk("docs");
const current = [
  "README.md",
  "AGENTS.md",
  "zenith-backend/README.md",
  "zenith-cli/README.md",
  "sdk/Typescript/README.md",
  "create-zenith/README.md",
  ...allDocs.filter((f) => !f.includes("/archivo/") && !f.startsWith("docs/investigations/")),
].filter((f) => exists(path(f)));
const text: Record<string, string> = Object.fromEntries(current.map((f) => [f, read(f)]));

// 1. The API reference is the one the engine generates.
const routesOf = (spec: Record<string, unknown>) =>
  new Set(
    Object.entries(spec.paths as Record<string, Record<string, unknown>>).flatMap(([p, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)
    ),
  );
const live = routesOf(generateProjectOpenApi({ appId: "miapp" }));
const committed = routesOf(JSON.parse(read("site/static/reference/openapi.json")));
const added = [...live].filter((r) => !committed.has(r));
const removed = [...committed].filter((r) => !live.has(r));
if (added.length || removed.length) {
  fail(
    `site/static/reference/openapi.json está desfasada (${added.length} rutas nuevas, ${removed.length} retiradas: ` +
      `${[...added, ...removed].slice(0, 6).join(", ")}…). Regenérala: ` +
      "zen generate docs --out site/static/reference --app-id miapp, desde una carpeta sin zen.config.ts",
  );
}

// 2. Route counts in current documents.
for (const [f, t] of Object.entries(text)) {
  for (const m of t.matchAll(/(\d{3}) rutas/g)) {
    if (Number(m[1]) !== live.size) {
      fail(`${f}: dice "${m[0]}"; con las features por defecto son ${live.size}`);
    }
  }
}

// 2b. The access breakdown in the API reference document.
{
  const spec = generateProjectOpenApi({ appId: "miapp" }) as {
    paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>>;
  };
  const count = { master: 0, user: 0, public: 0 };
  for (const ops of Object.values(spec.paths)) {
    for (const op of Object.values(ops)) {
      const names = (op.security ?? []).flatMap((s) => Object.keys(s));
      if (names.includes("masterKey")) count.master++;
      else if (names.length) count.user++;
      else count.public++;
    }
  }
  const doc = "docs/users/08-referencia-de-la-api.md";
  const m = text[doc]?.match(/(\d+) son `master`, (\d+) son `user` y (\d+) son públicas/);
  if (!m) fail(`${doc}: falta la frase "N son \`master\`, N son \`user\` y N son públicas"`);
  else if (+m[1] !== count.master || +m[2] !== count.user || +m[3] !== count.public) {
    fail(
      `${doc}: dice ${m[1]}/${m[2]}/${
        m[3]
      } (master/user/public); son ${count.master}/${count.user}/${count.public}`,
    );
  }
}

// 3. zen commands in the CLI reference.
const cliDoc = "docs/users/12-cli-zen.md";
const commands = [...new Set([...commandTable().values()].map((c) => c.name))];
if (!text[cliDoc]) fail(`${cliDoc} no existe`);
else {
  const missing = commands.filter((c) =>
    !word(`zen ${c}`).test(text[cliDoc]) && !word(`\`${c}`).test(text[cliDoc])
  );
  if (missing.length) {
    fail(`${cliDoc}: no nombra ${missing.length} comando(s): ${missing.join(", ")}`);
  }
  const listed = [...text[cliDoc].matchAll(/^\| `([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
  const unknown = listed.filter((c) => !commandTable().has(c));
  if (unknown.length) fail(`${cliDoc}: lista comandos que no existen: ${unknown.join(", ")}`);
}

// 4. Catalog features in the features guide.
const featuresDoc = "docs/users/05-piezas-y-motores.md";
const ids = FEATURE_CATALOG.map((e) => e.id);
const keys = new Set([
  ...ids,
  ...FEATURE_CATALOG.map((e) => e.feature).filter(Boolean) as string[],
]);
if (!text[featuresDoc]) fail(`${featuresDoc} no existe`);
else {
  const missing = ids.filter((id) => !word(`\`${id}\``).test(text[featuresDoc]));
  if (missing.length) {
    fail(
      `${featuresDoc}: no nombra ${missing.length} pieza(s) del catálogo: ${missing.join(", ")}`,
    );
  }
  // The catalog table is the one whose header starts with "| Pieza |".
  const table = text[featuresDoc].split(/^\| Pieza \|.*$/m)[1]?.split(/\n(?!\|)/)[0] ?? "";
  const catalogRows = [...table.matchAll(/^\| `([A-Za-z0-9_.]+)` \|/gm)].map((m) => m[1]);
  if (!catalogRows.length) {
    fail(`${featuresDoc}: no tiene la tabla del catálogo (cabecera "| Pieza |")`);
  }
  const unknown = catalogRows.filter((id) => !keys.has(id));
  if (unknown.length) {
    fail(`${featuresDoc}: lista piezas que no están en el catálogo: ${unknown.join(", ")}`);
  }
}

// 4b. Error codes in the error reference.
{
  const errorsDoc = "docs/users/09-errores.md";
  const enumSrc = read("zenith-backend/src/core/errors.ts");
  const body = enumSrc.slice(enumSrc.indexOf("export enum ZenithErrorCode"));
  const codes = [...body.slice(0, body.indexOf("}")).matchAll(/^\s+([A-Z_]+)\s*=\s*(\d+)/gm)];
  for (const [, name, code] of codes) {
    if (!new RegExp(`\\| \`${name}\` \\| ${code} \\|`).test(text[errorsDoc] ?? "")) {
      fail(`${errorsDoc}: falta ${name} (${code})`);
    }
  }
}

// 5. Exports and versions of the published packages.
const pkgDoc = "docs/package/README.md";
const userText = Object.entries(text).filter(([f]) => f.startsWith("docs/users/")).map(([, t]) => t)
  .join("\n");
const packages = [
  { dir: "zenith-backend", manifest: "deno.json" },
  { dir: "zenith-cli", manifest: "deno.json" },
  { dir: "sdk/Typescript", manifest: "package.json" },
  { dir: "create-zenith", manifest: "package.json" },
];
for (const { dir, manifest } of packages) {
  const m = JSON.parse(read(`${dir}/${manifest}`));
  const readme = text[`${dir}/README.md`] ?? "";
  for (const sub of Object.keys(m.exports ?? {})) {
    const spec = sub === "." ? m.name : `${m.name}${sub.slice(1)}`;
    if (!readme.includes(spec) && !userText.includes(spec)) {
      fail(`${spec} (export de ${dir}) no aparece en ${dir}/README.md ni en docs/users`);
    }
  }
  if (!text[pkgDoc]) continue;
  if (
    !new RegExp(`${escapeRe(m.name)}\`?\\s*\\|\\s*\`?${escapeRe(m.version)}`).test(text[pkgDoc])
  ) {
    fail(`${pkgDoc}: la fila de ${m.name} no da la versión ${m.version}`);
  }
}
if (!text[pkgDoc]) fail(`${pkgDoc} no existe`);

// 6. Relative links outside docs/.
const linked = [
  ...current.filter((f) => !f.startsWith("docs/")),
  "SECURITY.md",
  "CHANGELOG.md",
  "lab-infra/README.md",
  "k8s/helm/zenith/README.md",
  "infra/terraform/README.md",
].filter((f) => exists(path(f)));
for (const f of linked) {
  const t = read(f).replace(/```[\s\S]*?```/g, "");
  for (const m of t.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const target = new URL(href.split("#")[0], path(f));
    if (!exists(target)) fail(`${f}: enlace roto "${href}"`);
  }
}

// 7. No absolute local paths in what is versioned.
const privatePath =
  /(file:\/\/\/|\/home\/[a-z]|\/media\/[a-z]|\/Users\/[A-Za-z]|\b[A-Z]:[\\/](?!Windows|Program Files)[A-Za-z])/;
for (const f of [...allDocs, ...linked, "site/zudocs.config.json"]) {
  const lines = read(f).split("\n");
  lines.forEach((l, i) => {
    if (privatePath.test(l)) fail(`${f}:${i + 1}: ruta absoluta local`);
  });
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join("\n"));
  console.error(`\ndocs-coverage: ${errors.length} problema(s)`);
  Deno.exit(1);
}
console.log(
  `docs-coverage: ${live.size} rutas, ${commands.length} comandos de zen, ${ids.length} piezas y ${packages.length} paquetes documentados`,
);
