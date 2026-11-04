import Foundation

// The snapshot the app writes: see mobile/src/lib/widgets/snapshot.ts. Amounts
// arrive already formatted by the app, so the widgets and the app cannot format
// money differently. Anything that depends on today's date is worked out here.

struct WidgetSnapshot: Decodable {
  let version: Int
  let updatedAtMs: Double
  let leftToSpend: LeftToSpendSection?
  let upcoming: UpcomingSection?
  let netWorth: NetWorthSection?
}

struct LeftToSpendSection: Decodable {
  let asOfMs: Double
  let month: String
  let hasBudget: Bool
  let leftLabel: String
  let plannedLabel: String
  let spentLabel: String
  let usedFraction: Double
  let tone: String
}

struct UpcomingItem: Decodable {
  let date: String
  let name: String
  let amountLabel: String
  let link: String
}

struct UpcomingSection: Decodable {
  let asOfMs: Double
  let items: [UpcomingItem]
}

struct NetWorthSection: Decodable {
  let asOfMs: Double
  let netWorthLabel: String
  let assetsLabel: String
  let debtsLabel: String
}

/**
 * The extension's side of the store in modules/finlynq-widgets/ios/WidgetStore.swift.
 * It only reads, and it holds no session, password or encryption key, so its
 * figures are as of the last time the app ran.
 */
enum SharedData {
  private static let appGroup = "group.com.finlynq.mobile"
  private static let snapshotFile = "finlynq_widget_snapshot.json"
  static let snapshotVersion = 1
  private static let keyHideAmounts = "hideAmounts"

  static func readSnapshot() -> WidgetSnapshot? {
    guard
      let url = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
        .appendingPathComponent(snapshotFile),
      let data = try? Data(contentsOf: url)
    else { return nil }
    return decodeSnapshot(data)
  }

  static func decodeSnapshot(_ data: Data) -> WidgetSnapshot? {
    guard
      let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data),
      snapshot.version == snapshotVersion
    else { return nil }
    return snapshot
  }

  static func hideAmounts() -> Bool {
    UserDefaults(suiteName: appGroup)?.bool(forKey: keyHideAmounts) ?? false
  }
}

extension WidgetSnapshot {
  /** Invented figures for the widget gallery and the placeholder, never the user's. */
  static func sample(now: Date) -> WidgetSnapshot {
    let asOfMs = now.timeIntervalSince1970 * 1000
    func upcoming(_ days: Int, _ name: String, _ amountLabel: String, _ link: String) -> UpcomingItem {
      UpcomingItem(date: WidgetDates.iso(now, addingDays: days), name: name, amountLabel: amountLabel, link: link)
    }
    return WidgetSnapshot(
      version: SharedData.snapshotVersion,
      updatedAtMs: asOfMs,
      leftToSpend: LeftToSpendSection(
        asOfMs: asOfMs,
        month: String(WidgetDates.iso(now).prefix(7)),
        hasBudget: true,
        leftLabel: "$1,284.50",
        plannedLabel: "$3,000.00",
        spentLabel: "$1,715.50",
        usedFraction: 0.5718,
        tone: "ok"
      ),
      upcoming: UpcomingSection(
        asOfMs: asOfMs,
        items: [
          upcoming(0, "Car loan", "$412.40", WidgetLink.loans),
          upcoming(1, "Streaming", "$15.99", WidgetLink.subscriptions),
          upcoming(3, "Electricity", "$148.22", WidgetLink.subscriptions),
          upcoming(9, "Internet", "$79.00", WidgetLink.subscriptions),
        ]
      ),
      netWorth: NetWorthSection(
        asOfMs: asOfMs,
        netWorthLabel: "$48,250.00",
        assetsLabel: "$71,400.00",
        debtsLabel: "$23,150.00"
      )
    )
  }
}
