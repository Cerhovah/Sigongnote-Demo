package com.sigongnote.app

import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test

class IdentityLinkTest {
    private val config=CloudAccountConfig("https://api.example.test","https://auth.example.test","public",setOf("google","custom:naver","custom:kakao"))
    private val before=UploadSession(config.api,config.auth,config.auth,"public","old-access","old-refresh",System.currentTimeMillis()+3_600_000,
        "11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333","44444444-4444-4444-8444-444444444444",1,1)
    private fun response(request:Request,body:String,status:Int=200)=Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("fixture").body(body.toResponseBody()).build()
    private val companies get()="""{"user_id":"${before.userId}","memberships":[{"tenant_id":"${before.tenantId}","tenant_name":"fixture","role":"owner"}]}"""
    @Test fun authenticatedLinkUsesFixedEndpointAndKeepsPkce() {
        for((provider,host) in listOf("custom:naver" to "nid.naver.com","custom:kakao" to "kauth.kakao.com","google" to "accounts.google.com")) {
            val client=OkHttpClient.Builder().addInterceptor {chain->
                val request=chain.request();assertEquals("/auth/v1/user/identities/authorize",request.url.encodedPath)
                assertEquals("Bearer old-access",request.header("Authorization"));assertEquals(provider,request.url.queryParameter("provider"));assertEquals("s256",request.url.queryParameter("code_challenge_method"))
                response(request,"""{"url":"https://$host/authorize?fixture=1"}""")
            }.build()
            val target=IdentityLinkTarget.from(before);assertEquals(target,IdentityLinkTarget.decode(target.encode()))
            val flow=GoogleLoginFlow.create(provider=provider).copy(linkTarget=target)
            assertEquals("https://$host/authorize?fixture=1",CloudAccount(config,client).identityAuthorization(before,flow,"com.sigongnote.app.auth://callback"))
        }
    }
    @Test fun differentUserAndUntrustedProviderRedirectAreRejected() {
        for(url in listOf("https://nid.naver.com.evil.test/","http://nid.naver.com/","https://user@nid.naver.com/","https://nid.naver.com/#secret"))assertThrows(IllegalArgumentException::class.java) {identityProviderUrl("custom:naver",url)}
        val client=OkHttpClient.Builder().addInterceptor {chain->response(chain.request(),"""{"expires_in":3600,"user":{"id":"55555555-5555-4555-8555-555555555555"},"access_token":"new","refresh_token":"refresh"}""")}.build()
        assertThrows(IllegalArgumentException::class.java) {CloudAccount(config,client).exchange("code",GoogleLoginFlow.create().copy(linkTarget=IdentityLinkTarget.from(before)))}
    }
    private class Store(var raw:String?):UploadCredentialStore {
        override fun read()=raw
        override fun store(value:String) {raw=value}
        override fun clear() {raw=null}
        override fun clearSession() {raw=null}
    }
    @Test fun successPreservesSourcesAndDeviceWithoutEnrollment() {
        val store=Store(before.encode());var calls=0
        val client=OkHttpClient.Builder().addInterceptor {chain->calls++;assertEquals("/v1/me",chain.request().url.encodedPath);assertEquals("Bearer new",chain.request().header("Authorization"));response(chain.request(),companies)}.build()
        val result=UploadSessionManager(store,false,client).applyLinkedLogin(IdentityLinkTarget.from(before),AccountLogin("new","refresh",before.userId,before.expiresAtEpochMs))
        assertEquals(before.copy(accessToken="new",refreshToken="refresh"),result);assertEquals(1,calls)
    }
    @Test fun rejectedReplacementNeverRefreshesOldTokenOrErasesOldSession() {
        val store=Store(before.encode());var calls=0
        val client=OkHttpClient.Builder().addInterceptor {chain->calls++;response(chain.request(),"{}",401)}.build()
        assertThrows(IllegalStateException::class.java) {UploadSessionManager(store,false,client).applyLinkedLogin(IdentityLinkTarget.from(before),AccountLogin("new","refresh",before.userId,before.expiresAtEpochMs))}
        assertEquals(before.encode(),store.raw);assertEquals(1,calls)
    }
    @Test fun logoutDuringValidationCannotBeResurrected() {
        val store=Store(before.encode())
        val client=OkHttpClient.Builder().addInterceptor {chain->store.clear();response(chain.request(),companies)}.build()
        assertThrows(UploadSessionManager.LoginRequired::class.java) {UploadSessionManager(store,false,client).applyLinkedLogin(IdentityLinkTarget.from(before),AccountLogin("new","refresh",before.userId,before.expiresAtEpochMs))}
        assertNull(store.raw)
    }
    @Test fun changedCompanyOrLoginGenerationStopsBeforeNetwork() {
        val store=Store(before.copy(connectedAtEpochMs=2).encode())
        val client=OkHttpClient.Builder().addInterceptor {error("network should not be called")}.build()
        assertThrows(UploadSessionManager.LoginRequired::class.java) {UploadSessionManager(store,false,client).applyLinkedLogin(IdentityLinkTarget.from(before),AccountLogin("new","refresh",before.userId,before.expiresAtEpochMs))}
    }
}
