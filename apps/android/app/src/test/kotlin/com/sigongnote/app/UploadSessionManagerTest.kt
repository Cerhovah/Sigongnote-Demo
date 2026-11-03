package com.sigongnote.app

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test

class UploadSessionManagerTest {
    @Test fun lostRefreshResponseRetriesInsideReuseWindow() {
        val server = MockWebServer()
        server.start()
        try {
            val user = "22222222-2222-4222-8222-222222222222"
            val old = UploadSession(server.url("/").toString(),server.url("/").toString(),
                server.url("/").toString(),
                "fixture-publishable","old-access","old-refresh",1,
                "11111111-1111-4111-8111-111111111111",user,
                "33333333-3333-4333-8333-333333333333",
                "44444444-4444-4444-8444-444444444444",1,1)
            var saved: String? = old.encode()
            var progress = "sealed-progress"
            val store = object : UploadCredentialStore {
                override fun read() = saved
                override fun store(value: String) { saved = value }
                override fun clear() { saved = null; progress = "" }
                override fun clearSession() { saved = null }
            }
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(MockResponse().setBody(buildJsonObject {
                put("access_token","new-access"); put("refresh_token","new-refresh")
                put("expires_in",3600); put("user",buildJsonObject { put("id",user) })
            }.toString()))
            val began = System.nanoTime()
            assertEquals("new-access",UploadSessionManager(store,true).current().accessToken)
            assertTrue((System.nanoTime() - began) < java.util.concurrent.TimeUnit.SECONDS.toNanos(8))
            assertEquals(2,server.requestCount)
            assertEquals("sealed-progress",progress)
        } finally { server.shutdown() }
    }

    @Test fun invalidRefreshRequiresLoginButKeepsEncryptedProgress() {
        val server = MockWebServer()
        server.start()
        try {
            val old = UploadSession(server.url("/").toString(),server.url("/").toString(),
                server.url("/").toString(),
                "fixture-publishable","old-access","old-refresh",1,
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
                "33333333-3333-4333-8333-333333333333",
                "44444444-4444-4444-8444-444444444444",1,1)
            var saved: String? = old.encode()
            var progress = "sealed-progress"
            val store = object : UploadCredentialStore {
                override fun read() = saved
                override fun store(value: String) { saved = value }
                override fun clear() { saved = null; progress = "" }
                override fun clearSession() { saved = null }
            }
            server.enqueue(MockResponse().setResponseCode(400))
            try { UploadSessionManager(store,true).current(); fail("login required") }
            catch (_: UploadSessionManager.LoginRequired) { }
            assertNull(saved)
            assertEquals("sealed-progress",progress)
        } finally { server.shutdown() }
    }

    @Test fun refreshRotatesCredentialsAndRetainsPrincipal() {
        val server = MockWebServer()
        server.start()
        try {
            val user = "22222222-2222-4222-8222-222222222222"
            val old = UploadSession(server.url("/").toString(),server.url("/").toString(),
                server.url("/").toString(),
                "fixture-publishable","old-access","old-refresh",1,
                "11111111-1111-4111-8111-111111111111",user,
                "33333333-3333-4333-8333-333333333333",
                "44444444-4444-4444-8444-444444444444",1,1).validate(true)
            var saved: String? = old.encode()
            val store = object : UploadCredentialStore {
                override fun read() = saved
                override fun store(value: String) { saved = value }
                override fun clear() { saved = null }
                override fun clearSession() { saved = null }
            }
            server.enqueue(MockResponse().setBody(buildJsonObject {
                put("access_token","new-access"); put("refresh_token","new-refresh")
                put("expires_in",3600); put("user",buildJsonObject { put("id",user) })
            }.toString()))
            val manager = UploadSessionManager(store,true)
            val rotated = manager.current()
            assertEquals("new-access",rotated.accessToken)
            assertEquals("new-refresh",rotated.refreshToken)
            assertEquals(user,rotated.userId)
            assertEquals("new-access",manager.forceRefresh("old-access").accessToken)
            assertEquals(1,server.requestCount)
            val request = server.takeRequest()
            assertEquals("/auth/v1/token?grant_type=refresh_token",request.path)
            assertEquals("fixture-publishable",request.getHeader("apikey"))
            assertTrue(request.body.readUtf8().contains("old-refresh"))
            assertEquals(rotated,UploadSession.decode(saved!!,true))
        } finally { server.shutdown() }
    }
}
