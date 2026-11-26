---
description: "Un servidor Zenith con zen y una app que lo usa con el SDK de cliente, en unos quince minutos."
tipo: tutorial
---

# ¿Cómo levanto un servidor y le hablo desde una app?

Con `zen init` y `zen dev` tienes un servidor en `http://localhost:1337`; con `@zuccadev-labs/zenith-client`, una
app que guarda y consulta objetos en él. El recorrido entero lleva unos quince minutos.

## Qué vas a construir

Un backend con una clase `Todo`, una función de Cloud Code y un trigger, y un script de cliente que inicia sesión,
crea una tarea y la consulta.

## Antes de empezar

- Deno 2.4 o posterior.
- MongoDB. Para probar: `docker run -d --name zenith-mongo -p 27017:27017 --memory 1g mongo:9`.
- Para el paso 7, un engine-auth al que apunte `engineAuth` en `zen.config.ts` (ver
  [Usuarios y sesiones](./02-usuarios-y-sesiones.md)). Sin él, el resto funciona y las rutas de usuario responden
  503.

## Paso 1: instalar `zen`

```bash
deno install -g -A --unstable-kv -n zen jsr:@zuccadev-labs/zenith-cli/zen
```

Desde npm hay un atajo que comprueba que tienes Deno y crea el proyecto del paso 2:
`npm create @zuccadev-labs/zenith miapp`.

Desde un clon del repositorio, sin instalar nada:

```bash
alias zen="deno run -A --unstable-kv --config $PWD/zenith-cli/deno.json $PWD/zenith-cli/zen.ts"
```

Un proyecto creado así enlaza el motor de `zenith-backend/` en lugar del publicado. `ZENITH_ENGINE=jsr` o
`ZENITH_ENGINE=local` fuerzan uno u otro.

## Paso 2: crear el proyecto y arrancarlo

```bash
zen init miapp
cd miapp
zen dev
```

`zen init` genera `zen.config.ts`, `cloud/main.ts`, `plugins/`, `deno.json`, `.gitignore` y un `.env` con permisos
600 que lleva una master key aleatoria de 64 bytes y la URI de MongoDB. El `.env` no se sube a git. Nunca
sobrescribe un proyecto que ya existe.

Resultado esperado:

```bash
curl http://localhost:1337/health
```

responde, y `http://localhost:1337/swagger` muestra la API del proyecto. `/openapi.json` documenta exactamente las
rutas que ha montado el router.

## Paso 3: definir una clase

`/classes` solo acepta clases definidas antes ([ADR-014](../investigations/adr/14-classes-for-users.md)). Se
definen con la master key, que el servidor solo acepta desde localhost:

```bash
source .env
curl -X POST http://localhost:1337/schemas/Todo \
  -H "X-Parse-Application-Id: $ZENITH_APP_ID" \
  -H "X-Parse-Master-Key: $ZENITH_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fields": {"title": {"type": "String"}, "done": {"type": "Boolean"}}}'
```

Resultado esperado: la respuesta trae el esquema de `Todo` con sus dos campos.

## Paso 4: escribir Cloud Code

En `cloud/main.ts`:

```ts
import { Zen } from "@zuccadev-labs/zenith";

Zen.Cloud.define("hello", (req) => ({ message: `hello ${req.params.name ?? "world"}` }), { requireUser: true });

Zen.Cloud.beforeSave("Todo", (req) => {
  if (!req.object.title) throw new Error("title is required");
});
```

`zen dev` recarga solo. Una función sin validador solo la puede llamar la master key; `requireUser: true` la abre a
usuarios con sesión y `public: true`, a cualquiera ([ADR-013](../investigations/adr/13-composition-and-access.md)).

```bash
curl -X POST http://localhost:1337/functions/hello \
  -H "X-Parse-Application-Id: $ZENITH_APP_ID" -H "X-Parse-Master-Key: $ZENITH_MASTER_KEY" \
  -H "Content-Type: application/json" -d '{"name":"zen"}'
```

Resultado esperado: `{"result":{"message":"hello zen"}}`.

## Paso 5: elegir la credencial

| Credencial | Para | Cómo |
|---|---|---|
| Sesión de usuario | Apps de usuario final | `ZenithUser.logIn`. Necesita `engineAuth` |
| API key `sk_` | Backends de confianza | `zen api-keys create --name ci --env test --allowed-ips 203.0.113.10`. La key se muestra una sola vez |
| API key `pk_` | Lectura pública | Por defecto solo lee; una escritura responde 403 |
| Master key | Administración desde localhost | Está en `.env`. Nunca en un cliente |

El detalle está en [Acceso y API keys](./04-acceso-y-api-keys.md).

## Paso 6: instalar el SDK de cliente

```bash
npm install @zuccadev-labs/zenith-client
```

## Paso 7: la app

```ts
import { Zenith, ZenithObject, ZenithQuery, ZenithUser } from "@zuccadev-labs/zenith-client";

Zenith.initialize({ appId: "miapp", serverURL: "http://localhost:1337" });

await ZenithUser.logIn("alice", "s3cret");

const todo = new ZenithObject("Todo");
todo.set({ title: "Buy milk", done: false });
await todo.save();                                   // POST /classes/Todo

const open = await new ZenithQuery("Todo").equalTo("done", false).limit(10).find();
```

Con React: `import { ZenithProvider, useZenithQuery } from "@zuccadev-labs/zenith-client/react"`. Hay un ejemplo
completo con Vite en `sdk/Typescript/example/vite-react-app`.

## Comprueba el resultado

`open` contiene la tarea recién creada. Con la master key, `GET /classes/Todo` la devuelve también.

## Llevarlo a producción

```bash
zen compile --output miapp-server
```

Genera un binario con `cloud/` y `plugins/` dentro. `zen deploy --target docker` o `--target k8s` lo despliega
([El comando zen](./12-cli-zen.md)).

## Siguientes pasos

- [Usuarios y sesiones](./02-usuarios-y-sesiones.md): engine-auth y lo que todavía responde 501.
- [Piezas y motores](./05-piezas-y-motores.md): qué traer encendido y qué apagar.
- [Referencia de la API](./08-referencia-de-la-api.md).
