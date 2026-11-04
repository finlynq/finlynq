package com.finlynq.appupdate

import android.util.Log
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.install.model.UpdateAvailability
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Asks Google Play whether a newer build is available to this install. */
class FinlynqAppUpdateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FinlynqAppUpdate")

    // The versionCode Play would update this install to. Null when there is none or
    // Play can't say: installed from elsewhere, no Play Store, offline.
    AsyncFunction("availableVersionCode") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      AppUpdateManagerFactory.create(context).appUpdateInfo
        .addOnSuccessListener { info ->
          val available = info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
          promise.resolve(if (available) info.availableVersionCode() else null)
        }
        .addOnFailureListener { error ->
          Log.i(TAG, "Play could not answer: ${error.message}")
          promise.resolve(null)
        }
    }
  }

  private companion object {
    const val TAG = "FinlynqAppUpdate"
  }
}
