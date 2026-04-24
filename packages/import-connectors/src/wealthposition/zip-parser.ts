// Parses a WealthPosition export ZIP's 4 CSVs into Finlynq-shaped rows.
// The ZIP format preserves more structure than the API (Portfolio.csv maps
// holdings to their parent brokerage, signed amounts are on every row).
//
// Input: raw CSV strings for Accounts.csv / Categories.csv / Portfolio.csv /
// Transactions.csv, plus the resolved mapping from the user.
// Output: the same TransformResult shape that transform.ts returns for the
// API path — so the orchestrator + route code is interchangeable.

import type {
  ConnectorMappingResolved,
  ExternalAccount,
  ExternalCategory,
  RawTransaction,
  TransformResult,
  TransformSplitRow,
  TransformSplitTx,
} from "../types";
import { parseCsvDicts } from "./csv";

export interface ParsedExport {
  accounts: ExternalAccount[];
  categories: ExternalCategory[];
  /** holding name → { brokerageAccountName, symbol | null } */
  portfolioByHolding: Map<string, { brokerageAccount: string; symbol: string | null; currency: string }>;
  transactions: ZipTransactionRow[];
}

export interface ZipTransactionRow {
  date: string;
  account: string;
  categorization: string;
  currency: string;
  amount: number;
  quantity: number | null;
  portfolioHolding: string | null;
  note: string;
  payee: string;
  tags: string;
  /** 0-based index in the CSV (post-header). Stable ordering for split-grouping. */
  order: number;
}

export interface ZipContents {
  accountsCsv: string;
  categoriesCsv: string;
  portfolioCsv: string;
  transactionsCsv: string;
}

// Synthetic external ids: the CSV doesn't carry the API's UUIDs. We derive
// stable ids from names so the UI's existing mapping machinery works.
function syntheticAccountId(name: string): string {
  return `csv:acct:${name}`;
}
function syntheticCategoryId(name: string): string {
  return `csv:cat:${name}`;
}

export function parseWealthPositionExport(zip: ZipContents): ParsedExport {
  const acctRows = parseCsvDicts(zip.accountsCsv);
  const catRows = parseCsvDicts(zip.categoriesCsv);
  const portRows = parseCsvDicts(zip.portfolioCsv);
  const txRows = parseCsvDicts(zip.transactionsCsv);

  const accounts: ExternalAccount[] = acctRows
    .filter((r) => r.Account)
    .map((r) => ({
      id: syntheticAccountId(r.Account),
      name: r.Account,
      type: r.Type || "A",
      currency: r.Currency || "CAD",
      groupName: r.Group || undefined,
    }));

  const categories: ExternalCategory[] = catRows
    .filter((r) => r.Category)
    .map((r) => ({
      id: syntheticCategoryId(r.Category),
      name: r.Category,
      type: r.Type || "E",
      groupName: r.Group || undefined,
    }));

  const portfolioByHolding = new Map<string, { brokerageAccount: string; symbol: string | null; currency: string }>();
  for (const r of portRows) {
    const holdingName = r["Portfolio holding name"];
    const brokerageAccount = r["Portfolio account name"];
    if (!holdingName || !brokerageAccount) continue;
    portfolioByHolding.set(holdingName, {
      brokerageAccount,
      symbol: r.Symbol || null,
      currency: r.Currency || "CAD",
    });
  }

  const transactions: ZipTransactionRow[] = [];
  txRows.forEach((r, idx) => {
    const amount = parseFloat(r.Amount);
    if (!r.Date || !Number.isFinite(amount)) return;
    const qtyRaw = r.Quantity;
    const quantity = qtyRaw && qtyRaw.length > 0 ? parseFloat(qtyRaw) : null;
    transactions.push({
      date: r.Date,
      account: r.Account || "",
      categorization: r.Categorization || "",
      currency: r.Currency || "CAD",
      amount,
      quantity: Number.isFinite(quantity as number) ? (quantity as number) : null,
      portfolioHolding: r["Portfolio holding"] || null,
      note: r.Note || "",
      payee: r.Payee || "",
      tags: r.Tags || "",
      order: idx,
    });
  });

  return { accounts, categories, portfolioByHolding, transactions };
}

