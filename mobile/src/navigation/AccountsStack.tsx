import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import AccountsScreen from "../screens/AccountsScreen";
import AccountDetailScreen from "../screens/AccountDetailScreen";
import AddAccountScreen from "../screens/AddAccountScreen";
import AddTransactionScreen from "../screens/AddTransactionScreen";
// TransactionDetailScreen's Props are typed against TransactionsStackParamList;
// cast to ComponentType to mount it in this stack without duplicating its type.
import TransactionDetailScreen from "../screens/TransactionDetailScreen";
import type { AccountBalance, AccountDetailRow, Transaction } from "../../../shared/types";
import type { TransferEditSeed } from "../lib/transfer-pair";

export type AccountsStackParamList = {
  AccountsList: undefined;
  AccountDetail: { account: AccountBalance };
  // `account` present → edit mode (prefill + PUT); absent → create mode.
  AddAccount: { account?: AccountDetailRow } | undefined;
  AddTransaction: {
    mode?: "expense" | "income" | "transfer";
    preselectedAccountId?: number;
    // Edit an existing transfer pair (opened from TransactionDetail).
    editTransfer?: TransferEditSeed;
  };
  // Transaction view/edit screen reused from the Transactions tab.
  TransactionDetail: { transaction: Transaction };
};

const Stack = createNativeStackNavigator<AccountsStackParamList>();

export default function AccountsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="AccountsList" component={AccountsScreen} />
      <Stack.Screen name="AccountDetail" component={AccountDetailScreen} />
      <Stack.Screen
        name="AddAccount"
        component={AddAccountScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen
        name="AddTransaction"
        component={AddTransactionScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen
        name="TransactionDetail"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        component={TransactionDetailScreen as React.ComponentType<any>}
      />
    </Stack.Navigator>
  );
}
