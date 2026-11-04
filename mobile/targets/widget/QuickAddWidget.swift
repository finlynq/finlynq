import SwiftUI
import WidgetKit

/** Shows no figures, so it needs no snapshot and is never redrawn. */
struct QuickAddProvider: TimelineProvider {
  struct Entry: TimelineEntry {
    let date: Date
  }

  func placeholder(in context: Context) -> Entry {
    Entry(date: Date())
  }

  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
    completion(Entry(date: Date()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    completion(Timeline(entries: [Entry(date: Date())], policy: .never))
  }
}

struct QuickAddWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKinds.quickAdd, provider: QuickAddProvider()) { _ in
      QuickAddView()
    }
    .configurationDisplayName(WidgetText.quickAdd)
    .description("Opens a new transaction in one tap.")
    .supportedFamilies([.systemSmall])
  }
}

struct QuickAddView: View {
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let palette = Palette.of(scheme)
    VStack(spacing: 8) {
      ZStack {
        Circle()
          .fill(palette.primary)
          .widgetAccentable()
        Image(systemName: "plus")
          .font(.system(size: 26, weight: .semibold))
          .foregroundColor(palette.onPrimary)
      }
      .frame(width: 60, height: 60)
      Text(WidgetText.quickAdd)
        .font(.system(size: 13))
        .foregroundColor(palette.foreground)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
    .widgetContainer(palette.background)
    .widgetURL(WidgetLink.url(WidgetLink.addTransaction))
  }
}
