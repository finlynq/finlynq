package com.finlynq.widgets

import android.app.Activity
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.LinearLayout
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/**
 * Debug builds only. Hosts every widget through a real AppWidgetHost, so the
 * manifest, the provider info, the update broadcast and the RemoteViews all run
 * as they do on a launcher, from the sample snapshot in assets (the same file the
 * JS tests hold the snapshot builder to). Binding needs
 * `adb shell appwidget grantbind`; see scripts/widget-render-check.sh.
 */
class WidgetPreviewActivity : Activity() {
  private lateinit var host: AppWidgetHost
  private val hosted = ArrayList<Pair<String, View>>()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val scenario = intent.getStringExtra("scenario") ?: "sample"
    applyScenario(scenario)

    host = AppWidgetHost(this, HOST_ID)
    host.deleteHost()
    host.startListening()

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(WALLPAPER_COLOR)
      setPadding(px(16), px(32), px(16), px(16))
    }
    val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    root.addView(top)
    addWidget(top, WidgetKind.LEFT_TO_SPEND, "left-to-spend", 150, 170)
    addWidget(top, WidgetKind.QUICK_ADD, "quick-add", 72, 72)
    addWidget(root, WidgetKind.UPCOMING, "upcoming-large", 340, 200)
    addWidget(root, WidgetKind.UPCOMING, "upcoming-small", 340, 110)
    addWidget(root, WidgetKind.NET_WORTH, "net-worth", 260, 120)
    addWidget(root, WidgetKind.LEFT_TO_SPEND, "left-to-spend-small", 130, 120)
    setContentView(root)

    root.postDelayed({ saveAndFinish(scenario) }, RENDER_WAIT_MS)
  }

  override fun onDestroy() {
    host.stopListening()
    super.onDestroy()
  }

  private fun px(dp: Int) = (dp * resources.displayMetrics.density).toInt()

  private fun addWidget(parent: LinearLayout, kind: WidgetKind, name: String, widthDp: Int, heightDp: Int) {
    val manager = AppWidgetManager.getInstance(this)
    val id = host.allocateAppWidgetId()
    val options = Bundle().apply {
      putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, widthDp)
      putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, widthDp)
      putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, heightDp)
      putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, heightDp)
    }
    val provider = ComponentName(this, kind.providerClass)
    if (!manager.bindAppWidgetIdIfAllowed(id, provider, options)) {
      Log.e(TAG, "PREVIEW_BIND_FAILED $name")
      return
    }
    val view = host.createView(applicationContext, id, manager.getAppWidgetInfo(id))
    view.setPadding(0, 0, 0, 0)
    val params = LinearLayout.LayoutParams(px(widthDp), px(heightDp)).apply {
      setMargins(px(4), px(4), px(4), px(4))
    }
    parent.addView(view, params)
    hosted.add(name to view)
  }

  private fun saveAndFinish(scenario: String) {
    val night = resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES
    val dir = File(getExternalFilesDir(null), "preview").apply { mkdirs() }
    for ((name, view) in hosted) {
      val bitmap = Bitmap.createBitmap(view.width.coerceAtLeast(1), view.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
      view.draw(Canvas(bitmap))
      val file = File(dir, "$scenario-${if (night) "dark" else "light"}-$name.png")
      FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    Log.i(TAG, "PREVIEW_DONE scenario=$scenario widgets=${hosted.size}")
  }

  /** Writes the sample with its dates moved to today, then varies it per scenario. */
  private fun applyScenario(scenario: String) {
    WidgetStore.setHideAmounts(this, scenario == "hidden")
    when (scenario) {
      "empty" -> {
        WidgetStore.clear(this)
        return
      }
      "corrupt" -> {
        WidgetStore.write(this, "{not json")
        return
      }
    }
    val sample = JSONObject(assets.open("widget-snapshot.sample.json").bufferedReader().use { it.readText() })
    val now = System.currentTimeMillis()
    val iso = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    val left = sample.getJSONObject("leftToSpend")
    val upcoming = sample.getJSONObject("upcoming")
    val netWorth = sample.getJSONObject("netWorth")
    val asOf = if (scenario == "stale") now - STALE_AGE_MS else now
    left.put("asOfMs", asOf)
    upcoming.put("asOfMs", asOf)
    netWorth.put("asOfMs", asOf)
    left.put("month", iso.format(Calendar.getInstance().time).substring(0, 7))
    val items = upcoming.getJSONArray("items")
    for (i in 0 until items.length()) {
      val day = Calendar.getInstance().apply { add(Calendar.DAY_OF_MONTH, UPCOMING_OFFSETS[i % UPCOMING_OFFSETS.size]) }
      items.getJSONObject(i).put("date", iso.format(day.time))
    }
    when (scenario) {
      "warn" -> left.put("tone", "warn").put("usedFraction", 0.86)
      "over" -> left.put("tone", "over").put("usedFraction", 1.14).put("leftLabel", "$420.10")
      "no-budget" -> left.put("hasBudget", false).put("usedFraction", 0)
      "long" -> {
        left.put("leftLabel", "HK$1,234,567.89").put("plannedLabel", "HK$9,876,543.21")
        netWorth.put("netWorthLabel", "HK$12,345,678,901.23")
        items.getJSONObject(3)
          .put("name", "A very long merchant name that does not fit on one row")
          .put("amountLabel", "HK$1,204,999.00")
      }
      "nothing-due" -> upcoming.put("items", org.json.JSONArray())
    }
    WidgetStore.write(this, sample.toString())
  }

  private companion object {
    const val TAG = "FinlynqWidgetPreview"
    const val HOST_ID = 9217
    const val WALLPAPER_COLOR = 0xFF4A5A6A.toInt()
    const val RENDER_WAIT_MS = 2500L
    const val STALE_AGE_MS = 3 * 60 * 60 * 1000L
    val UPCOMING_OFFSETS = intArrayOf(0, 1, 3, 9, 20, 40)
  }
}
