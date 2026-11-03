package com.sigongnote.app

/** Vendor/provider PDUs can violate the library's assertions. Keep failures local. */
internal fun <T> readMmsPdu(read: () -> T): T = try {
    read()
} catch (_: AssertionError) {
    // Do not log PDU content; also do not swallow unrelated VM errors.
    throw IllegalStateException("MMS_CONTENT_UNREADABLE")
}

internal enum class MmsInboxKind { CONTENT, AWAITING_DOWNLOAD, REPORT }

/** NotificationInd is only an arrival notice, not downloaded message bytes. */
internal fun mmsInboxKind(type: Int) = when (type) {
    128, 132 -> MmsInboxKind.CONTENT
    130 -> MmsInboxKind.AWAITING_DOWNLOAD
    else -> MmsInboxKind.REPORT
}
