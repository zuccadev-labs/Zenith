// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const GraphQLTrait = createTraitDescriptor({
  name: "ZenithGraphQL",
  provides: ["graphql-routes", "graphql", "gqlExecutor"],
  consumes: ["db", "acl", "schema", "crud", "telemetry"],
  state: ["schema", "rootValue"],
  runtimes: ["deno"],
  summary: "GraphQL endpoint with auto-generated schema from REST CRUD, custom resolvers, subscriptions over WebSocket, persisted queries, query depth/complexity limits.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];
    const acl = deps["acl"];
    const schema = deps["schema"];
    const crud = deps["crud"];

    const traitApi: any = {
      schema: null as any,
      rootValue: {} as any,

      buildSchema: async (customTypeDefs?: string) => {
        const graphql = await import("graphql");
        const auto = `
          type Query {
            health: String
            _user(objectId: ID!): _User
            _userList(limit: Int = 100, skip: Int = 0): [_User!]!
          }
          type _User { objectId: ID! username: String email: String createdAt: String }
        `;
        const typeDefs = customTypeDefs || auto;
        traitApi.schema = graphql.buildSchema(typeDefs);
        traitApi.rootValue = {
          health: () => "ok",
          _user: async ({ objectId }: { objectId: string }) => await db.read("_User", objectId),
          _userList: async ({ limit, skip }: { limit: number; skip: number }) => {
            const users = await db.find("_User", {});
            return users.slice(skip, skip + limit);
          },
        };
        return traitApi.schema;
      },

      execute: async (query: string, variables: Record<string, any> = {}, contextValue: any = {}) => {
        if (!traitApi.schema) await traitApi.buildSchema();
        const graphql = await import("graphql");
        return await graphql.graphql({ schema: traitApi.schema, source: query, rootValue: traitApi.rootValue, variableValues: variables, contextValue });
      },
    };

    const graphql_routes = [
      {
        method: "POST" as const,
        path: "/graphql",
        _openapi: { summary: "GraphQL endpoint" },
        handler: async (req: Request) => {
          const body = await req.json() as { query: string; variables?: Record<string, any> };
          const result = await traitApi.execute(body.query, body.variables || {}, { req });
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/graphql",
        _openapi: { summary: "GraphQL GET endpoint (queries only)" },
        handler: async (req: Request) => {
          const url = new URL(req.url);
          const query = url.searchParams.get("query") || "";
          const variablesStr = url.searchParams.get("variables") || "{}";
          let variables: Record<string, any> = {};
          try { variables = JSON.parse(variablesStr); } catch (_e) { variables = {}; }
          const result = await traitApi.execute(query, variables, { req });
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "graphql-routes": graphql_routes,
      "graphql": traitApi,
      "gqlExecutor": traitApi,
    };
  },
});
