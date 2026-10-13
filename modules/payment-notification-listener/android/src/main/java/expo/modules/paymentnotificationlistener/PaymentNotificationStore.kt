package expo.modules.paymentnotificationlistener

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * On-device storage for the allowlist and the captured-notification buffer.
 *
 * Two JSON files under `noBackupFilesDir` — app-private, removed with the
 * app, and (unlike SharedPreferences / filesDir) excluded from Android's
 * cloud auto-backup, so the notification text never leaves the device that
 * way either. Nothing here talks to the network.
 *
 * The listener service and the JS module run in the same process; every
 * access goes through `lock`.
 */
internal object PaymentNotificationStore {
  private const val DIR = "payment_notification_listener"
  private const val CAPTURED_FILE = "captured.json"
  private const val ALLOWED_FILE = "allowed_packages.json"

  private val lock = Any()

  fun getAllowedPackages(context: Context): List<String> = synchronized(lock) {
    readAllowed(context)
  }

  fun setAllowedPackages(context: Context, packages: List<String>): List<String> = synchronized(lock) {
    val normalized = CapturedNotificationBuffer.normalizePackages(packages)
    val json = JSONArray()
    normalized.forEach { json.put(it) }
    write(file(context, ALLOWED_FILE), json.toString())
    normalized
  }

  /** Called by the listener service. Returns whether the notification was from an allowed app. */
  fun capture(
    context: Context,
    notificationKey: String?,
    packageName: String?,
    title: String?,
    text: String?,
    postedAt: Long
  ): Boolean = synchronized(lock) {
    val pkg = packageName?.trim().orEmpty()
    if (!CapturedNotificationBuffer.isAllowed(pkg, readAllowed(context))) return false
    val now = System.currentTimeMillis()
    val incoming = CapturedNotificationBuffer.normalize(notificationKey, pkg, title, text, postedAt, now)
      ?: return true
    val current = readCaptured(context)
    val next = CapturedNotificationBuffer.upsert(current, incoming, now)
    if (next != current) writeCaptured(context, next)
    true
  }

  fun getCaptured(context: Context): List<CapturedNotification> = synchronized(lock) {
    val current = readCaptured(context)
    val next = CapturedNotificationBuffer.purge(current, System.currentTimeMillis())
    if (next != current) writeCaptured(context, next)
    next
  }

  fun clearCaptured(context: Context) = synchronized(lock) {
    file(context, CAPTURED_FILE).delete()
  }

  private fun file(context: Context, name: String): AtomicFile {
    val dir = File(context.noBackupFilesDir, DIR)
    if (!dir.exists()) dir.mkdirs()
    return AtomicFile(File(dir, name))
  }

  private fun read(target: AtomicFile): String? =
    try {
      String(target.readFully(), Charsets.UTF_8)
    } catch (e: Exception) {
      null
    }

  private fun write(target: AtomicFile, content: String) {
    val stream = target.startWrite()
    try {
      stream.write(content.toByteArray(Charsets.UTF_8))
      target.finishWrite(stream)
    } catch (e: Exception) {
      target.failWrite(stream)
    }
  }

  private fun readAllowed(context: Context): List<String> {
    val raw = read(file(context, ALLOWED_FILE)) ?: return emptyList()
    return try {
      val json = JSONArray(raw)
      CapturedNotificationBuffer.normalizePackages(List(json.length()) { json.optString(it, "") })
    } catch (e: Exception) {
      emptyList()
    }
  }

  private fun readCaptured(context: Context): List<CapturedNotification> {
    val raw = read(file(context, CAPTURED_FILE)) ?: return emptyList()
    return try {
      val json = JSONArray(raw)
      val out = ArrayList<CapturedNotification>(json.length())
      for (i in 0 until json.length()) {
        val row = json.optJSONObject(i) ?: continue
        val key = row.optString("notificationKey", "")
        val pkg = row.optString("packageName", "")
        if (key.isEmpty() || pkg.isEmpty()) continue
        out.add(
          CapturedNotification(
            key,
            pkg,
            row.optString("title", ""),
            row.optString("text", ""),
            row.optLong("postedAt", 0L)
          )
        )
      }
      out
    } catch (e: Exception) {
      emptyList()
    }
  }

  private fun writeCaptured(context: Context, entries: List<CapturedNotification>) {
    val json = JSONArray()
    for (entry in entries) {
      json.put(
        JSONObject()
          .put("notificationKey", entry.notificationKey)
          .put("packageName", entry.packageName)
          .put("title", entry.title)
          .put("text", entry.text)
          .put("postedAt", entry.postedAt)
      )
    }
    write(file(context, CAPTURED_FILE), json.toString())
  }
}
