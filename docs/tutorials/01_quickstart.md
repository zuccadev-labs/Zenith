# Quickstart: un servidor Zenith y una app que lo usa

> Vigente a 2026-11-10. Comprobado contra el código: `zenith-cli/zen.ts`, `zenith-backend/src/traits/`
> y `sdk/Typescript/src/`. Sustituye a la versión anterior, que describía un servicio alojado
> (`api.zenith.io`, regiones, `@zenith/sdk-typescript`, SDK de Python) que no existe. La versión
> anterior sigue en el historial de git.

Zenith tiene dos SDK y este tutorial usa los dos:

- **SDK de servidor**: el motor `@zuccadev-labs/zenith` y el comando `zen`. Crean y ejecutan tu backend.
- **SDK de cliente**: `@zuccadev-labs/zenith-client`. Lo usa tu app para hablar con ese backend.

## 1. Requisitos

- Deno 2.4 o posterior.
- MongoDB. Para probar: `docker run -d --name zenith-mongo -p 27017:27017 --memory 1g mongo:9`.

## 2. Instalar `zen` (servidor)

```bash
deno install -g -A --unstable-kv -n zen jsr:@zuccadev-labs/zenith-cli/zen
```

Alternativa desde npm, que comprueba Deno y crea el proyecto del paso 3:
`npm create @zuccadev-labs/zenith miapp`.

> **Hasta que se publique:** desde un clon del monorepo,
> `alias zen="deno run -A --unstable-kv --config $PWD/zenith-cli/deno.json $PWD/zenith-cli/zen.ts"`.
> Los proyectos creados así enlazan el motor local de `zenith-backend/`.

## 3. Crear y arrancar el proyecto

```bash
zen init miapp
cd miapp
zen dev            # recarga en caliente en http://localhost:1337
```

`zen init` genera `zen.config.ts`, `cloud/main.ts`, `plugins/`, `deno.json`, `.gitignore` y un `.env`
con permisos 600 que contiene una master key aleatoria de 64 bytes y la URI de MongoDB. El `.env`
no se sube a git.

Comprueba que responde: `curl http://localhost:1337/health`. La API completa del proyecto está en
`http://localhost:1337/swagger`; `/openapi.json` documenta exactamente las rutas montadas.

## 4. Definir una clase (servidor, master key)

Por seguridad, `/classes` solo acepta clases definidas antes (ADR-014). Defínela con la master key,
que el servidor solo acepta desde localhost:

```bash
source .env
curl -X POST http://localhost:1337/schemas/Todo \
  -H "X-Parse-Application-Id: $ZENITH_APP_ID" \
  -H "X-Parse-Master-Key: $ZENITH_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fields": {"title": {"type": "String"}, "done": {"type": "Boolean"}}}'
```

## 5. Cloud code (servidor)

`cloud/main.ts`:

```ts
import { Zen } from "@zuccadev-labs/zenith";

Zen.Cloud.define("hello", (req) => ({ message: `hola ${req.params.name ?? "mundo"}` }));
Zen.Cloud.beforeSave("Todo", (req) => {
  if (!req.object.title) throw new Error("title es obligatorio");
});
```

`zen dev` recarga solo. Hoy las funciones cloud solo se pueden llamar con master key (ADR-013):

```bash
curl -X POST http://localhost:1337/functions/hello -H "X-Parse-Application-Id: $ZENITH_APP_ID" \
  -H "X-Parse-Master-Key: $ZENITH_MASTER_KEY" -H "Content-Type: application/json" -d '{"name":"zen"}'
```

## 6. Quién puede llamar a qué

| Credencial | Para | Cómo |
|---|---|---|
| Sesión de usuario | Apps de usuario final (navegador, móvil) | `ZenithUser.logIn`. Requiere engine-auth configurado (`engineAuth` en `zen.config.ts`, ADR-012); sin él, las rutas de usuario responden 503 |
| API key `sk_` | Backends de confianza | `zen api-keys create --name ci --env test`. El texto de la key se muestra una sola vez |
| API key `pk_` | Lectura pública | Solo hace lo que permiten sus scopes (por defecto, `data:read`): el servidor rechaza con 403 cualquier escritura |
| Master key | Administración, solo desde localhost | `.env`. Nunca en un cliente |

## 7. La app (cliente)

```bash
npm install @zuccadev-labs/zenith-client
```

> **Hasta que se publique:** `cd sdk/Typescript && npm run build`, y en tu app
> `npm install <ruta>/sdk/Typescript`.

```ts
import { Zenith, ZenithObject, ZenithQuery, ZenithUser } from "@zuccadev-labs/zenith-client";

Zenith.initialize({ appId: "miapp", serverURL: "http://localhost:1337" });

await ZenithUser.logIn("alice", "s3cret");      // sesión de usuario (paso 6)

const todo = new ZenithObject("Todo");
todo.set({ title: "Comprar leche", done: false });
await todo.save();                              // POST /classes/Todo

const pendientes = await new ZenithQuery("Todo").equalTo("done", false).limit(10).find();
```

Con React: `import { ZenithProvider, useZenithQuery } from "@zuccadev-labs/zenith-client/react"`.
Hay un ejemplo completo en `sdk/Typescript/example/vite-react-app`.

## 8. Producción

```bash
zen compile --output miapp-server   # un binario con cloud/ y plugins/ dentro
```

## Lo que todavía no funciona

Está documentado en `zenith-backend/docs/pending.md`:
- **Usuarios:** la recuperación de contraseña y la verificación de email responden 501.
- **Rutas solo con master key:** funciones cloud, archivos, LiveQuery y los módulos de negocio no se pueden usar desde un navegador.
