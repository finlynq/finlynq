import SwiftUI
import WidgetKit

/** Each widget's WidgetKit kind. WidgetStore.swift in the module lists the ones that read figures. */
enum WidgetKinds {
  static let leftToSpend = "FinlynqLeftToSpend"
  static let upcoming = "FinlynqUpcoming"
  static let netWorth = "FinlynqNetWorth"
  static let quickAdd = "FinlynqQuickAdd"
}

/** Where a tap goes: the fixed links in mobile/src/lib/widgets/links.ts. */
enum WidgetLink {
  static let home = "pf-mobile://home"
  static let budgets = "pf-mobile://budgets"
  static let loans = "pf-mobile://loans"
  static let subscriptions = "pf-mobile://subscriptions"
  static let addTransaction = "pf-mobile://add-transaction"
  private static let prefix = "pf-mobile://"

  /** Only this app's own scheme, whatever the snapshot says. */
  static func url(_ link: String) -> URL {
    URL(string: link.hasPrefix(prefix) ? link : home) ?? URL(string: home)!
  }
}

enum WidgetText {
  static let leftToSpend = "Left to spend"
  static let upcoming = "Upcoming payments"
  static let netWorth = "Net worth"
  static let quickAdd = "Add transaction"
  static let openToUpdate = "Open Finlynq to update"
  static let nothingDue = "Nothing due soon"
  static let today = "Today"
  static let tomorrow = "Tomorrow"
  static let over = "Over"
  static let overBudget = "Over budget"
  static let spentThisMonth = "Spent this month"
  static let noBudget = "No budget set"
  static let lastDay = "Last day"
  static let assets = "Assets"
  static let debts = "Debts"
  static let hiddenAmount = "••••"
  static let hiddenPercent = "•••"
  static let noPercent = "–"
}

/** The app's palettes (src/theme/colors.ts), the same as the Android widgets. */
struct Palette {
  let background: Color
  let foreground: Color
  let muted: Color
  let primary: Color
  let onPrimary: Color
  let positive: Color
  let negative: Color
  let ringTrack = Color(hex: 0x88929C).opacity(0.27)

  private static let light = Palette(
    background: Color(hex: 0xFFFFFF),
    foreground: Color(hex: 0x23262D),
    muted: Color(hex: 0x6F747C),
    primary: Color(hex: 0xF5A623),
    onPrimary: Color(hex: 0x241A06),
    positive: Color(hex: 0x1FB393),
    negative: Color(hex: 0xDB4F3F)
  )

  private static let dark = Palette(
    background: Color(hex: 0x101317),
    foreground: Color(hex: 0xE8EAED),
    muted: Color(hex: 0x9AA3AD),
    primary: Color(hex: 0xF5A623),
    onPrimary: Color(hex: 0x241A06),
    positive: Color(hex: 0x4FC8A6),
    negative: Color(hex: 0xE5624B)
  )

  static func of(_ scheme: ColorScheme) -> Palette {
    scheme == .dark ? dark : light
  }

  func tone(_ tone: String) -> Color {
    switch tone {
    case "over": return negative
    case "warn": return primary
    default: return positive
    }
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: 1
    )
  }
}

extension View {
  /** iOS 17 draws margins itself and blanks a widget that doesn't say what its background is. */
  @ViewBuilder
  func widgetContainer(_ background: Color) -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(background, for: .widget)
    } else {
      frame(maxWidth: .infinity, maxHeight: .infinity).padding().background(background)
    }
  }

  /** The same for a Lock Screen widget, which has no margins or background of its own. */
  @ViewBuilder
  func accessoryContainer() -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(Color.clear, for: .widget)
    } else {
      self
    }
  }
}

/** A title and one line of text, for a widget with no figures to show yet. */
struct WidgetMessage: View {
  @Environment(\.colorScheme) private var scheme
  let title: String
  let text: String
  let link: String

  var body: some View {
    let palette = Palette.of(scheme)
    VStack(alignment: .leading, spacing: 0) {
      Text(title)
        .font(.system(size: 12))
        .foregroundColor(palette.muted)
        .lineLimit(1)
      Spacer(minLength: 4)
      Text(text)
        .font(.system(size: 13))
        .foregroundColor(palette.foreground)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
      Spacer(minLength: 4)
    }
    .widgetContainer(palette.background)
    .widgetURL(WidgetLink.url(link))
  }
}

// MARK: - Timelines

struct SnapshotEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot?
  let hideAmounts: Bool
}

/**
 * Never touches the network: each widget redraws from the cached snapshot, which
 * keeps its dates current until the app next writes one and reloads the widgets.
 */
struct SnapshotProvider: TimelineProvider {
  func placeholder(in context: Context) -> SnapshotEntry {
    let now = Date()
    return SnapshotEntry(date: now, snapshot: .sample(now: now), hideAmounts: false)
  }

  func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
    if context.isPreview {
      completion(placeholder(in: context))
    } else {
      completion(SnapshotEntry(date: Date(), snapshot: SharedData.readSnapshot(), hideAmounts: SharedData.hideAmounts()))
    }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
    let snapshot = SharedData.readSnapshot()
    let hideAmounts = SharedData.hideAmounts()
    let entries = WidgetDates.redrawDates(from: Date()).map {
      SnapshotEntry(date: $0, snapshot: snapshot, hideAmounts: hideAmounts)
    }
    completion(Timeline(entries: entries, policy: .atEnd))
  }
}
