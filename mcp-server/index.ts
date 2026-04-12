import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { registerCoreTools } from "./register-core-tools.js";
import { registerV2Tools } from "./tools-v2.js";
import { registerImportTemplateTools } from "./tools-import-templates.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL environment variable is required.");
  console.error("Set it in your Claude Desktop MCP config or export it before running.");
  process.exit(1);
}

// Create PostgreSQL pool
const pool = new Pool({
  connectionString: databaseUrl,
});

// Validate database connection
try {
  const client = await pool.connect();
  await client.query("SELECT 1");
  client.release();
  console.error("Database connection verified.");
} catch (error) {
  console.error("ERROR: Could not connect to PostgreSQL database:", error);
  process.exit(1);
}

const db = drizzle(pool);

const server = new McpServer({
  name: "finlynq",
  version: "2.3.0",
});

registerCoreTools(server, db);
registerV2Tools(server, db);
registerImportTemplateTools(server, db);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Finlynq MCP server v2.3 running on stdio — 29 tools (23 read, 6 write)");
}

main().catch(console.error);
