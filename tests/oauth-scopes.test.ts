/**
 * OAuth scope library tests (Open #1, session 4d).
 *
 * Covers the read/write classification predicate, scope normalization, and
 * the per-token tool-allowed decision. The MCP route's tool-filter wrapper
 * relies on these functions returning the right answer for every tool name —
 * a regression here = read-only tokens silently exposing write tools.
 */

import { describe, it, expect } from "vitest";
import {
  mcpToolIsReadOnly,
  parseScope,
  normalizeRequestedScope,
  isToolAllowedForScope,
  InvalidScopeError,
  DEFAULT_SCOPE,
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
} from "@/lib/oauth-scopes";

describe("mcpToolIsReadOnly — name-prefix classification", () => {
  it.each([
    ["get_account_balances", true],
    ["get_net_worth", true],
    ["list_subscriptions", true],
    ["list_pending_uploads", true],
    ["search_transactions", true],
    ["find_anomalies", true],
    ["analyze_holding", true],
    ["preview_bulk_categorize", true],
    ["preview_bulk_delete", true],
    ["preview_bulk_update", true],
    ["preview_import", true],
    ["test_rule", true],
    ["trace_holding_quantity", true],
    ["detect_subscriptions", true],
    ["convert_amount", true],
    ["suggest_transaction_details", true],
    ["finlynq_help", true],
  ])("%s is read-only", (name, expected) => {
    expect(mcpToolIsReadOnly(name)).toBe(expected);
  });

  it.each([
    "add_account",
    "add_goal",
    "add_loan",
    "add_portfolio_holding",
    "add_snapshot",
    "add_split",
    "add_subscription",
    "apply_rules_to_uncategorized",
    "approve_staged_rows",
    "bulk_add_subscriptions",
    "bulk_record_transactions",
    "cancel_import",
    "create_category",
    "create_rule",
    "delete_account",
    "delete_budget",
    "delete_transaction",
    "execute_bulk_categorize",
    "execute_bulk_delete",
    "execute_bulk_update",
    "execute_import",
    "link_staged_transfer_pair",
    "record_trade",
    "record_transaction",
    "record_transfer",
    "reject_staged_import",
    "reorder_rules",
    "replace_splits",
    "set_budget",
    "set_fx_override",
    "update_account",
    "update_goal",
    "update_loan",
    "update_portfolio_holding",
    "update_rule",
    "update_split",
    "update_staged_transaction",
    "update_subscription",
    "update_transaction",
    "update_transfer",
  ])("%s is NOT read-only", (name) => {
    expect(mcpToolIsReadOnly(name)).toBe(false);
  });

  it("conservatively classifies novel tool names as write", () => {
    expect(mcpToolIsReadOnly("zap_everything")).toBe(false);
    expect(mcpToolIsReadOnly("foo_bar")).toBe(false);
  });
});

describe("normalizeRequestedScope", () => {
  it("returns DEFAULT_SCOPE for null/undefined/empty input", () => {
    expect(normalizeRequestedScope(null)).toBe(DEFAULT_SCOPE);
    expect(normalizeRequestedScope(undefined)).toBe(DEFAULT_SCOPE);
    expect(normalizeRequestedScope("")).toBe(DEFAULT_SCOPE);
    expect(normalizeRequestedScope("   ")).toBe(DEFAULT_SCOPE);
  });

  it("canonicalizes recognized scope tokens in stable order", () => {
    expect(normalizeRequestedScope("mcp:read")).toBe("mcp:read");
    expect(normalizeRequestedScope("mcp:write")).toBe("mcp:write");
    expect(normalizeRequestedScope("mcp:read mcp:write")).toBe("mcp:read mcp:write");
    expect(normalizeRequestedScope("mcp:write mcp:read")).toBe("mcp:read mcp:write");
    expect(normalizeRequestedScope("mcp:read mcp:read mcp:write")).toBe("mcp:read mcp:write");
  });

  it("collapses extra whitespace", () => {
    expect(normalizeRequestedScope("  mcp:read   mcp:write  ")).toBe("mcp:read mcp:write");
  });

  it("throws InvalidScopeError on unknown tokens", () => {
    expect(() => normalizeRequestedScope("mcp:admin")).toThrow(InvalidScopeError);
    expect(() => normalizeRequestedScope("mcp:read mcp:bogus")).toThrow(InvalidScopeError);
    expect(() => normalizeRequestedScope("read")).toThrow(InvalidScopeError);
    expect(() => normalizeRequestedScope("write")).toThrow(InvalidScopeError);
  });
});

describe("parseScope", () => {
  it("returns empty set for empty/null input", () => {
    expect(parseScope("").size).toBe(0);
    expect(parseScope(null).size).toBe(0);
    expect(parseScope(undefined).size).toBe(0);
  });

  it("parses recognized tokens", () => {
    const s = parseScope("mcp:read mcp:write");
    expect(s.has(SCOPE_MCP_READ)).toBe(true);
    expect(s.has(SCOPE_MCP_WRITE)).toBe(true);
  });

  it("silently drops unknown tokens (defense-in-depth)", () => {
    const s = parseScope("mcp:read mcp:admin");
    expect(s.has(SCOPE_MCP_READ)).toBe(true);
    expect(s.has("mcp:admin")).toBe(false);
    expect(s.size).toBe(1);
  });
});

describe("isToolAllowedForScope", () => {
  const readOnly = parseScope("mcp:read");
  const writeOnly = parseScope("mcp:write");
  const both = parseScope("mcp:read mcp:write");
  const empty = new Set<string>();

  it("read-only token allows read tools, blocks write tools", () => {
    expect(isToolAllowedForScope("get_net_worth", readOnly)).toBe(true);
    expect(isToolAllowedForScope("list_loans", readOnly)).toBe(true);
    expect(isToolAllowedForScope("record_transaction", readOnly)).toBe(false);
    expect(isToolAllowedForScope("delete_account", readOnly)).toBe(false);
  });

  it("write-scoped token allows BOTH read AND write tools (write implies read)", () => {
    // RFC 6749 doesn't formally require this, but the convention "write
    // implies read" is what every consent UI in the wild communicates and
    // matches what users expect.
    expect(isToolAllowedForScope("get_net_worth", writeOnly)).toBe(true);
    expect(isToolAllowedForScope("record_transaction", writeOnly)).toBe(true);
  });

  it("full-scope token allows everything", () => {
    expect(isToolAllowedForScope("get_net_worth", both)).toBe(true);
    expect(isToolAllowedForScope("record_transaction", both)).toBe(true);
    expect(isToolAllowedForScope("delete_account", both)).toBe(true);
  });

  it("empty scope blocks everything (malformed token guard)", () => {
    expect(isToolAllowedForScope("get_net_worth", empty)).toBe(false);
    expect(isToolAllowedForScope("record_transaction", empty)).toBe(false);
  });
});
