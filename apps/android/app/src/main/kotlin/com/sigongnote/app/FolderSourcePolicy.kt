package com.sigongnote.app

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.put

/** Source kind and first-use choices follow a file through copying and upload. */
object FolderSourcePolicy {
    val kinds = setOf("folder","photos","call_recording")
    fun isFolderKind(kind: String?) = kind in kinds

    fun allows(source: FolderSource, entry: FolderEntry): Boolean {
        if (source.historyMode == "legacy_recent" && source.processingPolicyId == null) return true
        if (source.scopeMode != "work_dedicated") return false
        if (source.historyMode == "since" && (entry.modifiedAtEpochMs == null ||
                entry.modifiedAtEpochMs < (source.historySinceEpochMs ?: Long.MAX_VALUE))) return false
        val audio = entry.mime.startsWith("audio/") ||
            entry.displayName.substringAfterLast('.',"").lowercase() in
                setOf("m4a","wav","mp3","aac","ogg","flac","amr")
        return when (source.kind) {
            "photos" -> entry.mime in setOf("image/jpeg","image/png","image/webp","image/heic","image/heif")
            "call_recording" -> audio
            "folder" -> !audio
            else -> false
        }
    }

    fun mediaMime(source: FolderSource, entry: FolderEntry): String {
        if(source.kind != "call_recording") return entry.mime
        return when(entry.displayName.substringAfterLast('.',"").lowercase()) {
            "m4a" -> "audio/mp4"; "wav" -> "audio/wav"; "mp3" -> "audio/mpeg"
            "aac" -> "audio/aac"; "ogg" -> "audio/ogg"; "flac" -> "audio/flac"
            "amr" -> "audio/amr"; else -> entry.mime
        }
    }

    fun scope(source: FolderSource) = buildJsonObject {
        put("capture_method","saf_tree")
        put("history_mode",source.historyMode)
        put("history_since",source.historySinceEpochMs?.let { kotlinx.serialization.json.JsonPrimitive(
            Instant.ofEpochMilli(it).toString()) } ?: JsonNull)
        put("scope_mode",source.scopeMode)
        put("rule_version",1)
        put("processing_policy_id",requireNotNull(source.processingPolicyId))
        put("fingerprint_algorithm","hmac-sha256-device-v1")
    }

    fun requestKey(localId: String, operation: String): String = UUID.nameUUIDFromBytes(
        "sigongnote-folder-v2:$localId:$operation".toByteArray(Charsets.UTF_8)).toString()
}
