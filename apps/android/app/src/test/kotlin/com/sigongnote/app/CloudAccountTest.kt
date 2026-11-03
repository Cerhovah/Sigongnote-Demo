package com.sigongnote.app

import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test

class CloudAccountTest {
    private val tenant="10000000-0000-4000-8000-000000000001"
    private val user="10000000-0000-4000-8000-000000000002"
    private val device="10000000-0000-4000-8000-000000000003"
    private val source="10000000-0000-4000-8000-000000000004"
    private val config=CloudAccountConfig("https://api.example.test","https://auth.example.test","public")
    private val login=AccountLogin("access","refresh",user,System.currentTimeMillis()+3_600_000)
    private val jwk=mapOf("kty" to "EC","crv" to "P-256","x" to "a","y" to "b")
    @Test fun RejectsBothSecretKeyFormats() {
        fun key(role: String)="eyJhbGciOiJIUzI1NiJ9."+java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString("""{"role":"$role"}""".toByteArray())+".fixture"
        for(value in listOf("sb_secret_fixture",key("service_role"),key("authenticated"),"eyBroken"))
            assertThrows(IllegalArgumentException::class.java) {config.copy(publicKey=value).validate()}
        config.copy(publicKey=key("anon")).validate()
    }
    @Test fun RequiresConsentMembershipAndActiveDevice() {
        var count=0
        val api=CloudAccount(config,OkHttpClient.Builder().addInterceptor {chain->
            count++
            val request=chain.request()
            assertEquals("Bearer access",request.header("Authorization"))
            val body=when {
                request.url.encodedPath=="/v1/me" -> """{"user_id":"$user","memberships":[{"tenant_id":"$tenant","tenant_name":"Fixture","role":"owner"}]}"""
                request.url.encodedPath.startsWith("/v1/devices/by-key/") -> """{"id":"$device","tenant_id":"$tenant","platform":"android","active":false}"""
                else->throw AssertionError("Unexpected request")
            }
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(body.toResponseBody()).build()
        }.build())
        assertThrows(IllegalArgumentException::class.java) {api.enroll(login,tenant,jwk,{user},false)}
        assertEquals(0,count)
        assertThrows(IllegalArgumentException::class.java) {api.enroll(login,tenant,jwk,{user},true)}
        assertEquals(2,count)
    }
    @Test fun ExistingDeviceAndSourceRestoreWithoutDuplicateRegistration() {
        var writes=0
        val api=CloudAccount(config,OkHttpClient.Builder().addInterceptor {chain->
            val request=chain.request();if(request.method!="GET")writes++
            val body=when {
                request.url.encodedPath=="/v1/me" -> """{"user_id":"$user","memberships":[{"tenant_id":"$tenant","tenant_name":"Fixture","role":"owner"}]}"""
                // Same ordered compact JWK JSON + SHA-256 as the API and Windows.
                request.url.encodedPath=="/v1/devices/by-key/b4e5f88c56684e7290ed0d25b8d4978670e6b349b7283cfb0138d2eaa5754bda" -> """{"id":"$device","tenant_id":"$tenant","platform":"android","active":true}"""
                request.url.encodedPath=="/v1/capture-sources" -> """{"sources":[{"id":"$source","device_id":"$device","tenant_id":"$tenant","kind":"manual_share","active":true,"upload_ready":true,"generation":1}]}"""
                else->throw AssertionError("Unexpected request")
            }
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(body.toResponseBody()).build()
        }.build())
        val session=api.enroll(login,tenant,jwk,{user},true)
        assertEquals(source,session.manualSourceId);assertEquals(device,session.deviceId);assertEquals(0,writes)
        assertThrows(IllegalArgumentException::class.java) {CloudAccountConfig("http://api.example.test",config.auth,"public").validate()}
    }
}
