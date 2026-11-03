package com.sigongnote.app

import java.io.OutputStream
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Response

data class TusTarget(
    val endpoint: String,
    val signature: String,
    val bucket: String,
    val objectName: String,
    val chunkBytes: Int = 6 * 1024 * 1024,
)

/** A signed TUS location is a short-lived credential; callers persist it encrypted. */
class TusTransfer(private val allowLocalCleartext: Boolean = false,
    private val client: OkHttpClient = OkHttpClient.Builder().followRedirects(false)
        .connectTimeout(20,TimeUnit.SECONDS).readTimeout(90,TimeUnit.SECONDS).build()) {
    class Expired : Exception()
    class ObjectExists : Exception()
    class Retryable(message: String) : Exception(message)
    class Rejected(message: String) : Exception(message)

    fun send(target: TusTarget, bearer: String, mime: String, length: Long, sha256: String,
        openPlaintext: (OutputStream) -> Unit, previousLocation: String? = null,
        rememberLocation: (String) -> Unit = {}, checkAllowed: () -> Unit = {},
        onChunkAcknowledged: () -> Unit = {}): String {
        require(length in 1..209_715_200)
        require(Regex("^[0-9a-f]{64}$").matches(sha256))
        require(target.chunkBytes == 6 * 1024 * 1024)
        require(target.bucket == "sigongnote-originals")
        require(Regex("^[0-9a-f-]{36}/[0-9a-f-]{36}$").matches(target.objectName))
        require(Regex("^[a-z0-9.+-]+/[a-z0-9.+-]+$").matches(mime))
        require(bearer.isNotBlank() && target.signature.isNotBlank())
        val endpoint = checkedUrl(target.endpoint)
        val digest = MessageDigest.getInstance("SHA-256")
        var checked = 0L
        openPlaintext(object : OutputStream() {
            override fun write(value: Int) {
                digest.update(value.toByte()); checked++
                if (checked > length) throw Rejected("local_copy_length")
            }
            override fun write(bytes: ByteArray, offset: Int, count: Int) {
                digest.update(bytes,offset,count); checked += count
                if (checked > length) throw Rejected("local_copy_length")
            }
        })
        if (checked != length || digest.digest().joinToString("") { "%02x".format(it) } != sha256)
            throw Rejected("local_copy_mismatch")

        checkAllowed()
        var location = previousLocation?.let { checkedLocation(endpoint,it) }
        var offset = location?.let { head(it,bearer,target.signature,length) }
        if (offset == null) {
            checkAllowed()
            location = create(endpoint,bearer,target,mime,length)
            rememberLocation(location.toString())
            offset = 0L
        }
        if (offset == length) return location.toString()
        val start = offset
        val buffer = ByteArray(target.chunkBytes)
        var fill = 0
        var position = 0L
        fun flush() {
            if (fill == 0) return
            checkAllowed()
            patch(location!!,bearer,target.signature,position,buffer,fill)
            onChunkAcknowledged()
            position += fill
            fill = 0
        }
        try {
            openPlaintext(object : OutputStream() {
                override fun write(value: Int) { write(byteArrayOf(value.toByte()),0,1) }
                override fun write(bytes: ByteArray, offset: Int, count: Int) {
                    var consumed = 0
                    while (consumed < count) {
                        if (position < start) {
                            val skip = minOf((start - position).toInt(),count - consumed)
                            position += skip
                            consumed += skip
                            continue
                        }
                        val take = minOf(buffer.size - fill,count - consumed)
                        bytes.copyInto(buffer,fill,offset + consumed,offset + consumed + take)
                        fill += take
                        consumed += take
                        if (fill == buffer.size) flush()
                    }
                }
            })
            flush()
            if (position != length) throw Rejected("local_copy_changed")
            return location.toString()
        } finally { buffer.fill(0) }
    }

    private fun create(endpoint: URL, bearer: String, target: TusTarget, mime: String,
        length: Long): URL {
        val request = request(endpoint,"POST",bearer,target.signature,ByteArray(0).toRequestBody())
            .header("Upload-Length",length.toString())
        fun encoded(value: String) = Base64.getEncoder().encodeToString(value.toByteArray(Charsets.UTF_8))
        request.header("Upload-Metadata","bucketName ${encoded(target.bucket)}," +
            "objectName ${encoded(target.objectName)},contentType ${encoded(mime)}")
        request.header("x-upsert","false")
        return client.newCall(request.build()).execute().use { reply ->
            if (reply.code == 409) throw ObjectExists()
            response(reply,201)
            val raw = reply.header("Location") ?: throw Retryable("tus_location_missing")
            checkedLocation(endpoint,raw)
        }
    }

    private fun head(location: URL, bearer: String, signature: String, length: Long): Long? {
        return client.newCall(request(location,"HEAD",bearer,signature).build()).execute().use { reply ->
            if (reply.code == 404 || reply.code == 410) return null
            response(reply,200,204)
            val offset = reply.header("Upload-Offset")?.toLongOrNull()
                ?: throw Retryable("tus_offset_missing")
            if (offset !in 0..length) throw Rejected("tus_offset_invalid")
            offset
        }
    }

    private fun patch(location: URL, bearer: String, signature: String, offset: Long,
        bytes: ByteArray, count: Int) {
        val body = bytes.toRequestBody("application/offset+octet-stream".toMediaType(),0,count)
        val request = request(location,"PATCH",bearer,signature,body)
            .header("Upload-Offset",offset.toString()).build()
        client.newCall(request).execute().use { reply ->
            response(reply,204)
            if (reply.header("Upload-Offset")?.toLongOrNull() != offset + count)
                throw Retryable("tus_offset_unconfirmed")
        }
    }

    private fun request(url: URL, method: String, bearer: String,
        signature: String, body: okhttp3.RequestBody? = null): Request.Builder =
        Request.Builder().url(url).method(method,body)
            .header("Tus-Resumable","1.0.0")
            .header("Authorization","Bearer $bearer")
            .header("x-signature",signature)

    private fun response(reply: Response, vararg accepted: Int) {
        val code = reply.code
        if (code in accepted) return
        if (code == 401 || code == 403) throw Expired()
        if (code == 408 || code == 409 || code == 423 || code == 429 || code >= 500)
            throw Retryable("tus_http_$code")
        throw Rejected("tus_http_$code")
    }

    private fun checkedUrl(raw: String): URL {
        val url = URI(raw).toURL()
        val local = allowLocalCleartext && url.protocol == "http" &&
            url.host in setOf("127.0.0.1","localhost")
        require(url.protocol == "https" || local)
        require(url.userInfo == null && url.ref == null)
        return url
    }

    private fun checkedLocation(endpoint: URL, raw: String): URL {
        val url = checkedUrl(endpoint.toURI().resolve(raw).toString())
        require(url.protocol == endpoint.protocol && url.host == endpoint.host &&
            url.port == endpoint.port && url.path.startsWith("/storage/v1/upload/resumable/"))
        return url
    }
}
