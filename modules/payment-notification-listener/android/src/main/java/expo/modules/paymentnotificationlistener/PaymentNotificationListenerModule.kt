package expo.modules.paymentnotificationlistener

import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS surface — see src/services/paymentNotificationListener.ts. */
class PaymentNotificationListenerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("PaymentNotificationListener")

    AsyncFunction("isNotificationAccessGranted") {
      isAccessGranted(context)
    }

    AsyncFunction("openNotificationAccessSettings") {
      openSettings(context)
    }

    AsyncFunction("getAllowedPackages") {
      PaymentNotificationStore.getAllowedPackages(context)
    }

    AsyncFunction("setAllowedPackages") { packages: List<String> ->
      PaymentNotificationStore.setAllowedPackages(context, packages)
    }

    AsyncFunction("getCapturedNotifications") {
      PaymentNotificationStore.getCaptured(context).map {
        mapOf(
          "notificationKey" to it.notificationKey,
          "packageName" to it.packageName,
          "title" to it.title,
          "text" to it.text,
          "postedAt" to it.postedAt.toDouble()
        )
      }
    }

    AsyncFunction("clearCapturedNotifications") {
      PaymentNotificationStore.clearCaptured(context)
      true
    }
  }

  private fun listenerComponent(context: Context) =
    ComponentName(context, PaymentNotificationListenerService::class.java)

  private fun isAccessGranted(context: Context): Boolean {
    val component = listenerComponent(context)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      if (manager != null) return manager.isNotificationListenerAccessGranted(component)
    }
    val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
      ?: return false
    return enabled.split(":").any { ComponentName.unflattenFromString(it) == component }
  }

  private fun openSettings(context: Context) {
    // Android 11+: straight to this app's own switch; otherwise (or if the
    // device has no such screen) the list of every listener app.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      try {
        context.startActivity(
          Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
            .putExtra(
              Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
              listenerComponent(context).flattenToString()
            )
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        return
      } catch (e: ActivityNotFoundException) {
        // fall through
      }
    }
    context.startActivity(
      Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
  }
}
