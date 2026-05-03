/**
 * Seed the public demo account on Finlynq.
 *
 * Idempotent — re-running wipes the demo user's data and re-inserts fresh samples.
 * Safe to run from a nightly systemd timer.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/seed-demo.ts
 *
 * The demo account credentials are intentionally published — this data is public.
 */

import pg from "pg";
import bcrypt from "bcryptjs";
import {
  createWrappedDEKForPassword,
  encryptField,
} from "../src/lib/crypto/envelope";
import { encryptName } from "../src/lib/crypto/encrypted-columns";

// ─── Configuration ─────────────────────────────────────────────────────────

const DEMO_EMAIL = "demo@finlynq.com";
const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "finlynq-demo";
const DEMO_USER_ID = "00000000-0000-0000-0000-00000000demo";
const DEMO_DISPLAY_NAME = "Finlynq Demo";

const databaseUrl: string = (() => {
  const url = process.env.DATABASE_URL ?? process.env.PF_DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL or PF_DATABASE_URL must be set.");
    process.exit(1);
  }
  return url;
})();

// ─── Sample data definitions ───────────────────────────────────────────────

// Account type uses single-letter codes in this app: "A" = asset, "L" = liability.
// Category type uses "I" = income, "E" = expense.
type AccountSeed = { type: "A" | "L"; group: string; name: string };
type CategorySeed = { type: "I" | "E"; group: string; name: string };

const ACCOUNTS: AccountSeed[] = [
  { type: "A", group: "Banks", name: "Chequing" },
  { type: "A", group: "Banks", name: "Savings" },
  { type: "A", group: "Investments", name: "Brokerage" },
  { type: "L", group: "Credit Cards", name: "Visa Rewards" },
];

const CATEGORIES: CategorySeed[] = [
  { type: "I", group: "Income", name: "Salary" },
  { type: "I", group: "Income", name: "Interest" },
  { type: "E", group: "Housing", name: "Rent" },
  { type: "E", group: "Housing", name: "Utilities" },
  { type: "E", group: "Housing", name: "Internet" },
  { type: "E", group: "Food", name: "Groceries" },
  { type: "E", group: "Food", name: "Dining" },
  { type: "E", group: "Transport", name: "Transit" },
  { type: "E", group: "Transport", name: "Fuel" },
  { type: "E", group: "Lifestyle", name: "Entertainment" },
  { type: "E", group: "Lifestyle", name: "Subscriptions" },
  { type: "E", group: "Lifestyle", name: "Shopping" },
  { type: "E", group: "Health", name: "Fitness" },
  { type: "E", group: "Health", name: "Medical" },
  { type: "E", group: "Savings", name: "Transfer to Savings" },
];

// ─── Transaction generation ────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

/** Deterministic-ish jitter so the seed looks realistic but re-runs produce the same data. */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

type TxSeed = {
  date: string;
  account: string;
  category: string;
  amount: number;
  payee: string;
  note?: string;
};

