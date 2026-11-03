package com.sigongnote.app

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.role.RoleManager
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.provider.Telephony
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager

/** Default-handler check and local-only telephony operations. */
object SmsRoleRuntime {
    data class LocalMessage(val id: Long, val address: String, val body: String,
        val type: Int, val date: Long) {
        val sent: Boolean get() = type != Telephony.Sms.MESSAGE_TYPE_INBOX
        val failed: Boolean get() = type == Telephony.Sms.MESSAGE_TYPE_FAILED
        fun preview(): String = body.replace('\n',' ').take(48)
    }

    fun isAvailable(context: Context): Boolean = context.packageManager.hasSystemFeature(
        PackageManager.FEATURE_TELEPHONY_MESSAGING)

    fun isDefault(context: Context): Boolean = isAvailable(context) &&
        if (Build.VERSION.SDK_INT >= 29)
            context.getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_SMS)
        else Telephony.Sms.getDefaultSmsPackage(context) == context.packageName

    fun canRead(context: Context): Boolean = isDefault(context) &&
        context.checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED

    fun canSend(context: Context): Boolean = isDefault(context) &&
        context.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED

    fun validAddress(value: String): Boolean = value.length in 3..40 &&
        value.all { it.isDigit() || it in "+- ()" }

    fun recentMessages(context: Context, limit: Int): List<LocalMessage> {
        if (!canRead(context)) return emptyList()
        val result = mutableListOf<LocalMessage>()
        val columns = arrayOf(Telephony.Sms._ID,Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,Telephony.Sms.TYPE,Telephony.Sms.DATE)
        context.contentResolver.query(Telephony.Sms.CONTENT_URI,columns,null,null,
            "${Telephony.Sms.DATE} DESC")?.use { cursor ->
            while (result.size < limit && cursor.moveToNext()) {
                val address = cursor.getString(1) ?: continue
                val body = cursor.getString(2) ?: ""
                result.add(LocalMessage(cursor.getLong(0),address,body,
                    cursor.getInt(3),cursor.getLong(4)))
            }
        }
        return result
    }

    fun availableSubscriptions(context: Context): List<Pair<Int,String>> {
        if (!isDefault(context)) return emptyList()
        val manager = context.getSystemService(SubscriptionManager::class.java)
        if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED) {
            val active = manager.activeSubscriptionInfoList.orEmpty()
            if (active.isNotEmpty()) return active.map { info ->
                info.subscriptionId to "SIM ${info.simSlotIndex + 1} · ${info.displayName}"
            }
        }
        val defaultId = SubscriptionManager.getDefaultSmsSubscriptionId()
        return if (defaultId == SubscriptionManager.INVALID_SUBSCRIPTION_ID) emptyList()
        else listOf(defaultId to "기본 문자 SIM")
    }

    @Suppress("DEPRECATION")
    private fun smsManager(context: Context, subscriptionId: Int): SmsManager {
        require(subscriptionId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
            "No SMS subscription"
        }
        return if (Build.VERSION.SDK_INT >= 31)
            context.getSystemService(SmsManager::class.java)
                .createForSubscriptionId(subscriptionId)
        else SmsManager.getDefault().createForSubscriptionId(subscriptionId)
    }

    fun sendText(context: Context, address: String, body: String, subscriptionId: Int) {
        check(canSend(context)) { "SMS role or permission missing" }
        require(validAddress(address) && body.isNotBlank() && body.length <= 20_000)
        val manager = smsManager(context,subscriptionId)
        val parts = manager.divideMessage(body)
        require(parts.isNotEmpty())
        val values = ContentValues().apply {
            put(Telephony.Sms.ADDRESS,address)
            put(Telephony.Sms.BODY,body)
            put(Telephony.Sms.DATE,System.currentTimeMillis())
            put(Telephony.Sms.READ,1)
            put(Telephony.Sms.SEEN,1)
            put(Telephony.Sms.SUBSCRIPTION_ID,subscriptionId)
            put(Telephony.Sms.TYPE,Telephony.Sms.MESSAGE_TYPE_OUTBOX)
        }
        val uri = context.contentResolver.insert(Telephony.Sms.Outbox.CONTENT_URI,values)
            ?: throw IllegalStateException("SMS provider unavailable")
        val id = ContentUris.parseId(uri)
        try {
            val sent = ArrayList<PendingIntent>(parts.size)
            for (part in parts.indices) {
                val result = Intent(context,SmsSendResultReceiver::class.java).apply {
                    data = Uri.parse("sigongnote-sms://result/$id/$part")
                    putExtra("message_id",id)
                    putExtra("part",part)
                    putExtra("parts",parts.size)
                }
                sent.add(PendingIntent.getBroadcast(context,(id + part).toInt(),result,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            }
            manager.sendMultipartTextMessage(address,null,parts,sent,null)
        } catch (error: Exception) {
            context.contentResolver.update(ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI,id),
                ContentValues().apply { put(Telephony.Sms.TYPE,Telephony.Sms.MESSAGE_TYPE_FAILED) },
                null,null)
            throw error
        }
    }

    fun showIncomingNotification(context: Context, id: Long, address: String) {
        if (!isDefault(context)) return
        val notificationManager = context.getSystemService(NotificationManager::class.java)
        val channel = "sms_messages"
        notificationManager.createNotificationChannel(NotificationChannel(channel,"문자 수신",
            NotificationManager.IMPORTANCE_DEFAULT))
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED) return
        val intent = Intent(context,SmsRoleActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            data = Uri.parse("smsto:$address")
            action = Intent.ACTION_SENDTO
        }
        val pending = PendingIntent.getActivity(context,id.toInt(),intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = android.app.Notification.Builder(context,channel)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("새 문자")
            .setContentText(address)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        notificationManager.notify(id.toInt(),notification)
    }

    fun rememberIncoming(context: Context, pdus: Array<out ByteArray>, format: String?,
        address: String, body: String, date: Long): Long? {
        if (!isDefault(context) || pdus.isEmpty()) return null
        val key = SmsPendingStore.digest(pdus,format)
        val prefs = context.getSharedPreferences("sms_delivery_ids",Context.MODE_PRIVATE)
        if (prefs.contains(key)) return null
        val values = ContentValues().apply {
            put(Telephony.Sms.ADDRESS,address)
            put(Telephony.Sms.BODY,body)
            put(Telephony.Sms.DATE,date)
            put(Telephony.Sms.READ,0)
            put(Telephony.Sms.SEEN,0)
            put(Telephony.Sms.TYPE,Telephony.Sms.MESSAGE_TYPE_INBOX)
        }
        val uri = context.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI,values)
            ?: return null
        prefs.edit().putLong(key,ContentUris.parseId(uri)).commit()
        return ContentUris.parseId(uri)
    }
}

