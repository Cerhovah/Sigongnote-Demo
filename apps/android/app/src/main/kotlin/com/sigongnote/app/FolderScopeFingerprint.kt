package com.sigongnote.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

/** Device-secret HMAC, never a guessable unsalted hash of a private URI. */
class FolderScopeFingerprint {
    companion object { private val keyLock = Any() }
    private fun key(): SecretKey = synchronized(keyLock) {
        val alias = "sigongnote.folder.scope.v1"
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias,null) as? SecretKey) ?: KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_HMAC_SHA256,"AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_SIGN)
                    .setDigests(KeyProperties.DIGEST_SHA256).build())
            }.generateKey()
    }
    fun of(tree: String, kind: String): String {
        require(kind in FolderSourcePolicy.kinds)
        return Mac.getInstance("HmacSHA256").run {
            init(key())
            doFinal("sigongnote-saf-v1\u0000$kind\u0000$tree".toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
        }
    }
}
