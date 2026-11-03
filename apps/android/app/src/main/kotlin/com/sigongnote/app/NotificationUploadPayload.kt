package com.sigongnote.app

import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** A partial OS observation, never a complete message or an accepted financial fact. */
object NotificationUploadPayload {
    const val mime = "application/json"
    const val maxBytes = 65_536

    fun encode(snapshot: NotificationSnapshot, vault: NotificationVault): ByteArray {
        val sealed = requireNotNull(snapshot.encryptedPayload)
        val original = Json.parseToJsonElement(vault.open(sealed)).jsonObject
        val payload = buildJsonObject {
            put("kind","notification_snapshot")
            put("partial",true)
            put("package_name",snapshot.packageName)
            put("conversation_hash",requireNotNull(snapshot.conversationHash))
            put("notification_key_hash",snapshot.keyHash)
            put("content_fingerprint",snapshot.contentFingerprint)
            put("update_index",snapshot.updateIndex)
            put("observed_at_epoch_ms",snapshot.observedAtEpochMs)
            put("from_active_at_reconnect",snapshot.fromActiveAtReconnect)
            put("title",original["title"]?.jsonPrimitive?.content ?: "")
            put("body",original["body"]?.jsonPrimitive?.content ?: "")
        }.toString().toByteArray(Charsets.UTF_8)
        require(payload.isNotEmpty() && payload.size <= maxBytes) { "notification_size" }
        return payload
    }

    fun sha256(payload: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(payload).joinToString("") { "%02x".format(it) }
}
