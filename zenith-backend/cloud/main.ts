/**
 * Zenith Cloud Orchestrator
 * Enterprise Boilerplate Structure
 * 
 * Instead of placing all logic in a single file, we import specific domain files.
 * The binary will read this entry point and hydrate the Barrits AST dynamically.
 */

// 1. Authentication Cloud Functions
import "./auth/web3.ts";

// 2. Generic CRUD Cloud Functions
import "./crud/forms.ts";

// 3. Database Triggers (beforeSave, afterSave)
import "./triggers/posts.ts";
import "./triggers/users.ts";

// ─── Health check (Example) ────────────────────────────────────────────────
import { Zen } from "../src/mod.ts";

Zen.Cloud.define("ping", async () => {
  return "pong from Zenith Enterprise Backend";
});
