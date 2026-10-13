package expo.modules.paymentnotificationlistener

internal data class CapturedNotification(
  val notificationKey: String,
  val packageName: String,
  val title: String,
  val text: String,
  /** Epoch milliseconds. */
  val postedAt: Long
)

/**
 * The buffer's rules, with no Android dependency. Mirrored 1:1 by
 * src/lib/paymentNotificationBuffer.ts, which is where they are case-tested
 * (src/lib/paymentNotificationBuffer.cases.ts) — change both together.
 */
internal object CapturedNotificationBuffer {
  const val MAX_ENTRIES = 50
  const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
  const val MAX_TITLE_LENGTH = 200
  const val MAX_TEXT_LENGTH = 1000

  /** Trimmed, non-empty, de-duplicated, first occurrence kept. */
  fun normalizePackages(raw: List<String>): List<String> {
    val out = LinkedHashSet<String>()
    for (item in raw) {
      val name = item.trim()
      if (name.isNotEmpty()) out.add(name)
    }
    return out.toList()
  }

  /** Exact, case-sensitive package match. An empty allowlist admits nothing. */
  fun isAllowed(packageName: String, allowed: Collection<String>): Boolean =
    packageName.isNotEmpty() && allowed.contains(packageName)

  /** `null` = nothing worth keeping (no key / package, or no title and no text). */
  fun normalize(
    notificationKey: String?,
    packageName: String?,
    title: String?,
    text: String?,
    postedAt: Long,
    now: Long
  ): CapturedNotification? {
    val key = notificationKey?.trim().orEmpty()
    val pkg = packageName?.trim().orEmpty()
    if (key.isEmpty() || pkg.isEmpty()) return null
    val cleanTitle = clean(title, MAX_TITLE_LENGTH)
    val cleanText = clean(text, MAX_TEXT_LENGTH)
    if (cleanTitle.isEmpty() && cleanText.isEmpty()) return null
    return CapturedNotification(key, pkg, cleanTitle, cleanText, if (postedAt > 0) postedAt else now)
  }

  /** Drops entries older than 7 days, newest first, at most 50. */
  fun purge(entries: List<CapturedNotification>, now: Long): List<CapturedNotification> =
    entries
      .filter { now - it.postedAt <= MAX_AGE_MS }
      .sortedByDescending { it.postedAt }
      .take(MAX_ENTRIES)

  /**
   * The same notification re-posted (same key, same title and text) is NOT
   * added again — the first arrival stays. The same key with DIFFERENT
   * content is kept as its own entry: some apps reuse one key for every
   * payment, and replacing would silently lose the earlier one.
   */
  fun upsert(
    entries: List<CapturedNotification>,
    incoming: CapturedNotification,
    now: Long
  ): List<CapturedNotification> {
    val repeated = entries.any {
      it.notificationKey == incoming.notificationKey &&
        it.title == incoming.title &&
        it.text == incoming.text
    }
    return purge(if (repeated) entries else entries + incoming, now)
  }

  private fun clean(value: String?, max: Int): String {
    val trimmed = value?.replace("\r\n", "\n")?.trim().orEmpty()
    return if (trimmed.length > max) trimmed.substring(0, max) else trimmed
  }
}
