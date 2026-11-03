package com.sigongnote.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey

/** P-256 registration/signing key. Its private half never leaves AndroidKeyStore. */
class DeviceKeyStore {
    private val alias = "sigongnote.device.v1"
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun ensureKey() {
        if (store().containsAlias(alias)) return
        val generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore")
        generator.initialize(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .build())
        generator.generateKeyPair()
    }

    fun publicJwk(): Map<String, String> {
        ensureKey()
        val key = store().getCertificate(alias).publicKey as ECPublicKey
        fun coordinate(value: BigInteger): String {
            val raw = value.toByteArray()
            val fixed = ByteArray(32)
            val take = raw.takeLast(32).toByteArray()
            System.arraycopy(take, 0, fixed, 32 - take.size, take.size)
            return Base64.encodeToString(fixed, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        }
        return mapOf("kty" to "EC", "crv" to "P-256",
            "x" to coordinate(key.w.affineX), "y" to coordinate(key.w.affineY))
    }

    fun sign(bytes: ByteArray): String {
        ensureKey()
        val key = store().getKey(alias, null) as java.security.PrivateKey
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(key)
        signature.update(bytes)
        return Base64.encodeToString(signature.sign(),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }
}
