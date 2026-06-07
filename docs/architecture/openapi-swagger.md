# Zenith OpenAPI & Swagger Architecture

Zenith implements a fully dynamic, AST-driven OpenAPI generation engine. Unlike legacy systems that rely on static YAML files or brittle decorators that easily drift from the actual implementation, Zenith generates its OpenAPI specification (`openapi.json`) and Swagger UI directly from the running routing capabilities of the `barrits` traits.

## 1. The Dynamic Generation Process

When the Zenith backend starts (or is compiled via `deno compile`), the core system calls `generateOpenApiSchema(manifest)`.

This engine reads all `*_routes` arrays exposed by the composed `barrits` traits. Because the HTTP server (`serve.ts`) and the OpenAPI generator use the **exact same AST source of truth**, the documentation can never be out of sync with the actual API.

## 2. Real-time Cloud Code Introspection

A key enterprise feature of Zenith is how it handles Cloud Functions (`Zen.Cloud.define`).

When a developer registers a new function in `cloud/main.ts`:
```typescript
Zen.Cloud.define("submitForm", async (request) => { ... });
```

The function `buildLiveOpenApiSpec` (located in `src/mod.ts`) reaches directly into the memory registry (`_cloudCodeRegistry.listFunctions()`). It dynamically calculates the input parameters, synthesizes a virtual route (`POST /functions/submitForm`), and injects it into the AST just before rendering the OpenAPI schema.

**This means:**
- Every `Zen.Cloud.define()` automatically appears in Swagger.
- You do not need to restart the development server or run a separate code-generation step. The endpoint `/parse/swagger` is rebuilt on-the-fly.

### ¿Cuándo ocurre esta compilación AST? (Build vs Dev)
El enfoque de Barrits permite que la generación sea **independiente del entorno**:
1. **Modo Desarrollo (`deno run`)**: Cada vez que el servidor arranca o se recarga por Hot Reloading, el AST se construye dinámicamente en memoria y se sirve.
2. **Modo Producción / Binario (`deno task build`)**: Cuando usas el comando de construcción `zen build` o compilas tu app mediante Deno, todo el código de `cloud/main.ts` se analiza estáticamente y se empaqueta dentro del ejecutable final. Dado que OpenAPI no depende de lectura de archivos YAML externos, sino del propio código empaquetado, **el Swagger sigue funcionando 100% nativo dentro del binario**. El ejecutable expondrá `/parse/swagger` perfectamente sin requerir configuraciones de volúmenes adicionales.

## 3. Endpoints

Zenith exposes two crucial endpoints under the application mount path (e.g., `/parse`):

- **`GET /openapi.json?appId=YOUR_APP_ID`**: Returns the raw OpenAPI v3.1 specification. Useful for importing into Postman, Insomnia, or generating frontend clients.
- **`GET /swagger?appId=YOUR_APP_ID`**: Returns an interactive HTML dashboard using `swagger-ui-dist`, hydrated directly with the live OpenAPI specification.

> [!TIP]
> **Compilation (Zen Build)**: When you build the Zenith backend into a binary using `deno task build`, the `cloud/main.ts` is statically analyzed and bundled. The OpenAPI engine continues to work flawlessly in the binary, providing zero-configuration documentation for your immutable production deployments.
