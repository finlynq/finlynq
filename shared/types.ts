// Shared types between web and mobile apps
// These types mirror the database schema and API response shapes

// --- API Response Envelope ---
export type ApiSuccessResponse<T> = {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
};

export type ApiErrorResponse = {
  success: false;
  error: string;
};

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// --- Domain Entities ---

export interface Account {
  id: number;
  type: "A" | "L"; // Asset or Liability
  group: string;
  name: string;
  currency: string;
  note: string;
}

export interface Category {
  id: number;
  type: "E" | "I" | "R"; // Expense, Income, Reconciliation
  group: string;
  name: string;
  note: string;
}

export interface Transaction {
  id: number;
  date: string;
  accountId: number | null;
  categoryId: number | null;
  currency: string;
  amount: number;
  quantity: number | null;
  portfolioHolding: string | null;
  note: string;
  payee: string;
  tags: string;
  isBusiness: number;
  splitPerson: string | null;
  splitRatio: number | null;
  importHash: string | null;
  fitId: string | null;
}

export interface Budget {
  id: number;
  categoryId: number;
  month: string;
  amount: number;
  currency: string;
}

export interface Goal {
  id: number;
  name: string;
  type: "savings" | "debt_payoff" | "investment" | "emergency_fund";
  targetAmount: number;
  deadline: string | null;
  accountId: number | null;
  priority: number;
  status: string;
  note: string;
}

export interface Loan {
  id: number;
  name: string;
  type: "mortgage" | "lease" | "loan" | "student_loan" | "credit_card";
  accountId: number | null;
  principal: number;
  annualRate: number;
  termMonths: number;
  startDate: string;
  paymentAmount: number | null;
  paymentFrequency: string;
  extraPayment: number;
  note: string;
}

export interface PortfolioHolding {
  id: number;
  accountId: number | null;
  name: string;
  symbol: string | null;
  currency: string;
  isCrypto: number;
  note: string;
}

export interface Subscription {
  id: number;
  name: string;
  amount: number;
  currency: string;
  frequency: "weekly" | "monthly" | "quarterly" | "annual";
  categoryId: number | null;
  accountId: number | null;
  nextDate: string | null;
  status: "active" | "paused" | "cancelled";
  cancelReminderDate: string | null;
  notes: string | null;
}

export interface Snapshot {
  id: number;
  accountId: number | null;
  date: string;
  value: number;
  note: string;
}

export interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  read: number;
  createdAt: string;
  metadata: string;
}

// --- Auth ---
export interface UnlockStatus {
  unlocked: boolean;
  needsSetup: boolean;
  mode: string;
  hasExistingData: boolean;
}

// --- Dashboard ---
export interface DashboardData {
  netWorth: number;
  totalAssets: number;
  totalLiabilities: number;
  monthlyIncome: number;
  monthlyExpenses: number;
  savingsRate: number;
  recentTransactions: Transaction[];
  accountBalances: Array<{ name: string; balance: number; type: string; currency: string }>;
}

// --- Health Score ---
export interface HealthScoreComponent {
  name: string;
  score: number;
  weight: number;
  weighted: number;
  detail: string;
}

export interface HealthScoreData {
  score: number;
  grade: "Excellent" | "Good" | "Fair" | "Needs Work";
  components: HealthScoreComponent[];
}

// --- Budget with spending ---
export interface BudgetWithSpending extends Budget {
  categoryName?: string;
  categoryGroup?: string;
  convertedAmount?: number;
  convertedSpent?: number;
  rolloverAmount?: number;
}

// --- Transaction form ---
export interface TransactionFormData {
  date: string;
  amount: number;
  accountId: number;
  categoryId: number;
  currency?: string;
  payee?: string;
  note?: string;
  tags?: string;
  isBusiness?: number;
  splitPerson?: string;
  splitRatio?: number;
  quantity?: number;
  portfolioHolding?: string;
}
