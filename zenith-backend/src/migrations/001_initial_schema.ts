import type { ZenithMigration } from "../traits/migration/migration.trait.ts";

export const initialSchemaMigration: ZenithMigration = {
  name: "001_initial_schema",
  up: async (_db, schema) => {
    console.log("[Migration 001] Creating basic class schemas...");
    
    // Crear esquema inicial de Post si no existe
    try {
      await schema.createSchema("Post", {
        title: { type: "String", required: true },
        content: { type: "String", required: true },
        author: { type: "Pointer", targetClass: "_User", required: true },
        likesCount: { type: "Number", required: false, default: 0 }
      });
      console.log("[Migration 001] Post schema created.");
    } catch (e: any) {
      if (e.code === "SCHEMA_EXISTS") {
        console.log("[Migration 001] Post schema already exists.");
      } else {
        throw e;
      }
    }
  },
  down: async (_db, _schema) => {
    // Aquí iría la lógica de rollback (ej. borrar la tabla Post)
    // Para entornos corporativos usualmente solo se borran campos o se ignora.
    console.log("[Migration 001] Reverting basic class schemas...");
  }
};
