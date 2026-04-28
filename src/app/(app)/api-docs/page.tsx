"use client";

import { DevModeGuard } from "@/components/dev-mode-guard";

import { useState } from "react";

// ============ API ROUTE DEFINITIONS ============

type ApiParam = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

type ApiRoute = {
  method: string;
  path: string;
  description: string;
  params?: ApiParam[];
  body?: ApiParam[];
  example?: string;
};

type ApiGroup = {
  name: string;
  description: string;
  routes: ApiRoute[];
};

const API_GROUPS: ApiGroup[] = [
  {
    name: "Accounts",
    description: "Manage financial accounts (banks, credit cards, investments)",
    routes: [
      {
        method: "GET",
        path: "/api/accounts",
        description: "List all accounts with type, group, currency, notes, and alias",
        example: `[{ "id": 1, "type": "A", "group": "Banks", "name": "Chequing", "currency": "CAD", "alias": null }]`,
      },
      {
        method: "POST",
        path: "/api/accounts",
        description: "Create a new account",
        body: [
          { name: "name", type: "string", required: true, description: "Unique account name" },
          { name: "type", type: "string", required: true, description: "'A' (asset) or 'L' (liability)" },
          { name: "group", type: "string", required: true, description: "Account group (e.g. 'Banks')" },
          { name: "currency", type: "string", required: true, description: "'CAD' or 'USD'" },
          { name: "note", type: "string", required: false, description: "Optional note" },
          { name: "alias", type: "string", required: false, description: "Optional short alias used to match the account when receipts/imports reference it by a non-canonical name (e.g. last 4 digits of a card). Max 64 chars." },
        ],
        example: `{ "id": 5, "type": "A", "group": "Banks", "name": "Visa Rewards", "currency": "CAD", "alias": "1234" }`,
      },
      {
        method: "PUT",
        path: "/api/accounts",
        description: "Update an existing account",
        body: [
          { name: "id", type: "number", required: true, description: "Account ID" },
          { name: "name", type: "string", required: false, description: "New name" },
          { name: "type", type: "string", required: false, description: "New type" },
          { name: "group", type: "string", required: false, description: "New group" },
          { name: "currency", type: "string", required: false, description: "New currency" },
          { name: "note", type: "string", required: false, description: "New note" },
          { name: "archived", type: "boolean", required: false, description: "Hide/show in balances and pickers" },
          { name: "alias", type: "string|null", required: false, description: "New alias. Send empty string or null to clear." },
        ],
      },
    ],
  },
  {
    name: "Transactions",
    description: "Query, create, update, and delete transactions",
    routes: [
      {
        method: "GET",
        path: "/api/transactions",
        description: "List transactions with optional filters",
        params: [
          { name: "startDate", type: "string", required: false, description: "Filter from date (YYYY-MM-DD)" },
          { name: "endDate", type: "string", required: false, description: "Filter to date (YYYY-MM-DD)" },
          { name: "accountId", type: "number", required: false, description: "Filter by account ID" },
          { name: "categoryId", type: "number", required: false, description: "Filter by category ID" },
          { name: "search", type: "string", required: false, description: "Search payee, note, tags" },
          { name: "limit", type: "number", required: false, description: "Max results (default 100)" },
          { name: "offset", type: "number", required: false, description: "Pagination offset" },
        ],
        example: `[{ "id": 1, "date": "2025-03-01", "accountName": "Chequing", "categoryName": "Groceries", "amount": -85.50, "payee": "Metro" }]`,
      },
      {
        method: "POST",
        path: "/api/transactions",
        description: "Create a new transaction",
        body: [
          { name: "date", type: "string", required: true, description: "Date (YYYY-MM-DD)" },
          { name: "accountId", type: "number", required: true, description: "Account ID" },
          { name: "categoryId", type: "number", required: true, description: "Category ID" },
          { name: "currency", type: "string", required: true, description: "Currency code" },
          { name: "amount", type: "number", required: true, description: "Amount (negative for expense)" },
          { name: "payee", type: "string", required: false, description: "Merchant/payee name" },
          { name: "note", type: "string", required: false, description: "Optional note" },
          { name: "tags", type: "string", required: false, description: "Comma-separated tags" },
        ],
      },
    ],
  },
  {
    name: "Categories",
    description: "Income and expense categories",
    routes: [
      {
        method: "GET",
        path: "/api/categories",
        description: "List all categories grouped by type (Income, Expense, Reconciliation)",
        example: `[{ "id": 1, "type": "E", "group": "Food", "name": "Groceries" }]`,
      },
      {
        method: "POST",
        path: "/api/categories",
        description: "Create a new category",
        body: [
          { name: "name", type: "string", required: true, description: "Category name (unique)" },
          { name: "type", type: "string", required: true, description: "'E' (expense), 'I' (income), 'R' (reconciliation)" },
          { name: "group", type: "string", required: true, description: "Category group" },
        ],
      },
    ],
  },
  {
    name: "Budgets",
    description: "Monthly budget targets by category",
    routes: [
      {
        method: "GET",
        path: "/api/budgets",
        description: "Get budgets, optionally filtered by month",
        params: [
          { name: "month", type: "string", required: false, description: "Filter by month (YYYY-MM)" },
        ],
        example: `[{ "id": 1, "categoryName": "Groceries", "month": "2025-03", "amount": 500 }]`,
      },
      {
        method: "POST",
        path: "/api/budgets",
        description: "Create or update a budget for a category/month",
        body: [
          { name: "categoryId", type: "number", required: true, description: "Category ID" },
          { name: "month", type: "string", required: true, description: "Month (YYYY-MM)" },
          { name: "amount", type: "number", required: true, description: "Budget amount" },
        ],
      },
    ],
  },
  {
    name: "Dashboard & Analytics",
    description: "Aggregated financial data for dashboards",
    routes: [
      {
        method: "GET",
        path: "/api/dashboard",
        description: "Account balances, monthly spending, income vs expenses, and net worth over time",
        example: `{ "accounts": [...], "monthlySpending": [...], "incomeVsExpenses": [...], "netWorthOverTime": [...] }`,
      },
      {
        method: "GET",
        path: "/api/health-score",
        description: "Financial health score (0-100) with component breakdown",
        example: `{ "score": 72, "grade": "Good", "components": [{ "name": "Savings Rate", "score": 85, "weight": 0.3 }] }`,
      },
      {
        method: "GET",
        path: "/api/insights",
        description: "Spending anomalies, category trends, top merchants, and day-of-week patterns",
        example: `{ "anomalies": [...], "trends": [...], "topMerchants": [...], "spendingByDay": [...] }`,
      },
      {
        method: "GET",
        path: "/api/age-of-money",
        description: "Age of money metric — how many days your current cash could last",
      },
    ],
  },
  {
    name: "Subscriptions",
    description: "Track recurring subscriptions and detect them from transactions",
    routes: [
      {
        method: "GET",
        path: "/api/subscriptions",
        description: "List all tracked subscriptions with status and next renewal date",
        example: `[{ "id": 1, "name": "Netflix", "amount": 16.49, "frequency": "monthly", "status": "active" }]`,
      },
      {
        method: "POST",
        path: "/api/subscriptions",
        description: "Create a subscription or detect from transactions (action: 'detect')",
        body: [
          { name: "name", type: "string", required: true, description: "Subscription name" },
          { name: "amount", type: "number", required: true, description: "Recurring amount" },
          { name: "frequency", type: "string", required: false, description: "weekly, monthly, quarterly, annual" },
        ],
      },
    ],
  },
  {
    name: "Forecast & Planning",
    description: "Cash flow forecasting and financial projections",
    routes: [
      {
        method: "GET",
        path: "/api/forecast",
        description: "Cash flow forecast based on recurring transactions",
        params: [
          { name: "days", type: "number", required: false, description: "Forecast horizon in days (default 90)" },
        ],
        example: `{ "currentBalance": 5420.00, "forecast": [...], "warnings": [...] }`,
      },
      {
        method: "GET",
        path: "/api/scenarios",
        description: "What-if financial scenario modeling",
      },
      {
        method: "GET",
        path: "/api/fire",
        description: "FIRE/retirement calculator projections",
      },
    ],
  },
  {
    name: "Portfolio & Investments",
    description: "Investment holdings and portfolio analysis",
    routes: [
      {
        method: "GET",
        path: "/api/portfolio",
        description: "All investment holdings with account grouping",
        example: `[{ "name": "VFV", "symbol": "VFV.TO", "account": "TFSA", "currency": "CAD" }]`,
      },
      {
        method: "POST",
        path: "/api/portfolio",
        description: "Create a portfolio holding. Requires an unlocked session DEK; pre-checks the per-(account, name) unique index and dual-writes Stream D encrypted columns.",
        example: `{ "name": "Vanguard All-Equity ETF", "symbol": "VEQT.TO", "accountId": 12, "currency": "CAD" }`,
      },
      {
        method: "PUT",
        path: "/api/portfolio",
        description: "Update a portfolio holding. Renames cascade to all transactions automatically (the aggregator joins by FK, not by name). Requires an unlocked session DEK; re-encrypts name + symbol on rename.",
        example: `{ "id": 42, "name": "VEQT renamed", "symbol": null, "note": "moved to TFSA" }`,
      },
      {
        method: "DELETE",
        path: "/api/portfolio?id=N",
        description: "Delete a portfolio holding. Returns { success, unlinkedTransactions: <count> } — the FK ON DELETE SET NULL keeps the transactions in place; they fall back to the orphan-aggregation path until reassigned.",
      },
      {
        method: "GET",
        path: "/api/prices",
        description: "Fetch current prices for portfolio holdings from Yahoo Finance",
      },
      {
        method: "GET",
        path: "/api/rebalancing",
        description: "Portfolio rebalancing recommendations vs target allocations",
      },
    ],
  },
  {
    name: "Loans & Debt",
    description: "Loan management and amortization",
    routes: [
      {
        method: "GET",
        path: "/api/loans",
        description: "All loans with amortization summary, remaining balance, and payoff projections",
        example: `[{ "id": 1, "name": "Mortgage", "principal": 400000, "annualRate": 0.055, "remainingBalance": 380000 }]`,
      },
    ],
  },
  {
    name: "Goals",
    description: "Financial goals tracking",
    routes: [
      {
        method: "GET",
        path: "/api/goals",
        description: "All financial goals with progress toward target amounts",
        example: `[{ "id": 1, "name": "Emergency Fund", "targetAmount": 15000, "status": "active" }]`,
      },
      {
        method: "POST",
        path: "/api/goals",
        description: "Create a new financial goal",
        body: [
          { name: "name", type: "string", required: true, description: "Goal name" },
          { name: "type", type: "string", required: true, description: "savings, debt_payoff, investment, emergency_fund" },
          { name: "targetAmount", type: "number", required: true, description: "Target amount" },
          { name: "deadline", type: "string", required: false, description: "Deadline (YYYY-MM-DD)" },
        ],
      },
    ],
  },
  {
    name: "Reports",
    description: "Financial reports and statements",
    routes: [
      {
        method: "GET",
        path: "/api/reports",
        description: "Income statement, balance sheet, and Sankey cash flow data",
        params: [
          { name: "startDate", type: "string", required: false, description: "Report start date" },
          { name: "endDate", type: "string", required: false, description: "Report end date" },
        ],
      },
      {
        method: "GET",
        path: "/api/reports/yoy",
        description: "Year-over-year comparison of income and expenses",
      },
    ],
  },
  {
    name: "Tax",
    description: "Canadian tax optimization tools",
    routes: [
      {
        method: "GET",
        path: "/api/tax",
        description: "Tax optimization recommendations (TFSA/RRSP room, deductions)",
      },
    ],
  },
  {
    name: "Import",
    description: "CSV and data import tools",
    routes: [
      {
        method: "POST",
        path: "/api/import/preview",
        description: "Preview a CSV file before importing (auto-detect columns)",
      },
      {
        method: "POST",
        path: "/api/import/execute",
        description: "Execute a CSV import with column mappings",
      },
      {
        method: "POST",
        path: "/api/import/backfill",
        description: "Backfill missing data from historical imports",
      },
    ],
  },
  {
    name: "Rules Engine",
    description: "Auto-categorization rules for transactions",
    routes: [
      {
        method: "GET",
        path: "/api/rules",
        description: "List all transaction categorization rules",
        example: `[{ "id": 1, "name": "Groceries rule", "matchField": "payee", "matchType": "contains", "matchValue": "metro" }]`,
      },
      {
        method: "POST",
        path: "/api/rules",
        description: "Create a new auto-categorization rule",
        body: [
          { name: "name", type: "string", required: true, description: "Rule name" },
          { name: "matchField", type: "string", required: true, description: "payee, amount, or tags" },
          { name: "matchType", type: "string", required: true, description: "contains, exact, regex, greater_than, less_than" },
          { name: "matchValue", type: "string", required: true, description: "Value to match" },
          { name: "assignCategoryId", type: "number", required: false, description: "Category to assign" },
        ],
      },
    ],
  },
];

