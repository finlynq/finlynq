// MCP Import Template Tools
// Provides: get_import_templates, import_with_template

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type Database from "better-sqlite3";

type TemplateRow = {
  id: number;
  user_id: string;
  name: string;
  account_id: number | null;
  file_type: string;
  column_mapping: string;
  has_headers: number;
  date_format: string;
  amount_format: string;
  is_default: number;
  created_at: string;
  updated_at: string;
};

function mcpText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function mcpError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

/** Parse a simple CSV string into rows (array of header→value maps). */
function parseCSVSimple(text: string): Record<string, string>[] {
  const cleaned = text.replace(/^\uFEFF/, "");
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.replace(/^"|"$/g, "").trim());
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

/** Parse amount based on format */
function parseAmount(raw: string, format: string, debitRaw = "", creditRaw = ""): number {
  if (format === "debit_credit") {
    const debit = parseFloat(debitRaw.replace(/[^0-9.-]/g, "")) || 0;
    const credit = parseFloat(creditRaw.replace(/[^0-9.-]/g, "")) || 0;
    return credit - debit;
  }
  const amount = parseFloat(raw.replace(/[^0-9.-]/g, "")) || 0;
  return format === "negate" ? -amount : amount;
}

export function registerImportTemplateTools(server: McpServer, sqlite: Database.Database) {
  // ---- get_import_templates ----
  server.tool(
    "get_import_templates",
    "List all saved CSV import templates. Optionally supply comma-separated file headers to get match scores for each template.",
    {
      headers: z
        .string()
        .optional()
        .describe("Comma-separated CSV column headers to score against templates"),
    },
    async ({ headers }) => {
      const templates = sqlite
        .prepare(
          `SELECT id, name, account_id, file_type, column_mapping, has_headers,
                  date_format, amount_format, is_default, created_at, updated_at
           FROM import_templates
           ORDER BY is_default DESC, name ASC`
        )
        .all() as TemplateRow[];

      if (!headers) {
        return mcpText(
          templates.map((t) => ({
            ...t,
            column_mapping: JSON.parse(t.column_mapping),
          }))
        );
      }

      const fileHeaders = headers
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);

      const scored = templates.map((t) => {
        let mapping: Record<string, string> = {};
        try {
          mapping = JSON.parse(t.column_mapping);
        } catch {
          /* ignore */
        }

        const mappedCols = Object.values(mapping)
          .filter(Boolean)
          .map((c) => c.toLowerCase());

        const weights: Record<string, number> = {
          date: 3,
          amount: 3,
          debit: 2,
          credit: 2,
          payee: 2,
        };

        let totalWeight = 0;
        let matchedWeight = 0;
        const matched: string[] = [];
        const missing: string[] = [];

        for (const [logical, csvCol] of Object.entries(mapping)) {
          if (!csvCol) continue;
          const w = weights[logical] ?? 1;
          totalWeight += w;
          if (fileHeaders.includes(csvCol.toLowerCase())) {
            matchedWeight += w;
            matched.push(csvCol);
          } else {
            missing.push(csvCol);
          }
        }

        const score = totalWeight > 0 ? Math.round((matchedWeight / totalWeight) * 100) : 0;
        return {
          id: t.id,
          name: t.name,
          account_id: t.account_id,
          file_type: t.file_type,
          column_mapping: mapping,
          has_headers: t.has_headers,
          date_format: t.date_format,
          amount_format: t.amount_format,
          is_default: t.is_default,
          match_score: score,
          matched_columns: matched,
          missing_columns: missing,
        };
      });

      scored.sort((a, b) => b.match_score - a.match_score);
      return mcpText(scored);
    }
  );

  // ---- import_with_template ----
  server.tool(
    "import_with_template",
    "Import transactions from a CSV string using a saved template. Returns a summary of imported, skipped (duplicate), and errored rows.",
    {
      template_id: z.number().int().describe("ID of the import template to use"),
      csv_content: z.string().describe("Raw CSV file content as a string"),
      account_id: z
        .number()
        .int()
        .optional()
        .describe("Account ID to assign transactions to (overrides template default)"),
      dry_run: z
        .boolean()
        .optional()
        .describe("If true, parse and validate without inserting. Default: false"),
    },
    async ({ template_id, csv_content, account_id, dry_run }) => {
      const tmpl = sqlite
        .prepare(
          `SELECT id, name, account_id, column_mapping, has_headers,
                  date_format, amount_format
           FROM import_templates WHERE id = ?`
        )
        .get(template_id) as TemplateRow | undefined;

      if (!tmpl) return mcpError(`Template ${template_id} not found`);

      let mapping: Record<string, string> = {};
      try {
        mapping = JSON.parse(tmpl.column_mapping);
      } catch {
        return mcpError("Template has invalid column_mapping JSON");
      }

      const rows = parseCSVSimple(csv_content);
      if (rows.length === 0) return mcpError("No rows found in CSV content");

      const resolvedAccountId = account_id ?? tmpl.account_id;
      if (!resolvedAccountId) {
        return mcpError("No account_id provided and template has no default account");
      }

      const account = sqlite
        .prepare(`SELECT id, currency FROM accounts WHERE id = ?`)
        .get(resolvedAccountId) as { id: number; currency: string } | undefined;
      if (!account) return mcpError(`Account ${resolvedAccountId} not found`);

      // Build a map of existing import hashes to detect duplicates
      const existingHashes = new Set<string>(
        (
          sqlite
            .prepare(`SELECT import_hash FROM transactions WHERE import_hash IS NOT NULL`)
            .all() as { import_hash: string }[]
        ).map((r) => r.import_hash)
      );

      const imported: unknown[] = [];
      const skipped: unknown[] = [];
      const errors: string[] = [];

      const get = (col: string | undefined, row: Record<string, string>) =>
        col ? (row[col] ?? "") : "";

      const insertStmt = sqlite.prepare(
        `INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, payee, note, tags, import_hash)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
      );

      // Get first row's user_id from accounts
      const accountRow = sqlite
        .prepare(`SELECT user_id FROM accounts WHERE id = ?`)
        .get(resolvedAccountId) as { user_id: string } | undefined;
      const userId = accountRow?.user_id ?? "default";

      const importBatch = sqlite.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          try {
            const rawDate = get(mapping.date, row);
            if (!rawDate) {
              errors.push(`Row ${i + 1}: missing date`);
              continue;
            }

            const amount = parseAmount(
              get(mapping.amount, row),
              tmpl.amount_format,
              get(mapping.debit, row),
              get(mapping.credit, row)
            );

            const payee = get(mapping.payee, row);
            const note = get(mapping.note, row);
            const tags = get(mapping.tags, row);
            const currency = get(mapping.currency, row) || account.currency;

            // Simple hash: date + amount + payee
            const hashInput = `${rawDate}|${amount}|${payee}`;
            const hash =
              Buffer.from(hashInput).toString("base64").replace(/[+/=]/g, "").slice(0, 32) +
              `_r${i}`;

            if (existingHashes.has(hash)) {
              skipped.push({ row: i + 1, date: rawDate, amount, payee });
              continue;
            }

            if (!dry_run) {
              insertStmt.run(userId, rawDate, resolvedAccountId, currency, amount, payee, note, tags, hash);
              existingHashes.add(hash);
            }
            imported.push({ row: i + 1, date: rawDate, amount, payee });
          } catch (err) {
            errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });

      importBatch();

      return mcpText({
        dry_run: dry_run ?? false,
        template: { id: tmpl.id, name: tmpl.name },
        account_id: resolvedAccountId,
        total_rows: rows.length,
        imported: imported.length,
        skipped_duplicates: skipped.length,
        errors: errors.length,
        error_details: errors.slice(0, 10),
      });
    }
  );
}
