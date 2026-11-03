package com.sigongnote.app

import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

data class CloudAccountConfig(val api: String,val auth: String,val publicKey: String,val providers: Set<String> = setOf("google")) {
    /** Public capability discovery, with no account token or redirected destination. */
    fun discoverProviders(): CloudAccountConfig {
        val client=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(8,TimeUnit.SECONDS).build()
        client.newCall(Request.Builder().url(api.trimEnd('/')+"/connection.json").build()).execute().use {response ->
            check(response.isSuccessful)
            val source=response.body!!.source();source.request(64*1024L+1)
            check(source.buffer.size<=64*1024L)
            val bytes=source.readByteArray()
            val value=Json.parseToJsonElement(String(bytes,Charsets.UTF_8)).jsonObject
            check(value["mode"]?.jsonPrimitive?.content=="cloud" && value["apiOrigin"]?.jsonPrimitive?.content==api.trimEnd('/'))
            val enabled=value.getValue("providers").jsonArray.map {it.jsonPrimitive.content}.toSet()
            return copy(providers=enabled).validate()
        }
    }
    fun validate(): CloudAccountConfig {
        GoogleLoginFlow.requireHttpsOrigin(api);GoogleLoginFlow.requireHttpsOrigin(auth)
        require(publicKey.isNotBlank() && publicKey.length<=4096 && publicKey.none {it.isISOControl()})
        require(!publicKey.startsWith("sb_secret_"))
        if(publicKey.startsWith("ey") || publicKey.contains('.')) {
            val parts=publicKey.split('.');require(parts.size==3)
            val payload=Json.parseToJsonElement(String(java.util.Base64.getUrlDecoder().decode(parts[1]),Charsets.UTF_8)).jsonObject
            require(payload["role"]?.jsonPrimitive?.content=="anon") {"Only a public client key is allowed"}
        }
        require(providers.all {it in setOf("google","custom:naver","custom:kakao")})
        return this
    }
    companion object {
        fun installed(): CloudAccountConfig? = runCatching {
            CloudAccountConfig(BuildConfig.CLOUD_API_ORIGIN,BuildConfig.CLOUD_AUTH_ORIGIN,
                BuildConfig.CLOUD_PUBLISHABLE_KEY,BuildConfig.CLOUD_LOGIN_PROVIDERS.split(',').map {it.trim()}.filter {it.isNotEmpty()}.toSet()).validate()
        }.getOrNull()
    }
}

data class AccountLogin(val access: String,val refresh: String,val user: String,val expires: Long) {
    fun encode()=buildJsonObject {put("access",access);put("refresh",refresh);put("user",user);put("expires",expires)}.toString()
    companion object {
        fun decode(raw: String): AccountLogin {
            val j=Json.parseToJsonElement(raw).jsonObject
            return AccountLogin(j.text("access"),j.text("refresh"),j.text("user"),j.text("expires").toLong())
        }
    }
}
data class AccountCompany(val id: String,val name: String)
private fun JsonObject.text(name: String)=getValue(name).jsonPrimitive.content
private fun sha(value: String)=MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") {"%02x".format(it)}

