package com.sigongnote.app

import android.content.Context
import android.content.pm.ApplicationInfo

/** Reads the native account marker only; uploading still requires a fresh server consent check. */
object NotificationAccount {
    fun current(context: Context): UploadSession? {
        return try {
            val raw = TokenVault(context).read() ?: return null
            val allowLocal = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
            UploadSession.decode(raw,allowLocal)
        } catch (_: Exception) { null }
    }

    fun matches(tenant: String?, user: String?, device: String?, session: UploadSession): Boolean =
        tenant == session.tenantId && user == session.userId && device == session.deviceId
}
