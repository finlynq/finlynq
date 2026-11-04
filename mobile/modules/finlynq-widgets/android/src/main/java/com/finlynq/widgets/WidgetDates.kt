package com.finlynq.widgets

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/** Date wording worked out when a widget draws, so it stays right between refreshes. */
internal object WidgetDates {
  /** A snapshot younger than this says nothing about its age. */
  private const val STALE_AFTER_MS = 60 * 60 * 1000L

  private fun isoFormat() = SimpleDateFormat("yyyy-MM-dd", Locale.US)

  fun today(now: Date = Date()): String = isoFormat().format(now)

  private fun parseDay(iso: String): Date? = try {
    isoFormat().parse(iso)
  } catch (e: Exception) {
    null
  }

  /** "12 days left", "1 day left" or "Last day" for the month containing `now`. */
  fun daysLeftInMonth(now: Date = Date()): Int {
    val calendar = Calendar.getInstance().apply { time = now }
    return calendar.getActualMaximum(Calendar.DAY_OF_MONTH) - calendar.get(Calendar.DAY_OF_MONTH)
  }

  /** Whole calendar days from `today` to `iso`; half a day of slack absorbs a clock change. */
  private fun daysUntil(iso: String, today: String): Long? {
    val to = parseDay(iso) ?: return null
    val from = parseDay(today) ?: return null
    return TimeUnit.MILLISECONDS.toDays(to.time - from.time + TimeUnit.HOURS.toMillis(12))
  }

  fun isDueSoon(iso: String, today: String): Boolean {
    val days = daysUntil(iso, today) ?: return false
    return days in 0L..1L
  }

  /** "Today", "Tomorrow", "Sat" within the week, then "Nov 12". */
  fun whenLabel(iso: String, today: String, todayText: String, tomorrowText: String): String {
    val days = daysUntil(iso, today) ?: return iso
    val date = parseDay(iso) ?: return iso
    return when {
      days == 0L -> todayText
      days == 1L -> tomorrowText
      days in 2L..6L -> SimpleDateFormat("EEE", Locale.getDefault()).format(date)
      else -> SimpleDateFormat("MMM d", Locale.getDefault()).format(date)
    }
  }

  /** "2h" or "3d" when the figures are at least an hour old, else null. */
  fun staleAge(asOfMs: Long, nowMs: Long = System.currentTimeMillis()): String? {
    val age = nowMs - asOfMs
    if (asOfMs <= 0L || age < STALE_AFTER_MS) return null
    val hours = TimeUnit.MILLISECONDS.toHours(age)
    return if (hours < 24) "${hours}h" else "${hours / 24}d"
  }
}