/** The API checks membership and the device; Google profile fields grant no company access. */
class CloudAccount(private val config: CloudAccountConfig,
    private val http: OkHttpClient=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(25,TimeUnit.SECONDS).build()) {
    init {config.validate()}
    private fun call(path: String,body: JsonObject?=null,login: AccountLogin?=null,
        tenant: String?=null,key: String?=null,allowMissing: Boolean=false): JsonObject? {
        val origin=if(path.startsWith("/auth/"))config.auth else config.api
        val request=Request.Builder().url(origin.trimEnd('/')+path)
        if(path.startsWith("/auth/"))request.header("apikey",config.publicKey)
        login?.let {require(it.expires>System.currentTimeMillis());request.header("Authorization","Bearer ${it.access}")}
        tenant?.let {require(UUID.fromString(it).toString()==it);request.header("X-Tenant-Id",it)}
        key?.let {request.header("Idempotency-Key",it)}
        body?.let {request.post(it.toString().toRequestBody("application/json".toMediaType()))}
        return http.newCall(request.build()).execute().use {
            if(it.code==404 && allowMissing)return@use null
            check(it.isSuccessful) {"ACCOUNT_REQUEST_FAILED"}
            val raw=it.body?.string().orEmpty();require(raw.length<=1_000_000)
            Json.parseToJsonElement(raw).jsonObject
        }
    }
    fun identityAuthorization(session:UploadSession,flow:GoogleLoginFlow,callback:String):String {
        require(flow.provider in config.providers && flow.linkTarget?.matches(session)==true)
        require(config.api==session.apiBaseUrl && config.auth==session.supabaseOrigin)
        val query=java.net.URI(flow.authorize(config.auth,callback)).rawQuery
        val login=AccountLogin(session.accessToken,session.refreshToken,session.userId,session.expiresAtEpochMs)
        val body=call("/auth/v1/user/identities/authorize?$query&skip_http_redirect=true",login=login)!!
        return identityProviderUrl(flow.provider,body.text("url"))
    }
    fun exchange(code: String,flow: GoogleLoginFlow): AccountLogin {
        val body=call("/auth/v1/token?grant_type=pkce",buildJsonObject {
            put("auth_code",code);put("code_verifier",flow.verifier)
        })!!
        val seconds=body.text("expires_in").toLong();require(seconds in 60..86400)
        val user=body.getValue("user").jsonObject.text("id");require(UUID.fromString(user).toString()==user)
        require(flow.linkTarget==null || user==flow.linkTarget.user) {"LINK_ACCOUNT_MISMATCH"}
        val access=body.text("access_token");val refresh=body.text("refresh_token")
        require(listOf(access,refresh).all {it.isNotBlank() && it.none(Char::isISOControl)})
        return AccountLogin(access,refresh,user,System.currentTimeMillis()+seconds*1000)
    }
    fun companies(login: AccountLogin): List<AccountCompany> {
        val me=call("/v1/me",login=login)!!;require(me.text("user_id")==login.user)
        return me.getValue("memberships").jsonArray.map {it.jsonObject}
            .filter {it.text("role") in setOf("owner","operator")}
            .map {AccountCompany(it.text("tenant_id"),it.text("tenant_name"))}
    }
    fun enroll(login: AccountLogin,tenant: String,jwk: Map<String,String>,
        stableKey: (String)->String,allowSharedUpload: Boolean): UploadSession {
        require(allowSharedUpload) {"CONSENT_REQUIRED"}
        require(companies(login).any {it.id==tenant})
        val publicKey=buildJsonObject {for(k in listOf("kty","crv","x","y"))put(k,jwk.getValue(k))}
        val fingerprint=sha(publicKey.toString())
        val device=call("/v1/devices/by-key/$fingerprint",login=login,tenant=tenant,allowMissing=true)
            ?: call("/v1/devices",buildJsonObject {
                put("platform","android");put("app_version","0.1.0");put("public_key_jwk",publicKey)
            },login,tenant,stableKey("$tenant:${login.user}:device:$fingerprint"))!!
        require(device.text("tenant_id")==tenant && device.text("platform")=="android" && device.text("active")=="true")
        val deviceId=device.text("id")
        val sources=call("/v1/capture-sources",login=login,tenant=tenant)!!.getValue("sources").jsonArray
            .map {it.jsonObject}.filter {it.text("device_id")==deviceId && it.text("kind")=="manual_share"}
        // Do not silently override a revoked source or broaden a prior refusal.
        val source=sources.firstOrNull {it.text("active")=="true" && it.text("upload_ready")=="true"}
            ?: if(sources.isNotEmpty()) error("SOURCE_REVIEW_REQUIRED") else call("/v1/capture-sources",buildJsonObject {
                put("device_id",deviceId);put("kind","manual_share")
                put("scope_fingerprint",sha("manual-share-v1:$deviceId"));put("consent_version",1)
                put("local_selection_consent",true);put("server_upload_consent",true);put("external_ai_consent",false)
            },login,tenant,stableKey("$tenant:${login.user}:manual:$deviceId"))!!
        require(source.text("tenant_id")==tenant && source.text("device_id")==deviceId && source.text("upload_ready")=="true")
        return UploadSession(config.api,config.auth,config.auth,config.publicKey,login.access,login.refresh,
            login.expires,tenant,login.user,deviceId,source.text("id"),source.text("generation").toInt(),System.currentTimeMillis()).validate(false)
    }
}
