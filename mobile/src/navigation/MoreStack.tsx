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

export type MoreStackParamList = {
  MoreHome: undefined;
  Budgets: undefined;
  Goals: undefined;
  Categories: undefined;
  Import: undefined;
  Settings: undefined;
  AddTransaction: { mode?: "expense" | "income" | "transfer" } | undefined;
  AddCategory: undefined;
  AddGoal: undefined;
  WhatsNew: undefined;
  Feedback: undefined;
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
      <Stack.Screen name="Settings" component={SettingsScreen} />
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
    </Stack.Navigator>
  );
}
