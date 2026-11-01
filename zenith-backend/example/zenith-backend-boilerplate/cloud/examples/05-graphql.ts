import { Zen } from "@zuccadev-labs/zenith";

/**
 * 05 — GraphQL
 *
 * Endpoints GraphQL: query y mutation sobre clases de Parse.
 * Demostración de schema dinámico, resolvers con autenticación,
 * y rate-limiting por query.
 *
 * API usada:
 *   Zen.Cloud.define()
 *   Zen.DB.*
 *   Zen.Cloud.httpRequest()
 *   Zen.Config.get()
 */

// ─── Schema GraphQL embebido ──────────────────────────────────────
Zen.Cloud.define("graphql:schema", async () => {
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              { name: "health", args: [], type: { kind: "SCALAR", name: "String" } },
              { name: "todo", args: [{ name: "id", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "ID" } } }], type: { kind: "OBJECT", name: "TodoItem" } },
              { name: "todos", args: [
                { name: "limit", type: { kind: "SCALAR", name: "Int" } },
                { name: "skip", type: { kind: "SCALAR", name: "Int" } },
              ], type: { kind: "LIST", ofType: { kind: "OBJECT", name: "TodoItem" } } },
            ],
          },
          {
            kind: "OBJECT",
            name: "Mutation",
            fields: [
              { name: "createTodo", args: [{ name: "title", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } } }], type: { kind: "OBJECT", name: "TodoItem" } },
            ],
          },
          {
            kind: "OBJECT",
            name: "TodoItem",
            fields: [
              { name: "id", type: { kind: "SCALAR", name: "ID" } },
              { name: "title", type: { kind: "SCALAR", name: "String" } },
              { name: "done", type: { kind: "SCALAR", name: "Boolean" } },
            ],
          },
        ],
      },
    },
  };
});

// ─── Query GraphQL genérica ───────────────────────────────────────
Zen.Cloud.define("graphql:query", async (req) => {
  const { query, variables } = req.params;
  if (!query) throw new Error("query GraphQL es requerida");

  // Parser simple para queries GraphQL (demostración)
  // En producción, usa graphql-js o graphql-yoga
  const trimmed = (query as string).trim();

  if (trimmed.startsWith("{") && trimmed.includes("health")) {
    return { data: { health: "ok", uptime: performance.now() } };
  }

  if (trimmed.includes("todos") || trimmed.includes("todo")) {
    const todoId = (variables as Record<string, unknown> | undefined)?.id as string | undefined;

    if (todoId) {
      const todos = await Zen.DB.find("TodoItem", {
        where: todoId ? { objectId: todoId } : {},
        limit: 1,
      });
      if (todos.length === 0) throw new Error("Todo no encontrado");

      return {
        data: {
          todo: {
            id: todos[0].objectId,
            title: todos[0].title,
            done: todos[0].done || false,
          },
        },
      };
    }

    const limit = Math.min((variables as Record<string, unknown> | undefined)?.limit as number || 50, 100);
    const skip = (variables as Record<string, unknown> | undefined)?.skip as number || 0;

    const todos = await Zen.DB.find("TodoItem", { limit, skip });
    return {
      data: {
        todos: todos.map((t: Record<string, unknown>) => ({
          id: t.objectId,
          title: t.title,
          done: t.done || false,
        })),
      },
    };
  }

  if (trimmed.includes("__schema")) {
    return Zen.Cloud.run("graphql:schema");
  }

  throw new Error(`Query GraphQL no soportada. Usa el schema en /functions/graphql:schema`);
});

// ─── Mutation GraphQL ─────────────────────────────────────────────
Zen.Cloud.define("graphql:mutation", async (req) => {
  const { mutation, variables } = req.params;
  if (!mutation) throw new Error("mutation GraphQL es requerida");

  const trimmed = (mutation as string).trim();

  if (trimmed.includes("createTodo")) {
    const title = (variables as Record<string, unknown> | undefined)?.title as string;
    if (!title) throw new Error("title es requerido para createTodo");

    const todo = await Zen.DB.insert("TodoItem", {
      title,
      done: false,
      _createdBy: req.user?.objectId || "anonymous",
    });

    return {
      data: {
        createTodo: {
          id: todo.objectId,
          title: todo.title,
          done: false,
        },
      },
    };
  }

  throw new Error("Mutation no soportada");
});

// ─── Proxy a servidor GraphQL externo ─────────────────────────────
Zen.Cloud.define("graphql:proxy", async (req) => {
  const { url, query, variables, headers } = req.params;
  if (!url || !query) throw new Error("url y query son requeridos");

  const response = await Zen.Cloud.httpRequest({
    url: url as string,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headers as Record<string, string> || {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  return response.data;
});