// ============ COMPONENTS ============

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  POST: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
  PUT: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  DELETE: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
};

function MethodBadge({ method }: { method: string }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${METHOD_COLORS[method] ?? "bg-gray-100 text-gray-700"}`}>
      {method}
    </span>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
      <code>{children}</code>
    </pre>
  );
}

function ParamTable({ params, label }: { params: ApiParam[]; label: string }) {
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50">
              <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-300">Name</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-300">Type</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-300">Required</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-300">Description</th>
            </tr>
          </thead>
          <tbody>
            {params.map((p) => (
              <tr key={p.name} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                <td className="px-3 py-2 font-mono text-xs text-indigo-600 dark:text-indigo-400">{p.name}</td>
                <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">{p.type}</td>
                <td className="px-3 py-2 text-xs">{p.required ? <span className="text-rose-600 dark:text-rose-400">yes</span> : <span className="text-zinc-400">no</span>}</td>
                <td className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RouteCard({ route }: { route: ApiRoute }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
      >
        <MethodBadge method={route.method} />
        <code className="flex-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">{route.path}</code>
        <span className="hidden text-xs text-zinc-500 dark:text-zinc-400 sm:inline">{route.description}</span>
        <svg className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{route.description}</p>
          {route.params && <ParamTable params={route.params} label="Query Parameters" />}
          {route.body && <ParamTable params={route.body} label="Request Body (JSON)" />}
          {route.example && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Example Response</p>
              <CodeBlock>{route.example}</CodeBlock>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============ MCP TOOLS SECTION ============

const MCP_TOOLS = [
  { name: "get_account_balances", type: "read", description: "Current balances grouped by type" },
  { name: "get_budget_summary", type: "read", description: "Budget vs actual for a month" },
  { name: "get_spending_trends", type: "read", description: "Spending trends by category" },
  { name: "get_net_worth", type: "read", description: "Current totals, or a trend if months>0 is passed" },
  { name: "get_categories", type: "read", description: "All transaction categories" },
  { name: "get_loans", type: "read", description: "Loans with amortization summary" },
  { name: "get_goals", type: "read", description: "Financial goals with progress" },
  { name: "get_recurring_transactions", type: "read", description: "Detected recurring transactions" },
  { name: "get_income_statement", type: "read", description: "Income statement for a period" },
  { name: "get_transaction_rules", type: "read", description: "Auto-categorization rules" },
  { name: "get_financial_health_score", type: "read", description: "Health score 0-100 with breakdown" },
  { name: "get_spending_anomalies", type: "read", description: "Categories with >30% deviation from average" },
  { name: "get_subscription_summary", type: "read", description: "Subscriptions with total cost and renewals" },
  { name: "get_cash_flow_forecast", type: "read", description: "30/60/90 day cash flow projection" },
  { name: "search_transactions", type: "read", description: "Flexible search: payee, amount, date, category, tags" },
  { name: "get_portfolio_analysis", type: "read", description: "Portfolio holdings with all metrics. Pass `symbols` to filter." },
  { name: "get_portfolio_performance", type: "read", description: "TWR, XIRR, period-filtered performance" },
  { name: "analyze_holding", type: "read", description: "Single holding metrics: cost basis, P&L, dividends" },
  { name: "get_investment_insights", type: "read", description: "mode: 'patterns' | 'rebalancing' (needs targets) | 'benchmark' (SP500/TSX/MSCI_WORLD/BONDS_CA)" },
  { name: "get_weekly_recap", type: "read", description: "Weekly financial recap with top categories" },
  { name: "get_spotlight_items", type: "read", description: "Attention items for the dashboard" },
  { name: "list_loans", type: "read", description: "Loans with derived balance, interest, payoff date" },
  { name: "get_loan_amortization", type: "read", description: "Loan amortization schedule" },
  { name: "get_debt_payoff_plan", type: "read", description: "Avalanche or snowball payoff plan across all loans" },
  { name: "get_fx_rate", type: "read", description: "FX rate for a currency pair on a given date" },
  { name: "list_fx_overrides", type: "read", description: "User-pinned FX rate overrides" },
  { name: "convert_amount", type: "read", description: "Convert an amount between currencies" },
  { name: "list_subscriptions", type: "read", description: "Subscriptions with status and next billing date" },
  { name: "detect_subscriptions", type: "read", description: "Detect recurring payments as subscription candidates" },
  { name: "list_rules", type: "read", description: "Auto-categorization rules" },
  { name: "test_rule", type: "read", description: "Dry-run a rule against existing transactions" },
  { name: "suggest_transaction_details", type: "read", description: "Category + tag suggestions based on payee history" },
  { name: "list_splits", type: "read", description: "Splits on a transaction" },
  { name: "list_pending_uploads", type: "read", description: "Uploaded files awaiting preview or execute" },
  { name: "preview_import", type: "read", description: "Parse a pending upload and return a confirmation token" },
  { name: "finlynq_help", type: "read", description: "Self-describing help for available tools" },
  { name: "get_import_templates", type: "read", description: "Saved CSV/OFX import templates" },
  { name: "record_transaction", type: "write", description: "Record a transaction with smart defaults: fuzzy matching + auto-categorize" },
  { name: "update_transaction", type: "write", description: "Update any field of a transaction by ID (including category)" },
  { name: "delete_transaction", type: "write", description: "Delete a transaction by ID" },
  { name: "bulk_record_transactions", type: "write", description: "Insert many transactions in one call" },
  { name: "set_budget", type: "write", description: "Set or update a budget" },
  { name: "delete_budget", type: "write", description: "Delete a budget" },
  { name: "add_goal", type: "write", description: "Create a financial goal" },
  { name: "update_goal", type: "write", description: "Update a financial goal" },
  { name: "delete_goal", type: "write", description: "Delete a financial goal" },
  { name: "add_snapshot", type: "write", description: "Record a net worth snapshot" },
  { name: "add_account", type: "write", description: "Create a new account (optional alias for receipt/import matching)" },
  { name: "update_account", type: "write", description: "Update an account, including its alias" },
  { name: "delete_account", type: "write", description: "Delete an account" },
  { name: "create_category", type: "write", description: "Create a new transaction category" },
  { name: "create_rule", type: "write", description: "Create an auto-categorization rule" },
  { name: "update_rule", type: "write", description: "Update a rule" },
  { name: "delete_rule", type: "write", description: "Delete a rule" },
  { name: "reorder_rules", type: "write", description: "Change rule priority order" },
  { name: "add_loan", type: "write", description: "Add a loan" },
  { name: "update_loan", type: "write", description: "Update a loan" },
  { name: "delete_loan", type: "write", description: "Delete a loan" },
  { name: "set_fx_override", type: "write", description: "Pin an FX rate for a specific date" },
  { name: "delete_fx_override", type: "write", description: "Remove an FX override" },
  { name: "add_subscription", type: "write", description: "Add a subscription" },
  { name: "update_subscription", type: "write", description: "Update any field of a subscription (status, amount, cadence, etc.)" },
  { name: "delete_subscription", type: "write", description: "Delete a subscription" },
  { name: "bulk_add_subscriptions", type: "write", description: "Commit detected subscription candidates (needs confirmation token)" },
  { name: "add_split", type: "write", description: "Add a split to a transaction" },
  { name: "update_split", type: "write", description: "Update a split" },
  { name: "delete_split", type: "write", description: "Delete a split" },
  { name: "replace_splits", type: "write", description: "Atomically replace all splits on a transaction" },
  { name: "preview_bulk_update", type: "write", description: "Preview a bulk transaction update and return a confirmation token" },
  { name: "execute_bulk_update", type: "write", description: "Execute a previewed bulk update" },
  { name: "preview_bulk_delete", type: "write", description: "Preview a bulk delete and return a confirmation token" },
  { name: "execute_bulk_delete", type: "write", description: "Execute a previewed bulk delete" },
  { name: "preview_bulk_categorize", type: "write", description: "Preview a bulk categorize and return a confirmation token" },
  { name: "execute_bulk_categorize", type: "write", description: "Execute a previewed bulk categorize" },
  { name: "execute_import", type: "write", description: "Commit a previewed import (needs confirmation token)" },
  { name: "cancel_import", type: "write", description: "Cancel a pending upload and delete the file" },
  { name: "import_with_template", type: "write", description: "Run a saved import template against parsed rows" },
  { name: "apply_rules_to_uncategorized", type: "write", description: "Apply all rules to uncategorized transactions" },
];

// ============ PAGE ============

function ApiDocsPageContent() {
  const [activeTab, setActiveTab] = useState<"rest" | "mcp">("rest");

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <div className="mx-auto max-w-4xl px-6 py-12">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">API Documentation</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            PF exposes both a REST API (Next.js routes) and an MCP server for AI assistant integration.
            All data is local — no external services required.
          </p>
        </div>

        {/* Auth Notice */}
        <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">Authentication (Optional)</h3>
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
            Routes can optionally require an API key via the <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-900/50">X-API-Key</code> header.
            Generate your key from Settings. The MCP server runs locally on stdio and does not require authentication.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="mb-6 flex gap-1 rounded-lg border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-700 dark:bg-zinc-800">
          <button
            onClick={() => setActiveTab("rest")}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "rest"
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            REST API ({API_GROUPS.reduce((s, g) => s + g.routes.length, 0)} routes)
          </button>
          <button
            onClick={() => setActiveTab("mcp")}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "mcp"
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            MCP Server ({MCP_TOOLS.length} tools)
          </button>
        </div>

        {/* REST API Tab */}
        {activeTab === "rest" && (
          <div className="space-y-8">
            {/* Base URL */}
            <div>
              <h3 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">Base URL</h3>
              <CodeBlock>{"http://localhost:3000"}</CodeBlock>
            </div>

            {/* Response Format */}
            <div>
              <h3 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">Standard Response Format (with apiSuccess/apiError helpers)</h3>
              <CodeBlock>{`// Success
{ "success": true, "data": { ... }, "meta": { "total": 42 } }

// Error
{ "success": false, "error": "Descriptive error message" }`}</CodeBlock>
            </div>

            {/* Route Groups */}
            {API_GROUPS.map((group) => (
              <div key={group.name}>
                <h2 className="mb-1 text-xl font-bold text-zinc-800 dark:text-zinc-100">{group.name}</h2>
                <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">{group.description}</p>
                <div className="space-y-2">
                  {group.routes.map((route) => (
                    <RouteCard key={`${route.method}-${route.path}`} route={route} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* MCP Tab */}
        {activeTab === "mcp" && (
          <div className="space-y-6">
            {/* Connection Info */}
            <div>
              <h3 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">Connection</h3>
              <CodeBlock>{`Transport: stdio
Server name: finlynq
Version: 2.2.0

# Run with:
npx tsx mcp-server/index.ts

# Or add to Claude Desktop config:
{
  "mcpServers": {
    "finlynq": {
      "command": "npx",
      "args": ["tsx", "/path/to/pf-app/mcp-server/index.ts"]
    }
  }
}`}</CodeBlock>
            </div>

            {/* Discovery */}
            <div>
              <h3 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">Discovery</h3>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Server metadata is available at{" "}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">/.well-known/mcp.json</code>
              </p>
            </div>

            {/* Tools */}
            <div>
              <h3 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">
                Read Tools ({MCP_TOOLS.filter((t) => t.type === "read").length})
              </h3>
              <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50">
                      <th className="px-4 py-2 text-left font-medium text-zinc-600 dark:text-zinc-300">Tool</th>
                      <th className="px-4 py-2 text-left font-medium text-zinc-600 dark:text-zinc-300">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {MCP_TOOLS.filter((t) => t.type === "read").map((tool) => (
                      <tr key={tool.name} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                        <td className="px-4 py-2 font-mono text-xs text-emerald-600 dark:text-emerald-400">{tool.name}</td>
                        <td className="px-4 py-2 text-xs text-zinc-600 dark:text-zinc-300">{tool.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">
                Write Tools ({MCP_TOOLS.filter((t) => t.type === "write").length})
              </h3>
              <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50">
                      <th className="px-4 py-2 text-left font-medium text-zinc-600 dark:text-zinc-300">Tool</th>
                      <th className="px-4 py-2 text-left font-medium text-zinc-600 dark:text-zinc-300">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {MCP_TOOLS.filter((t) => t.type === "write").map((tool) => (
                      <tr key={tool.name} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                        <td className="px-4 py-2 font-mono text-xs text-indigo-600 dark:text-indigo-400">{tool.name}</td>
                        <td className="px-4 py-2 text-xs text-zinc-600 dark:text-zinc-300">{tool.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Security Model */}
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Security Model</h3>
              <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                <li>Local-only: MCP server runs on localhost via stdio transport</li>
                <li>Zero-knowledge: No data leaves your machine</li>
                <li>Read + controlled writes: Write tools are limited to safe operations</li>
                <li>No bank integrations: Manual entry and CSV import only</li>
              </ul>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-12 border-t border-zinc-200 pt-6 text-center text-xs text-zinc-400 dark:border-zinc-800">
          Finlynq v2.3 &mdash; Local-first personal finance. Track your money here, analyze it anywhere.
        </div>
      </div>
    </div>
  );
}

export default function ApiDocsPage() { return <DevModeGuard><ApiDocsPageContent /></DevModeGuard>; }
