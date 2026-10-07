import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import TransactionsScreen from "../screens/TransactionsScreen";
import TransactionDetailScreen from "../screens/TransactionDetailScreen";
import AddTransactionScreen from "../screens/AddTransactionScreen";
import SplitsEditorScreen from "../screens/SplitsEditorScreen";
import type { Transaction } from "../../../shared/types";
import type { TransferEditSeed } from "../lib/transfer-pair";

export type TransactionsStackParamList = {
  TransactionsList: undefined;
  TransactionDetail: { transaction: Transaction };
  // `editTransfer` → edit an existing transfer pair (opened from TransactionDetail).
  AddTransaction: { mode?: "expense" | "income" | "transfer"; editTransfer?: TransferEditSeed } | undefined;
  // Edit splits for an already-saved transaction. totalAmount carries the
  // parent's sign; the editor works in magnitudes and re-applies it on save.
  SplitsEditor: { transactionId: number; totalAmount: number; currency: string };
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
      <Stack.Screen
        name="SplitsEditor"
        component={SplitsEditorScreen}
        options={{ presentation: "modal" }}
      />
    </Stack.Navigator>
  );
}
