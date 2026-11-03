package com.sigongnote.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object ShareInputPolicy {
    const val maxItems = 20
    const val maxTextBytes = 65_536L
    private val prohibitedExtensions = setOf("exe", "apk", "dll", "bat", "cmd", "ps1", "pfx", "p12", "key", "pem", "cer", "crt", "p7b", "p7m", "db", "sqlite", "sqlite3", "bak", "kdbx")

    fun limit(mime: String, name: String?): Long? {
        val extension = name?.substringAfterLast('.', "")?.lowercase() ?: ""
        if (name?.startsWith('.') == true || name?.startsWith("~$") == true) return null
        if (extension in prohibitedExtensions || extension in setOf("dwg","dxf","dgn","rvt","ifc")) return null
        val type = mime.lowercase().substringBefore(';').trim()
        return when {
            type == "text/plain" && name == null -> maxTextBytes
            type == "text/plain" -> 200L * 1024 * 1024
            type.startsWith("image/") -> 200L * 1024 * 1024
            type.startsWith("audio/") -> 200L * 1024 * 1024
            type.startsWith("video/") -> 200L * 1024 * 1024
            type == "application/pdf" || extension == "pdf" -> 200L * 1024 * 1024
            extension in setOf("hwp", "hwpx", "xls", "xlsx") ||
                type.contains("spreadsheet") || type.contains("excel") || type.contains("hwp") -> 200L * 1024 * 1024
            extension in setOf("doc","docx","ppt","pptx","odt","ods","odp","rtf","txt","csv","tsv","md","json","xml",
                "jpg","jpeg","png","gif","webp","bmp","tif","tiff","heic","heif","mp4","mov","avi","mkv","webm","3gp") -> 200L * 1024 * 1024
            else -> null
        }
    }
}

data class SealedCopy(val fileName: String, val sha256: String, val byteLength: Long)

class ShareCopyKey {
    private val alias = "sigongnote.share.v1"
    fun get(): SecretKey {
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
}

/** The provider stream is never written as plaintext to disk. */
class ShareCopyWriter(private val key: SecretKey, private val directory: File) {
    private val chunkSize = 1024 * 1024

