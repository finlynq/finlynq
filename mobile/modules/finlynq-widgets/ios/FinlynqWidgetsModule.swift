import ExpoModulesCore

/// The JS side of the widgets: it writes the snapshot, the widgets read it.
public class FinlynqWidgetsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FinlynqWidgets")

    // iOS tells nobody when the last widget is removed, so this asks on the way back in.
    OnAppBecomesActive {
      DispatchQueue.global(qos: .utility).async {
        WidgetStore.clearIfNoReaders()
      }
    }

    Function("hasSnapshotReaders") { WidgetStore.hasSnapshotReaders() }

    Function("readSnapshot") { WidgetStore.read() }

    AsyncFunction("writeSnapshot") { (json: String) in
      try WidgetStore.write(json)
      WidgetStore.reloadWidgets()
    }

    AsyncFunction("clearSnapshot") {
      WidgetStore.clear()
      WidgetStore.reloadWidgets()
    }

    Function("getHideAmounts") { WidgetStore.hideAmounts() }

    AsyncFunction("setHideAmounts") { (hide: Bool) in
      WidgetStore.setHideAmounts(hide)
      WidgetStore.reloadWidgets()
    }

    // iOS has no "add this widget" prompt: widgets are added from the home screen.
    Function("canPinWidgets") { false }

    Function("pinWidget") { (_: String) in false }
  }
}