function generateTransactions(): TxSeed[] {
  const txs: TxSeed[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setMonth(startDate.getMonth() - 6);

  // Income: salary twice a month (1st and 15th), plus a tiny interest credit monthly
  for (let m = 0; m < 6; m++) {
    const month = new Date(startDate);
    month.setMonth(startDate.getMonth() + m);
    const firstPay = new Date(month.getFullYear(), month.getMonth(), 1);
    const midPay = new Date(month.getFullYear(), month.getMonth(), 15);
    txs.push({ date: isoDate(firstPay), account: "Chequing", category: "Salary", amount: 3200, payee: "Acme Corp" });
    txs.push({ date: isoDate(midPay), account: "Chequing", category: "Salary", amount: 3200, payee: "Acme Corp" });
    const interestDay = new Date(month.getFullYear(), month.getMonth(), 28);
    txs.push({ date: isoDate(interestDay), account: "Savings", category: "Interest", amount: 18 + pseudoRandom(m) * 4, payee: "Bank interest" });
  }

  // Rent on the 1st of each month
  for (let m = 0; m < 6; m++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + m, 1);
    txs.push({ date: isoDate(d), account: "Chequing", category: "Rent", amount: -1850, payee: "Maple Leaf Properties" });
  }

  // Utilities + Internet on the 5th of each month
  for (let m = 0; m < 6; m++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + m, 5);
    txs.push({ date: isoDate(d), account: "Visa Rewards", category: "Utilities", amount: -(130 + Math.round(pseudoRandom(m * 3) * 40)), payee: "Hydro One" });
    txs.push({ date: isoDate(d), account: "Visa Rewards", category: "Internet", amount: -89.99, payee: "Rogers" });
  }

  // Subscriptions (recurring, monthly)
  const subs = [
    { payee: "Netflix", amount: -16.49 },
    { payee: "Spotify", amount: -10.99 },
    { payee: "Claude Pro", amount: -20.0 },
    { payee: "GitHub Copilot", amount: -13.0 },
    { payee: "Cloud Storage", amount: -9.99 },
  ];
  for (let m = 0; m < 6; m++) {
    const baseDay = new Date(startDate.getFullYear(), startDate.getMonth() + m, 10);
    subs.forEach((s, i) => {
      const day = new Date(baseDay);
      day.setDate(baseDay.getDate() + i);
      txs.push({ date: isoDate(day), account: "Visa Rewards", category: "Subscriptions", amount: s.amount, payee: s.payee });
    });
  }

  // Groceries — ~4/week on Visa
  const groceryStores = ["Loblaws", "Metro", "No Frills", "Costco", "Farm Boy"];
  const weeksBack = 26;
  for (let w = 0; w < weeksBack; w++) {
    for (let i = 0; i < 2; i++) {
      const day = addDays(startDate, w * 7 + 1 + i * 3);
      if (day > today) break;
      const store = groceryStores[(w + i) % groceryStores.length];
      // Make March (month 2 when looking back 6 months) noticeably higher for a believable anomaly
      const marchBump = day.getMonth() === 2 ? 1.6 : 1.0;
      const amount = -Math.round((55 + pseudoRandom(w * 10 + i) * 60) * marchBump * 100) / 100;
      txs.push({ date: isoDate(day), account: "Visa Rewards", category: "Groceries", amount, payee: store });
    }
  }

  // Dining — ~2/week
  const restaurants = ["Tim Hortons", "Starbucks", "Chipotle", "A&W", "Kinton Ramen", "Pai Northern", "Sushi Q"];
  for (let w = 0; w < weeksBack; w++) {
    for (let i = 0; i < 2; i++) {
      const day = addDays(startDate, w * 7 + 2 + i * 2);
      if (day > today) break;
      const place = restaurants[(w + i) % restaurants.length];
      const amount = -Math.round((12 + pseudoRandom(w * 7 + i) * 35) * 100) / 100;
      txs.push({ date: isoDate(day), account: "Visa Rewards", category: "Dining", amount, payee: place });
    }
  }

  // Transit — weekly
  for (let w = 0; w < weeksBack; w++) {
    const day = addDays(startDate, w * 7);
    if (day > today) break;
    txs.push({ date: isoDate(day), account: "Visa Rewards", category: "Transit", amount: -15.5, payee: "TTC" });
  }

  // Fuel — bi-weekly
  for (let w = 0; w < weeksBack; w += 2) {
    const day = addDays(startDate, w * 7 + 3);
    if (day > today) break;
    const amount = -Math.round((55 + pseudoRandom(w) * 25) * 100) / 100;
    txs.push({ date: isoDate(day), account: "Visa Rewards", category: "Fuel", amount, payee: "Shell" });
  }

  // Entertainment — ~2/month
  for (let m = 0; m < 6; m++) {
    for (let i = 0; i < 2; i++) {
      const d = new Date(startDate.getFullYear(), startDate.getMonth() + m, 8 + i * 10);
      if (d > today) break;
      const amount = -Math.round((25 + pseudoRandom(m * 5 + i) * 40) * 100) / 100;
      txs.push({ date: isoDate(d), account: "Visa Rewards", category: "Entertainment", amount, payee: "Cineplex" });
    }
  }

  // Fitness — monthly gym
  for (let m = 0; m < 6; m++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + m, 3);
    txs.push({ date: isoDate(d), account: "Visa Rewards", category: "Fitness", amount: -49, payee: "GoodLife Fitness" });
  }

  // Transfers to savings (monthly)
  for (let m = 0; m < 6; m++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + m, 16);
    txs.push({ date: isoDate(d), account: "Chequing", category: "Transfer to Savings", amount: -500, payee: "Transfer" });
    txs.push({ date: isoDate(d), account: "Savings", category: "Transfer to Savings", amount: 500, payee: "Transfer in" });
  }

  // Credit card payments (monthly)
  for (let m = 0; m < 6; m++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + m, 25);
    txs.push({ date: isoDate(d), account: "Chequing", category: "Transfer to Savings", amount: -1100, payee: "Visa payment" });
    txs.push({ date: isoDate(d), account: "Visa Rewards", category: "Transfer to Savings", amount: 1100, payee: "Visa payment in" });
  }

  // Brokerage deposit so TFSA has cash to invest
  const brokerageDepositDate = new Date(startDate);
  brokerageDepositDate.setDate(brokerageDepositDate.getDate() + 3);
  txs.push({ date: isoDate(brokerageDepositDate), account: "Chequing", category: "Transfer to Savings", amount: -12000, payee: "Transfer to TFSA" });
  txs.push({ date: isoDate(brokerageDepositDate), account: "Brokerage", category: "Transfer to Savings", amount: 12000, payee: "Transfer from Chequing" });

  return txs;
}

