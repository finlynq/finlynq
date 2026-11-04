import SwiftUI
import WidgetKit

struct LeftToSpendWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKinds.leftToSpend, provider: SnapshotProvider()) { entry in
      LeftToSpendEntryView(entry: entry)
    }
    .configurationDisplayName(WidgetText.leftToSpend)
    .description("What is left of this month's spending budget and the days to go.")
    .supportedFamilies([.systemSmall, .accessoryCircular])
  }
}

private struct LeftToSpendEntryView: View {
  @Environment(\.widgetFamily) private var family
  let entry: SnapshotEntry

  var body: some View {
    LeftToSpendView(entry: entry, family: family)
  }
}

struct LeftToSpendView: View {
  let entry: SnapshotEntry
  let family: WidgetFamily

  var body: some View {
    let model = LeftToSpendModel(entry: entry)
    switch family {
    case .accessoryCircular:
      LeftToSpendCircular(model: model)
    default:
      if let model {
        LeftToSpendSmall(model: model)
      } else {
        WidgetMessage(title: WidgetText.leftToSpend, text: WidgetText.openToUpdate, link: WidgetLink.budgets)
      }
    }
  }
}

struct LeftToSpendModel {
  let title: String
  let amount: String
  let sub: String?
  let days: String?
  let stale: String?
  /** How much of the ring is drawn: it empties as the month's budget is spent. */
  let ringFill: Double
  let ringLabel: String
  let tone: String

  /** Nil when there is nothing to show for the month this entry falls in. */
  init?(entry: SnapshotEntry) {
    // Last month's figures say nothing about this month.
    guard
      let section = entry.snapshot?.leftToSpend,
      section.month == String(WidgetDates.iso(entry.date).prefix(7))
    else { return nil }

    let hide = entry.hideAmounts
    let hasBudget = section.hasBudget
    let over = hasBudget && section.tone == "over"
    let remaining = min(max(1 - max(section.usedFraction, 0), 0), 1)

    tone = section.tone
    stale = WidgetDates.staleText(asOfMs: section.asOfMs, now: entry.date)
    if hide || !hasBudget {
      ringFill = 0
    } else {
      ringFill = over ? 1 : remaining
    }
    if hide {
      ringLabel = WidgetText.hiddenPercent
    } else if !hasBudget {
      ringLabel = WidgetText.noPercent
    } else {
      ringLabel = over ? WidgetText.over : "\(Int((remaining * 100).rounded()))%"
    }

    if hasBudget {
      title = over ? WidgetText.overBudget : WidgetText.leftToSpend
      amount = hide ? WidgetText.hiddenAmount : section.leftLabel
      // When over, the amount is how far over, so "of" the budget would misread.
      sub = hide ? nil : (over ? "Budget \(section.plannedLabel)" : "of \(section.plannedLabel)")
      let daysLeft = WidgetDates.daysLeftInMonth(entry.date)
      days = daysLeft == 0 ? WidgetText.lastDay : (daysLeft == 1 ? "1 day left" : "\(daysLeft) days left")
    } else {
      title = WidgetText.spentThisMonth
      amount = hide ? WidgetText.hiddenAmount : section.spentLabel
      sub = WidgetText.noBudget
      days = nil
    }
  }
}

/** A ring that empties as the budget is spent; `fill` runs 1 to 0. */
private struct BudgetRing: View {
  @Environment(\.colorScheme) private var scheme
  let fill: Double
  let color: Color
  let lineWidth: CGFloat

  var body: some View {
    ZStack {
      Circle().stroke(Palette.of(scheme).ringTrack, lineWidth: lineWidth)
      if fill > 0 {
        Circle()
          .trim(from: 0, to: fill)
          .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
          .rotationEffect(.degrees(-90))
          .widgetAccentable()
      }
    }
    .padding(lineWidth / 2)
    .aspectRatio(1, contentMode: .fit)
  }
}

private struct LeftToSpendSmall: View {
  @Environment(\.colorScheme) private var scheme
  let model: LeftToSpendModel

  var body: some View {
    let palette = Palette.of(scheme)
    VStack(spacing: 1) {
      Text(model.title)
        .font(.system(size: 12))
        .foregroundColor(palette.muted)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
      ZStack {
        BudgetRing(fill: model.ringFill, color: palette.tone(model.tone), lineWidth: 5)
        Text(model.ringLabel)
          .font(.system(size: 10, weight: .bold))
          .foregroundColor(palette.foreground)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
          .padding(.horizontal, 7)
          .privacySensitive()
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      Text(model.amount)
        .font(.system(size: 20, weight: .bold))
        .foregroundColor(palette.foreground)
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .privacySensitive()
      ForEach([model.sub, model.days, model.stale].compactMap { $0 }, id: \.self) { line in
        Text(line)
          .font(.system(size: 11))
          .foregroundColor(palette.muted)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .privacySensitive(line == model.sub)
      }
    }
    .widgetContainer(palette.background)
    .widgetURL(WidgetLink.url(WidgetLink.budgets))
  }
}

private struct LeftToSpendCircular: View {
  let model: LeftToSpendModel?

  var body: some View {
    Gauge(value: model?.ringFill ?? 0) {
      Text(WidgetText.leftToSpend)
    } currentValueLabel: {
      Text(model?.ringLabel ?? WidgetText.noPercent)
        .lineLimit(1)
        .minimumScaleFactor(0.6)
    }
    .gaugeStyle(.accessoryCircularCapacity)
    .privacySensitive()
    .accessoryContainer()
    .widgetURL(WidgetLink.url(WidgetLink.budgets))
  }
}
