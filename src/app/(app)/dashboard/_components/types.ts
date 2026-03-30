export type Balance = {
  accountId: number;
  accountName: string;
  accountType: string;
  accountGroup: string;
  currency: string;
  balance: number;
};

export type IncomeExpense = { month: string; type: string; total: number };

export type CategorySpend = {
  categoryId: number;
  categoryName: string;
  categoryGroup: string;
  total: number;
};

export type NetWorthPoint = { month: string; currency: string; cumulative: number };

export type DashboardData = {
  balances: Balance[];
  incomeVsExpenses: IncomeExpense[];
  spendingByCategory: CategorySpend[];
  netWorthOverTime: NetWorthPoint[];
};

export type HealthData = {
  score: number;
  grade: string;
  components: { name: string; score: number; weight: number; weighted: number; detail: string }[];
};

export type SpotlightItem = {
  id: string;
  type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  actionUrl: string;
  amount?: number;
};

export type WeeklyRecapData = {
  weekStart: string;
  weekEnd: string;
  spending: {
    total: number;
    previousWeekTotal: number;
    changePercent: number;
    topCategories: { name: string; total: number }[];
  };
  income: { total: number; previousWeekTotal: number };
  netCashFlow: number;
  budgetStatus: { category: string; budget: number; spent: number; pctUsed: number }[];
  notableTransactions: { date: string; payee: string; category: string; amount: number }[];
  upcomingBills: { name: string; amount: number; date: string }[];
  netWorthChange: number;
};

export type MonthlyData = { month: string; income: number; expenses: number };

export type InsightsData = {
  anomalies: { category: string; currentMonth: number; average: number; percentAbove: number; severity: string }[];
  trends: { category: string; trend: string; changePercent: number }[];
  topMerchants: { payee: string; totalSpent: number; count: number }[];
  spendingByDay: { day: string; total: number; count: number }[];
};

export type RecurringData = {
  recurring: { payee: string; avgAmount: number; frequency: string; nextDate: string }[];
  monthlyRecurringTotal: number;
  count: number;
};
