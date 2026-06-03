import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import MoreScreen from "../screens/MoreScreen";
import BudgetsScreen from "../screens/BudgetsScreen";
import GoalsScreen from "../screens/GoalsScreen";
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
import ReconcileThresholdsScreen from "../screens/ReconcileThresholdsScreen";
import type { Category, GoalWithProgress } from "../../../shared/types";

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
  Categories: undefined;
  Import: undefined;
  Inbox: { accountId?: number } | undefined;
  Settings: undefined;
  ReconcileThresholds: undefined;
  AddTransaction:
    | { mode?: "expense" | "income" | "transfer"; preselectedAccountId?: number }
    | undefined;
  // `category`/`goal` present → edit mode (prefill + PUT); absent → create.
  AddCategory: { category?: Category } | undefined;
  AddGoal: { goal?: GoalWithProgress } | undefined;
  WhatsNew: undefined;
  Feedback: undefined;
  Reports: undefined;
  IncomeStatement: ReportRangeRouteParams;
  BalanceSheet: { endDate: string; displayCurrency: string };
  Trends: ReportRangeRouteParams;
  CashFlowSankey: ReportRangeRouteParams;
  YearOverYear: { displayCurrency: string };
};

const Stack = createNativeStackNavigator<MoreStackParamList>();

export default function MoreStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreHome" component={MoreScreen} />
      <Stack.Screen name="Budgets" component={BudgetsScreen} />
      <Stack.Screen name="Goals" component={GoalsScreen} />
      <Stack.Screen name="Categories" component={CategoriesScreen} />
      <Stack.Screen name="Import" component={ImportScreen} />
      <Stack.Screen name="Inbox" component={InboxScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="ReconcileThresholds" component={ReconcileThresholdsScreen} />
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
