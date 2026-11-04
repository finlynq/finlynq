import SwiftUI
import WidgetKit

struct UpcomingWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKinds.upcoming, provider: SnapshotProvider()) { entry in
      UpcomingEntryView(entry: entry)
    }
    .configurationDisplayName(WidgetText.upcoming)
    .description("Your next bills, subscriptions and loan payments.")
    .supportedFamilies([.systemMedium, .accessoryRectangular])
  }
}

private struct UpcomingEntryView: View {
  @Environment(\.widgetFamily) private var family
  let entry: SnapshotEntry

  var body: some View {
    UpcomingView(entry: entry, family: family)
  }
}

struct UpcomingRow: Identifiable {
  let id: Int
  let when: String
  let dueSoon: Bool
  let name: String
  let amount: String
  let link: String
}

enum UpcomingModel {
  case rows([UpcomingRow], stale: String?, staleAge: String?)
  case message(String)

  init(entry: SnapshotEntry) {
    guard let section = entry.snapshot?.upcoming else {
      self = .message(WidgetText.openToUpdate)
      return
    }
    let today = WidgetDates.iso(entry.date)
    let due = section.items.filter { $0.date >= today }
    if due.isEmpty {
      // Every saved payment has passed: the list is old, not empty.
      self = .message(section.items.isEmpty ? WidgetText.nothingDue : WidgetText.openToUpdate)
      return
    }
    let rows = due.enumerated().map { index, item in
      UpcomingRow(
        id: index,
        when: WidgetDates.whenLabel(item.date, now: entry.date),
        dueSoon: WidgetDates.isDueSoon(item.date, now: entry.date),
        name: item.name,
        amount: entry.hideAmounts ? WidgetText.hiddenAmount : item.amountLabel,
        link: item.link
      )
    }
    self = .rows(
      rows,
      stale: WidgetDates.staleText(asOfMs: section.asOfMs, now: entry.date),
      staleAge: WidgetDates.staleAge(asOfMs: section.asOfMs, now: entry.date)
    )
  }
}

struct UpcomingView: View {
  let entry: SnapshotEntry
  let family: WidgetFamily

  var body: some View {
    let model = UpcomingModel(entry: entry)
    switch family {
    case .accessoryRectangular:
      UpcomingRectangular(model: model)
    default:
      switch model {
      case .rows(let rows, let stale, _):
        UpcomingMedium(rows: rows, stale: stale)
      case .message(let text):
        WidgetMessage(title: WidgetText.upcoming, text: text, link: WidgetLink.subscriptions)
      }
    }
  }
}

private struct UpcomingMedium: View {
  @Environment(\.colorScheme) private var scheme
  /** How many rows a medium widget holds on the smallest phone. */
  private static let maxRows = 4
  let rows: [UpcomingRow]
  let stale: String?

  var body: some View {
    let palette = Palette.of(scheme)
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Text(WidgetText.upcoming)
          .font(.system(size: 12))
          .foregroundColor(palette.muted)
          .lineLimit(1)
        Spacer(minLength: 0)
        if let stale {
          Text(stale)
            .font(.system(size: 10))
            .foregroundColor(palette.muted)
            .lineLimit(1)
        }
      }
      .padding(.bottom, 2)
      ForEach(rows.prefix(Self.maxRows)) { row in
        Link(destination: WidgetLink.url(row.link)) {
          HStack(spacing: 0) {
            Text(row.when)
              .font(.system(size: 11))
              .foregroundColor(row.dueSoon ? palette.primary : palette.muted)
              .lineLimit(1)
              .frame(width: 62, alignment: .leading)
            Text(row.name)
              .font(.system(size: 13))
              .foregroundColor(palette.foreground)
              .lineLimit(1)
              .privacySensitive()
            Spacer(minLength: 8)
            Text(row.amount)
              .font(.system(size: 13, weight: .bold))
              .foregroundColor(palette.foreground)
              .lineLimit(1)
              .privacySensitive()
          }
          .frame(height: 25)
        }
      }
      Spacer(minLength: 0)
    }
    .widgetContainer(palette.background)
    .widgetURL(WidgetLink.url(WidgetLink.subscriptions))
  }
}

/** The next payment only: the Lock Screen has room for three short lines. */
private struct UpcomingRectangular: View {
  let model: UpcomingModel

  var body: some View {
    Group {
      switch model {
      case .rows(let rows, _, let staleAge):
        if let next = rows.first {
          VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
              Text(next.when)
                .font(.system(size: 13, weight: .semibold))
                .widgetAccentable()
                .lineLimit(1)
              Spacer(minLength: 0)
              if let staleAge {
                Text("\(staleAge) ago")
                  .font(.system(size: 11))
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
              }
            }
            Text(next.name)
              .font(.system(size: 13))
              .lineLimit(1)
              .privacySensitive()
            Text(next.amount)
              .font(.system(size: 15, weight: .bold))
              .lineLimit(1)
              .minimumScaleFactor(0.6)
              .privacySensitive()
          }
          .widgetURL(WidgetLink.url(next.link))
        }
      case .message(let text):
        Text(text)
          .font(.system(size: 13))
          .lineLimit(2)
          .widgetURL(WidgetLink.url(WidgetLink.subscriptions))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessoryContainer()
  }
}