class SmsDeliverReceiver : BroadcastReceiver() {
    private fun health(context: Context, value: String) {
        context.getSharedPreferences("sms_role_health",Context.MODE_PRIVATE)
            .edit().putString("last_receive",value).apply()
    }

    private fun warnSaveFailure(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("sms_health","문자 저장 상태",
            NotificationManager.IMPORTANCE_HIGH))
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        manager.notify(1701,android.app.Notification.Builder(context,"sms_health")
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("문자를 저장하지 못했습니다")
            .setContentText("저장공간과 기본 문자앱 연결을 확인해 주세요")
            .build())
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION) return
        @Suppress("DEPRECATION")
        val pdus = (intent.extras?.get("pdus") as? Array<*>)
            ?.filterIsInstance<ByteArray>()?.toTypedArray()
        if (pdus.isNullOrEmpty()) { health(context,"empty_pdu"); return }
        try {
            SmsPendingStore.save(context,pdus,intent.getStringExtra("format"))
            health(context,"durable_pending")
        } catch (_: Exception) {
            try {
                if (SmsRoleRuntime.isDefault(context)) {
                    val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
                    val address = messages.firstOrNull()?.displayOriginatingAddress
                    if (!address.isNullOrBlank()) {
                        val id = SmsRoleRuntime.rememberIncoming(context,pdus,
                            intent.getStringExtra("format"),address,
                            messages.joinToString("") { it.displayMessageBody ?: "" },
                            messages.first().timestampMillis)
                        if (id != null) {
                            health(context,"fallback_stored")
                            SmsRoleRuntime.showIncomingNotification(context,id,address)
                            return
                        }
                    }
                }
            } catch (_: Exception) { /* Warn below if both durable paths fail. */ }
            health(context,"pending_save_failed")
            warnSaveFailure(context)
            return
        }
        val pending = goAsync()
        (context.applicationContext as SigongnoteApp).notificationExecutor.execute {
            try {
                if (SmsPendingStore.recover(context) > 0) health(context,"stored")
                else health(context,"pending_role_or_provider")
            } catch (_: Exception) { health(context,"receive_failed") }
            finally { pending.finish() }
        }
    }
}

class SmsSendResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!SmsRoleRuntime.isDefault(context)) return
        val id = intent.getLongExtra("message_id",-1)
        val part = intent.getIntExtra("part",-1)
        val total = intent.getIntExtra("parts",0)
        if (id < 0 || part !in 0 until total || total > 200) return
        val prefs = context.getSharedPreferences("sms_send_results",Context.MODE_PRIVATE)
        val key = "$id:$part"
        if (prefs.contains(key)) return
        prefs.edit().putBoolean(key,resultCode == Activity.RESULT_OK).commit()
        val results = (0 until total).map { prefs.getBoolean("$id:$it",false) }
        val known = (0 until total).all { prefs.contains("$id:$it") }
        if (!known) return
        val status = if (results.all { it }) Telephony.Sms.MESSAGE_TYPE_SENT
            else Telephony.Sms.MESSAGE_TYPE_FAILED
        context.contentResolver.update(ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI,id),
            ContentValues().apply { put(Telephony.Sms.TYPE,status) },null,null)
        val pending = goAsync()
        (context.applicationContext as SigongnoteApp).notificationExecutor.execute {
            try {
                if (SmsRoleRuntime.isDefault(context))
                    NotificationAccount.current(context)?.let { session ->
                        SmsBusinessCapture(context).captureSms(id,session)
                    }
            } catch (_: Exception) { /* Original message remains in Telephony. */ }
            finally { pending.finish() }
        }
    }
}

class SmsRoleChangedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.ACTION_DEFAULT_SMS_PACKAGE_CHANGED) return
        val held = SmsRoleRuntime.isDefault(context)
        if (!held) context.getSystemService(NotificationManager::class.java).cancelAll()
        val pending = goAsync()
        (context.applicationContext as SigongnoteApp).notificationExecutor.execute {
            try { SmsBusinessCapture(context).roleChanged() }
            catch (_: Exception) { /* Subsequent scans still re-check the OS role. */ }
            finally { pending.finish() }
        }
    }
}

class SmsRespondService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == TelephonyManager.ACTION_RESPOND_VIA_MESSAGE &&
            SmsRoleRuntime.canSend(this)) {
            val address = intent.data?.schemeSpecificPart.orEmpty()
            val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
            if (SmsRoleRuntime.validAddress(address) && text.isNotBlank()) {
                try {
                    SmsRoleRuntime.sendText(this,address,text,
                        SubscriptionManager.getDefaultSmsSubscriptionId())
                } catch (_: Exception) { /* The user can retry from the inbox. */ }
            }
        }
        stopSelf(startId)
        return START_NOT_STICKY
    }
}
