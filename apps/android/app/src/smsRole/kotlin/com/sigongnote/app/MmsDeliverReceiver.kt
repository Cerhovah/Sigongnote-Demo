package com.sigongnote.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SubscriptionManager

class MmsDeliverReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION ||
            !SmsRoleRuntime.isDefault(context)) return
        val data = intent.getByteArrayExtra("data") ?: return
        val subscriptionId = intent.getIntExtra("subscription",
            SubscriptionManager.getDefaultSmsSubscriptionId())
        val pending = goAsync()
        (context.applicationContext as SigongnoteApp).notificationExecutor.execute {
            try { MmsRoleRuntime.receiveNotification(context,data,subscriptionId) }
            catch (_: Exception) { /* Unresolved carrier PDU never becomes work evidence. */ }
            finally { pending.finish() }
        }
    }
}
