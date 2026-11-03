package com.sigongnote.app

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Telephony
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import com.google.android.mms.pdu_alt.EncodedStringValue
import com.google.android.mms.pdu_alt.CharacterSets
import com.google.android.mms.pdu_alt.NotificationInd
import com.google.android.mms.pdu_alt.PduBody
import com.google.android.mms.pdu_alt.PduComposer
import com.google.android.mms.pdu_alt.PduParser
import com.google.android.mms.pdu_alt.PduPart
import com.google.android.mms.pdu_alt.PduPersister
import com.google.android.mms.pdu_alt.PduHeaders
import com.google.android.mms.pdu_alt.RetrieveConf
import com.google.android.mms.pdu_alt.SendReq
import com.google.android.mms.pdu_alt.NotifyRespInd
import java.security.MessageDigest
import java.util.UUID

/** MMS carrier hand-off is local to the default-handler debug flavor. */
object MmsRoleRuntime {
    data class Attachment(val mime: String, val uri: Uri?)
    data class LocalMms(val id: Long, val address: String, val text: String,
        val attachments: List<Attachment>, val status: Int, val date: Long)

    private fun digest(data: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(data).joinToString("") { "%02x".format(it) }

    @Suppress("DEPRECATION")
    private fun manager(context: Context, subscriptionId: Int): SmsManager {
        require(subscriptionId != SubscriptionManager.INVALID_SUBSCRIPTION_ID)
        return if (Build.VERSION.SDK_INT >= 31)
            context.getSystemService(SmsManager::class.java)
                .createForSubscriptionId(subscriptionId)
        else SmsManager.getDefault().createForSubscriptionId(subscriptionId)
    }

    fun receiveNotification(context: Context, data: ByteArray, subscriptionId: Int) {
        if (!SmsRoleRuntime.isDefault(context) || data.size !in 1..262_144) return
        val notification = PduParser(data,true).parse() as? NotificationInd ?: return
        val location = notification.contentLocation?.toString(Charsets.ISO_8859_1) ?: return
        if (location.length > 2048 || !location.startsWith("http",true)) return
        val key = digest((notification.transactionId ?: byteArrayOf()) +
            location.toByteArray(Charsets.ISO_8859_1) +
            subscriptionId.toString().toByteArray())
        val prefs = context.getSharedPreferences("mms_transfers",Context.MODE_PRIVATE)
        if (prefs.getString(key,null) in setOf("pending","stored","complete")) return
        context.getDir("mms-notifications",Context.MODE_PRIVATE)
            .resolve("$key.pdu").writeBytes(data)
        prefs.edit().putString(key,"pending")
            .putInt("$key:subscription",subscriptionId).commit()
        try {
            val intent = Intent(context,MmsTransferResultReceiver::class.java).apply {
                this.data = Uri.parse("sigongnote-mms://download/$key")
                putExtra("key",key)
                putExtra("direction","download")
                putExtra("subscription_id",subscriptionId)
            }
            val result = PendingIntent.getBroadcast(context,key.hashCode(),intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val config = manager(context,subscriptionId).carrierConfigValues
            val downloadUrl = if (location.endsWith('=') &&
                config.getBoolean(SmsManager.MMS_CONFIG_APPEND_TRANSACTION_ID,false))
                location + (notification.transactionId ?: byteArrayOf())
                    .toString(Charsets.ISO_8859_1) else location
            manager(context,subscriptionId).downloadMultimediaMessage(context,downloadUrl,
                MmsTransferProvider.uri(context,key),null,result)
        } catch (_: Exception) {
            prefs.edit().putString(key,"failed").commit()
            sendNotifyResponse(context,key,subscriptionId,PduHeaders.STATUS_DEFERRED)
            showStatus(context,"MMS 내려받기 실패 · 통신상태를 확인해 주세요")
        }
    }

    fun retryFailedDownloads(context: Context): Int {
        if (!SmsRoleRuntime.isDefault(context)) return 0
        val prefs = context.getSharedPreferences("mms_transfers",Context.MODE_PRIVATE)
        val directory = context.getDir("mms-notifications",Context.MODE_PRIVATE)
        var retried = 0
        for ((key,value) in prefs.all) {
            if (value !in setOf("failed","stored","revoked") ||
                !Regex("[a-f0-9]{64}").matches(key)) continue
            val file = directory.resolve("$key.pdu")
            if (!file.isFile || file.length() !in 1..262_144) continue
            val subscriptionId = prefs.getInt("$key:subscription",
                SubscriptionManager.getDefaultSmsSubscriptionId())
            if (value == "stored") sendNotifyResponse(context,key,
                subscriptionId,PduHeaders.STATUS_RETRIEVED)
            else receiveNotification(context,file.readBytes(),
                subscriptionId)
            retried++
        }
        return retried
    }

    fun finishDownload(context: Context, key: String, subscriptionId: Int, succeeded: Boolean) {
        val file = MmsTransferProvider.file(context,key)
        val prefs = context.getSharedPreferences("mms_transfers",Context.MODE_PRIVATE)
        if (!SmsRoleRuntime.isDefault(context)) {
            file.delete()
            prefs.edit().putString(key,"revoked").commit()
            return
        }
        if (!succeeded || !file.isFile || file.length() !in 1..(5L * 1024 * 1024)) {
            prefs.edit().putString(key,"failed").commit()
            sendNotifyResponse(context,key,subscriptionId,PduHeaders.STATUS_DEFERRED)
            showStatus(context,"MMS 내려받기 실패 · 수동으로 다시 확인해 주세요")
            return
        }
        try {
            val pdu = PduParser(file.readBytes(),true).parse() as? RetrieveConf
                ?: throw IllegalArgumentException("Unexpected MMS response")
            val uri = PduPersister.getPduPersister(context).persist(pdu,
                Telephony.Mms.Inbox.CONTENT_URI,true,true,null,subscriptionId)
            runCatching {
                NotificationAccount.current(context)?.let { session ->
                    SmsBusinessCapture(context).captureMms(ContentUris.parseId(uri),session)
                }
            }
            prefs.edit().putString(key,"stored").commit()
            sendNotifyResponse(context,key,subscriptionId,PduHeaders.STATUS_RETRIEVED)
            showStatus(context,"새 MMS · 앱에서 내용과 첨부를 확인해 주세요",ContentUris.parseId(uri))
            file.delete()
        } catch (_: Exception) {
            prefs.edit().putString(key,"failed").commit()
            sendNotifyResponse(context,key,subscriptionId,PduHeaders.STATUS_DEFERRED)
            showStatus(context,"MMS 해석 실패 · 원본 알림은 보관됨")
        }
    }

    /** AOSP Messaging sends M-NotifyResp.ind after an automatic retrieval. */
    private fun sendNotifyResponse(context: Context, key: String, subscriptionId: Int,
        status: Int) {
        if (!SmsRoleRuntime.isDefault(context)) return
        try {
            val original = context.getDir("mms-notifications",Context.MODE_PRIVATE)
                .resolve("$key.pdu")
            val notification = PduParser(original.readBytes(),true).parse() as? NotificationInd
                ?: return
            val transactionId = notification.transactionId ?: return
            val location = notification.contentLocation?.toString(Charsets.ISO_8859_1) ?: return
            val response = NotifyRespInd(PduHeaders.CURRENT_MMS_VERSION,transactionId,status)
            val encoded = PduComposer(context,response).make() ?: return
            require(encoded.size in 1..65_536)
            val controlKey = digest("$key:$status:response".toByteArray())
            MmsTransferProvider.file(context,controlKey).writeBytes(encoded)
            val intent = Intent(context,MmsTransferResultReceiver::class.java).apply {
                data = Uri.parse("sigongnote-mms://control/$controlKey")
                putExtra("key",controlKey)
                putExtra("parent_key",key)
                putExtra("status",status)
                putExtra("direction","control")
            }
            val notifyWap = manager(context,subscriptionId).carrierConfigValues
                .getBoolean(SmsManager.MMS_CONFIG_NOTIFY_WAP_MMSC_ENABLED,false)
            manager(context,subscriptionId).sendMultimediaMessage(context,
                MmsTransferProvider.uri(context,controlKey),
                MmsResponsePolicy.locationUrl(notifyWap,location),null,
                PendingIntent.getBroadcast(context,controlKey.hashCode(),intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        } catch (_: Exception) { /* Stored MMS remains visible and response can be retried. */ }
    }

    fun finishControl(context: Context, key: String, parentKey: String,
        status: Int, succeeded: Boolean) {
        MmsTransferProvider.file(context,key).delete()
        if (!SmsRoleRuntime.isDefault(context) || !succeeded ||
            status != PduHeaders.STATUS_RETRIEVED) return
        context.getSharedPreferences("mms_transfers",Context.MODE_PRIVATE)
            .edit().putString(parentKey,"complete").commit()
        context.getDir("mms-notifications",Context.MODE_PRIVATE)
            .resolve("$parentKey.pdu").delete()
    }

    fun send(context: Context, address: String, text: String, mime: String?,
        attachment: ByteArray?, subscriptionId: Int) {
        check(SmsRoleRuntime.canSend(context))
        require(SmsRoleRuntime.validAddress(address) && text.length <= 20_000)
        require(text.isNotBlank() || attachment != null)
        require((attachment?.size ?: 0) <= 1024 * 1024)
        if (attachment != null) require(mime in setOf("image/jpeg","image/png","image/gif"))
        val request = SendReq().apply {
            addTo(EncodedStringValue(address))
            prepareFromAddress(context,null,subscriptionId)
            date = System.currentTimeMillis() / 1000
        }
        val body = PduBody()
        if (text.isNotBlank()) body.addPart(PduPart().apply {
            contentType = "text/plain".toByteArray()
            charset = CharacterSets.UTF_8
            name = "text.txt".toByteArray()
            contentLocation = "text.txt".toByteArray()
            contentId = "text".toByteArray()
            data = text.toByteArray(Charsets.UTF_8)
        })
        if (attachment != null) body.addPart(PduPart().apply {
            contentType = requireNotNull(mime).toByteArray()
            val extension = when (mime) {
                "image/png" -> "png"
                "image/gif" -> "gif"
                else -> "jpg"
            }
            val filename = "photo.$extension".toByteArray()
            name = filename
            contentLocation = filename
            contentId = "photo".toByteArray()
            data = attachment
        })
        request.body = body
        val encoded = PduComposer(context,request).make()
            ?: throw IllegalStateException("MMS encoding failed")
        require(encoded.size <= 2 * 1024 * 1024)
        val uri = PduPersister.getPduPersister(context).persist(request,
            Telephony.Mms.Outbox.CONTENT_URI,true,false,null,subscriptionId)
        val id = ContentUris.parseId(uri)
        val key = digest((UUID.randomUUID().toString() + id).toByteArray())
        MmsTransferProvider.file(context,key).writeBytes(encoded)
        try {
            val result = Intent(context,MmsTransferResultReceiver::class.java).apply {
                data = Uri.parse("sigongnote-mms://send/$key")
                putExtra("key",key)
                putExtra("direction","send")
                putExtra("message_id",id)
            }
            manager(context,subscriptionId).sendMultimediaMessage(context,
                MmsTransferProvider.uri(context,key),null,null,
                PendingIntent.getBroadcast(context,key.hashCode(),result,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        } catch (error: Exception) {
            updateStatus(context,id,Telephony.Mms.MESSAGE_BOX_FAILED)
            MmsTransferProvider.file(context,key).delete()
            throw error
        }
    }

    fun finishSend(context: Context, key: String, id: Long, succeeded: Boolean) {
        if (id >= 0 && SmsRoleRuntime.isDefault(context)) updateStatus(context,id,
            if (succeeded) Telephony.Mms.MESSAGE_BOX_SENT else Telephony.Mms.MESSAGE_BOX_FAILED)
        if (id >= 0 && SmsRoleRuntime.isDefault(context)) runCatching {
            NotificationAccount.current(context)?.let { session ->
                SmsBusinessCapture(context).captureMms(id,session)
            }
        }
        MmsTransferProvider.file(context,key).delete()
    }

    private fun updateStatus(context: Context, id: Long, box: Int) {
        context.contentResolver.update(ContentUris.withAppendedId(Telephony.Mms.CONTENT_URI,id),
            ContentValues().apply { put(Telephony.Mms.MESSAGE_BOX,box) },null,null)
    }

    data class InboxResult(val messages: List<LocalMms>, val unread: Int, val awaitingDownload: Int)

    fun recentMessages(context: Context, limit: Int): InboxResult {
        check(SmsRoleRuntime.canRead(context)) { "SMS_PERMISSION_REQUIRED" }
        val boundedLimit = limit.coerceIn(1,200)
        val result = mutableListOf<LocalMms>()
        var inspected = 0
        var unread = 0
        var awaitingDownload = 0
        requireNotNull(context.contentResolver.query(Telephony.Mms.CONTENT_URI,
            arrayOf(Telephony.Mms._ID,Telephony.Mms.MESSAGE_BOX,Telephony.Mms.DATE,Telephony.Mms.MESSAGE_TYPE),
            "${Telephony.Mms.MESSAGE_TYPE} IN (128,130,132)",null,"${Telephony.Mms.DATE} DESC")) {
            "MMS_PROVIDER_UNAVAILABLE"
        }.use { cursor ->
            while (inspected < boundedLimit && cursor.moveToNext()) {
                inspected++
                when (mmsInboxKind(cursor.getInt(3))) {
                    MmsInboxKind.AWAITING_DOWNLOAD -> { awaitingDownload++; continue }
                    MmsInboxKind.REPORT -> continue
                    MmsInboxKind.CONTENT -> Unit
                }
                val id = cursor.getLong(0)
                try {
                    val pdu = readMmsPdu { PduPersister.getPduPersister(context).load(
                        ContentUris.withAppendedId(Telephony.Mms.CONTENT_URI,id)) }
                    if (pdu !is RetrieveConf && pdu !is SendReq) { unread++; continue }
                    val address = when (pdu) {
                        is RetrieveConf -> pdu.from?.string.orEmpty()
                        is SendReq -> pdu.to?.firstOrNull()?.string.orEmpty()
                        else -> ""
                    }
                    val parts = when (pdu) {
                        is RetrieveConf -> pdu.body
                        is SendReq -> pdu.body
                        else -> null
                    }
                    val text = StringBuilder()
                    val attachments = mutableListOf<Attachment>()
                    for (index in 0 until (parts?.partsNum ?: 0)) {
                        val part = requireNotNull(parts).getPart(index)
                        val type = part.contentType?.toString(Charsets.ISO_8859_1).orEmpty()
                        if (type == "text/plain") text.append(part.data?.toString(Charsets.UTF_8).orEmpty())
                        else if (type != "application/smil")
                            attachments.add(Attachment(type,part.dataUri))
                    }
                    result.add(LocalMms(id,address,text.toString(),attachments,cursor.getInt(1),
                        cursor.getLong(2) * 1000))
                } catch (_: Exception) { unread++ }
            }
        }
        context.getSharedPreferences("sms_role_health",Context.MODE_PRIVATE).edit()
            .putInt("mms_recent_unread",unread).putInt("mms_awaiting_download",awaitingDownload).apply()
        return InboxResult(result,unread,awaitingDownload)
    }

    private fun showStatus(context: Context, message: String, id: Long = 0L) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("mms_messages","MMS",
            NotificationManager.IMPORTANCE_DEFAULT))
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(
                android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val intent = PendingIntent.getActivity(context,0,
            Intent(context,SmsRoleActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        manager.notify((id.takeIf { it > 0 } ?: System.currentTimeMillis()).toInt(),
            Notification.Builder(context,"mms_messages")
                .setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("시공노트 문자")
                .setContentText(message).setContentIntent(intent).setAutoCancel(true).build())
    }
}

class MmsTransferResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val key = intent.getStringExtra("key") ?: return
        if (!Regex("[a-f0-9]{64}").matches(key)) return
        val pending = goAsync()
        (context.applicationContext as SigongnoteApp).notificationExecutor.execute {
            try {
                when (intent.getStringExtra("direction")) {
                    "download" -> MmsRoleRuntime.finishDownload(context,key,
                        intent.getIntExtra("subscription_id",-1),resultCode == Activity.RESULT_OK)
                    "send" -> MmsRoleRuntime.finishSend(context,key,
                        intent.getLongExtra("message_id",-1),resultCode == Activity.RESULT_OK)
                    "control" -> {
                        val parent = intent.getStringExtra("parent_key") ?: return@execute
                        if (!Regex("[a-f0-9]{64}").matches(parent)) return@execute
                        MmsRoleRuntime.finishControl(context,key,parent,
                            intent.getIntExtra("status",-1),resultCode == Activity.RESULT_OK)
                    }
                }
            } catch (_: Exception) { /* Preserve local pending record for manual recovery. */ }
            finally { pending.finish() }
        }
    }
}
