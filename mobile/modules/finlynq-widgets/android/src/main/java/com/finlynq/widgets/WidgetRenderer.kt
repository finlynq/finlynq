package com.finlynq.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Turns the cached snapshot into each widget's views. Amounts arrive already
 * formatted by the app, so the widgets and the app cannot format money
 * differently. Anything that depends on today's date is worked out here.
 */
internal object WidgetRenderer {
  private const val LINK_HOME = "pf-mobile://home"
  private const val LINK_BUDGETS = "pf-mobile://budgets"
  private const val LINK_SUBSCRIPTIONS = "pf-mobile://subscriptions"
  private const val LINK_ADD_TRANSACTION = "pf-mobile://add-transaction"
  private const val LINK_PREFIX = "pf-mobile://"

  private const val HIDDEN_AMOUNT = "••••"
  private const val RING_SIZE_PX = 220
  private const val RING_STROKE_PX = 30f
  private const val RING_TRACK_COLOR = 0x4488929C

  private const val UPCOMING_HEADER_DP = 40
  private const val UPCOMING_ROW_DP = 27
  private const val UPCOMING_DEFAULT_ROWS = 3
  private const val UPCOMING_MAX_ROWS = 6

  /** Never throws: a widget that throws shows "can't load widget" until it is re-added. */
  fun render(context: Context, kind: WidgetKind, options: Bundle?): RemoteViews = try {
    val snapshot = if (kind.readsSnapshot) readSnapshot(context) else null
    when (kind) {
      WidgetKind.LEFT_TO_SPEND -> leftToSpend(context, snapshot)
      WidgetKind.UPCOMING -> upcoming(context, snapshot, options)
      WidgetKind.NET_WORTH -> netWorth(context, snapshot)
      WidgetKind.QUICK_ADD -> quickAdd(context)
    }
  } catch (e: Exception) {
    Log.w(WIDGET_LOG_TAG, "could not draw ${kind.key}", e)
    message(context, titleOf(kind), R.string.finlynq_widget_open_to_update, LINK_HOME)
  }

  /** Redraws every placed widget from the current snapshot. */
  fun refreshAll(context: Context) {
    val manager = AppWidgetManager.getInstance(context)
    for (kind in WidgetKind.values()) {
      for (id in manager.getAppWidgetIds(ComponentName(context, kind.providerClass))) {
        manager.updateAppWidget(id, render(context, kind, manager.getAppWidgetOptions(id)))
      }
    }
  }

  private fun readSnapshot(context: Context): JSONObject? {
    val json = WidgetStore.read(context) ?: return null
    return try {
      JSONObject(json)
    } catch (e: Exception) {
      Log.w(WIDGET_LOG_TAG, "unreadable snapshot", e)
      null
    }
  }

  private fun titleOf(kind: WidgetKind): Int = when (kind) {
    WidgetKind.LEFT_TO_SPEND -> R.string.finlynq_widget_left_to_spend_name
    WidgetKind.UPCOMING -> R.string.finlynq_widget_upcoming_name
    WidgetKind.NET_WORTH -> R.string.finlynq_widget_net_worth_name
    WidgetKind.QUICK_ADD -> R.string.finlynq_widget_quick_add_name
  }

