package com.sigongnote.app

import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

class TusTransferTest {
    @Test fun vanishedSessionAndExistingObjectEscalatesToCompletion() {
        val bytes = "fixture original".toByteArray()
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
        var heads = 0
        var creations = 0
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.method) {
                "HEAD" -> { heads++; MockResponse().setResponseCode(404) }
                "POST" -> { creations++; MockResponse().setResponseCode(409) }
                else -> throw AssertionError("Unexpected transfer attempt")
            }
        }
        server.start()
        try {
            val endpoint = server.url("/storage/v1/upload/resumable").toString()
            val target = TusTarget(endpoint,"fixture-signature","sigongnote-originals",
                "a".repeat(36) + "/" + "b".repeat(36))
            try {
                TusTransfer(allowLocalCleartext = true).send(target,"fixture-user",
                    "text/plain",bytes.size.toLong(),sha,{ it.write(bytes) },
                    previousLocation = server.url("/storage/v1/upload/resumable/session").toString())
                fail("caller must try completion rather than repeating the same create")
            } catch (_: TusTransfer.ObjectExists) { }
            assertEquals(1,heads)
            assertEquals(1,creations)
        } finally { server.shutdown() }
    }

    @Test fun resumesAfterInterruptedSecondChunkWithoutRecreatingObject() {
        val bytes = ByteArray(11 * 1024 * 1024) { (it % 251).toByte() }
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
        val received = ByteArrayOutputStream()
        var creations = 0
        var patches = 0
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                assertEquals("Bearer fixture-user",request.getHeader("Authorization"))
                assertEquals("fixture-signature",request.getHeader("x-signature"))
                assertEquals("1.0.0",request.getHeader("Tus-Resumable"))
                return when (request.method) {
                    "POST" -> {
                        creations++
                        assertEquals(bytes.size.toString(),request.getHeader("Upload-Length"))
                        assertEquals("false",request.getHeader("x-upsert"))
                        val metadata = request.getHeader("Upload-Metadata") ?: ""
                        assertTrue(metadata.contains("bucketName ${b64("sigongnote-originals")}"))
                        assertTrue(metadata.contains("objectName ${b64("a".repeat(36) + "/" + "b".repeat(36))}"))
                        MockResponse().setResponseCode(201)
                            .addHeader("Location","/storage/v1/upload/resumable/session")
                    }
                    "HEAD" -> MockResponse().setResponseCode(204)
                        .addHeader("Upload-Offset",received.size())
                    "PATCH" -> {
                        patches++
                        assertEquals(received.size(),request.getHeader("Upload-Offset")!!.toInt())
                        val chunk = request.body.readByteArray()
                        if (patches == 2) MockResponse().setResponseCode(503)
                        else {
                            assertTrue(chunk.size <= 6 * 1024 * 1024)
                            received.write(chunk)
                            MockResponse().setResponseCode(204)
                                .addHeader("Upload-Offset",received.size())
                        }
                    }
                    else -> throw AssertionError(request.method)
                }
            }
        }
        server.start()
        try {
            val target = TusTarget(server.url("/storage/v1/upload/resumable").toString(),
                "fixture-signature","sigongnote-originals",
                "a".repeat(36) + "/" + "b".repeat(36))
            val transfer = TusTransfer(allowLocalCleartext = true)
            var location: String? = null
            var acknowledgedChunks = 0
            val open: (java.io.OutputStream) -> Unit = { it.write(bytes) }
            try {
                transfer.send(target,"fixture-user","application/pdf",bytes.size.toLong(),sha,
                    open,rememberLocation = { location = it },
                    onChunkAcknowledged = { acknowledgedChunks++ })
                fail("second chunk should fail transiently")
            } catch (error: TusTransfer.Retryable) {
                assertEquals("tus_http_503",error.message)
            }
            assertNotNull(location)
            assertEquals(1,acknowledgedChunks)
            transfer.send(target,"fixture-user","application/pdf",bytes.size.toLong(),sha,
                open,previousLocation = location,
                onChunkAcknowledged = { acknowledgedChunks++ })
            assertEquals(1,creations)
            assertEquals(3,patches)
            assertEquals(2,acknowledgedChunks)
            assertArrayEquals(bytes,received.toByteArray())
            try {
                transfer.send(target,"fixture-user","application/pdf",bytes.size.toLong(),
                    "0".repeat(64),open)
                fail("damaged local copy must not touch network")
            } catch (_: TusTransfer.Rejected) { }
            assertEquals(1,creations)
            try {
                TusTransfer().send(target,"fixture-user","application/pdf",bytes.size.toLong(),
                    sha,open)
                fail("release transport must reject cleartext")
            } catch (_: IllegalArgumentException) { }
        } finally { server.shutdown() }
    }

    private fun b64(value: String): String = Base64.getEncoder()
        .encodeToString(value.toByteArray(Charsets.UTF_8))
}