// --------------------------------------------------------------------------
// Transform: ParsedExport + resolved mapping → TransformResult
// --------------------------------------------------------------------------

const SPLIT_SENTINEL = "#SPLIT#";

type RowKind = "account" | "category" | "holding" | "split" | "unknown";

interface ParsedExportIndexes {
  accountsByName: Map<string, ExternalAccount>;
  categoriesByName: Map<string, ExternalCategory>;
  portfolioByHolding: Map<string, { brokerageAccount: string; symbol: string | null; currency: string }>;
}

function classifyAccountCell(
  raw: string,
  idx: ParsedExportIndexes,
): { kind: RowKind; account?: ExternalAccount; holdingRef?: { brokerageAccount: string; symbol: string | null; currency: string; holdingName: string } } {
  if (raw === SPLIT_SENTINEL) return { kind: "split" };
  if (!raw) return { kind: "unknown" };
  const acct = idx.accountsByName.get(raw);
  if (acct) return { kind: "account", account: acct };
  const port = idx.portfolioByHolding.get(raw);
  if (port) return { kind: "holding", holdingRef: { ...port, holdingName: raw } };
  return { kind: "unknown" };
}

function classifyCategorizationCell(
  raw: string,
  idx: ParsedExportIndexes,
): { kind: RowKind; account?: ExternalAccount; category?: ExternalCategory; holdingRef?: { brokerageAccount: string; symbol: string | null; currency: string; holdingName: string } } {
  if (raw === SPLIT_SENTINEL) return { kind: "split" };
  if (!raw) return { kind: "unknown" };
  const cat = idx.categoriesByName.get(raw);
  if (cat) return { kind: "category", category: cat };
  const acct = idx.accountsByName.get(raw);
  if (acct) return { kind: "account", account: acct };
  const port = idx.portfolioByHolding.get(raw);
  if (port) return { kind: "holding", holdingRef: { ...port, holdingName: raw } };
  return { kind: "unknown" };
}

/**
 * Resolve a Finlynq account id from either a direct account name (WP Account
 * column) or a holding name (routes through Portfolio.csv to the brokerage).
 * Returns undefined if the mapping hasn't been made yet.
 */
function resolveFinlynqAccount(
  externalAccount: ExternalAccount | undefined,
  holdingRef: { brokerageAccount: string } | undefined,
  idx: ParsedExportIndexes,
  mapping: ConnectorMappingResolved,
): { finlynqAccountId: number; finlynqAccountName: string; externalAccount: ExternalAccount } | null {
  let extAcct: ExternalAccount | undefined = externalAccount;
  if (!extAcct && holdingRef) {
    extAcct = idx.accountsByName.get(holdingRef.brokerageAccount);
  }
  if (!extAcct) return null;
  const finlynqAccountId = mapping.accountMap.get(extAcct.id);
  if (finlynqAccountId === undefined) return null;
  const finlynqAccountName = mapping.accountNameById.get(finlynqAccountId);
  if (!finlynqAccountName) return null;
  return { finlynqAccountId, finlynqAccountName, externalAccount: extAcct };
}

