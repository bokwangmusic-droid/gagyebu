package expo.modules.paymentnotificationlistener

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * Receives posted notifications once the user has turned notification
 * access on for this app, and keeps the ones from allowlisted packages in
 * the on-device buffer (PaymentNotificationStore).
 *
 * This class does nothing else: no network, no transaction, no parsing.
 * Notification title / text are never written to logcat.
 */
class PaymentNotificationListenerService : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    if (sbn == null) return
    try {
      val packageName = sbn.packageName ?: return
      if (packageName == applicationContext.packageName) return

      val notification = sbn.notification ?: return
      // The group summary only repeats what its children already say.
      if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

      val extras = notification.extras ?: return
      val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
      val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
      val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
      // The expanded text, when there is one, is the untruncated body.
      val body = if (bigText != null && bigText.length > (text?.length ?: 0)) bigText else text

      PaymentNotificationStore.capture(applicationContext, sbn.key, packageName, title, body, sbn.postTime)
    } catch (e: Exception) {
      Log.w(TAG, "capture failed: ${e.javaClass.simpleName}")
    }
  }

  private companion object {
    const val TAG = "PaymentNotifListener"
  }
}
