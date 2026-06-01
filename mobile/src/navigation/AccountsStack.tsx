import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import AccountsScreen from "../screens/AccountsScreen";
import AccountDetailScreen from "../screens/AccountDetailScreen";
import AddAccountScreen from "../screens/AddAccountScreen";
import type { AccountBalance } from "../../../shared/types";

export type AccountsStackParamList = {
  AccountsList: undefined;
  AccountDetail: { account: AccountBalance };
  AddAccount: undefined;
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
    </Stack.Navigator>
  );
}
