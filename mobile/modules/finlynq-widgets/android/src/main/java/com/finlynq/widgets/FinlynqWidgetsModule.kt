package com.finlynq.widgets

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The JS side of the widgets: it writes the snapshot, the widgets read it. */
class FinlynqWidgetsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("FinlynqWidgets")

    Function("hasSnapshotReaders") { WidgetStore.hasSnapshotReaders(context) }

    Function("readSnapshot") { WidgetStore.read(context) }

    AsyncFunction("writeSnapshot") { json: String ->
      WidgetStore.write(context, json)
      WidgetRenderer.refreshAll(context)
    }

    AsyncFunction("clearSnapshot") {
      WidgetStore.clear(context)
      WidgetRenderer.refreshAll(context)
    }

    Function("getHideAmounts") { WidgetStore.hideAmounts(context) }

    AsyncFunction("setHideAmounts") { hide: Boolean ->
      WidgetStore.setHideAmounts(context, hide)
      WidgetRenderer.refreshAll(context)
    }

    Function("canPinWidgets") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        AppWidgetManager.getInstance(context).isRequestPinAppWidgetSupported
    }

    // Asks the launcher to show its "add this widget" prompt.
    Function("pinWidget") { key: String ->
      val kind = WidgetKind.fromKey(key)
      kind != null &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        AppWidgetManager.getInstance(context)
          .requestPinAppWidget(ComponentName(context, kind.providerClass), null, null)
    }
  }
}
