import SwiftUI
import WidgetKit

// Draws every iOS widget in each scenario, light and dark, on one sheet per image,
// since widgets can't be seen from a unit test. Compiled with the extension's own
// Swift by scripts/ios-widget-render-check.sh; it ships in nothing. It draws through
// ImageRenderer rather than WidgetKit, so it shows layout and wording but not what
// the system does around a widget: margins and backgrounds are imitated here, and
// the Lock Screen's vibrant colours are not.

@main
struct WidgetPreviewHost: App {
  init() {
    Task { @MainActor in
      PreviewRunner.run()
      exit(0)
    }
  }

  var body: some Scene {
    WindowGroup { Text("Drawing the widgets") }
  }
}

private struct Phone: Identifiable {
  let id: String
  let small: CGFloat
  let mediumWidth: CGFloat
  let circular: CGFloat
  let rectangularWidth: CGFloat
}

/** The smallest and largest iPhones that can run the extension (Apple's widget size tables). */
private let phones = [
  Phone(id: "375pt (SE)", small: 148, mediumWidth: 321, circular: 68, rectangularWidth: 153),
  Phone(id: "430pt (Plus / Pro Max)", small: 170, mediumWidth: 364, circular: 76, rectangularWidth: 172),
]

private let scenarios = [
  "sample", "hidden", "locked", "warn", "over", "no-budget", "long", "stale", "nothing-due",
  "payments-passed", "last-month", "empty", "corrupt",
]

@MainActor
private enum PreviewRunner {
  static func run() {
    let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let now = Date()
    for scenario in scenarios {
      let entry = SnapshotEntry(date: now, snapshot: snapshot(scenario, now: now), hideAmounts: scenario == "hidden")
      for (label, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
        let renderer = ImageRenderer(content: Sheet(scenario: scenario, label: label, scheme: scheme, entry: entry))
        renderer.scale = 2
        guard let png = renderer.uiImage?.pngData() else {
          print("PREVIEW_FAILED \(scenario)-\(label)")
          continue
        }
        try? png.write(to: dir.appendingPathComponent("\(scenario)-\(label).png"))
      }
    }
    FileManager.default.createFile(atPath: dir.appendingPathComponent("DONE").path, contents: Data())
  }

  /** The sample with its dates moved to today, then varied per scenario, read as the extension reads it. */
  static func snapshot(_ scenario: String, now: Date) -> WidgetSnapshot? {
    switch scenario {
    case "empty": return nil
    case "corrupt": return SharedData.decodeSnapshot(Data("{not json".utf8))
    default: break
    }
    guard
      let url = Bundle.main.url(forResource: "widget-snapshot.sample", withExtension: "json"),
      let data = try? Data(contentsOf: url),
      var json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      var left = json["leftToSpend"] as? [String: Any],
      var upcoming = json["upcoming"] as? [String: Any],
      var netWorth = json["netWorth"] as? [String: Any],
      var items = upcoming["items"] as? [[String: Any]]
    else {
      print("PREVIEW_FAILED no sample")
      return nil
    }

    let ageSeconds: TimeInterval = scenario == "stale" ? 3 * 3600 : 0
    let asOfMs = (now.timeIntervalSince1970 - ageSeconds) * 1000
    left["asOfMs"] = asOfMs
    upcoming["asOfMs"] = asOfMs
    netWorth["asOfMs"] = asOfMs
    left["month"] = String(WidgetDates.iso(now).prefix(7))
    let offsets = [0, 1, 3, 9, 20, 40]
    for index in items.indices {
      items[index]["date"] = WidgetDates.iso(now, addingDays: offsets[index % offsets.count])
    }

    switch scenario {
    case "warn":
      left["tone"] = "warn"
      left["usedFraction"] = 0.86
    case "over":
      left["tone"] = "over"
      left["usedFraction"] = 1.14
      left["leftLabel"] = "$420.10"
    case "no-budget":
      left["hasBudget"] = false
      left["usedFraction"] = 0
    case "long":
      left["leftLabel"] = "HK$1,234,567.89"
      left["plannedLabel"] = "HK$9,876,543.21"
      netWorth["netWorthLabel"] = "HK$12,345,678,901.23"
      items[0]["name"] = "A very long merchant name that does not fit on one row"
      items[0]["amountLabel"] = "HK$1,204,999.00"
    case "nothing-due":
      items = []
    case "payments-passed":
      for index in items.indices { items[index]["date"] = "2020-01-01" }
    case "last-month":
      left["month"] = "2020-01"
    default:
      break
    }

    upcoming["items"] = items
    json["leftToSpend"] = left
    json["upcoming"] = upcoming
    json["netWorth"] = netWorth
    guard let patched = try? JSONSerialization.data(withJSONObject: json) else { return nil }
    return SharedData.decodeSnapshot(patched)
  }
}

private struct Sheet: View {
  let scenario: String
  let label: String
  let scheme: ColorScheme
  let entry: SnapshotEntry

  var body: some View {
    let sheet = VStack(alignment: .leading, spacing: 14) {
      Text("\(scenario) · \(label)")
        .font(.system(size: 16, weight: .bold))
        .foregroundColor(.white)
      ForEach(phones) { phone in
        Text(phone.id)
          .font(.system(size: 11))
          .foregroundColor(.white)
        HStack(alignment: .top, spacing: 14) {
          system(LeftToSpendView(entry: entry, family: .systemSmall), phone.small, phone.small)
          system(NetWorthView(entry: entry, family: .systemSmall), phone.small, phone.small)
          system(QuickAddView(), phone.small, phone.small)
          system(UpcomingView(entry: entry, family: .systemMedium), phone.mediumWidth, phone.small)
          system(NetWorthView(entry: entry, family: .systemMedium), phone.mediumWidth, phone.small)
        }
        HStack(alignment: .center, spacing: 14) {
          accessory(LeftToSpendView(entry: entry, family: .accessoryCircular), phone.circular, phone.circular)
          accessory(UpcomingView(entry: entry, family: .accessoryRectangular), phone.rectangularWidth, phone.circular)
        }
      }
    }
    .padding(20)
    .background(Color(hex: 0x4A5A6A))
    .environment(\.colorScheme, scheme)

    if scenario == "locked" {
      // What the system does to privacySensitive() views while the phone is locked.
      sheet.redacted(reason: .privacy)
    } else {
      sheet
    }
  }

  /** The system's margins and background, which containerBackground only asks for inside WidgetKit. */
  private func system<V: View>(_ content: V, _ width: CGFloat, _ height: CGFloat) -> some View {
    content
      .frame(width: width - 32, height: height - 32)
      .padding(16)
      .background(Palette.of(scheme).background)
      .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
  }

  private func accessory<V: View>(_ content: V, _ width: CGFloat, _ height: CGFloat) -> some View {
    content
      .frame(width: width, height: height)
      .foregroundColor(.white)
      .environment(\.colorScheme, .dark)
      .background(Color.black.opacity(0.35))
  }
}