/** Investment buys/sells on the Brokerage account.
 * Each row binds to a portfolio_holdings row via portfolio_holding_id (FK)
 * so the portfolio page can price holdings at live market rates. */
type InvestmentTx = { daysFromStart: number; holding: string; quantity: number; amount: number; payee: string };

function investmentTransactions(startDate: Date): InvestmentTx[] {
  return [
    { daysFromStart: 10, holding: "VTI", quantity: 20, amount: -5500, payee: "Buy VTI" },
    { daysFromStart: 45, holding: "VOO", quantity: 10, amount: -4800, payee: "Buy VOO" },
    { daysFromStart: 80, holding: "BTC", quantity: 0.025, amount: -1200, payee: "Buy BTC" },
    { daysFromStart: 120, holding: "VTI", quantity: 5, amount: -1400, payee: "Buy VTI (DCA)" },
  ];
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    console.log(`[seed-demo] Target DB: ${databaseUrl.split("@")[1] ?? "(hidden)"}`);
    const now = new Date().toISOString();

    // 1. Upsert demo user (with envelope-encryption DEK).
    //
    // Every reseed rotates the wrapped DEK — crucially, also rotating the DEK
    // itself — because we're inserting freshly-encrypted ciphertext using
    // whichever DEK we generate here. That means old rows wouldn't decrypt,
    // but the wipe step below drops them first so there's no mismatch.
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
    const { dek: demoDek, wrapped: demoWrap } = createWrappedDEKForPassword(DEMO_PASSWORD);
    // ON CONFLICT now targets the primary key (id). The old `(email)` target
    // assumed a hard UNIQUE on the email column, but that constraint was
    // replaced by a partial unique index on lower(email) when usernames
    // shipped — so ON CONFLICT (email) would error. Idempotent reseeds key
    // off the canonical demo UUID.
    await client.query(
      `INSERT INTO users (id, username, email, password_hash, display_name, role, email_verified, mfa_enabled, onboarding_complete, plan, kek_salt, dek_wrapped, dek_wrapped_iv, dek_wrapped_tag, encryption_v, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'user', 1, 0, 1, 'free', $6, $7, $8, $9, 1, $10, $10)
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username,
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         display_name = EXCLUDED.display_name,
         kek_salt = EXCLUDED.kek_salt,
         dek_wrapped = EXCLUDED.dek_wrapped,
         dek_wrapped_iv = EXCLUDED.dek_wrapped_iv,
         dek_wrapped_tag = EXCLUDED.dek_wrapped_tag,
         encryption_v = EXCLUDED.encryption_v,
         updated_at = EXCLUDED.updated_at`,
      [
        DEMO_USER_ID,
        DEMO_USERNAME,
        DEMO_EMAIL,
        passwordHash,
        DEMO_DISPLAY_NAME,
        demoWrap.salt.toString("base64"),
        demoWrap.wrapped.toString("base64"),
        demoWrap.iv.toString("base64"),
        demoWrap.tag.toString("base64"),
        now,
      ]
    );

    // Ensure the user row we just upserted has the canonical ID, in case it was created earlier with a different one
    const { rows: userRows } = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [DEMO_EMAIL]
    );
    const userId = userRows[0]?.id ?? DEMO_USER_ID;
    console.log(`[seed-demo] Demo user id: ${userId}`);

    // 2. Wipe existing demo data (order matters due to FKs)
    console.log(`[seed-demo] Wiping existing demo data…`);
    await client.query(
      `DELETE FROM transaction_splits
       WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = $1)`,
      [userId]
    );
    const tables = [
      "transactions",
      "budgets",
      "goals",
      "portfolio_holdings",
      "recurring_transactions",
      "subscriptions",
      "snapshots",
      "target_allocations",
      "transaction_rules",
      "budget_templates",
      "contribution_room",
      "fx_overrides",
      "notifications",
      "import_templates",
      "settings",
    ];
    for (const t of tables) {
      await client.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    }
    await client.query(`DELETE FROM categories WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM accounts WHERE user_id = $1`, [userId]);

    // 3. Insert accounts. Stream D Phase 4 cutover (2026-05-03): plaintext
    // `name` and `alias` columns physically dropped — only name_ct + name_lookup
    // carry the display name. Demo's DEK is derivable here, so we encrypt directly.
    console.log(`[seed-demo] Inserting ${ACCOUNTS.length} accounts…`);
    const accountIds: Record<string, number> = {};
    for (const a of ACCOUNTS) {
      const enc = encryptName(demoDek, a.name);
      const { rows } = await client.query(
        `INSERT INTO accounts (user_id, type, "group", name_ct, name_lookup, currency, note)
         VALUES ($1, $2, $3, $4, $5, 'CAD', '') RETURNING id`,
        [userId, a.type, a.group, enc.ct, enc.lookup]
      );
      accountIds[a.name] = rows[0].id;
    }

    // 4. Insert categories. Same encrypted-only contract.
    console.log(`[seed-demo] Inserting ${CATEGORIES.length} categories…`);
    const categoryIds: Record<string, number> = {};
    for (const c of CATEGORIES) {
      const enc = encryptName(demoDek, c.name);
      const { rows } = await client.query(
        `INSERT INTO categories (user_id, type, "group", name_ct, name_lookup, note)
         VALUES ($1, $2, $3, $4, $5, '') RETURNING id`,
        [userId, c.type, c.group, enc.ct, enc.lookup]
      );
      categoryIds[c.name] = rows[0].id;
    }

    // 5. Insert transactions — payee, note, tags, portfolio_holding encrypted
    //    with the demo user's DEK.
    const txs = generateTransactions();
    console.log(`[seed-demo] Inserting ${txs.length} transactions…`);
    for (const tx of txs) {
      const accountId = accountIds[tx.account];
      const categoryId = categoryIds[tx.category];
      if (!accountId || !categoryId) continue;
      await client.query(
        `INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, payee, note, tags, is_business)
         VALUES ($1, $2, $3, $4, 'CAD', $5, $6, $7, $8, 0)`,
        [
          userId,
          tx.date,
          accountId,
          categoryId,
          tx.amount,
          encryptField(demoDek, tx.payee),
          encryptField(demoDek, tx.note ?? ""),
          encryptField(demoDek, ""),
        ]
      );
    }

    // Portfolio holdings — inserted BEFORE investment transactions so we can
    // bind portfolio_holding_id (FK) directly on each tx. Without this, the
    // demo perpetually contributes withoutFk > 0 to
    // /api/admin/portfolio-holding-fk-progress and blocks the Phase 5 cutover.
    const brokerageId = accountIds["Brokerage"];
    console.log(`[seed-demo] Inserting portfolio holdings…`);
    const holdingsSeed = [
      { name: "VTI", symbol: "VTI", currency: "USD", isCrypto: 0, note: "Vanguard Total Stock Market" },
      { name: "VOO", symbol: "VOO", currency: "USD", isCrypto: 0, note: "Vanguard S&P 500" },
      { name: "BTC", symbol: "BTC", currency: "USD", isCrypto: 1, note: "Bitcoin" },
    ];
    const holdingIdsByName: Record<string, number> = {};
    for (const h of holdingsSeed) {
      // Stream D Phase 4 cutover (2026-05-03): plaintext `name` + `symbol`
      // physically dropped. *_ct + *_lookup are the sole storage.
      const nameEnc = encryptName(demoDek, h.name);
      const symbolEnc = encryptName(demoDek, h.symbol);
      const { rows } = await client.query(
        `INSERT INTO portfolio_holdings (user_id, account_id, name_ct, name_lookup, symbol_ct, symbol_lookup, currency, is_crypto, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [userId, brokerageId, nameEnc.ct, nameEnc.lookup, symbolEnc.ct, symbolEnc.lookup, h.currency, h.isCrypto, h.note]
      );
      holdingIdsByName[h.name] = rows[0].id;
    }

    // Investment buys — bind portfolio_holding_id (FK). Phase 5 (2026-04-29)
    // retired the legacy encrypted portfolio_holding text column.
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const invStart = new Date(today0); invStart.setMonth(invStart.getMonth() - 6);
    const invTxs = investmentTransactions(invStart);
    console.log(`[seed-demo] Inserting ${invTxs.length} investment transactions…`);
    for (const i of invTxs) {
      const d = new Date(invStart); d.setDate(d.getDate() + i.daysFromStart);
      const holdingId = holdingIdsByName[i.holding];
      if (!holdingId) {
        throw new Error(`[seed-demo] Investment tx references unknown holding '${i.holding}'`);
      }
      await client.query(
        `INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, quantity, portfolio_holding_id, payee, note, tags, is_business)
         VALUES ($1, $2, $3, NULL, 'CAD', $4, $5, $6, $7, $8, $9, 0)`,
        [
          userId,
          isoDate(d),
          brokerageId,
          i.amount,
          i.quantity,
          holdingId,
          encryptField(demoDek, i.payee),
          encryptField(demoDek, ""),
          encryptField(demoDek, ""),
        ]
      );
    }

    // 6. Insert budgets for the current month (with Groceries noticeably over)
    const thisMonth = new Date().toISOString().slice(0, 7);
    const budgets = [
      { category: "Groceries", amount: 400 },
      { category: "Dining", amount: 200 },
      { category: "Entertainment", amount: 100 },
      { category: "Subscriptions", amount: 70 },
    ];
    console.log(`[seed-demo] Inserting ${budgets.length} budgets for ${thisMonth}…`);
    for (const b of budgets) {
      const categoryId = categoryIds[b.category];
      if (!categoryId) continue;
      await client.query(
        `INSERT INTO budgets (user_id, category_id, month, amount, currency)
         VALUES ($1, $2, $3, $4, 'CAD')`,
        [userId, categoryId, thisMonth, b.amount]
      );
    }

    // 7. Goals. Phase 4: plaintext `name` dropped; encrypt the two literals.
    console.log(`[seed-demo] Inserting goals…`);
    const efEnc = encryptName(demoDek, "Emergency fund");
    const tjEnc = encryptName(demoDek, "Trip to Japan");
    await client.query(
      `INSERT INTO goals (user_id, name_ct, name_lookup, type, target_amount, deadline, account_id, priority, status, note)
       VALUES
         ($1, $3, $4, 'savings', 10000, NULL, $2, 1, 'active', 'Three months of expenses'),
         ($1, $5, $6, 'savings', 5000, '2027-03-01', $2, 2, 'active', '')`,
      [userId, accountIds["Savings"], efEnc.ct, efEnc.lookup, tjEnc.ct, tjEnc.lookup]
    );

    // Note: login_count and last_login_at are intentionally NOT reset here
    // so they accumulate across nightly reseeds and give a true interaction metric.

    const { rows: metricRows } = await client.query(
      `SELECT login_count, last_login_at FROM users WHERE id = $1`,
      [userId]
    );
    console.log(
      `[seed-demo] Done. Demo user ${DEMO_EMAIL} is ready. ` +
        `Cumulative logins: ${metricRows[0]?.login_count ?? 0}, last: ${metricRows[0]?.last_login_at ?? "never"}.`
    );
  } catch (err) {
    console.error(`[seed-demo] Failed:`, err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
