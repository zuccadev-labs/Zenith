# 02 — Integración de Barrits en Zenith: Traits y Orquestación Determinista

> ℹ️ **Estado: histórico.** Investigación previa al diseño actual; sus imports y rutas (`@zenith/core`, `src/cli/`…) no son los del código. Índice vigente: [docs/index.md](../../users/README.md).

> **Fase**: Investigación & Diseño Arquitectónico  
> **Autor**: Equipo Zenith — @zuccadev-labs  
> **Fecha**: 2026-05-21  
> **Estado**: Draft v1.0  
> **Prerrequisito**: [01_parse_server_architecture_analysis.md](./01-parse-server-architecture-analysis.md)

---

## 1. El Problema a Resolver: "El Impuesto de Alucinación"

En el desarrollo tradicional asistido por Inteligencia Artificial, los LLMs tienden a "alucinar" conexiones entre módulos. Por ejemplo, al pedirle a un LLM que conecte un servicio de autenticación con una base de datos, el LLM asume clases, inyecta dependencias inexistentes o inventa métodos `save()` o `find()` que no corresponden a la API real del proyecto.

**Zenith resuelve este problema usando `@zuccadev-labs/barrits`**, un motor de orquestación determinista basado en el Principio de Responsabilidad Única (SRP). En lugar de permitir que la IA (o el desarrollador) decida arbitrariamente cómo conectar los componentes, Zenith fuerza el uso de **Contratos Declarativos (Traits)**.

### 1.1 ¿Qué es un Trait en Barrits?
Un Trait es la unidad atómica de funcionalidad en Zenith. Define de forma estricta:
1. **Qué provee** (`provides`)
2. **Qué consume/necesita** (`consumes`)
3. **Qué estado maneja** (`state`)
4. **Con qué entra en conflicto** (`conflicts`)

Cuando la IA (o el desarrollador) escribe código, no orquesta manualmente las dependencias; simplemente define Traits. Barrits se encarga de analizar el Árbol Sintáctico Abstracto (AST), validar que los contratos se cumplan y componer los Traits en tiempo de compilación/ejecución.

---

## 2. Patrones de Diseño con Barrits en Zenith

A diferencia de Parse Server, que usa herencia clásica (`AdaptableController` base class), Zenith utiliza **Composición Pura**.

### 2.1 Definición Estricta de Traits (Trait Descriptors)

Todo módulo en Zenith DEBE exportarse utilizando `createTraitDescriptor`. Esto permite que Barrits lea los metadatos y construya el "Discovery Graph" antes de ejecutar la aplicación.

#### Ejemplo: Trait de Base de Datos

```typescript
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { MongoClient } from "npm:mongodb";

export const databaseTrait = createTraitDescriptor({
  name: "ZenithDatabase",
  provides: ["database-crud", "database-schema"],
  state: ["connectionPool"],
  runtime: "deno",
  create: (deps) => {
    // El estado interno y conexión
    let db: any = null;

    return {
      connect: async (uri: string) => {
        const client = new MongoClient(uri);
        await client.connect();
        db = client.db();
      },
      // Operaciones REST Puras
      find: async (className: string, query: any) => {
        return db.collection(className).find(query).toArray();
      },
      insert: async (className: string, data: any) => {
        return db.collection(className).insertOne(data);
      }
    };
  }
});
```

#### Ejemplo: Trait de Autenticación (Consumidor)

```typescript
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const authTrait = createTraitDescriptor({
  name: "ZenithAuth",
  provides: ["auth-session"],
  consumes: ["database-crud"], // <- Contrato estricto
  conflicts: ["legacy-auth"],
  create: (deps) => {
    return {
      login: async (username, password) => {
        // La dependencia deps.database está garantizada por Barrits
        // Si no se provee en la composición, el servidor no arranca.
        const user = await deps["database-crud"].find("User", { username });
        if (!user) throw new Error("Not found");
        // ...validación de password
        return "session_token_jwt";
      }
    };
  }
});
```

### 2.2 Composición y Pipeline (El Reemplazo de Express)

Parse Server utiliza una cadena masiva de middlewares de Express. Zenith abstrae el flujo HTTP usando `composePipeline` de Barrits.

```typescript
import { composePipeline } from "@zuccadev-labs/barrits";

// Un pipeline funcional puro, sin dependencias de Express
export const requestPipeline = composePipeline(
  initialRequest,
  (req) => applyCORS(req),
  (req) => validateHeaders(req),
  (req) => resolveAuth(req),
  (req) => enforceRateLimit(req),
  (req) => dispatchToRouter(req)
);
```

### 2.3 Resolución Determinista (Discovery Graphs)

Cuando compilamos Zenith (vía `deno compile`), el AST analyzer de Barrits recorre todo el código buscando estas definiciones.

Si un agente de IA intenta inyectar un Trait de IA (`AITrait`) que consume `vector-database`, pero el usuario no ha compuesto ningún Trait que provea `vector-database`, Barrits arrojará un error de compilación explícito, evitando fallos en tiempo de ejecución.

---

## 3. Guía para Agentes de IA

Para garantizar la visión de "cero alucinaciones", todo agente de Inteligencia Artificial que trabaje en el código de Zenith debe cumplir las siguientes reglas:

### Regla 1: Prohibido Instanciar Clases Globales
- **Mal:** `const db = new DatabaseController()`
- **Bien:** Declarar `@barrits-consumes database-crud` y acceder vía inyección.

### Regla 2: El Estado es Exclusivo del Trait
- El estado mutable (caches, conexiones) debe declararse en la propiedad `state: []` del Trait Descriptor.
- No exportar variables mutables `let` o `var` a nivel de módulo.

### Regla 3: Inmutabilidad en Transformaciones
- Toda función de middleware (pipeline) debe recibir un dato y retornar un **nuevo objeto**. 
- No mutar el objeto request/response directamente.

### Regla 4: Uso de AST Docs
- Los Agentes pueden usar JSDoc para definir metadatos en caso de traits programáticos:
  ```typescript
  /**
   * @barrits-trait
   * @barrits-provides cloud-functions
   * @barrits-consumes database-crud
   */
  ```

---

## 4. Diseño del Motor Central de Zenith (`ZenServer`)

El orquestador principal no es una clase `Server` pesada como en Parse. Es una función de composición:

```typescript
import { composeTraitDescriptors } from "@zuccadev-labs/barrits";

export function createZenithServer(config: ZenithConfig) {
  // 1. Recolectar todos los traits base
  const baseTraits = [
    config.databaseAdapter || mongoDatabaseTrait,
    config.cacheAdapter || denoKVCacheTrait,
    authTrait,
    schemaTrait
  ];

  // 2. Añadir plugins del usuario
  const allTraits = [...baseTraits, ...(config.plugins || [])];

  // 3. Barrits compone y valida
  // Si hay un conflicto (ej. dos adapters de DB proveen 'database-crud'), fallará rápido.
  const zenithEngine = composeTraitDescriptors({
    input: allTraits,
    conflictStrategy: "error"
  });

  // 4. Retornar el motor listo para escuchar (Deno.serve)
  return zenithEngine;
}
```

## 5. Próximos Pasos

El siguiente documento (`03_zenith_architecture.md`) trazará el diagrama exacto de flujo de datos (Request → Router → Logic → DB) usando esta filosofía de Traits.
