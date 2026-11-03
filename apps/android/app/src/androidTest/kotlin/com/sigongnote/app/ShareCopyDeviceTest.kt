package com.sigongnote.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.InputStream
import java.io.OutputStream
import java.io.File
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.runner.RunWith
import org.junit.Test

@RunWith(AndroidJUnit4::class)
class ShareCopyDeviceTest {
    @Test fun keystoreSealsAndStreams100MiBOnDevice() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "test-${UUID.randomUUID()}")
        try {
            val length = 100L * 1024 * 1024
            val input = object : InputStream() {
                var remaining = length
                override fun read(): Int = if (remaining-- > 0) 0x42 else -1
                override fun read(bytes: ByteArray, offset: Int, size: Int): Int {
                    if (remaining <= 0) return -1
                    val count = minOf(remaining, size.toLong()).toInt()
                    bytes.fill(0x42.toByte(), offset, offset + count)
                    remaining -= count
                    return count
                }
            }
            val key = ShareCopyKey().get()
            val sealed = ShareCopyWriter(key,directory).seal(input,200L * 1024 * 1024)
            val output = object : OutputStream() {
                var count = 0L
                override fun write(value: Int) { count++ }
                override fun write(bytes: ByteArray, offset: Int, length: Int) { count += length }
            }
            directory.resolve(sealed.fileName).inputStream().use {
                ShareCopyReader(key).unseal(it,output,sealed.sha256,sealed.byteLength)
            }
            assertEquals(length, output.count)
            val file = directory.resolve(sealed.fileName)
            java.io.RandomAccessFile(file,"rw").use { random ->
                random.seek(file.length() / 2)
                val original = random.readByte()
                random.seek(file.length() / 2)
                random.writeByte(original.toInt() xor 1)
            }
            assertThrows(Exception::class.java) {
                file.inputStream().use { ShareCopyReader(key).unseal(it,output,sealed.sha256,sealed.byteLength) }
            }
        } finally { directory.deleteRecursively() }
    }
}
