package com.sigongnote.app

import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Base64
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class NotificationEnvelope(
    val packageName: String,
    val key: String,
    val shortcutId: String?,
    val title: String?,
    val body: String?,
    val postedAtEpochMs: Long,
    val groupSummary: Boolean,
)

object NotificationCapturePolicy {
    private val sensitiveTerms = Regex("(?i)(인증번호|인증코드|일회용|otp|verification code|보안코드|주민등록번호|계좌비밀번호)")
    private val residentNumber = Regex("\\b\\d{6}[- ]?[1-8]\\d{6}\\b")
    private val excludedPackages = listOf("com.kbstar.","com.shinhan.","com.wooribank.",
        "com.nhbank.","nh.smart.","com.toss.","viva.republica.toss","com.kakaobank.channel",
        "com.kakaopay", "com.samsung.android.spay", "com.samsung.android.shealth",
        "com.google.android.apps.fitness", "com.google.android.apps.authenticator")
    const val candidateLifetimeMs = 24L * 60 * 60 * 1000

    private val smsPackages = setOf("com.samsung.android.messaging",
        "com.google.android.apps.messaging", "com.android.mms", "com.android.messaging")

    fun packageSelectable(packageName: String, defaultSmsPackage: String? = null): Boolean =
        packageName !in smsPackages && packageName != defaultSmsPackage &&
            excludedPackages.none(packageName::startsWith)

    fun accept(event: NotificationEnvelope, defaultSmsPackage: String? = null): Boolean {
        if (event.groupSummary || !packageSelectable(event.packageName,defaultSmsPackage)) return false
        val text = listOfNotNull(event.title,event.body).joinToString("\n")
        return text.toByteArray(Charsets.UTF_8).size <= 65_536 &&
            !sensitiveTerms.containsMatchIn(text) && !residentNumber.containsMatchIn(text)
    }
}

/** Raw title/body and OS keys never enter Room or logs. */
class NotificationVault {
    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val encAlias = "sigongnote.notification.enc.v1"
    private val macAlias = "sigongnote.notification.mac.v1"

    private fun encKey(): SecretKey = (store.getKey(encAlias,null) as? SecretKey) ?: run {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(encAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build())
        generator.generateKey()
    }

    private fun macKey(): SecretKey = (store.getKey(macAlias,null) as? SecretKey) ?: run {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256,"AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(macAlias,KeyProperties.PURPOSE_SIGN)
            .setDigests(KeyProperties.DIGEST_SHA256).build())
        generator.generateKey()
    }

    fun hash(value: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(macKey())
        return mac.doFinal(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    fun seal(title: String?, body: String?): String {
        val payload = buildJsonObject { put("title",title ?: ""); put("body",body ?: "") }.toString()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE,encKey())
        val data = cipher.doFinal(payload.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + data,Base64.NO_WRAP)
    }

    fun title(sealed: String?): String? {
        if (sealed == null) return null
        return Json.parseToJsonElement(open(sealed)).jsonObject["title"]?.jsonPrimitive?.content
    }

    fun open(sealed: String): String {
        val bytes = Base64.decode(sealed,Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE,encKey(),GCMParameterSpec(128,bytes.copyOfRange(0,12)))
        return String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)),Charsets.UTF_8)
    }
}

object NotificationRuntime {
    @Volatile private var listener: java.lang.ref.WeakReference<BusinessNotificationListener>? = null
    val connected: Boolean get() = listener?.get()?.let { service ->
        runCatching { service.activeNotifications != null }.getOrDefault(false)
    } == true
    fun connected(service: BusinessNotificationListener) {
        listener = java.lang.ref.WeakReference(service)
    }
    fun disconnected(service: BusinessNotificationListener) {
        if (listener?.get() === service) listener = null
    }
    @Volatile var onChange: (() -> Unit)? = null
}

object NotificationHealthTracker {
    fun connected(previous: NotificationHealth?, now: Long,
        sameProcessWasConnected: Boolean): NotificationHealth {
        if (previous == null) return NotificationHealth(1,"connected",now,null,0,null,null)
        val unobservedGap = previous.state == "connected" && !sameProcessWasConnected
        return previous.copy(state = "connected",lastConnectedAtEpochMs = now,
            gapCount = previous.gapCount + if (unobservedGap) 1 else 0,
            lastGapStartAtEpochMs = if (unobservedGap) previous.lastConnectedAtEpochMs
                else previous.lastGapStartAtEpochMs,
            lastGapEndAtEpochMs = if (previous.state == "disconnected" || unobservedGap) now
                else previous.lastGapEndAtEpochMs)
    }

    fun disconnected(previous: NotificationHealth?, now: Long): NotificationHealth {
        if (previous == null) return NotificationHealth(1,"disconnected",null,now,1,now,null)
        if (previous.state == "disconnected") return previous
        return previous.copy(state = "disconnected",lastDisconnectedAtEpochMs = now,
            gapCount = previous.gapCount + 1,lastGapStartAtEpochMs = now,
            lastGapEndAtEpochMs = null)
    }
}

