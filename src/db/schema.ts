import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // 'A' (asset) or 'L' (liability)
  group: text("group").notNull().default(""),
  name: text("name").notNull().unique(),
  currency: text("currency").notNull().default("CAD"),
  note: text("note").default(""),
});

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // 'E' (expense), 'I' (income), 'R' (reconciliation)
  group: text("group").notNull().default(""),
  name: text("name").notNull().unique(),
  note: text("note").default(""),
});

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  categoryId: integer("category_id").references(() => categories.id),
  currency: text("currency").notNull().default("CAD"),
  amount: real("amount").notNull().default(0),
  quantity: real("quantity"),
  portfolioHolding: text("portfolio_holding"),
  note: text("note").default(""),
  payee: text("payee").default(""),
  tags: text("tags").default(""),
  isBusiness: integer("is_business").default(0),
  splitPerson: text("split_person"),
  splitRatio: real("split_ratio"),
});

export const portfolioHoldings = sqliteTable("portfolio_holdings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").references(() => accounts.id),
  name: text("name").notNull(),
  symbol: text("symbol"),
  currency: text("currency").notNull().default("CAD"),
  note: text("note").default(""),
});

export const budgets = sqliteTable("budgets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  categoryId: integer("category_id")
    .references(() => categories.id)
    .notNull(),
  month: text("month").notNull(),
  amount: real("amount").notNull().default(0),
});

// Feature 1: Loans & Amortization
export const loans = sqliteTable("loans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'mortgage', 'lease', 'loan', 'student_loan', 'credit_card'
  accountId: integer("account_id").references(() => accounts.id),
  principal: real("principal").notNull(),
  annualRate: real("annual_rate").notNull(),
  termMonths: integer("term_months").notNull(),
  startDate: text("start_date").notNull(),
  paymentAmount: real("payment_amount"),
  paymentFrequency: text("payment_frequency").notNull().default("monthly"),
  extraPayment: real("extra_payment").default(0),
  note: text("note").default(""),
});

// Feature 9: Net Worth Snapshots
export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").references(() => accounts.id),
  date: text("date").notNull(),
  value: real("value").notNull(),
  note: text("note").default(""),
});

// Feature 11: Financial Goals
export const goals = sqliteTable("goals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'savings', 'debt_payoff', 'investment', 'emergency_fund'
  targetAmount: real("target_amount").notNull(),
  deadline: text("deadline"),
  accountId: integer("account_id").references(() => accounts.id),
  priority: integer("priority").default(1),
  status: text("status").notNull().default("active"),
  note: text("note").default(""),
});

// Feature 15: Rebalancing Target Allocations
export const targetAllocations = sqliteTable("target_allocations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  targetPct: real("target_pct").notNull(),
  category: text("category").notNull(),
});

// Feature 6: Recurring Transactions
export const recurringTransactions = sqliteTable("recurring_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  payee: text("payee").notNull(),
  amount: real("amount").notNull(),
  frequency: text("frequency").notNull(),
  categoryId: integer("category_id").references(() => categories.id),
  accountId: integer("account_id").references(() => accounts.id),
  nextDate: text("next_date"),
  active: integer("active").notNull().default(1),
  note: text("note").default(""),
});

// Feature 2: Price Cache
export const priceCache = sqliteTable("price_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  date: text("date").notNull(),
  price: real("price").notNull(),
  currency: text("currency").notNull(),
});

// Feature 5: FX Rates
export const fxRates = sqliteTable("fx_rates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  fromCurrency: text("from_currency").notNull(),
  toCurrency: text("to_currency").notNull(),
  rate: real("rate").notNull(),
});

// Feature 19: Notifications
export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  read: integer("read").notNull().default(0),
  createdAt: text("created_at").notNull(),
  metadata: text("metadata").default(""),
});

// Feature 8: Tax - Contribution Room
export const contributionRoom = sqliteTable("contribution_room", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // 'TFSA', 'RRSP', 'RESP'
  year: integer("year").notNull(),
  room: real("room").notNull(),
  used: real("used").default(0),
  note: text("note").default(""),
});