    fun seal(input: InputStream, maxBytes: Long): SealedCopy {
        require(maxBytes > 0)
        check(directory.isDirectory || directory.mkdirs()) { "Private inbox directory unavailable" }
        val temporary = File.createTempFile("staging-", ".tmp", directory)
        val name = java.util.UUID.randomUUID().toString() + ".sealed"
        val final = File(directory, name)
        var length = 0L
        val digest = MessageDigest.getInstance("SHA-256")
        val fileKey = ByteArray(32).also(SecureRandom()::nextBytes)
        try {
            val wrapping = Cipher.getInstance("AES/GCM/NoPadding")
            wrapping.init(Cipher.ENCRYPT_MODE, key)
            val wrapped = wrapping.doFinal(fileKey)
            val noncePrefix = ByteArray(8).also(SecureRandom()::nextBytes)
            val header = ByteArrayOutputStream().also { bytes ->
                DataOutputStream(bytes).use { out ->
                    out.write(byteArrayOf(0x53, 0x47, 0x4e, 0x02))
                    out.writeByte(wrapping.iv.size)
                    out.write(wrapping.iv)
                    out.writeShort(wrapped.size)
                    out.write(wrapped)
                    out.write(noncePrefix)
                }
            }.toByteArray()
            val fileOutput = temporary.outputStream()
            DataOutputStream(fileOutput.buffered()).use { output ->
                output.write(header)
                input.use { source ->
                    val buffer = ByteArray(chunkSize)
                    var index = 0
                    while (true) {
                        var count = 0
                        var emptyReads = 0
                        while (count < chunkSize) {
                            val read = source.read(buffer, count, chunkSize - count)
                            if (read < 0) break
                            if (read == 0) {
                                if (++emptyReads >= 8) throw IllegalStateException("Provider stalled")
                                continue
                            }
                            emptyReads = 0
                            count += read
                        }
                        if (count == 0) break
                        length += count
                        if (length > maxBytes) throw ShareTooLarge()
                        digest.update(buffer, 0, count)
                        val ciphertext = segmentCipher(Cipher.ENCRYPT_MODE, fileKey,
                            noncePrefix, header, index, false).doFinal(buffer, 0, count)
                        output.writeByte(0)
                        output.writeInt(ciphertext.size)
                        output.write(ciphertext)
                        index++
                    }
                    if (length == 0L) throw ShareEmpty()
                    val terminal = segmentCipher(Cipher.ENCRYPT_MODE, fileKey,
                        noncePrefix, header, index, true).doFinal()
                    output.writeByte(1)
                    output.writeInt(terminal.size)
                    output.write(terminal)
                }
                output.flush()
                fileOutput.fd.sync()
            }
            check(!final.exists() && temporary.renameTo(final)) { "Private copy commit failed" }
            return SealedCopy(name, digest.digest().joinToString("") { "%02x".format(it) }, length)
        } finally {
            fileKey.fill(0)
            if (temporary.exists()) temporary.delete()
        }
    }
}

/** Each 1 MiB record authenticates its sequence; a required final record detects truncation. */
class ShareCopyReader(private val key: SecretKey) {
    fun unseal(input: InputStream, output: OutputStream, expectedSha256: String,
        expectedLength: Long) {
        val source = DataInputStream(input.buffered())
        val headerBytes = ByteArrayOutputStream()
        val magic = ByteArray(4).also(source::readFully)
        require(magic.contentEquals(byteArrayOf(0x53, 0x47, 0x4e, 0x02)))
        headerBytes.write(magic)
        val ivSize = source.readUnsignedByte()
        require(ivSize == 12)
        headerBytes.write(ivSize)
        val wrapIv = ByteArray(ivSize).also(source::readFully)
        headerBytes.write(wrapIv)
        val wrapLength = source.readUnsignedShort()
        require(wrapLength == 48)
        headerBytes.write(byteArrayOf((wrapLength shr 8).toByte(), wrapLength.toByte()))
        val wrapped = ByteArray(wrapLength).also(source::readFully)
        headerBytes.write(wrapped)
        val noncePrefix = ByteArray(8).also(source::readFully)
        headerBytes.write(noncePrefix)
        val header = headerBytes.toByteArray()
        val wrapping = Cipher.getInstance("AES/GCM/NoPadding")
        wrapping.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, wrapIv))
        val fileKey = wrapping.doFinal(wrapped)
        require(fileKey.size == 32)
        val digest = MessageDigest.getInstance("SHA-256")
        var length = 0L
        var index = 0
        try {
            while (true) {
                val flag = source.readUnsignedByte()
                require(flag == 0 || flag == 1)
                val terminal = flag == 1
                val size = source.readInt()
                require(size in 16..(1024 * 1024 + 16))
                val encrypted = ByteArray(size).also(source::readFully)
                val plain = segmentCipher(Cipher.DECRYPT_MODE, fileKey,
                    noncePrefix, header, index, terminal).doFinal(encrypted)
                if (terminal) {
                    require(size == 16 && plain.isEmpty() && source.read() == -1)
                    break
                }
                require(plain.isNotEmpty())
                length += plain.size
                require(length <= expectedLength)
                digest.update(plain)
                output.write(plain)
                index++
            }
            require(length == expectedLength &&
                digest.digest().joinToString("") { "%02x".format(it) } == expectedSha256)
        } finally { fileKey.fill(0) }
    }
}

private fun segmentCipher(mode: Int, fileKey: ByteArray, prefix: ByteArray,
    header: ByteArray, index: Int, terminal: Boolean): Cipher {
    require(index >= 0)
    val nonce = ByteBuffer.allocate(12).put(prefix).putInt(index).array()
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(mode, SecretKeySpec(fileKey, "AES"), GCMParameterSpec(128, nonce))
    cipher.updateAAD(header)
    cipher.updateAAD(ByteBuffer.allocate(5).putInt(index)
        .put(if (terminal) 1.toByte() else 0.toByte()).array())
    return cipher
}

class ShareTooLarge : Exception()
class ShareEmpty : Exception()
