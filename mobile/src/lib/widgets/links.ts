// Where a tap on a widget goes. Any app can send these links, so they only ever
// open a fixed screen, carry no parameters, and anything else is ignored.

export const WIDGET_LINKS = {
  home: "pf-mobile://home",
  budgets: "pf-mobile://budgets",
  loans: "pf-mobile://loans",
  subscriptions: "pf-mobile://subscriptions",
  addTransaction: "pf-mobile://add-transaction",
} as const;

export type WidgetLinkTarget =
  | { tab: "Home" }
  | { tab: "More"; screen: "Budgets" | "Loans" | "Subscriptions" }
  | { tab: "Transactions"; screen: "AddTransaction" };

const TARGETS: Record<string, WidgetLinkTarget> = {
  [WIDGET_LINKS.home]: { tab: "Home" },
  [WIDGET_LINKS.budgets]: { tab: "More", screen: "Budgets" },
  [WIDGET_LINKS.loans]: { tab: "More", screen: "Loans" },
  [WIDGET_LINKS.subscriptions]: { tab: "More", screen: "Subscriptions" },
  [WIDGET_LINKS.addTransaction]: { tab: "Transactions", screen: "AddTransaction" },
};

export function widgetLinkTarget(url: string | null | undefined): WidgetLinkTarget | null {
  if (!url) return null;
  return Object.prototype.hasOwnProperty.call(TARGETS, url) ? TARGETS[url] : null;
}
