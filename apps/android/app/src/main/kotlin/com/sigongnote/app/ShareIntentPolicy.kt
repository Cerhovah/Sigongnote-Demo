package com.sigongnote.app

import android.content.Intent

object ShareIntentPolicy {
    fun shouldReceive(action: String?, savedState: Boolean, flags: Int): Boolean =
        (action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE) &&
            !savedState && flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0
}
