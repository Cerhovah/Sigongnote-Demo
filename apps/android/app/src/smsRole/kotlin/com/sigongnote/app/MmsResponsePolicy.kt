package com.sigongnote.app

/** Carrier configuration decides whether the notify response targets WAP URL or MMSC. */
internal object MmsResponsePolicy {
    fun locationUrl(notifyWapMmscEnabled: Boolean, contentLocation: String): String? =
        if (notifyWapMmscEnabled) contentLocation else null
}
