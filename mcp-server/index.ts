import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3-multiple-ciphers";
import type BetterSqlite3 from "better-sqlite3";
import { deriveKey } from "../shared/crypto.js";
import { readConfig, resolveDbPath } from "../shared/config.js";
import { checkLock, isReadOnly } from "../src/db/sync.js";
import { registerCoreTools } from "./register-core-tools.js";
import { registerV2Tools } from "./tools-v2.js";
import { registerImportTemplateTools } from "./tools-import-templates.js";

const passphrase = process.env.PF_PASSPHRASE;
if (!passphrase) {
  console.error("ERROR: PF_PASSPHRASE environment variable is required.");
  console.error("Set it in your Claude Desktop MCP config or export it before running.");
  process.exit(1);
}

const config = readConfig();
const dbPath = resolveDbPath(config);
const salt = Buffer.from(config.salt, "hex");
const hexKey = deriveKey(passphrase, salt);

// Check lock status for cloud mode
let cloudReadOnly = false;
if (config.mode === "cloud") {
  checkLock(dbPath);
  cloudReadOnly = isReadOnly();
}

const sqlite: BetterSqlite3.Database = new (Database as unknown as typeof BetterSqlite3)(
  dbPath,
  cloudReadOnly ? { readonly: true } : undefined
);
sqlite.pragma(`key = "x'${hexKey}'"`);

// Validate passphrase
try {
  sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
} catch {
  console.error("ERROR: Invalid passphrase. Could not unlock the database.");
  process.exit(1);
}

if (!cloudReadOnly) {
  if (config.mode === "cloud") {
    sqlite.pragma("journal_mode = DELETE");
  } else {
    sqlite.pragma("journal_mode = WAL");
  }
}
sqlite.pragma("foreign_keys = ON");

const server = new McpServer({
  name: "finlynq",
  version: "2.3.0",
});

registerCoreTools(server, sqlite);
registerV2Tools(server, sqlite);
registerImportTemplateTools(server, sqlite);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Finlynq MCP server v2.3 running on stdio — 29 tools (23 read, 6 write)");
}

main().catch(console.error);
