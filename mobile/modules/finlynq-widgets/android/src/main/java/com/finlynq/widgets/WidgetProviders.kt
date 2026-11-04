package com.finlynq.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle

/**
 * The system calls these for a new widget, a resize and the periodic update
 * (android:updatePeriodMillis). None of them touch the network: they redraw from
 * the cached snapshot, which keeps "12 days left" and "Tomorrow" current until
 * the app next refreshes the figures.
 */
abstract class FinlynqWidgetProvider internal constructor(private val kind: WidgetKind) : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
    for (id in appWidgetIds) {
      manager.updateAppWidget(id, WidgetRenderer.render(context, kind, manager.getAppWidgetOptions(id)))
    }
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
    manager.updateAppWidget(appWidgetId, WidgetRenderer.render(context, kind, newOptions))
  }

  /** The last widget of this kind is gone: keep no figures that nothing reads. */
  override fun onDisabled(context: Context) {
    if (!WidgetStore.hasSnapshotReaders(context)) WidgetStore.clear(context)
  }
}

class LeftToSpendWidgetProvider : FinlynqWidgetProvider(WidgetKind.LEFT_TO_SPEND)

class UpcomingWidgetProvider : FinlynqWidgetProvider(WidgetKind.UPCOMING)

class NetWorthWidgetProvider : FinlynqWidgetProvider(WidgetKind.NET_WORTH)

class QuickAddWidgetProvider : FinlynqWidgetProvider(WidgetKind.QUICK_ADD)
