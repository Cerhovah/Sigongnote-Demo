package com.sigongnote.app

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.put
import kotlinx.serialization.json.add
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class UploadApiTest {
    private val tenant = "11111111-1111-4111-8111-111111111111"
    private val user = "22222222-2222-4222-8222-222222222222"
    private val device = "33333333-3333-4333-8333-333333333333"
    private val source = "44444444-4444-4444-8444-444444444444"
    private val capture = "55555555-5555-4555-8555-555555555555"
    private val ingestion = "66666666-6666-4666-8666-666666666666"

    @Test fun signedSourcePrepareCompleteUsesNativeBearerAndGeneration() {
        val server = MockWebServer()
        server.start()
        try {
            val session = UploadSession(server.url("/").toString(),server.url("/").toString(),
                server.url("/").toString(),
                "fixture-publishable","fixture-bearer","fixture-refresh",Long.MAX_VALUE,tenant,
                user,device,source,2,1).validate(true)
            assertEquals(session,UploadSession.decode(session.encode(),true))
            try { session.validate(false); fail("release must require HTTPS") }
            catch (_: IllegalArgumentException) { }
            val sources = buildJsonObject {
                put("sources",buildJsonArray { add(buildJsonObject {
                    put("id",source); put("tenant_id",tenant); put("device_id",device)
                    put("kind","manual_share"); put("capability","manual_only")
                    put("permission","granted"); put("reported_permission","granted")
                    put("permission_trust","client_report_only"); put("health","current")
                    put("scope_version",1); put("generation",2); put("version",1)
                    put("active",true); put("device_active",true); put("upload_ready",true)
                    put("local_selection_consent",true); put("server_upload_consent",true)
                    put("external_ai_consent",false); put("permission_checked_at",null)
                    put("coverage_from",null); put("last_successful_scan_at",null)
                    put("last_event_at",null); put("last_server_ack_at",null)
                    put("pending_count",0); put("bytes_pending",0); put("last_error_code",null)
                }) })
            }.toString()
            server.enqueue(MockResponse().setBody(sources))
            server.enqueue(MockResponse().setBody(sources))
            val prepare = buildJsonObject {
                put("ingestion_id",ingestion); put("state","prepared")
                put("upload_url",server.url("/storage/v1/object/upload/sign/$tenant/$ingestion?token=fixture" ).toString())
                put("expires_at","2026-09-29T00:00:00.000Z")
                put("upload",buildJsonObject {
                    put("protocol","tus"); put("endpoint",server.url("/storage/v1/upload/resumable").toString())
                    put("signature","x".repeat(40)); put("bucket","sigongnote-originals")
                    put("object_name","$tenant/$ingestion"); put("chunk_bytes",6291456)
                    put("authorization","user_bearer+signature")
                    put("metadata_keys","bucketName,objectName,contentType"); put("upsert",false)
                })
            }.toString()
            server.enqueue(MockResponse().setResponseCode(201).setBody(prepare))
            server.enqueue(MockResponse().setBody(buildJsonObject {
                put("ingestion_id",ingestion); put("state","queued")
                put("blob_id",UUID.randomUUID().toString())
                put("document_id",UUID.randomUUID().toString())
                put("revision_id",UUID.randomUUID().toString())
                put("job_id",UUID.randomUUID().toString())
                put("deduplicated",false)
            }.toString()))
            val api = UploadApi(session)
            assertTrue(api.sourceReady(source,2,"manual_share"))
            assertFalse(api.sourceReady(source,3,"manual_share"))
            val item = CaptureQueueItem(capture,tenant,user,device,source,2,"ready",
                "copy.sealed","a".repeat(64),25,1,1)
            assertEquals(ingestion,api.prepare(item,"text/plain",UUID.randomUUID().toString()).ingestion_id)
            assertEquals("queued",api.complete(ingestion,"a".repeat(64),25,
                UUID.randomUUID().toString()).state)
            repeat(4) {
                val request = server.takeRequest()
                assertEquals("Bearer fixture-bearer",request.getHeader("Authorization"))
                assertEquals(tenant,request.getHeader("X-Tenant-ID"))
                if (it >= 2) assertNotNull(request.getHeader("Idempotency-Key"))
            }
            server.enqueue(MockResponse().setResponseCode(201).setBody(
                prepare.replace(server.url("/storage/v1/upload/resumable").toString(),
                    "https://untrusted.example/storage/v1/upload/resumable")))
            try {
                api.prepare(item,"text/plain",UUID.randomUUID().toString())
                fail("bearer must not be sent to an untrusted storage endpoint")
            } catch (_: IllegalArgumentException) { }
            server.takeRequest()
            server.enqueue(MockResponse().setResponseCode(201).setBody(prepare))
            val predecessor = FolderObservation("previous","local","b".repeat(64),
                "c".repeat(64),25,"text/plain","copy.sealed",25,1,1,
                "acknowledged",1,null,
                "77777777-7777-4777-8777-777777777777",
                "88888888-8888-4888-8888-888888888888",1)
            api.prepare(item,"text/plain",UUID.randomUUID().toString(),predecessor)
            val revisionRequest = server.takeRequest().body.readUtf8()
            assertTrue(revisionRequest.contains("\"document_id\":\"${predecessor.serverDocumentId}\""))
            assertTrue(revisionRequest.contains("\"predecessor_revision_id\":\"${predecessor.serverRevisionId}\""))
            assertTrue(revisionRequest.contains("\"expected_version\":1"))
            val notificationSource = sources.replace("\"kind\":\"manual_share\"",
                "\"kind\":\"notifications\"")
            server.enqueue(MockResponse().setBody(notificationSource))
            assertEquals(UploadApi.ReadySource(source,2),
                api.singleReadySource("notifications"))
            server.takeRequest()
            server.enqueue(MockResponse().setBody(notificationSource.replace(
                "\"server_upload_consent\":true","\"server_upload_consent\":false")))
            assertNull(api.singleReadySource("notifications"))
            server.takeRequest()
        } finally { server.shutdown() }
    }
}
