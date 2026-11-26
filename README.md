# Zenith

Backend como servicio (BaaS) para Deno, compatible con los SDK de Parse Server y construido sobre
[barrits](https://jsr.io/@zuccadev-labs/barrits): cada capacidad del motor es un trait que se enciende o se apaga en
la configuración del proyecto.

Los paquetes están publicados desde el 2026-11-19: el motor y el CLI en JSR, y el SDK de cliente y `create-zenith`
en npm. Las versiones están en [Publicación](docs/package/README.md).

## Dos SDK distintos: servidor y cliente

| | SDK de servidor | SDK de cliente |
|---|---|---|
| Para qué | Construir y ejecutar tu backend | Que una app (web, móvil, IoT) hable con un Zenith en marcha |
| Paquetes | `@zuccadev-labs/zenith` (el motor) y `@zuccadev-labs/zenith-cli` (el comando `zen`), en JSR | `@zuccadev-labs/zenith-client`, en npm |
| Dónde corre | Deno 2.4 o posterior | Navegador, Node, Deno y React |
| Crea proyectos | Sí, con `zen init` | No |
| Código | `zenith-backend/`, `zenith-cli/`, `create-zenith/` | `sdk/Typescript/` (las demás carpetas de `sdk/` están vacías) |

### Servidor

```bash
deno install -g -A --unstable-kv -n zen jsr:@zuccadev-labs/zenith-cli/zen   # o: npm create @zuccadev-labs/zenith miapp
zen init miapp
cd miapp && zen dev                                                          # http://localhost:1337
```

`zen init` crea el proyecto; el motor queda como dependencia y no se edita:

```
miapp/
├── zen.config.ts   configuración de la app (lee .env)
├── cloud/main.ts   Cloud Code: Zen.Cloud.define(...), triggers
├── plugins/        plugins propios (verificados contra plugins.lock.json)
├── .env            secretos: master key aleatoria, URI de MongoDB (no se sube a git)
└── deno.json       @zuccadev-labs/zenith → el motor
```

### Cliente

```ts
import { Zenith, ZenithObject, ZenithQuery } from "@zuccadev-labs/zenith-client";

Zenith.initialize({ appId: "miapp", serverURL: "http://localhost:1337" });
```

El recorrido completo, con lo que el servidor exige antes (clases, usuarios, keys), está en
[Primeros pasos](docs/users/01-primeros-pasos.md).

## Antes de usarlo en serio

- La master key solo vale desde localhost, y casi todas las rutas fuera de `/classes`, `/batch` y las de usuarios
  son solo para ella ([Acceso y API keys](docs/users/04-acceso-y-api-keys.md)).
- Los usuarios viven en engine-auth: sin `engineAuth` configurado, las rutas de usuario responden 503.
- LiveQuery por WebSocket y la sala de medios del SDK de cliente no funcionan hoy. Esto y lo demás que falta está
  en [Lo que falta](docs/development/10-lo-que-falta.md).

## Repositorio

| Carpeta | Contenido |
|---|---|
| `zenith-backend/` | El motor: traits, pipeline de seguridad y adaptadores. [README](zenith-backend/README.md) |
| `zenith-cli/` | `zen`: init, dev, compile, generate, api-keys… [README](zenith-cli/README.md) |
| `create-zenith/` | `npm create @zuccadev-labs/zenith`: comprueba Deno y llama a `zen init` |
| `sdk/Typescript/` | SDK de cliente y un ejemplo con Vite y React. [README](sdk/Typescript/README.md) |
| `docs/` | Documentación, por áreas: [uso](docs/users/README.md), [desarrollo](docs/development/README.md), [investigación](docs/investigations/README.md), [publicación](docs/package/README.md) y [agentes](docs/agents/README.md) |
| `site/` | Configuración del sitio de documentación (zudocs) y la referencia de la API generada |
| `lab-infra/` | Laboratorio con todos los servicios (Proxmox y Docker). [Recrearlo](docs/development/07-laboratorio.md) |
| `k8s/`, `infra/`, `observability/` | Chart de Helm, registro de imágenes, Terraform y dashboards |

Para agentes de IA: `AGENTS.md`. Seguridad: `SECURITY.md`.

## Licencia

MIT. Ver [LICENSE](LICENSE).
