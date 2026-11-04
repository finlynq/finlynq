import SwiftUI
import WidgetKit

@main
struct FinlynqWidgetBundle: WidgetBundle {
  var body: some Widget {
    LeftToSpendWidget()
    UpcomingWidget()
    NetWorthWidget()
    QuickAddWidget()
  }
}
