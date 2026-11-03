package com.sigongnote.app

import com.sigongnote.contracts.IngestionPrepareResponse
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Durable idempotency keys are sealed before a prepare request can leave the device. */
data class UploadAttempt(
    val prepareKey: String,
    val completeKey: String,
    val receipt: IngestionPrepareResponse? = null,
    val location: String? = null,
) {
    fun encode(): String = buildJsonObject {
        put("prepareKey",prepareKey)
        put("completeKey",completeKey)
        if (receipt != null) put("receipt",Json.encodeToString(receipt))
        if (location != null) put("location",location)
    }.toString()

    companion object {
        fun fresh() = UploadAttempt(UUID.randomUUID().toString(),UUID.randomUUID().toString())
        fun decode(raw: String): UploadAttempt {
            val json = Json.parseToJsonElement(raw).jsonObject
            fun field(name: String) = json[name]?.jsonPrimitive?.content
            val prepare = requireNotNull(field("prepareKey"))
            val complete = requireNotNull(field("completeKey"))
            require(UUID.fromString(prepare).toString() == prepare &&
                UUID.fromString(complete).toString() == complete)
            val receipt = field("receipt")?.let {
                Json { ignoreUnknownKeys = true }.decodeFromString<IngestionPrepareResponse>(it)
            }
            return UploadAttempt(prepare,complete,receipt,field("location"))
        }
    }
}