export function transformWealthPositionExport(
  parsed: ParsedExport,
  mapping: ConnectorMappingResolved,
): TransformResult {
  const flat: RawTransaction[] = [];
  const splits: TransformSplitTx[] = [];
  const errors: TransformResult["errors"] = [];

  const idx: ParsedExportIndexes = {
    accountsByName: new Map(parsed.accounts.map((a) => [a.name, a])),
    categoriesByName: new Map(parsed.categories.map((c) => [c.name, c])),
    portfolioByHolding: parsed.portfolioByHolding,
  };

  // Walk rows in CSV order. A multi-leg group is a parent row (real account,
  // cat=#SPLIT#) followed by consecutive #SPLIT# children.
  const rows = parsed.transactions;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const acctKind = classifyAccountCell(row.account, idx);
    const catKind = classifyCategorizationCell(row.categorization, idx);

    // --- CASE: standalone direct row (account known, categorization is category/account/empty/holding)
    if (acctKind.kind === "account" && catKind.kind !== "split") {
      emitSingleRowTx(row, acctKind.account!, catKind, idx, mapping, flat, errors);
      i++;
      continue;
    }

    // --- CASE: direct row where `account` is a holding name (e.g., "Bitcoin")
    // Route through the brokerage, preserve the ticker.
    if (acctKind.kind === "holding" && catKind.kind !== "split") {
      emitHoldingSideTx(row, acctKind.holdingRef!, catKind, idx, mapping, flat, errors);
      i++;
      continue;
    }

    // --- CASE: parent row of a multi-leg group
    if (acctKind.kind === "account" && catKind.kind === "split") {
      const parent = row;
      const parentAccount = acctKind.account!;
      const children: ZipTransactionRow[] = [];
      let j = i + 1;
      while (j < rows.length && rows[j].account === SPLIT_SENTINEL) {
        children.push(rows[j]);
        j++;
      }
      emitGroup(parent, parentAccount, children, idx, mapping, flat, splits, errors);
      i = j;
      continue;
    }

    // --- CASE: parent row where `account` is a holding
    if (acctKind.kind === "holding" && catKind.kind === "split") {
      const parent = row;
      const children: ZipTransactionRow[] = [];
      let j = i + 1;
      while (j < rows.length && rows[j].account === SPLIT_SENTINEL) {
        children.push(rows[j]);
        j++;
      }
      // Holding-parent: walk children as position legs on the brokerage.
      emitGroup(parent, acctKind.holdingRef ? idx.accountsByName.get(acctKind.holdingRef.brokerageAccount) : undefined, children, idx, mapping, flat, splits, errors, acctKind.holdingRef);
      i = j;
      continue;
    }

    // --- CASE: orphan child (we shouldn't normally see this — parent walk ate them)
    errors.push({ externalId: `row-${row.order}`, reason: `Orphan #SPLIT# row at ${row.date}: ${row.account} / ${row.categorization} (no preceding parent)` });
    i++;
  }

  return { flat, splits, errors };
}

function emitSingleRowTx(
  row: ZipTransactionRow,
  account: ExternalAccount,
  catKind: ReturnType<typeof classifyCategorizationCell>,
  idx: ParsedExportIndexes,
  mapping: ConnectorMappingResolved,
  flat: RawTransaction[],
  errors: TransformResult["errors"],
): void {
  const finlynq = resolveFinlynqAccount(account, undefined, idx, mapping);
  if (!finlynq) {
    errors.push({ externalId: `row-${row.order}`, reason: `Account "${account.name}" is not mapped.` });
    return;
  }

  let categoryName: string | undefined;
  if (catKind.kind === "category") {
    const catId = mapping.categoryMap.get(catKind.category!.id);
    if (catId !== undefined && catId !== null) {
      categoryName = mapping.categoryNameById.get(catId);
    }
  } else if (catKind.kind === "account") {
    // Transfer leg represented as a single row (rare in #SPLIT# style, but possible)
    const transferId = mapping.transferCategoryId;
    if (transferId !== null) {
      categoryName = mapping.categoryNameById.get(transferId);
    }
  } else if (catKind.kind === "holding") {
    // Portfolio purchase written as a single row — use the holding as symbol.
  }

  flat.push(buildRawTransaction({
    date: row.date,
    accountName: finlynq.finlynqAccountName,
    amount: row.amount,
    currency: row.currency,
    payee: row.payee,
    note: row.note,
    tags: row.tags,
    category: categoryName,
    portfolioHolding: catKind.kind === "holding" ? catKind.holdingRef!.holdingName : row.portfolioHolding || undefined,
    symbol: catKind.kind === "holding" ? catKind.holdingRef!.symbol : null,
    quantity: row.quantity ?? undefined,
  }));
}

