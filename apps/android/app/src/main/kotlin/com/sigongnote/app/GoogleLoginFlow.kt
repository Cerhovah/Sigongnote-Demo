package com.sigongnote.app

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** Only the native credential vault persists this short-lived PKCE flow. */
data class GoogleLoginFlow(val verifier: String, val state: String, val createdAt: Long,val provider: String="google",val linkTarget: IdentityLinkTarget?=null) {
    fun authorize(origin: String, callback: String): String {
        requireHttpsOrigin(origin)
        require(callback in callbacks)
        require(provider in setOf("google","custom:naver","custom:kakao"))
        val redirect="$callback?state=${encode(state)}"
        return origin.trimEnd('/')+"/auth/v1/authorize?provider=${encode(provider)}&"+
            "redirect_to=${encode(redirect)}&code_challenge=${challenge(verifier)}&code_challenge_method=s256"
    }
    fun code(returned: String, callback: String, now: Long): String {
        require(callback in callbacks)
        require(now-createdAt in 0..600_000) { "LOGIN_EXPIRED" }
        val actual=URI(returned);val expected=URI(callback)
        require(actual.scheme==expected.scheme && actual.host==expected.host &&
            actual.path==expected.path && actual.port==-1 && actual.userInfo==null && actual.rawFragment==null)
        val pairs=actual.rawQuery.orEmpty().split('&').map { it.split('=',limit=2) }
        require(pairs.all { it.size==2 })
        val values=pairs.map { decode(it[0]) to decode(it[1]) }
        require(values.map { it.first }.distinct().size==values.size)
        val params=values.toMap()
        require(params["state"]==state && !params.containsKey("error")) { "LOGIN_REJECTED" }
        return requireNotNull(params["code"]).also {
            require(it.length in 1..2048 && it.none { c->c.isWhitespace() || c.isISOControl() })
        }
    }
    companion object {
        private val callbacks=setOf("com.sigongnote.app.auth://callback","com.sigongnote.app.smsrole.auth://callback","com.sigongnote.app.smssync.auth://callback","com.sigongnote.app.devtest.auth://callback")
        private fun encode(value: String)=URLEncoder.encode(value,"UTF-8")
        private fun decode(value: String)=URLDecoder.decode(value,"UTF-8")
        private fun random()=Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })
        fun create(now: Long=System.currentTimeMillis(),provider: String="google")=GoogleLoginFlow(random(),random(),now,provider)
        fun challenge(verifier: String): String {
            require(verifier.matches(Regex("[A-Za-z0-9._~-]{43,128}")))
            return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        }
        fun requireHttpsOrigin(value: String) {
            val uri=URI(value)
            require(uri.scheme=="https" && !uri.host.isNullOrBlank() && uri.userInfo==null &&
                uri.rawQuery==null && uri.rawFragment==null && (uri.path.isNullOrEmpty() || uri.path=="/"))
        }
    }
}
