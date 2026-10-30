import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import MoreScreen from "../screens/MoreScreen";
import BudgetsScreen from "../screens/BudgetsScreen";
import GoalsScreen from "../screens/GoalsScreen";
import LoansScreen from "../screens/LoansScreen";
import LoanDetailScreen from "../screens/LoanDetailScreen";
import LoanInterestScreen from "../screens/LoanInterestScreen";
import AddLoanScreen from "../screens/AddLoanScreen";
import CategoriesScreen from "../screens/CategoriesScreen";
import ImportScreen from "../screens/ImportScreen";
import SettingsScreen from "../screens/SettingsScreen";
import AddTransactionScreen from "../screens/AddTransactionScreen";
import AddCategoryScreen from "../screens/AddCategoryScreen";
import AddGoalScreen from "../screens/AddGoalScreen";
import WhatsNewScreen from "../screens/WhatsNewScreen";
import FeedbackScreen from "../screens/FeedbackScreen";
import ReportsScreen from "../screens/ReportsScreen";
import IncomeStatementScreen from "../screens/IncomeStatementScreen";
import BalanceSheetScreen from "../screens/BalanceSheetScreen";
import TrendsScreen from "../screens/TrendsScreen";
import CashFlowSankeyScreen from "../screens/CashFlowSankeyScreen";
import YearOverYearScreen from "../screens/YearOverYearScreen";
import InboxScreen from "../screens/InboxScreen";
import EmailImportsScreen from "../screens/EmailImportsScreen";
import EmailRecordScreen from "../screens/EmailRecordScreen";
import StagedImportScreen from "../screens/StagedImportScreen";
import BankFeedScreen from "../screens/BankFeedScreen";
import ReconcileThresholdsScreen from "../screens/ReconcileThresholdsScreen";
import SubscriptionsScreen from "../screens/SubscriptionsScreen";
import AddSubscriptionScreen from "../screens/AddSubscriptionScreen";
import CategoryReportsScreen from "../screens/CategoryReportsScreen";
import CategoryDetailScreen from "../screens/CategoryDetailScreen";
import CostBasisScreen from "../screens/CostBasisScreen";
import type {
  Category,
  EmailInboxItem,
  GoalWithProgress,
  LoanSummary,
  Subscription,
  SubscriptionFormData,
} from "../../../shared/types";

/** Date range + display currency threaded from the Reports hub to a detail
 *  screen (trends/sankey/income-statement responses don't all carry currency). */
export interface ReportRangeRouteParams {
  startDate: string;
  endDate: string;
  isBusiness: boolean;
  displayCurrency: string;
  rangeLabel: string;
}

export type MoreStackParamList = {
  MoreHome: undefined;
  Budgets: undefined;
  Goals: undefined;
  Loans: undefined;
  // One loan and its payment schedule, opened from the Loans list.
  LoanDetail: { loan: LoanSummary };
  // That loan's interest: what the schedule calculates beside what is booked.
  LoanInterest: { loan: LoanSummary };
  // `loan` present -> edit (prefill + PUT); absent -> create.
  AddLoan: { loan?: LoanSummary } | undefined;
  Categories: undefined;
  Import: undefined;
  Inbox: { accountId?: number } | undefined;
  // Email imports (2026-10-15): emailed transactions to record + statement
  // files waiting for review.
  EmailImports: undefined;
  EmailRecord: { item: EmailInboxItem };
  StagedImport: { id: string; title: string };
  // Bank feed (2026-10-30): sync SimpleFIN for the accounts linked on the web.
  BankFeed: undefined;
  Settings: undefined;
  ReconcileThresholds: undefined;
  // Simple average or advanced lot allocation (also on the Portfolio tab).
  CostBasis: undefined;
  AddTransaction:
    | { mode?: "expense" | "income" | "transfer"; preselectedAccountId?: number }
    | undefined;
  // `category`/`goal` present → edit mode (prefill + PUT); absent → create.
  AddCategory: { category?: Category } | undefined;
  AddGoal: { goal?: GoalWithProgress } | undefined;
  Subscriptions: undefined;
  // `subscription` → edit; `prefill` → create seeded from a detected series.
  AddSubscription: { subscription?: Subscription; prefill?: SubscriptionFormData } | undefined;
  WhatsNew: undefined;
  Feedback: undefined;
  Reports: undefined;
  IncomeStatement: ReportRangeRouteParams;
  BalanceSheet: { endDate: string; displayCurrency: string };
  Trends: ReportRangeRouteParams;
  CashFlowSankey: ReportRangeRouteParams;
  YearOverYear: { displayCurrency: string };
  // Category reports (2026-10): month-by-category overview + one category.
  CategoryReports: { type?: "E" | "I" } | undefined;
  CategoryDetail: { categoryId: number; name?: string };
};

const Stack = createNativeStackNavigator<MoreStackParamList>();

export default function MoreStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreHome" component={MoreScreen} />
      <Stack.Screen name="Budgets" component={BudgetsScreen} />
      <Stack.Screen name="Goals" component={GoalsScreen} />
      <Stack.Screen name="Loans" component={LoansScreen} />
      <Stack.Screen name="LoanDetail" component={LoanDetailScreen} />
      <Stack.Screen name="LoanInterest" component={LoanInterestScreen} />
      <Stack.Screen
        name="AddLoan"
        component={AddLoanScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen name="Subscriptions" component={SubscriptionsScreen} />
      <Stack.Screen name="CategoryReports" component={CategoryReportsScreen} />
      <Stack.Screen name="CategoryDetail" component={CategoryDetailScreen} />
      <Stack.Screen name="Categories" component={CategoriesScreen} />
      <Stack.Screen name="Import" component={ImportScreen} />
      <Stack.Screen name="Inbox" component={InboxScreen} />
      <Stack.Screen name="EmailImports" component={EmailImportsScreen} />
      <Stack.Screen
        name="EmailRecord"
        component={EmailRecordScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen name="StagedImport" component={StagedImportScreen} />
      <Stack.Screen name="BankFeed" component={BankFeedScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="ReconcileThresholds" component={ReconcileThresholdsScreen} />
      <Stack.Screen name="CostBasis" component={CostBasisScreen} />
      <Stack.Screen
        name="AddTransaction"
        component={AddTransactionScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen
        name="AddCategory"
        component={AddCategoryScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen
        name="AddGoal"
        component={AddGoalScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen
        name="AddSubscription"
        component={AddSubscriptionScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen name="WhatsNew" component={WhatsNewScreen} />
      <Stack.Screen
        name="Feedback"
        component={FeedbackScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen name="Reports" component={ReportsScreen} />
      <Stack.Screen name="IncomeStatement" component={IncomeStatementScreen} />
      <Stack.Screen name="BalanceSheet" component={BalanceSheetScreen} />
      <Stack.Screen name="Trends" component={TrendsScreen} />
      <Stack.Screen name="CashFlowSankey" component={CashFlowSankeyScreen} />
      <Stack.Screen name="YearOverYear" component={YearOverYearScreen} />
    </Stack.Navigator>
  );
}
