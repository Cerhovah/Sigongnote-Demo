package com.sigongnote.app

import java.net.URI
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

interface UploadCredentialStore {
    fun store(value: String)
    fun read(): String?
    fun clear()
    fun clearSession()
    fun replaceIfUnchanged(expected:String,replacement:String):Boolean=synchronized(this) {if(read()!=expected)false else {store(replacement);true}}
}

/** Refresh rotation is serialized across foreground and worker callers. */
class UploadSessionManager(private val vault: UploadCredentialStore,
    private val allowLocalCleartext: Boolean,
    private val client: OkHttpClient = OkHttpClient.Builder().followRedirects(false)
        .connectTimeout(20,TimeUnit.SECONDS).readTimeout(30,TimeUnit.SECONDS).build()) {
    class LoginRequired : Exception()
    class Retryable : Exception()
    companion object { private val refreshLock = Any() }

    fun current(): UploadSession = synchronized(refreshLock) {
        val session = vault.read()?.let { UploadSession.decode(it,allowLocalCleartext) }
            ?: throw LoginRequired()
        if (session.expiresAtEpochMs - System.currentTimeMillis() > 5 * 60_000) session
        else refresh(session)
    }

    fun forceRefresh(previousAccessToken: String): UploadSession = synchronized(refreshLock) {
        val session = vault.read()?.let { UploadSession.decode(it,allowLocalCleartext) }
            ?: throw LoginRequired()
        if (session.accessToken != previousAccessToken) session else refresh(session)
    }

    fun applyLinkedLogin(target:IdentityLinkTarget,login:AccountLogin):UploadSession {
        val raw=vault.read() ?: throw LoginRequired()
        val before=UploadSession.decode(raw,allowLocalCleartext)
        if(!target.matches(before) || login.user!=before.userId || login.expires<=System.currentTimeMillis())throw LoginRequired()
        // CloudAccount validates the replacement token directly; no refresh to the old session.
        val companies=CloudAccount(CloudAccountConfig(before.apiBaseUrl,before.supabaseOrigin,before.publishableKey),client).companies(login)
        if(companies.none {it.id==before.tenantId})throw LoginRequired()
        val next=before.copy(accessToken=login.access,refreshToken=login.refresh,expiresAtEpochMs=login.expires).validate(allowLocalCleartext)
        synchronized(refreshLock) {if(!vault.replaceIfUnchanged(raw,next.encode()))throw LoginRequired()}
        return next
    }

    private fun refresh(before: UploadSession): UploadSession {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
        var attempts = 0
        while (true) {
            attempts++
            try { return refreshOnce(before) }
            catch (_: IOException) { /* The server may have rotated the token already. */ }
            catch (_: Retryable) { /* Retry inside the refresh-token reuse window. */ }
            if (attempts >= 3 || System.nanoTime() + TimeUnit.SECONDS.toNanos(2) >= deadline)
                throw Retryable()
            Thread.sleep(1_000)
        }
    }

    private fun refreshOnce(before: UploadSession): UploadSession {
        val origin = URI(before.supabaseOrigin.trimEnd('/') + "/")
        val request = Request.Builder()
            .url(origin.resolve("auth/v1/token?grant_type=refresh_token").toURL())
            .post(buildJsonObject { put("refresh_token",before.refreshToken) }.toString()
                .toRequestBody("application/json".toMediaType()))
            .header("apikey",before.publishableKey).build()
        val call = client.newCall(request)
        call.timeout().timeout(3,TimeUnit.SECONDS)
        val result = call.execute().use { response ->
            if (response.code in setOf(400,401,403)) {
                vault.clearSession()
                throw LoginRequired()
            }
            if (response.code != 200) throw Retryable()
            try {
                val json = Json.parseToJsonElement(response.body?.string() ?: "").jsonObject
                fun value(name: String) = json.getValue(name).jsonPrimitive.content
                val userId = json.getValue("user").jsonObject.getValue("id").jsonPrimitive.content
                if (userId != before.userId) {
                    vault.clearSession()
                    throw LoginRequired()
                }
                val seconds = value("expires_in").toLong()
                if (seconds !in 60..86_400) throw Retryable()
                before.copy(accessToken = value("access_token"),
                    refreshToken = value("refresh_token"),
                    expiresAtEpochMs = System.currentTimeMillis() + seconds * 1_000)
                    .validate(allowLocalCleartext)
            } catch (error: LoginRequired) { throw error }
              catch (_: Exception) { throw Retryable() }
        }
        val latest = vault.read()?.let { UploadSession.decode(it,allowLocalCleartext) }
            ?: throw LoginRequired()
        if (latest.tenantId != before.tenantId || latest.userId != before.userId ||
            latest.deviceId != before.deviceId) {
            throw LoginRequired()
        }
        if (latest.refreshToken != before.refreshToken) return latest
        vault.store(result.encode())
        return result
    }
}
