import Foundation

/**
 * Date wording worked out from each timeline entry's own date, so a widget stays
 * right between refreshes. The app's dates are Gregorian, whatever calendar the
 * phone is set to, so day arithmetic and ISO dates are too.
 */
enum WidgetDates {
  /** A snapshot younger than this says nothing about its age. */
  private static let staleAfterSeconds: TimeInterval = 60 * 60
  private static let redrawHours = 24

  private static var gregorian: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    return calendar
  }

  private static var isoFormatter: DateFormatter {
    let formatter = DateFormatter()
    formatter.calendar = gregorian
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter
  }

  static func iso(_ date: Date, addingDays days: Int = 0) -> String {
    isoFormatter.string(from: gregorian.date(byAdding: .day, value: days, to: date) ?? date)
  }

  /** Days after `now` in its month: 0 on the last day. */
  static func daysLeftInMonth(_ now: Date) -> Int {
    let calendar = gregorian
    let lastDay = calendar.range(of: .day, in: .month, for: now)?.count ?? 0
    return max(lastDay - calendar.component(.day, from: now), 0)
  }

  /** Whole calendar days from `now` to `iso`. */
  private static func daysUntil(_ iso: String, from now: Date) -> Int? {
    guard let day = isoFormatter.date(from: iso) else { return nil }
    let calendar = gregorian
    return calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: day)).day
  }

  static func isDueSoon(_ iso: String, now: Date) -> Bool {
    guard let days = daysUntil(iso, from: now) else { return false }
    return days == 0 || days == 1
  }

  /** "Today", "Tomorrow", "Sat" within the week, then "Nov 12". */
  static func whenLabel(_ iso: String, now: Date) -> String {
    guard let days = daysUntil(iso, from: now), let day = isoFormatter.date(from: iso) else { return iso }
    switch days {
    case 0: return WidgetText.today
    case 1: return WidgetText.tomorrow
    default:
      let formatter = DateFormatter()
      formatter.setLocalizedDateFormatFromTemplate((2...6).contains(days) ? "EEE" : "MMMd")
      return formatter.string(from: day)
    }
  }

  /** "2h" or "3d" when the figures are at least an hour old, else nil. */
  private static func staleAge(asOfMs: Double, now: Date) -> String? {
    guard asOfMs > 0 else { return nil }
    let age = now.timeIntervalSince1970 - asOfMs / 1000
    if age < staleAfterSeconds { return nil }
    let hours = Int(age / 3600)
    return hours < 24 ? "\(hours)h" : "\(hours / 24)d"
  }

  static func staleText(asOfMs: Double, now: Date) -> String? {
    staleAge(asOfMs: asOfMs, now: now).map { "Updated \($0) ago" }
  }

  /** For a widget with no room to say "Updated". */
  static func staleShortText(asOfMs: Double, now: Date) -> String? {
    staleAge(asOfMs: asOfMs, now: now).map { "\($0) ago" }
  }

  /**
   * When to draw next without the app: hourly, so "Updated 2h ago" keeps up, and at
   * midnight, so "12 days left" and "Tomorrow" turn over on time.
   */
  static func redrawDates(from now: Date) -> [Date] {
    let calendar = gregorian
    var dates = (0...redrawHours).map { now.addingTimeInterval(TimeInterval($0) * 3600) }
    if let midnight = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) {
      dates.append(midnight)
    }
    return dates.sorted()
  }
}
