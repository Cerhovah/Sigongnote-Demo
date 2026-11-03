package com.sigongnote.app

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.security.MessageDigest
import javax.crypto.KeyGenerator
import org.junit.Assert.*
import org.junit.Test

class ShareCopyTest {
    @Test fun sealedCopyPreservesBytesAndOnlyCiphertextTouchesDisk() {
        val directory = Files.createTempDirectory("share-test").toFile()
        try {
            val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            val plain = "합성 테스트 공유 문서".toByteArray(Charsets.UTF_8)
            val sealed = ShareCopyWriter(key, directory).seal(ByteArrayInputStream(plain), 1024)
            assertEquals(plain.size.toLong(), sealed.byteLength)
            assertEquals(MessageDigest.getInstance("SHA-256").digest(plain)
                .joinToString("") { "%02x".format(it) }, sealed.sha256)
            val stored = directory.resolve(sealed.fileName).readBytes()
            assertFalse(String(stored, Charsets.ISO_8859_1)
                .contains(String(plain, Charsets.ISO_8859_1)))
            assertArrayEquals(byteArrayOf(0x53, 0x47, 0x4e, 0x02), stored.copyOfRange(0, 4))
            val restored = ByteArrayOutputStream()
            ShareCopyReader(key).unseal(ByteArrayInputStream(stored), restored,
                sealed.sha256, sealed.byteLength)
            assertArrayEquals(plain, restored.toByteArray())
            assertThrows(Exception::class.java) {
                ShareCopyReader(key).unseal(ByteArrayInputStream(stored.copyOf(stored.size - 1)),
                    ByteArrayOutputStream(), sealed.sha256, sealed.byteLength)
            }
            val changed = stored.copyOf().also { it[it.size / 2] = (it[it.size / 2].toInt() xor 1).toByte() }
            assertThrows(Exception::class.java) {
                ShareCopyReader(key).unseal(ByteArrayInputStream(changed),
                    ByteArrayOutputStream(), sealed.sha256, sealed.byteLength)
            }
        } finally { directory.deleteRecursively() }
    }

    @Test fun oversizedShareLeavesNoPrivateCopy() {
        val directory = Files.createTempDirectory("share-test").toFile()
        try {
            val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            assertThrows(ShareTooLarge::class.java) {
                ShareCopyWriter(key, directory).seal(ByteArrayInputStream(ByteArray(20)), 10)
            }
            assertTrue(directory.listFiles().isNullOrEmpty())
        } finally { directory.deleteRecursively() }
    }

    @Test fun largeCopyStreamsUnderSmallTestHeap() {
        val directory = Files.createTempDirectory("share-large-test").toFile()
        try {
            val count = 100L * 1024 * 1024
            val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            val source = object : InputStream() {
                var remaining = count
                override fun read(): Int = if (remaining-- > 0) 0x42 else -1
                override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                    if (remaining <= 0) return -1
                    val size = minOf(length.toLong(), remaining).toInt()
                    bytes.fill(0x42.toByte(), offset, offset + size)
                    remaining -= size
                    return size
                }
            }
            val sealed = ShareCopyWriter(key, directory).seal(source, 200L * 1024 * 1024)
            assertEquals(count, sealed.byteLength)
            val sink = object : OutputStream() {
                var bytes = 0L
                override fun write(value: Int) { bytes++ }
                override fun write(buffer: ByteArray, offset: Int, length: Int) { bytes += length }
            }
            directory.resolve(sealed.fileName).inputStream().use { input ->
                ShareCopyReader(key).unseal(input, sink, sealed.sha256, sealed.byteLength)
            }
            assertEquals(count, sink.bytes)
        } finally { directory.deleteRecursively() }
    }

    @Test fun inputLimitsAndSensitiveFileDefaults() {
        assertEquals(ShareInputPolicy.maxTextBytes, ShareInputPolicy.limit("text/plain", null))
        assertEquals(200L * 1024 * 1024, ShareInputPolicy.limit("image/jpeg", "photo.jpg"))
        assertEquals(200L * 1024 * 1024, ShareInputPolicy.limit("audio/mp4", "memo.m4a"))
        assertNull(ShareInputPolicy.limit("application/octet-stream", "certificate.pfx"))
        assertNull(ShareInputPolicy.limit("application/octet-stream", "backup.bak"))
        assertNull(ShareInputPolicy.limit("application/octet-stream", null))
    }

    @Test fun stalledProviderCannotSpinForever() {
        val directory = Files.createTempDirectory("share-stall-test").toFile()
        try {
            val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            val stalled = object : InputStream() {
                override fun read(): Int = 0
                override fun read(bytes: ByteArray, offset: Int, length: Int): Int = 0
            }
            assertThrows(IllegalStateException::class.java) {
                ShareCopyWriter(key,directory).seal(stalled,1024)
            }
            assertTrue(directory.listFiles().isNullOrEmpty())
        } finally { directory.deleteRecursively() }
    }
}
