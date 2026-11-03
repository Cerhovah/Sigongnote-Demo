package com.sigongnote.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** SAF tree identifiers are private paths and remain encrypted in Room. */
class FolderHandleVault {
    private val alias = "sigongnote.folder.handle.v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build())
        return generator.generateKey()
    }

    fun seal(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE,key())
        require(cipher.iv.size == 12)
        val bytes = byteArrayOf(0x53,0x47,0x48,0x01) + cipher.iv +
            cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(bytes,Base64.NO_WRAP)
    }

    fun open(encoded: String): String {
        val bytes = Base64.decode(encoded,Base64.NO_WRAP)
        require(bytes.size >= 32 && bytes.copyOfRange(0,4)
            .contentEquals(byteArrayOf(0x53,0x47,0x48,0x01)))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,bytes.copyOfRange(4,16)))
        return String(cipher.doFinal(bytes.copyOfRange(16,bytes.size)),Charsets.UTF_8)
    }
}