function emitHoldingSideTx(
  row: ZipTransactionRow,
  holdingRef: { brokerageAccount: string; symbol: string | null; currency: string; holdingName: string },
  catKind: ReturnType<typeof classifyCategorizationCell>,
  idx: ParsedExportIndexes,
  mapping: ConnectorMappingResolved,
  flat: RawTransaction[],
  errors: TransformResult["errors"],
): void {
  const finlynq = resolveFinlynqAccount(undefined, holdingRef, idx, mapping);
  if (!finlynq) {
    errors.push({ externalId: `row-${row.order}`, reason: `Brokerage account "${holdingRef.brokerageAccount}" (for holding "${holdingRef.holdingName}") is not mapped.` });
    return;
  }
  let categoryName: string | undefined;
  if (catKind.kind === "category") {
    const catId = mapping.categoryMap.get(catKind.category!.id);
    if (catId !== undefined && catId !== null) categoryName = mapping.categoryNameById.get(catId);
  }
  flat.push(buildRawTransaction({
    date: row.date,
    accountName: finlynq.finlynqAccountName,
    amount: row.amount,
    currency: row.currency,
    payee: row.payee,
    note: row.note,
    tags: row.tags,
    category: categoryName,
    portfolioHolding: row.portfolioHolding || holdingRef.holdingName,
    symbol: holdingRef.symbol,
    quantity: row.quantity ?? undefined,
  }));
}

