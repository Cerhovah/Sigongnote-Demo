package com.sigongnote.app

import org.junit.Assert.*
import org.junit.Test

class GoogleLoginFlowTest {
    private val callback="com.sigongnote.app.auth://callback"
    @Test fun privateSmsLoginReturnsOnlyToItsOwnApplication() {
        val privateCallback="com.sigongnote.app.smssync.auth://callback"
        val flow=GoogleLoginFlow.create(1000,"custom:naver")
        assertTrue(flow.authorize("https://auth.example.test",privateCallback).contains("code_challenge_method=s256"))
        assertEquals("good",flow.code("$privateCallback?state=${flow.state}&code=good",privateCallback,1001))
        assertThrows(IllegalArgumentException::class.java) {flow.code("$callback?state=${flow.state}&code=good",privateCallback,1001)}
        assertThrows(IllegalArgumentException::class.java) {flow.code("$privateCallback?state=wrong&code=good",privateCallback,1001)}
    }
    @Test fun everyProviderKeepsPkceAndOriginalAccountBoundary() {
        for(provider in listOf("google","custom:naver","custom:kakao")) {
            val flow=GoogleLoginFlow.create(1000,provider)
            val url=java.net.URI(flow.authorize("https://auth.example.test",callback))
            assertTrue(url.rawQuery.contains("provider="+java.net.URLEncoder.encode(provider,"UTF-8")))
            assertTrue(url.rawQuery.contains("code_challenge_method=s256"))
            assertEquals("good",flow.code("$callback?state=${flow.state}&code=good",callback,1001))
        }
        assertThrows(IllegalArgumentException::class.java) {GoogleLoginFlow.create(provider="other").authorize("https://auth.example.test",callback)}
    }
    @Test fun challengeAndStrictReturn() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            GoogleLoginFlow.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        val flow=GoogleLoginFlow.create(1000)
        assertEquals("good",flow.code("$callback?state=${flow.state}&code=good",callback,1001))
        val authorize=flow.authorize("https://auth.example.test",callback)
        assertTrue(authorize.contains("code_challenge_method=s256"));assertFalse(authorize.contains(flow.verifier))
        for (bad in listOf("$callback?state=wrong&code=good",
            "$callback?state=${flow.state}&code=good&code=other",
            "$callback?state=${flow.state}&code=good#fragment",
            "com.sigongnote.app.smsrole.auth://callback?state=${flow.state}&code=good")) {
            assertThrows(IllegalArgumentException::class.java) {flow.code(bad,callback,1001)}
        }
        assertThrows(IllegalArgumentException::class.java) {flow.code("$callback?state=${flow.state}&code=good",callback,601001)}
        assertThrows(IllegalArgumentException::class.java) {flow.authorize("https://auth.example.test",callback+"/wrong")}
        assertThrows(IllegalArgumentException::class.java) {flow.authorize("http://auth.example.test",callback)}
    }
}
