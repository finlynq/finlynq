import Foundation
import WidgetKit

struct AppGroupUnavailableError: Error {}

/**
 * Where the widgets' data lives. Widgets only ever read this cached snapshot:
 * they never hold the session, a password or the encryption key.
 *
 * The snapshot holds decrypted names and amounts, so it is a file in the App
 * Group container, kept out of device backups (preferences in the group could not
 * be). It stays readable while the phone is locked, for the Lock Screen widgets,
 * but not after a restart until the first unlock. It is deleted on sign-out and
 * once no widget that reads it is left. The extension's reading side is
 * targets/widget/SharedData.swift.
 */
enum WidgetStore {
  private static let appGroup = "group.com.finlynq.mobile"
  private static let snapshotFile = "finlynq_widget_snapshot.json"
  private static let keyHideAmounts = "hideAmounts"
  private static let keyHasReaders = "hasSnapshotReaders"
  /** The widgets that show figures: every kind in targets/widget but Add transaction. */
  private static let readerKinds: Set<String> = ["FinlynqLeftToSpend", "FinlynqUpcoming", "FinlynqNetWorth"]
  private static let readersTimeoutSeconds = 1.0

  private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

  private static var snapshotURL: URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appendingPathComponent(snapshotFile)
  }

  static func read() -> String? {
    guard let url = snapshotURL else { return nil }
    return try? String(contentsOf: url, encoding: .utf8)
  }

  /** Written atomically, so a widget never reads half a snapshot. */
  static func write(_ json: String) throws {
    guard var url = snapshotURL else { throw AppGroupUnavailableError() }
    try Data(json.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }

  static func clear() {
    guard let url = snapshotURL else { return }
    try? FileManager.default.removeItem(at: url)
  }

  static func hideAmounts() -> Bool {
    defaults?.bool(forKey: keyHideAmounts) ?? false
  }

  static func setHideAmounts(_ hide: Bool) {
    defaults?.set(hide, forKey: keyHideAmounts)
  }

  /**
   * Is any widget that needs figures on a home or Lock Screen? WidgetKit answers
   * asynchronously and JS asks synchronously, on its own thread, so this waits a
   * moment and falls back to the last answer. The answer only ever travels through
   * the defaults, so a reply arriving after the timeout is still safe.
   */
  static func hasSnapshotReaders() -> Bool {
    let answered = DispatchSemaphore(value: 0)
    WidgetCenter.shared.getCurrentConfigurations { result in
      if case .success(let widgets) = result {
        defaults?.set(widgets.contains { readerKinds.contains($0.kind) }, forKey: keyHasReaders)
      }
      answered.signal()
    }
    _ = answered.wait(timeout: .now() + readersTimeoutSeconds)
    return defaults?.bool(forKey: keyHasReaders) ?? false
  }

  /** The last widget that reads it is gone: keep no figures that nothing reads. */
  static func clearIfNoReaders() {
    if !hasSnapshotReaders() { clear() }
  }

  static func reloadWidgets() {
    WidgetCenter.shared.reloadAllTimelines()
  }
}
