import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Pool } from "pg";
import { createPgCompat } from "./pg-compat.js";
import { registerCoreTools } from "./register-core-tools.js";
import { registerV2Tools } from "./tools-v2.js";
import { registerImportTemplateTools } from "./tools-import-templates.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL environment variable is required.");
  console.error("Set it in your Claude Desktop MCP config or export it before running.");
  console.error("Example: DATABASE_URL=postgresql://user:pass@localhost:5432/finlynq");
  process.exit(1);
}

const userId = process.env.PF_USER_ID?.trim();
if (!userId) {
  console.error("ERROR: PF_USER_ID environment variable is required.");
  console.error("");
  console.error("The stdio MCP server has no HTTP auth, so it must be bound to a single");
  console.error("user at startup. Export PF_USER_ID alongside DATABASE_URL so the server");
  console.error("can scope every query to your account.");
  console.error("");
  console.error("PF_USER_ID must match a row in the users table (users.id, a UUID).");
  console.error("");
  console.error("Example:");
  console.error("  PF_USER_ID=00000000-0000-0000-0000-000000000001 \\");
  console.error("  DATABASE_URL=postgresql://user:pass@localhost:5432/finlynq \\");
  console.error("  node mcp-server/dist/index.js");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

// Validate connection
try {
  const client = await pool.connect();
  await client.query("SELECT 1");
  client.release();
} catch (err) {
  console.error("ERROR: Could not connect to PostgreSQL database.");
  console.error(err);
  process.exit(1);
}

// Create PostgreSQL-compatible database interface
// This translates SQLite-style prepare/all/get/run calls to async PostgreSQL queries
const db = createPgCompat(pool);

const server = new McpServer({
  name: "finlynq",
  version: "3.0.0",
});

registerCoreTools(server, db, { userId });
registerV2Tools(server, db, { userId });
registerImportTemplateTools(server, db, { userId });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Finlynq MCP server v3.0 running on stdio (PostgreSQL mode, user=${userId})`);
}

main().catch(console.error);
