import SwiftUI
import WidgetKit

struct NetWorthWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKinds.netWorth, provider: SnapshotProvider()) { entry in
      NetWorthEntryView(entry: entry)
    }
    .configurationDisplayName(WidgetText.netWorth)
    .description("Your net worth, with assets and debts.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

private struct NetWorthEntryView: View {
  @Environment(\.widgetFamily) private var family
  let entry: SnapshotEntry

  var body: some View {
    NetWorthView(entry: entry, family: family)
  }
}

struct NetWorthView: View {
  @Environment(\.colorScheme) private var scheme
  let entry: SnapshotEntry
  let family: WidgetFamily

  var body: some View {
    if let section = entry.snapshot?.netWorth {
      content(section, palette: Palette.of(scheme))
    } else {
      WidgetMessage(title: WidgetText.netWorth, text: WidgetText.openToUpdate, link: WidgetLink.home)
    }
  }

  private func amount(_ label: String) -> String {
    entry.hideAmounts ? WidgetText.hiddenAmount : label
  }

  private func content(_ section: NetWorthSection, palette: Palette) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Text(WidgetText.netWorth)
          .font(.system(size: 12))
          .foregroundColor(palette.muted)
          .lineLimit(1)
        Spacer(minLength: 0)
        if let stale = family == .systemSmall
          ? WidgetDates.staleShortText(asOfMs: section.asOfMs, now: entry.date)
          : WidgetDates.staleText(asOfMs: section.asOfMs, now: entry.date) {
          Text(stale)
            .font(.system(size: 10))
            .foregroundColor(palette.muted)
            .lineLimit(1)
        }
      }
      Text(amount(section.netWorthLabel))
        .font(.system(size: 26, weight: .bold))
        .foregroundColor(palette.foreground)
        .lineLimit(1)
        .minimumScaleFactor(0.35)
        .privacySensitive()
        .widgetAccentable()
      Spacer(minLength: 0)
      // A small widget is too narrow for two amounts side by side.
      if family == .systemSmall {
        figure(WidgetText.assets, amount(section.assetsLabel), color: palette.positive, label: palette.muted)
        figure(WidgetText.debts, amount(section.debtsLabel), color: palette.negative, label: palette.muted)
      } else {
        HStack(spacing: 8) {
          figure(WidgetText.assets, amount(section.assetsLabel), color: palette.positive, label: palette.muted)
          figure(WidgetText.debts, amount(section.debtsLabel), color: palette.negative, label: palette.muted)
        }
      }
    }
    .widgetContainer(palette.background)
    .widgetURL(WidgetLink.url(WidgetLink.home))
  }

  private func figure(_ title: String, _ value: String, color: Color, label: Color) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title)
        .font(.system(size: 11))
        .foregroundColor(label)
        .lineLimit(1)
      Text(value)
        .font(.system(size: 13, weight: .bold))
        .foregroundColor(color)
        .lineLimit(1)
        .minimumScaleFactor(0.6)
        .privacySensitive()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
