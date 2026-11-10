# Zenith

Backend como servicio (BaaS) para Deno, compatible con los SDK de Parse Server y construido sobre
[barrits](https://jsr.io/@zuccadev-labs/barrits): cada capacidad del motor es un trait que se compone
según la configuración del proyecto.

> **Estado (2026-11-10):** ningún paquete está publicado todavía. Todo se usa desde este monorepo;
> los nombres y comandos de abajo son los definitivos y ya pasan la publicación simulada.

## Dos SDK distintos: servidor y cliente

| | SDK de servidor | SDK de cliente |
|---|---|---|
| Para qué | Construir y ejecutar **tu** backend Zenith | Que una app (web, móvil, IoT) hable con un Zenith en marcha |
| Paquetes | `@zuccadev-labs/zenith` (el motor, JSR) y `@zuccadev-labs/zenith-cli` (el comando `zen`, JSR) | `@zuccadev-labs/zenith-client` (TypeScript/JavaScript, npm) |
| Dónde corre | Deno 2.4 o posterior | Navegador, Node, Deno, React |
| Crea un proyecto | Sí: `zen init` | No, nunca |
| Código | `zenith-backend/`, `zenith-cli/`, `create-zenith/` | `sdk/Typescript/` (las demás carpetas de `sdk/` están vacías) |

### Servidor: crear un proyecto

```bash
deno install -g -A --unstable-kv -n zen jsr:@zuccadev-labs/zenith-cli/zen   # o: npm create @zuccadev-labs/zenith miapp
zen init miapp
cd miapp && zen dev                                                          # http://localhost:1337
```

`zen init` crea la estructura del proyecto; el motor queda como dependencia y no se edita:

```
miapp/
├── zen.config.ts   configuración de la app (lee .env)
├── cloud/main.ts   cloud code: Zen.Cloud.define(...), triggers
├── plugins/        plugins propios (verificados contra plugins.lock.json)
├── .env            secretos: master key aleatoria, URI de MongoDB (no se sube a git)
└── deno.json       @zuccadev-labs/zenith → el motor
```

Hasta que se publique, desde este repositorio: `deno run -A --config zenith-cli/deno.json zenith-cli/zen.ts init miapp`
(el proyecto enlaza el motor de `zenith-backend/`).

### Cliente: usar un servidor

```ts
import { Zenith, ZenithObject, ZenithQuery } from "@zuccadev-labs/zenith-client";

Zenith.initialize({ appId: "miapp", serverURL: "http://localhost:1337" });
```

Guía completa, con lo que exige el servidor antes (clases, usuarios, keys): [docs/tutorials/01_quickstart.md](docs/tutorials/01_quickstart.md).

## Repositorio

| Carpeta | Contenido |
|---|---|
| `zenith-backend/` | El motor: traits, pipeline de seguridad, adaptadores. [README](zenith-backend/README.md) |
| `zenith-cli/` | `zen` / `zenith`: init, dev, compile, generate, api-keys… [README](zenith-cli/README.md) |
| `create-zenith/` | `npm create @zuccadev-labs/zenith`: comprueba Deno y llama a `zen init` |
| `sdk/Typescript/` | SDK de cliente y un ejemplo con Vite y React. [README](sdk/Typescript/README.md) |
| `docs/` | Documentación. Empieza por [docs/index.md](docs/index.md): indica qué documentos están vigentes |
| `lab-infra/` | Laboratorio con todos los servicios (Proxmox y Docker). [Recrearlo](lab-infra/docs/recrear-desde-cero.md) |

## Licencia

MIT. Ver [LICENSE](LICENSE).
