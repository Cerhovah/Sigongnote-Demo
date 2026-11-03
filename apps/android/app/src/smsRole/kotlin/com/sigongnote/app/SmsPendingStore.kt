package com.sigongnote.app

import android.content.Context
import android.telephony.SmsMessage
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Durable encrypted carrier hand-off before the SMS_DELIVER broadcast completes. */
object SmsPendingStore {
    private const val alias = "sigongnote.sms.pending.v1"
    private const val maxBytes = 256 * 1024

    private fun directory(context: Context) = File(context.filesDir,"sms-pending").apply { mkdirs() }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(alias,null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build())
        return generator.generateKey()
    }

    fun digest(pdus: Array<out ByteArray>, format: String?): String {
        val hash = MessageDigest.getInstance("SHA-256")
        pdus.forEach(hash::update)
        hash.update((format ?: "").toByteArray(Charsets.UTF_8))
        return hash.digest().joinToString("") { "%02x".format(it) }
    }

    fun save(context: Context, pdus: Array<out ByteArray>, format: String?): String {
        require(pdus.isNotEmpty() && pdus.size <= 20 && format.orEmpty().length <= 32)
        require(pdus.all { it.isNotEmpty() && it.size <= 65_536 })
        require(pdus.sumOf { it.size } <= maxBytes)
        val id = digest(pdus,format)
        val target = File(directory(context),"$id.pending")
        if (target.exists()) return id
        val plain = ByteArrayOutputStream().also { output ->
            DataOutputStream(output).use { data ->
                data.writeUTF(format.orEmpty())
                data.writeInt(pdus.size)
                pdus.forEach { pdu -> data.writeInt(pdu.size); data.write(pdu) }
            }
        }.toByteArray()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE,key())
        val encrypted = cipher.iv + cipher.doFinal(plain)
        val temp = File.createTempFile("sms-",".tmp",directory(context))
        try {
            temp.outputStream().use { stream ->
                stream.write(encrypted)
                stream.fd.sync()
            }
            if (!temp.renameTo(target) && !target.exists())
                throw IllegalStateException("SMS pending save failed")
        } finally { temp.delete() }
        return id
    }

    fun pendingCount(context: Context): Int = directory(context).listFiles()
        ?.count { it.name.matches(Regex("[a-f0-9]{64}\\.pending")) } ?: 0

    fun recover(context: Context): Int {
        if (!SmsRoleRuntime.canRead(context)) return 0
        var recovered = 0
        for (file in directory(context).listFiles().orEmpty().take(100)) {
            if (!file.name.matches(Regex("[a-f0-9]{64}\\.pending")) ||
                file.length() !in 1..(maxBytes + 1024).toLong()) continue
            try {
                val encrypted = file.readBytes()
                require(encrypted.size > 28)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE,key(),
                    GCMParameterSpec(128,encrypted.copyOfRange(0,12)))
                val plain = cipher.doFinal(encrypted.copyOfRange(12,encrypted.size))
                val (format,pdus) = DataInputStream(ByteArrayInputStream(plain)).use { input ->
                    val format = input.readUTF()
                    val count = input.readInt()
                    require(count in 1..20)
                    val pdus = Array(count) {
                        val size = input.readInt()
                        require(size in 1..65_536)
                        ByteArray(size).also { input.readFully(it) }
                    }
                    require(input.available() == 0)
                    format to pdus
                }
                require(digest(pdus,format) == file.name.removeSuffix(".pending"))
                val messages = pdus.mapNotNull { SmsMessage.createFromPdu(it,format) }
                require(messages.size == pdus.size)
                val address = messages.first().displayOriginatingAddress ?: continue
                val body = messages.joinToString("") { it.displayMessageBody ?: "" }
                val id = SmsRoleRuntime.rememberIncoming(context,pdus,format,address,body,
                    messages.first().timestampMillis)
                val stored = context.getSharedPreferences("sms_delivery_ids",Context.MODE_PRIVATE)
                    .contains(file.name.removeSuffix(".pending"))
                if (stored) {
                    file.delete()
                    if (id != null) SmsRoleRuntime.showIncomingNotification(context,id,address)
                    if (id != null) runCatching {
                        NotificationAccount.current(context)?.let { session ->
                            SmsBusinessCapture(context).captureSms(id,session)
                        }
                    }
                    recovered++
                }
            } catch (_: Exception) { /* Keep encrypted PDU and expose pending count. */ }
        }
        return recovered
    }
}
