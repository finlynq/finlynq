import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import TransactionsScreen from "../screens/TransactionsScreen";
import TransactionDetailScreen from "../screens/TransactionDetailScreen";
import AddTransactionScreen from "../screens/AddTransactionScreen";
import type { Transaction } from "../../../shared/types";

export type TransactionsStackParamList = {
  TransactionsList: undefined;
  TransactionDetail: { transaction: Transaction };
  AddTransaction: undefined;
};

const Stack = createNativeStackNavigator<TransactionsStackParamList>();

export default function TransactionsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="TransactionsList" component={TransactionsScreen} />
      <Stack.Screen name="TransactionDetail" component={TransactionDetailScreen} />
      <Stack.Screen
        name="AddTransaction"
        component={AddTransactionScreen}
        options={{ presentation: "modal" }}
      />
    </Stack.Navigator>
  );
}