  private fun openLink(context: Context, link: String): PendingIntent {
    // Only this app's own scheme, whatever the snapshot says.
    val safeLink = if (link.startsWith(LINK_PREFIX)) link else LINK_HOME
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(safeLink))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(
      context,
      safeLink.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun message(context: Context, title: Int, text: Int, link: String): RemoteViews =
    RemoteViews(context.packageName, R.layout.finlynq_widget_message).apply {
      setTextViewText(R.id.finlynq_title, context.getString(title))
      setTextViewText(R.id.finlynq_message, context.getString(text))
      setOnClickPendingIntent(R.id.finlynq_root, openLink(context, link))
    }

  private fun setStale(context: Context, views: RemoteViews, section: JSONObject) {
    val age = WidgetDates.staleAge(section.optLong("asOfMs", 0L))
    if (age == null) {
      views.setViewVisibility(R.id.finlynq_stale, View.GONE)
    } else {
      views.setViewVisibility(R.id.finlynq_stale, View.VISIBLE)
      views.setTextViewText(R.id.finlynq_stale, context.getString(R.string.finlynq_widget_updated_ago, age))
    }
  }

  private fun amountOr(hide: Boolean, value: String): String = if (hide) HIDDEN_AMOUNT else value

  // ─── Left to spend ────────────────────────────────────────────────────────

  private fun daysLeftText(context: Context): String {
    val days = WidgetDates.daysLeftInMonth()
    return if (days == 0) {
      context.getString(R.string.finlynq_widget_last_day)
    } else {
      context.resources.getQuantityString(R.plurals.finlynq_widget_days_left, days, days)
    }
  }

  private fun toneColor(context: Context, tone: String): Int = context.getColor(
    when (tone) {
      "over" -> R.color.finlynq_widget_neg
      "warn" -> R.color.finlynq_widget_primary
      else -> R.color.finlynq_widget_pos
    },
  )

  /** A ring that empties as the month's budget is spent; `remaining` runs 1 to 0. */
  private fun ringBitmap(remaining: Float, color: Int): Bitmap {
    val bitmap = Bitmap.createBitmap(RING_SIZE_PX, RING_SIZE_PX, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val inset = RING_STROKE_PX / 2
    val bounds = RectF(inset, inset, RING_SIZE_PX - inset, RING_SIZE_PX - inset)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = RING_STROKE_PX
      strokeCap = Paint.Cap.ROUND
    }
    paint.color = RING_TRACK_COLOR
    canvas.drawArc(bounds, 0f, 360f, false, paint)
    if (remaining > 0f) {
      paint.color = color
      canvas.drawArc(bounds, -90f, 360f * remaining.coerceAtMost(1f), false, paint)
    }
    return bitmap
  }

  private fun leftToSpend(context: Context, snapshot: JSONObject?): RemoteViews {
    val title = R.string.finlynq_widget_left_to_spend_name
    val section = snapshot?.optJSONObject("leftToSpend")
      ?: return message(context, title, R.string.finlynq_widget_open_to_update, LINK_BUDGETS)
    // Last month's figures say nothing about this month.
    if (section.optString("month") != WidgetDates.today().substring(0, 7)) {
      return message(context, title, R.string.finlynq_widget_open_to_update, LINK_BUDGETS)
    }

    val hide = WidgetStore.hideAmounts(context)
    val hasBudget = section.optBoolean("hasBudget", false)
    val tone = section.optString("tone", "ok")
    val used = section.optDouble("usedFraction", 0.0).toFloat().coerceAtLeast(0f)
    val over = hasBudget && tone == "over"
    val remaining = (1f - used).coerceIn(0f, 1f)

    val views = RemoteViews(context.packageName, R.layout.finlynq_widget_left_to_spend)
    views.setOnClickPendingIntent(R.id.finlynq_root, openLink(context, LINK_BUDGETS))

    val ringFill = when {
      hide || !hasBudget -> 0f
      over -> 1f
      else -> remaining
    }
    views.setImageViewBitmap(R.id.finlynq_ring, ringBitmap(ringFill, toneColor(context, tone)))
    views.setTextViewText(
      R.id.finlynq_ring_label,
      when {
        hide -> "•••"
        !hasBudget -> "–"
        over -> context.getString(R.string.finlynq_widget_over)
        else -> "${(remaining * 100).roundToInt()}%"
      },
    )

    if (hasBudget) {
      views.setTextViewText(
        R.id.finlynq_title,
        context.getString(if (over) R.string.finlynq_widget_over_budget else title),
      )
      views.setTextViewText(R.id.finlynq_amount, amountOr(hide, section.optString("leftLabel")))
      views.setTextViewText(
        R.id.finlynq_sub,
        if (hide) {
          daysLeftText(context)
        } else {
          context.getString(R.string.finlynq_widget_of_budget, section.optString("plannedLabel"), daysLeftText(context))
        },
      )
    } else {
      views.setTextViewText(R.id.finlynq_title, context.getString(R.string.finlynq_widget_spent_this_month))
      views.setTextViewText(R.id.finlynq_amount, amountOr(hide, section.optString("spentLabel")))
      views.setTextViewText(R.id.finlynq_sub, context.getString(R.string.finlynq_widget_no_budget))
    }
    setStale(context, views, section)
    return views
  }

  // ─── Upcoming payments ────────────────────────────────────────────────────

  /** How many rows fit. In portrait the height a launcher gives is MAX_HEIGHT. */
  private fun upcomingRowCount(options: Bundle?): Int {
    val height = options?.let {
      maxOf(it.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT), it.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT))
    } ?: 0
    if (height <= 0) return UPCOMING_DEFAULT_ROWS
    return ((height - UPCOMING_HEADER_DP) / UPCOMING_ROW_DP).coerceIn(1, UPCOMING_MAX_ROWS)
  }

  private fun upcoming(context: Context, snapshot: JSONObject?, options: Bundle?): RemoteViews {
    val title = R.string.finlynq_widget_upcoming_name
    val section = snapshot?.optJSONObject("upcoming")
      ?: return message(context, title, R.string.finlynq_widget_open_to_update, LINK_SUBSCRIPTIONS)
    val items = section.optJSONArray("items")
    val today = WidgetDates.today()

    val due = ArrayList<JSONObject>()
    for (i in 0 until (items?.length() ?: 0)) {
      val item = items?.optJSONObject(i) ?: continue
      if (item.optString("date") >= today) due.add(item)
    }
    if (due.isEmpty()) {
      // Every saved payment has passed: the list is old, not empty.
      val text = if ((items?.length() ?: 0) > 0) {
        R.string.finlynq_widget_open_to_update
      } else {
        R.string.finlynq_widget_nothing_due
      }
      return message(context, title, text, LINK_SUBSCRIPTIONS)
    }

    val hide = WidgetStore.hideAmounts(context)
    val views = RemoteViews(context.packageName, R.layout.finlynq_widget_upcoming)
    views.setOnClickPendingIntent(R.id.finlynq_root, openLink(context, LINK_SUBSCRIPTIONS))
    views.removeAllViews(R.id.finlynq_rows)
    val todayText = context.getString(R.string.finlynq_widget_today)
    val tomorrowText = context.getString(R.string.finlynq_widget_tomorrow)
    for (item in due.take(upcomingRowCount(options))) {
      val date = item.optString("date")
      val row = RemoteViews(context.packageName, R.layout.finlynq_widget_upcoming_row)
      row.setTextViewText(R.id.finlynq_row_when, WidgetDates.whenLabel(date, today, todayText, tomorrowText))
      row.setTextColor(
        R.id.finlynq_row_when,
        context.getColor(if (WidgetDates.isDueSoon(date, today)) R.color.finlynq_widget_primary else R.color.finlynq_widget_muted),
      )
      row.setTextViewText(R.id.finlynq_row_name, item.optString("name"))
      row.setTextViewText(R.id.finlynq_row_amount, amountOr(hide, item.optString("amountLabel")))
      row.setOnClickPendingIntent(R.id.finlynq_row, openLink(context, item.optString("link", LINK_SUBSCRIPTIONS)))
      views.addView(R.id.finlynq_rows, row)
    }
    setStale(context, views, section)
    return views
  }

  // ─── Net worth ────────────────────────────────────────────────────────────

  private fun netWorth(context: Context, snapshot: JSONObject?): RemoteViews {
    val section = snapshot?.optJSONObject("netWorth")
      ?: return message(context, R.string.finlynq_widget_net_worth_name, R.string.finlynq_widget_open_to_update, LINK_HOME)
    val hide = WidgetStore.hideAmounts(context)
    val views = RemoteViews(context.packageName, R.layout.finlynq_widget_net_worth)
    views.setOnClickPendingIntent(R.id.finlynq_root, openLink(context, LINK_HOME))
    views.setTextViewText(R.id.finlynq_amount, amountOr(hide, section.optString("netWorthLabel")))
    views.setTextViewText(R.id.finlynq_assets, amountOr(hide, section.optString("assetsLabel")))
    views.setTextViewText(R.id.finlynq_debts, amountOr(hide, section.optString("debtsLabel")))
    setStale(context, views, section)
    return views
  }

  // ─── Quick add ────────────────────────────────────────────────────────────

  private fun quickAdd(context: Context): RemoteViews =
    RemoteViews(context.packageName, R.layout.finlynq_widget_quick_add).apply {
      setOnClickPendingIntent(R.id.finlynq_root, openLink(context, LINK_ADD_TRANSACTION))
    }
}