class BusinessNotificationListener : NotificationListenerService() {
    @Volatile private var bound = false
    override fun onListenerConnected() {
        super.onListenerConnected()
        bound = true
        val active = try { activeNotifications?.take(100).orEmpty() } catch (_: Exception) { emptyList() }
        val app = application as SigongnoteApp
        app.notificationExecutor.execute {
            if (!bound) return@execute
            val dao = app.queue.notificationDao()
            NotificationSourceGuard.enforce(applicationContext,app.queue)
            val previous = dao.health()
            val wasConnected = NotificationRuntime.connected
            dao.putHealth(NotificationHealthTracker.connected(previous,System.currentTimeMillis(),
                wasConnected))
            NotificationRuntime.connected(this)
            Handler(Looper.getMainLooper()).post { NotificationRuntime.onChange?.invoke() }
            if (previous != null) active.forEach { capture(it,true) }
        }
    }

    override fun onListenerDisconnected() {
        bound = false
        NotificationRuntime.disconnected(this)
        val app = application as SigongnoteApp
        app.notificationExecutor.execute {
            val dao = app.queue.notificationDao()
            dao.putHealth(NotificationHealthTracker.disconnected(dao.health(),System.currentTimeMillis()))
            Handler(Looper.getMainLooper()).post { NotificationRuntime.onChange?.invoke() }
        }
        if (Build.VERSION.SDK_INT >= 27 &&
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .isNotificationListenerAccessGranted(ComponentName(this,javaClass))) {
            requestRebind(ComponentName(this,javaClass))
        }
        super.onListenerDisconnected()
    }

    override fun onDestroy() {
        bound = false
        NotificationRuntime.disconnected(this)
        NotificationRuntime.onChange?.invoke()
        super.onDestroy()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) = capture(sbn,false)

    private fun capture(sbn: StatusBarNotification, fromActiveAtReconnect: Boolean) {
        val database = (application as SigongnoteApp).queue
        (application as SigongnoteApp).notificationExecutor.execute {
            try {
                val dao = database.notificationDao()
                if (!NotificationSourceGuard.selectable(applicationContext,sbn.packageName)) {
                    NotificationSourceGuard.revokeIfBlocked(applicationContext,database,sbn.packageName)
                    return@execute
                }
                val source = dao.source(sbn.packageName) ?: return@execute
                if (source.state != "selected") return@execute
                val notification = sbn.notification ?: return@execute
                val extras = notification.extras
                val event = NotificationEnvelope(sbn.packageName,sbn.key,notification.shortcutId,
                    extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
                    (extras?.getCharSequence(Notification.EXTRA_BIG_TEXT) ?:
                        extras?.getCharSequence(Notification.EXTRA_TEXT))?.toString(),
                    sbn.postTime,notification.flags and Notification.FLAG_GROUP_SUMMARY != 0)
                if (!NotificationCapturePolicy.accept(event)) return@execute
                val now = System.currentTimeMillis()
                dao.purgeExpiredCandidates(now)
                val vault = NotificationVault()
                val keyHash = vault.hash(event.key)
                val fingerprint = vault.hash(listOf(event.title ?: "",event.body ?: "",
                    event.postedAtEpochMs.toString()).joinToString("\u0000"))
                val previous = dao.latest(event.packageName,keyHash)
                if (previous?.state != "revoked_purged" &&
                    previous?.contentFingerprint == fingerprint) return@execute
                val conversationHash = event.shortcutId?.takeIf(String::isNotBlank)?.let(vault::hash)
                val hasBody = !event.body.isNullOrBlank()
                val scope = conversationHash?.let { dao.scope(event.packageName,it) }
                val account = NotificationAccount.current(applicationContext)
                val approved = scope != null && (scope.tenantId == null ||
                    (account != null && NotificationAccount.matches(scope.tenantId,
                        scope.userId,scope.deviceId,account)))
                val state = when {
                    !hasBody -> "no_body"
                    approved -> "approved_local"
                    else -> "candidate_local"
                }
                if (dao.retainedCount() >= 2_000) return@execute
                val row = NotificationSnapshot(UUID.randomUUID().toString(),event.packageName,
                    keyHash,conversationHash,fingerprint,(previous?.updateIndex ?: 0) + 1,
                    if (hasBody) vault.seal(event.title,event.body) else null,now,
                    if (state != "approved_local") now + NotificationCapturePolicy.candidateLifetimeMs else null,
                    state,fromActiveAtReconnect,
                    if (approved) scope?.tenantId else null,
                    if (approved) scope?.userId else null,
                    if (approved) scope?.deviceId else null)
                if (dao.insertSnapshot(row) > 0) {
                    dao.recordEvent(event.packageName,now)
                    if (row.state == "approved_local" && row.tenantId != null)
                        CaptureUploadWork.enqueue(applicationContext)
                }
            } catch (_: Exception) {
                // Missing Keystore or full local storage leaves the source unconfirmed; no raw text is logged.
            }
        }
    }
}
