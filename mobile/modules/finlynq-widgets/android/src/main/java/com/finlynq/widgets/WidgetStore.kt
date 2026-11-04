package com.finlynq.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.util.Log
import java.io.File

internal const val WIDGET_LOG_TAG = "FinlynqWidgets"

/** The widgets this app offers. `key` is the name the JS side uses. */
internal enum class WidgetKind(
  val key: String,
  val providerClass: Class<out AppWidgetProvider>,
  /** False for a widget that shows no figures, so it needs no snapshot. */
  val readsSnapshot: Boolean,
) {
  LEFT_TO_SPEND("leftToSpend", LeftToSpendWidgetProvider::class.java, true),
  UPCOMING("upcoming", UpcomingWidgetProvider::class.java, true),
  NET_WORTH("netWorth", NetWorthWidgetProvider::class.java, true),
  QUICK_ADD("quickAdd", QuickAddWidgetProvider::class.java, false);

  companion object {
    fun fromKey(key: String): WidgetKind? = values().firstOrNull { it.key == key }
  }
}

/**
 * Where the widgets' data lives. Widgets only ever read this cached snapshot:
 * they never hold the session, a password or the encryption key.
 *
 * The snapshot holds decrypted names and amounts, so it stays inside the app's
 * private storage, in noBackupFilesDir to keep it out of Android Auto Backup.
 * It is deleted on sign-out and when the last widget that reads it is removed.
 */
internal object WidgetStore {
  private const val SNAPSHOT_FILE = "finlynq_widget_snapshot.json"
  private const val PREFS = "finlynq_widgets"
  private const val KEY_HIDE_AMOUNTS = "hideAmounts"

  private fun snapshotFile(context: Context) = File(context.noBackupFilesDir, SNAPSHOT_FILE)

  fun read(context: Context): String? = try {
    snapshotFile(context).takeIf { it.exists() }?.readText()
  } catch (e: Exception) {
    Log.w(WIDGET_LOG_TAG, "could not read the snapshot", e)
    null
  }

  /** Written to a temp file and renamed, so a widget never reads half a snapshot. */
  fun write(context: Context, json: String) {
    val target = snapshotFile(context)
    val temp = File(target.parentFile, "$SNAPSHOT_FILE.tmp")
    temp.writeText(json)
    if (!temp.renameTo(target)) {
      target.writeText(json)
      temp.delete()
    }
  }

  fun clear(context: Context) {
    snapshotFile(context).delete()
  }

  fun hideAmounts(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_HIDE_AMOUNTS, false)

  fun setHideAmounts(context: Context, hide: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_HIDE_AMOUNTS, hide).apply()
  }

  /** Is any widget that needs figures on a home screen? */
  fun hasSnapshotReaders(context: Context): Boolean {
    val manager = AppWidgetManager.getInstance(context)
    return WidgetKind.values().any { kind ->
      kind.readsSnapshot && manager.getAppWidgetIds(ComponentName(context, kind.providerClass)).isNotEmpty()
    }
  }
}
