package com.sigongnote.app

import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

data class BridgeCommand(val requestId: String, val method: String, val argument: String? = null)

object BridgePolicy {
    const val trustedOrigin = "https://appassets.androidplatform.net"
    private val noArgument = setOf("openPhotoCapture", "startVoiceInput", "getConnectionState", "getQueueSummary", "logout",
        "reviewNotificationScopes", "manageNotificationSources", "openSmsInbox", "openAccount")
    private val idArguments = mapOf(
        "cancelVoiceInput" to "voice_request_id",
        "pauseSource" to "source_id",
        "openEvidence" to "revision_id",
        "enqueueShare" to "share_token",
    )
    private val sourceKinds = setOf("folder", "photos", "notifications", "sms", "call_recording")

    fun decode(sourceOrigin: String, isMainFrame: Boolean, raw: String): BridgeCommand? {
        if (sourceOrigin != trustedOrigin || !isMainFrame || raw.toByteArray().size > 1_100_000) return null
        return try {
            val root = Json.parseToJsonElement(raw) as? JsonObject ?: return null
            if (root.keys != setOf("bridgeVersion", "requestId", "method", "payload")) return null
            val version = root["bridgeVersion"]?.jsonPrimitive ?: return null
            if (version.isString || version.intOrNull != 1) return null
            val requestId = root["requestId"]?.jsonPrimitive?.content ?: return null
            if (!canonicalUuid(requestId)) return null
            val method = root["method"]?.jsonPrimitive?.content ?: return null
            val payload = root["payload"] as? JsonObject ?: return null
            val workRoute=payload["route"]?.jsonPrimitive?.content
            // Complete: (64k lines + 16k quantities + <2.2k form/recipient) * 6 JSON escape bytes + envelope <500k.
            // Context command: 16k characters * 6 escape bytes + envelope <100k. Typed route limits still apply.
            val largeWork=(workRoute=="photos.command"&&raw.toByteArray().size<=64_000)||workRoute=="voice.transcribe"||(workRoute=="activity.append"&&raw.toByteArray().size<=500_000)||(workRoute=="documents.complete"&&raw.toByteArray().size<=500_000)||(workRoute=="context-learning.command"&&raw.toByteArray().size<=100_000)
            if(raw.toByteArray().size>16_384 && (method!="workRequest" || !largeWork))return null
            when {
                method == "workRequest" && WorkRoutes.decode(payload)!=null && (raw.toByteArray().size<=16_384 || largeWork) -> BridgeCommand(requestId,method,payload.toString())
                method in noArgument && payload.isEmpty() -> BridgeCommand(requestId, method)
                method == "connectSource" && payload.keys == setOf("kind") -> {
                    val kind = payload["kind"]?.jsonPrimitive?.content ?: return null
                    if (kind !in sourceKinds) null else BridgeCommand(requestId, method, kind)
                }
                method in idArguments && payload.keys == setOf(idArguments[method]) -> {
                    val id = payload[idArguments[method]]?.jsonPrimitive?.content ?: return null
                    if (!canonicalUuid(id)) null else BridgeCommand(requestId, method, id)
                }
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun canonicalUuid(value: String): Boolean = try {
        UUID.fromString(value).toString() == value
    } catch (_: IllegalArgumentException) {
        false
    }
}
