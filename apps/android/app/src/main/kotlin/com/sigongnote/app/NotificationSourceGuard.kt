package com.sigongnote.app

import android.content.Context
import android.content.Intent
import android.provider.Telephony

data class SmsAppInventory(val defaultPackage: String?, val capablePackages: Set<String>)
enum class NotificationPackageDecision { ALLOW, BLOCK, UNAVAILABLE }

/** Resolve on every boundary: the user can change the default SMS app while we are running. */
object NotificationSourceGuard {
    private fun inventory(context: Context) = SmsAppInventory(Telephony.Sms.getDefaultSmsPackage(context),
        context.packageManager.queryBroadcastReceivers(Intent(Telephony.Sms.Intents.SMS_DELIVER_ACTION),0)
            .map { it.activityInfo.packageName }.toSet())

    fun decide(packageName: String, lookup: () -> SmsAppInventory): NotificationPackageDecision {
        if (!NotificationCapturePolicy.packageSelectable(packageName)) return NotificationPackageDecision.BLOCK
        return try {
            val sms = lookup()
            if (packageName == sms.defaultPackage || packageName in sms.capablePackages)
                NotificationPackageDecision.BLOCK else NotificationPackageDecision.ALLOW
        } catch (_: Exception) { NotificationPackageDecision.UNAVAILABLE }
    }

    fun decision(context: Context, packageName: String) = decide(packageName) { inventory(context) }
    fun selectable(context: Context, packageName: String) = decision(context,packageName) == NotificationPackageDecision.ALLOW

    fun revokeIfBlocked(context: Context, db: CaptureQueueDatabase, packageName: String) {
        if (decision(context,packageName) == NotificationPackageDecision.BLOCK &&
            db.notificationDao().hasRetainedPackageData(packageName)) revoke(db,packageName)
    }

    fun enforce(context: Context, db: CaptureQueueDatabase, lookup: () -> SmsAppInventory = { inventory(context) }) {
        val resolution = runCatching(lookup)
        val packages = db.notificationDao().retainedPackages()
        packages.filter { decide(it) { resolution.getOrThrow() } == NotificationPackageDecision.BLOCK }
            .filter { db.notificationDao().hasRetainedPackageData(it) }.forEach { revoke(db,it) }
        RevokedCapturePurger(db,context.filesDir,TokenVault(context)).purgePending()
    }

    /** Only app-owned notification copies are cleared. Server receipts and provider originals remain. */
    fun revoke(db: CaptureQueueDatabase, packageName: String) {
        db.runInTransaction {
            db.queueDao().stopForNotificationPackage(packageName,System.currentTimeMillis())
            db.notificationDao().pause(packageName)
            db.notificationDao().removePackageScopes(packageName)
            db.notificationDao().purgePackage(packageName)
        }
    }
}
