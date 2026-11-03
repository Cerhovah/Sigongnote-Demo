package com.sigongnote.app

import java.net.URI
import kotlinx.serialization.json.*

/** Identity-only snapshot; no credentials or file paths are persisted in this record. */
data class IdentityLinkTarget(val api:String,val auth:String,val user:String,val tenant:String,val device:String,val connected:Long) {
    fun matches(session:UploadSession)=api==session.apiBaseUrl && auth==session.supabaseOrigin && user==session.userId && tenant==session.tenantId && device==session.deviceId && connected==session.connectedAtEpochMs
    fun encode()=buildJsonObject {put("api",api);put("auth",auth);put("user",user);put("tenant",tenant);put("device",device);put("connected",connected)}.toString()
    companion object {
        fun from(session:UploadSession)=IdentityLinkTarget(session.apiBaseUrl,session.supabaseOrigin,session.userId,session.tenantId,session.deviceId,session.connectedAtEpochMs)
        fun decode(raw:String):IdentityLinkTarget {val j=Json.parseToJsonElement(raw).jsonObject;fun f(k:String)=j.getValue(k).jsonPrimitive.content
            return IdentityLinkTarget(f("api"),f("auth"),f("user"),f("tenant"),f("device"),f("connected").toLong())}
    }
}
internal fun identityProviderUrl(provider:String,raw:String):String {
    require(raw.length in 1..8192)
    val uri=URI(raw)
    val host=when(provider) {"custom:naver"->"nid.naver.com";"custom:kakao"->"kauth.kakao.com";"google"->"accounts.google.com";else->error("UNKNOWN_PROVIDER")}
    require(uri.scheme=="https" && uri.host==host && uri.port in setOf(-1,443) && uri.userInfo==null && uri.fragment==null)
    return raw
}