function emitGroup(
  parent: ZipTransactionRow,
  parentAccount: ExternalAccount | undefined,
  children: ZipTransactionRow[],
  idx: ParsedExportIndexes,
  mapping: ConnectorMappingResolved,
  flat: RawTransaction[],
  splits: TransformSplitTx[],
  errors: TransformResult["errors"],
  parentHoldingRef?: { brokerageAccount: string; symbol: string | null; currency: string; holdingName: string },
): void {
  const finlynq = resolveFinlynqAccount(parentAccount, parentHoldingRef, idx, mapping);
  if (!finlynq) {
    const name = parentAccount?.name ?? parentHoldingRef?.brokerageAccount ?? parent.account;
    errors.push({ externalId: `row-${parent.order}`, reason: `Parent account "${name}" is not mapped.` });
    return;
  }

  if (children.length === 0) {
    // Parent with no children — emit as a single tx.
    flat.push(buildRawTransaction({
      date: parent.date,
      accountName: finlynq.finlynqAccountName,
      amount: parent.amount,
      currency: parent.currency,
      payee: parent.payee,
      note: parent.note,
      tags: parent.tags,
      category: undefined,
      portfolioHolding: parentHoldingRef?.holdingName ?? parent.portfolioHolding ?? undefined,
      symbol: parentHoldingRef?.symbol ?? null,
      quantity: parent.quantity ?? undefined,
    }));
    return;
  }

  // Classify children by kind
  const childClasses = children.map((c) => ({ row: c, cls: classifyCategorizationCell(c.categorization, idx) }));
  const catChildren = childClasses.filter((c) => c.cls.kind === "category");
  const acctChildren = childClasses.filter((c) => c.cls.kind === "account");
  const holdingChildren = childClasses.filter((c) => c.cls.kind === "holding");

  // --- All children are categories → category split (parent + N splits)
  if (catChildren.length === children.length && children.length >= 1) {
    const parentTx = buildRawTransaction({
      date: parent.date,
      accountName: finlynq.finlynqAccountName,
      amount: parent.amount,
      currency: parent.currency,
      payee: parent.payee,
      note: parent.note,
      tags: parent.tags,
      category: undefined,
      portfolioHolding: parentHoldingRef?.holdingName ?? parent.portfolioHolding ?? undefined,
      symbol: parentHoldingRef?.symbol ?? null,
      quantity: parent.quantity ?? undefined,
    });
    const splitRows: TransformSplitRow[] = catChildren.map((c) => {
      const catId = c.cls.category ? (mapping.categoryMap.get(c.cls.category.id) ?? null) : null;
      return { categoryId: catId, amount: c.row.amount, note: c.row.note };
    });
    splits.push({ parent: parentTx, splits: splitRows, externalId: `group-${parent.order}` });
    return;
  }

  // --- All children are accounts → transfer set (parent + N flat txs, all with Transfer category)
  if (acctChildren.length === children.length) {
    const transferId = mapping.transferCategoryId;
    const transferName = transferId !== null ? mapping.categoryNameById.get(transferId) : undefined;
    // Parent leg
    flat.push(buildRawTransaction({
      date: parent.date,
      accountName: finlynq.finlynqAccountName,
      amount: parent.amount,
      currency: parent.currency,
      payee: parent.payee,
      note: parent.note,
      tags: parent.tags,
      category: transferName,
      portfolioHolding: parentHoldingRef?.holdingName ?? parent.portfolioHolding ?? undefined,
      symbol: parentHoldingRef?.symbol ?? null,
      quantity: parent.quantity ?? undefined,
    }));
    for (const c of acctChildren) {
      const resolved = resolveFinlynqAccount(c.cls.account, undefined, idx, mapping);
      if (!resolved) {
        errors.push({ externalId: `row-${c.row.order}`, reason: `Transfer leg account "${c.cls.account!.name}" is not mapped.` });
        continue;
      }
      flat.push(buildRawTransaction({
        date: c.row.date,
        accountName: resolved.finlynqAccountName,
        amount: c.row.amount,
        currency: c.row.currency,
        payee: c.row.payee || parent.payee,
        note: c.row.note || parent.note,
        tags: c.row.tags || parent.tags,
        category: transferName,
        portfolioHolding: c.row.portfolioHolding || undefined,
        symbol: null,
        quantity: c.row.quantity ?? undefined,
      }));
    }
    return;
  }

  // --- All children are holdings → position purchases
  if (holdingChildren.length === children.length) {
    // Emit the parent cash leg on its own account so balances reconcile
    // against WP's /account_balances (e.g., RBC Checking drops by $6000
    // when the money leaves to buy positions). Skip when the parent is
    // itself a holding on the same brokerage — that's an intra-brokerage
    // swap where parent + children are all positions in the same account.
    if (!parentHoldingRef) {
      const transferId = mapping.transferCategoryId;
      const transferName = transferId !== null ? mapping.categoryNameById.get(transferId) : undefined;
      flat.push(buildRawTransaction({
        date: parent.date,
        accountName: finlynq.finlynqAccountName,
        amount: parent.amount,
        currency: parent.currency,
        payee: parent.payee,
        note: parent.note,
        tags: parent.tags,
        category: transferName,
        portfolioHolding: undefined,
        symbol: null,
        quantity: parent.quantity ?? undefined,
      }));
    }

    // Each position leg goes to its OWN brokerage (via Portfolio.csv),
    // NOT to the parent's account. A stock buy from a Questrade holding
    // should land on Questrade, not on the CL cash account that funded it.
    for (const c of holdingChildren) {
      const holdingRef = c.cls.holdingRef!;
      const brokerageExt = idx.accountsByName.get(holdingRef.brokerageAccount);
      const childResolved = resolveFinlynqAccount(brokerageExt, holdingRef, idx, mapping);
      if (!childResolved) {
        errors.push({
          externalId: `row-${c.row.order}`,
          reason: `Brokerage "${holdingRef.brokerageAccount}" (for holding "${holdingRef.holdingName}") is not mapped.`,
        });
        continue;
      }
      flat.push(buildRawTransaction({
        date: c.row.date,
        accountName: childResolved.finlynqAccountName,
        amount: c.row.amount,
        currency: c.row.currency,
        payee: c.row.payee || parent.payee,
        note: c.row.note || parent.note,
        tags: c.row.tags || parent.tags,
        category: undefined,
        portfolioHolding: c.row.portfolioHolding || holdingRef.holdingName,
        symbol: holdingRef.symbol,
        quantity: c.row.quantity ?? undefined,
      }));
    }
    return;
  }

  // --- Mixed children (e.g., 1 category + 1 holding). Emit best-effort: any
  // categories become splits on the parent; any account/holding children
  // become additional flat txs.
  const parentTx = buildRawTransaction({
    date: parent.date,
    accountName: finlynq.finlynqAccountName,
    amount: catChildren.reduce((s, c) => s + c.row.amount, parent.amount - catChildren.reduce((s, c) => s + c.row.amount, 0)) || parent.amount,
    currency: parent.currency,
    payee: parent.payee,
    note: parent.note,
    tags: parent.tags,
    category: undefined,
    portfolioHolding: parentHoldingRef?.holdingName ?? parent.portfolioHolding ?? undefined,
    symbol: parentHoldingRef?.symbol ?? null,
    quantity: parent.quantity ?? undefined,
  });
  if (catChildren.length > 0) {
    splits.push({
      parent: parentTx,
      splits: catChildren.map((c) => ({
        categoryId: c.cls.category ? (mapping.categoryMap.get(c.cls.category.id) ?? null) : null,
        amount: c.row.amount,
        note: c.row.note,
      })),
      externalId: `group-${parent.order}`,
    });
  } else {
    flat.push(parentTx);
  }
  // Account / holding children as flat txs
  for (const c of acctChildren) {
    const resolved = resolveFinlynqAccount(c.cls.account, undefined, idx, mapping);
    if (!resolved) continue;
    flat.push(buildRawTransaction({
      date: c.row.date,
      accountName: resolved.finlynqAccountName,
      amount: c.row.amount,
      currency: c.row.currency,
      payee: c.row.payee || parent.payee,
      note: c.row.note || parent.note,
      tags: c.row.tags || parent.tags,
      category: undefined,
      portfolioHolding: c.row.portfolioHolding || undefined,
      symbol: null,
      quantity: c.row.quantity ?? undefined,
    }));
  }
  for (const c of holdingChildren) {
    const holdingRef = c.cls.holdingRef!;
    const brokerageExt = idx.accountsByName.get(holdingRef.brokerageAccount);
    const childResolved = resolveFinlynqAccount(brokerageExt, holdingRef, idx, mapping);
    if (!childResolved) {
      errors.push({
        externalId: `row-${c.row.order}`,
        reason: `Brokerage "${holdingRef.brokerageAccount}" (for holding "${holdingRef.holdingName}") is not mapped.`,
      });
      continue;
    }
    flat.push(buildRawTransaction({
      date: c.row.date,
      accountName: childResolved.finlynqAccountName,
      amount: c.row.amount,
      currency: c.row.currency,
      payee: c.row.payee || parent.payee,
      note: c.row.note || parent.note,
      tags: c.row.tags || parent.tags,
      category: undefined,
      portfolioHolding: c.row.portfolioHolding || holdingRef.holdingName,
      symbol: holdingRef.symbol,
      quantity: c.row.quantity ?? undefined,
    }));
  }
}

interface BuildArgs {
  date: string;
  accountName: string;
  amount: number;
  currency: string;
  payee: string;
  note: string;
  tags: string;
  category?: string;
  portfolioHolding?: string;
  symbol: string | null;
  quantity?: number;
}

function buildRawTransaction(args: BuildArgs): RawTransaction {
  const row: RawTransaction = {
    date: args.date,
    account: args.accountName,
    amount: args.amount,
    payee: (args.payee || "").trim(),
    currency: args.currency,
    note: args.note || undefined,
    tags: args.tags ? args.tags : undefined,
    category: args.category,
  };
  // `portfolio_holding` on a transaction must match `portfolio_holdings.name`
  // — the portfolio/overview aggregator keys off that name when computing per-
  // holding quantity + cost basis. Symbol lives separately on
  // `portfolio_holdings.symbol`, so don't put it on the transaction.
  if (args.portfolioHolding) {
    row.portfolioHolding = args.portfolioHolding;
  }
  if (args.quantity !== undefined && Number.isFinite(args.quantity)) {
    row.quantity = args.quantity;
  }
  return row;
}
