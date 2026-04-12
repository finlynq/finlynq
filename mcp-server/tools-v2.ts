// MCP Tools v2 — Additional read and write tools
// Exported as registration functions to avoid conflicts with other team's changes to index.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ============ TYPES ============

type AccountRow = {
  id: number;
  name: string;
  type: string;
  group: string;
  currency: string;
  balance: number;
};

type TransactionRow = {
  id: number;
  date: string;
  account: string;
  category: string;
  category_type: string;
  currency: string;
  amount: number;
  payee: string;
  note: string;
  tags: string;
};
