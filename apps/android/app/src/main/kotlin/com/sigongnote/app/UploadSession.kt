package com.sigongnote.app

import java.net.URI
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Provisioned only by native authenticated onboarding; never by the WebView bridge. */
data class UploadSession(
    val apiBaseUrl: String,
    val supabaseOrigin: String,
    val storageOrigin: String,
    val publishableKey: String,
    val accessToken: String,
    val refreshToken: String,
    val expiresAtEpochMs: Long,
    val tenantId: String,
    val userId: String,
    val deviceId: String,
    val manualSourceId: String,
    val manualGeneration: Int,
    val connectedAtEpochMs: Long,
) {
    fun validate(allowLocalCleartext: Boolean): UploadSession {
        listOf(apiBaseUrl,supabaseOrigin,storageOrigin).forEach { raw ->
            val origin = URI(raw)
            val local = allowLocalCleartext && origin.scheme == "http" &&
                origin.host in setOf("127.0.0.1","localhost")
            require(origin.scheme == "https" || local)
            require(origin.userInfo == null && origin.rawQuery == null && origin.rawFragment == null)
            require(origin.path.isNullOrEmpty() || origin.path == "/")
        }
        require(publishableKey.isNotBlank() && accessToken.isNotBlank() && refreshToken.isNotBlank())
        require(listOf(publishableKey,accessToken,refreshToken).none { it.any { c -> c == '\n' || c == '\r' } })
        listOf(tenantId,userId,deviceId,manualSourceId).forEach {
            require(UUID.fromString(it).toString() == it)
        }
        require(manualGeneration > 0 && connectedAtEpochMs > 0 && expiresAtEpochMs > 0)
        return this
    }

    fun encode(): String = buildJsonObject {
        put("apiBaseUrl",apiBaseUrl)
        put("supabaseOrigin",supabaseOrigin)
        put("storageOrigin",storageOrigin)
        put("publishableKey",publishableKey)
        put("accessToken",accessToken)
        put("refreshToken",refreshToken)
        put("expiresAtEpochMs",expiresAtEpochMs)
        put("tenantId",tenantId)
        put("userId",userId)
        put("deviceId",deviceId)
        put("manualSourceId",manualSourceId)
        put("manualGeneration",manualGeneration)
        put("connectedAtEpochMs",connectedAtEpochMs)
    }.toString()

    companion object {
        fun decode(raw: String, allowLocalCleartext: Boolean): UploadSession {
            val json = Json.parseToJsonElement(raw).jsonObject
            fun field(name: String) = json.getValue(name).jsonPrimitive.content
            return UploadSession(field("apiBaseUrl"),field("supabaseOrigin"),
                field("storageOrigin"),
                field("publishableKey"),field("accessToken"),field("refreshToken"),
                field("expiresAtEpochMs").toLong(),field("tenantId"),
                field("userId"),field("deviceId"),field("manualSourceId"),
                field("manualGeneration").toInt(),field("connectedAtEpochMs").toLong())
                .validate(allowLocalCleartext)
        }
    }
}
