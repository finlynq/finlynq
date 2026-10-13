import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import PortfolioScreen from "../screens/PortfolioScreen";
import HoldingDetailScreen from "../screens/HoldingDetailScreen";
import PortfolioOpsScreen from "../screens/PortfolioOpsScreen";
import OperationFormScreen from "../screens/OperationFormScreen";
import AddHoldingScreen from "../screens/AddHoldingScreen";
import PerformanceScreen from "../screens/PerformanceScreen";
import RealizedGainsScreen from "../screens/RealizedGainsScreen";
import DividendsScreen from "../screens/DividendsScreen";
import CostBasisScreen from "../screens/CostBasisScreen";
import LotSalesScreen from "../screens/LotSalesScreen";
import type {
  PortfolioHoldingSummary,
  EnrichedHolding,
  PortfolioOpKey,
} from "../../../shared/types";

export type PortfolioStackParamList = {
  PortfolioOverview: undefined;
  HoldingDetail: {
    summary: PortfolioHoldingSummary;
    members: EnrichedHolding[];
    displayCurrency: string;
  };
  PortfolioOps: undefined;
  OperationForm: {
    op: PortfolioOpKey;
    editId?: number;
    preselectAccountId?: number;
    preselectHoldingId?: number;
  };
  AddHolding: { accountId?: number; op?: PortfolioOpKey };
  Performance: undefined;
  RealizedGains: { displayCurrency?: string } | undefined;
  Dividends: { displayCurrency?: string } | undefined;
  // Simple average or advanced lot allocation (also reachable from Settings).
  CostBasis: undefined;
  // The sales of one position (a holding in one account) and the lots each used.
  LotSales: { holdingId: number; accountId: number | null; title: string; accountName?: string };
};

const Stack = createNativeStackNavigator<PortfolioStackParamList>();

export default function PortfolioStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="PortfolioOverview" component={PortfolioScreen} />
      <Stack.Screen name="HoldingDetail" component={HoldingDetailScreen} />
      <Stack.Screen
        name="PortfolioOps"
        component={PortfolioOpsScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen
        name="OperationForm"
        component={OperationFormScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen
        name="AddHolding"
        component={AddHoldingScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen name="Performance" component={PerformanceScreen} />
      <Stack.Screen name="RealizedGains" component={RealizedGainsScreen} />
      <Stack.Screen name="Dividends" component={DividendsScreen} />
      <Stack.Screen name="CostBasis" component={CostBasisScreen} />
      <Stack.Screen name="LotSales" component={LotSalesScreen} />
    </Stack.Navigator>
  );
}
