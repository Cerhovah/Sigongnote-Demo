package com.sigongnote.app

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.sigongnote.contracts.IngestionPrepareResponse
import com.sigongnote.contracts.IngestionPrepareResponseUpload
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CaptureUploadDeviceTest {
    @Test fun notificationSource403StopsMembershipWithoutRetrying() =
        notificationSourceFault(403)

    @Test fun notificationSource503StillUploadsManualShare() =
        notificationSourceFault(503)

    private fun notificationSourceFault(statusCode: Int) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val component = ComponentName(context,BusinessNotificationListener::class.java)
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val wasGranted = manager.isNotificationListenerAccessGranted(component)
        if (!wasGranted) {
            instrumentation.uiAutomation.executeShellCommand(
                "cmd notification allow_listener ${component.flattenToString()}").close()
            val deadline = System.currentTimeMillis() + 5_000
            while (!manager.isNotificationListenerAccessGranted(component) &&
                System.currentTimeMillis() < deadline) Thread.sleep(100)
        }
        assertTrue(manager.isNotificationListenerAccessGranted(component))
        val db = (context.applicationContext as SigongnoteApp).queue
        val vault = TokenVault(context)
        val tenant = UUID.randomUUID().toString()
        val user = UUID.randomUUID().toString()
        val device = UUID.randomUUID().toString()
        val manualSource = UUID.randomUUID().toString()
        val capture = UUID.randomUUID().toString()
        val snapshotId = UUID.randomUUID().toString()
        val ingestion = UUID.randomUUID().toString()
        val pkg = "com.sigongnote.fixture${System.currentTimeMillis()}"
        val conversation = NotificationVault().hash("fixture-conversation")
        val directory = File(context.filesDir,"share-inbox")
        val copy = ShareCopyWriter(ShareCopyKey().get(),directory)
            .seal("synthetic manual share".byteInputStream(),100)
        val server = MockWebServer()
        var sourceCalls = 0
        var prepareCalls = 0
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/v1/capture-sources" -> {
                    sourceCalls++
                    if (sourceCalls == 1) MockResponse().setResponseCode(statusCode)
                        .setBody(buildJsonObject { put("error",buildJsonObject {
                            put("code",if (statusCode == 403) "FORBIDDEN" else "UNAVAILABLE")
                            put("retryable",statusCode == 503)
                        }) }.toString())
                    else MockResponse().setBody(sourceBody(tenant,device,manualSource))
                }
                request.path == "/v1/ingestions" && request.method == "POST" -> {
                    prepareCalls++
                    MockResponse().setResponseCode(201).setBody(buildJsonObject {
                        put("ingestion_id",ingestion); put("state","prepared")
                        put("upload_url",server.url("/storage/v1/object/upload/sign/$tenant/$ingestion?token=fixture").toString())
                        put("expires_at","2099-01-01T00:00:00.000Z")
                        put("upload",buildJsonObject {
                            put("protocol","tus")
                            put("endpoint",server.url("/storage/v1/upload/resumable").toString())
                            put("signature","x".repeat(40)); put("bucket","sigongnote-originals")
                            put("object_name","$tenant/$ingestion"); put("chunk_bytes",6291456)
                            put("authorization","user_bearer+signature")
                            put("metadata_keys","bucketName,objectName,contentType")
                            put("upsert",false)
                        })
                    }.toString())
                }
                request.path == "/storage/v1/upload/resumable" && request.method == "POST" ->
                    MockResponse().setResponseCode(201)
                        .addHeader("Location","/storage/v1/upload/resumable/session")
                request.path == "/storage/v1/upload/resumable/session" &&
                    request.method == "PATCH" -> MockResponse().setResponseCode(204)
                        .addHeader("Upload-Offset",request.body.size)
                request.path == "/v1/ingestions/$ingestion/complete" ->
                    MockResponse().setBody(buildJsonObject {
                        put("ingestion_id",ingestion); put("state","queued")
                        put("blob_id",UUID.randomUUID().toString())
                        put("document_id",UUID.randomUUID().toString())
                        put("revision_id",UUID.randomUUID().toString())
                        put("job_id",UUID.randomUUID().toString())
                        put("deduplicated",false)
                    }.toString())
                else -> MockResponse().setResponseCode(500)
            }
        }
        server.start()
        val now = System.currentTimeMillis()
        try {
            val address = server.url("/").toString()
            vault.store(UploadSession(address,address,address,"fixture-publishable",
                "fixture-access","fixture-refresh",Long.MAX_VALUE,
                tenant,user,device,manualSource,1,now - 1000).validate(true).encode())
            db.notificationDao().putSource(NotificationSource(pkg,"selected",now,null))
            db.notificationDao().insertScope(NotificationScope(pkg,conversation,now,
                NotificationVault().seal("fixture",null),tenant,user,device))
            db.notificationDao().insertSnapshot(NotificationSnapshot(snapshotId,pkg,
                NotificationVault().hash("key"),conversation,NotificationVault().hash("body"),1,
                NotificationVault().seal("fixture","partial observation"),now,null,
                "approved_local",false,tenant,user,device))
            db.shareInboxDao().insert(ShareInboxItem(capture,capture,"staged_unbound",
                "text/plain",copy.fileName,copy.sha256,copy.byteLength,null,now))
            val work = OneTimeWorkRequestBuilder<CaptureUploadWorker>().build()
            val workManager = WorkManager.getInstance(context)
            workManager.enqueue(work).result.get(20,TimeUnit.SECONDS)
            val deadline = System.currentTimeMillis() + 60_000
            var state: WorkInfo.State?
            do {
                state = workManager.getWorkInfoById(work.id).get(10,TimeUnit.SECONDS)?.state
                if (state?.isFinished == true) break
                Thread.sleep(250)
            } while (System.currentTimeMillis() < deadline)
            assertEquals(WorkInfo.State.SUCCEEDED,state)
            assertEquals(if (statusCode == 403) "membership_lost" else "acknowledged",
                db.queueDao().get(capture)?.state)
            assertEquals(if (statusCode == 403) 1 else 3,sourceCalls)
            assertEquals(if (statusCode == 403) 0 else 1,prepareCalls)
        } finally {
            vault.clear()
            db.openHelper.writableDatabase.execSQL(
                "DELETE FROM capture_queue WHERE captureId IN (?,?)",arrayOf(capture,snapshotId))
            db.openHelper.writableDatabase.execSQL(
                "DELETE FROM share_inbox WHERE shareId = ?",arrayOf(capture))
            db.openHelper.writableDatabase.execSQL(
                "DELETE FROM notification_snapshots WHERE snapshotId = ?",arrayOf(snapshotId))
            db.openHelper.writableDatabase.execSQL(
                "DELETE FROM notification_scopes WHERE packageName = ?",arrayOf(pkg))
            db.openHelper.writableDatabase.execSQL(
                "DELETE FROM notification_sources WHERE packageName = ?",arrayOf(pkg))
            File(directory,copy.fileName).delete()
            server.shutdown()
            if (!wasGranted) instrumentation.uiAutomation.executeShellCommand(
                "cmd notification disallow_listener ${component.flattenToString()}").close()
        }
    }

    @Test fun forbiddenPrepareStopsBackgroundRetry() = deniedPrepare(
        403,"FORBIDDEN","membership_lost")

    @Test fun captureConflictBecomesVisibleFailure() = deniedPrepare(
        409,"IDEMPOTENCY_CONFLICT","failed_visible")

    private fun deniedPrepare(code: Int, errorCode: String, expectedState: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = (context.applicationContext as SigongnoteApp).queue
        val vault = TokenVault(context)
        val tenant = UUID.randomUUID().toString()
        val user = UUID.randomUUID().toString()
        val device = UUID.randomUUID().toString()
        val source = UUID.randomUUID().toString()
        val capture = UUID.randomUUID().toString()
        val directory = File(context.filesDir,"share-inbox")
        val copy = ShareCopyWriter(ShareCopyKey().get(),directory)
            .seal("synthetic denied share".byteInputStream(),100)
        val server = MockWebServer()
        var prepareCalls = 0
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/v1/capture-sources" ->
                    MockResponse().setBody(sourceBody(tenant,device,source))
                request.path == "/v1/ingestions" && request.method == "POST" -> {
                    prepareCalls++
                    MockResponse().setResponseCode(code).setBody(buildJsonObject {
                        put("error",buildJsonObject {
                            put("code",errorCode); put("retryable",false)
                        })
                    }.toString())
                }
                else -> MockResponse().setResponseCode(500)
            }
        }
        server.start()
        val now = System.currentTimeMillis()
        try {
            val address = server.url("/").toString()
            vault.store(UploadSession(address,address,address,"fixture-publishable",
                "fixture-access","fixture-refresh",Long.MAX_VALUE,
                tenant,user,device,source,1,now - 1000).validate(true).encode())
            db.shareInboxDao().insert(ShareInboxItem(capture,capture,"staged_unbound",
                "text/plain",copy.fileName,copy.sha256,copy.byteLength,null,now))
            val work = OneTimeWorkRequestBuilder<CaptureUploadWorker>().build()
            val manager = WorkManager.getInstance(context)
            manager.enqueue(work).result.get(20,TimeUnit.SECONDS)
            val deadline = System.currentTimeMillis() + 45_000
            var state: WorkInfo.State?
            do {
                state = manager.getWorkInfoById(work.id).get(10,TimeUnit.SECONDS)?.state
                if (state?.isFinished == true) break
                Thread.sleep(250)
            } while (System.currentTimeMillis() < deadline)
            assertEquals(WorkInfo.State.SUCCEEDED,state)
            assertEquals(expectedState,db.queueDao().get(capture)?.state)
            assertEquals(1,prepareCalls)
            if (code == 409) {
                assertEquals("failed_visible",db.shareInboxDao().item(capture)?.state)
                assertEquals("server_capture_conflict",
                    db.shareInboxDao().item(capture)?.failureCode)
            }
        } finally {
            vault.clear()
            db.openHelper.writableDatabase.execSQL("DELETE FROM capture_queue WHERE captureId = ?",
                arrayOf(capture))
            db.openHelper.writableDatabase.execSQL("DELETE FROM share_inbox WHERE shareId = ?",
                arrayOf(capture))
            File(directory,copy.fileName).delete()
            server.shutdown()
        }
    }

    @Test fun sealedShareReachesReceiptThroughActualWorkerAndRetainsCopy() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = (context.applicationContext as SigongnoteApp).queue
        val vault = TokenVault(context)
        val tenant = UUID.randomUUID().toString()
        val user = UUID.randomUUID().toString()
        val device = UUID.randomUUID().toString()
        val source = UUID.randomUUID().toString()
        val capture = UUID.randomUUID().toString()
        val ingestion = UUID.randomUUID().toString()
        val bytes = "synthetic field note only".toByteArray()
        val directory = File(context.filesDir,"share-inbox")
        val copy = ShareCopyWriter(ShareCopyKey().get(),directory)
            .seal(bytes.inputStream(),bytes.size.toLong())
        val server = MockWebServer()
        var uploaded = 0
        var prepared = 0
        var completed = 0
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/v1/capture-sources" ->
                    MockResponse().setBody(sourceBody(tenant,device,source))
                request.path == "/v1/ingestions" && request.method == "POST" -> {
                    prepared++
                    assertTrue(request.body.readUtf8().contains(capture))
                    MockResponse().setResponseCode(201).setBody(buildJsonObject {
                        put("ingestion_id",ingestion); put("state","prepared")
                        put("upload_url",server.url("/storage/v1/object/upload/sign/$tenant/$ingestion?token=fixture").toString())
                        put("expires_at","2099-01-01T00:00:00.000Z")
                        put("upload",buildJsonObject {
                            put("protocol","tus")
                            put("endpoint",server.url("/storage/v1/upload/resumable").toString())
                            put("signature","x".repeat(40)); put("bucket","sigongnote-originals")
                            put("object_name","$tenant/$ingestion"); put("chunk_bytes",6291456)
                            put("authorization","user_bearer+signature")
                            put("metadata_keys","bucketName,objectName,contentType")
                            put("upsert",false)
                        })
                    }.toString())
                }
                request.path == "/storage/v1/upload/resumable" && request.method == "POST" ->
                    MockResponse().setResponseCode(201)
                        .addHeader("Location","/storage/v1/upload/resumable/session")
                request.path == "/storage/v1/upload/resumable/session" &&
                    request.method == "PATCH" -> {
                    assertEquals("Bearer fixture-access",request.getHeader("Authorization"))
                    assertEquals("0",request.getHeader("Upload-Offset"))
                    uploaded += request.body.size.toInt()
                    MockResponse().setResponseCode(204).addHeader("Upload-Offset",uploaded)
                }
                request.path == "/v1/ingestions/$ingestion/complete" -> {
                    completed++
                    MockResponse().setBody(buildJsonObject {
                        put("ingestion_id",ingestion); put("state","queued")
                        put("blob_id",UUID.randomUUID().toString())
                        put("document_id",UUID.randomUUID().toString())
                        put("revision_id",UUID.randomUUID().toString())
                        put("job_id",UUID.randomUUID().toString())
                        put("deduplicated",false)
                    }.toString())
                }
                else -> MockResponse().setResponseCode(500)
            }
        }
        server.start()
        val now = System.currentTimeMillis()
        try {
            val address = server.url("/").toString()
            vault.store(UploadSession(address,address,address,"fixture-publishable",
                "fixture-access","fixture-refresh",Long.MAX_VALUE,
                tenant,user,device,source,1,now - 1000).validate(true).encode())
            db.shareInboxDao().insert(ShareInboxItem(capture,capture,"staged_unbound",
                "text/plain",copy.fileName,copy.sha256,copy.byteLength,null,now))
            val work = OneTimeWorkRequestBuilder<CaptureUploadWorker>().build()
            val manager = WorkManager.getInstance(context)
            manager.enqueue(work).result.get(20,TimeUnit.SECONDS)
            val deadline = System.currentTimeMillis() + 60_000
            var state: WorkInfo.State?
            do {
                state = manager.getWorkInfoById(work.id).get(10,TimeUnit.SECONDS)?.state
                if (state?.isFinished == true) break
                Thread.sleep(250)
            } while (System.currentTimeMillis() < deadline)
            assertEquals(WorkInfo.State.SUCCEEDED,state)
            assertEquals(bytes.size,uploaded)
            assertEquals(1,prepared)
            assertEquals(1,completed)
            assertEquals("acknowledged",db.queueDao().get(capture)?.state)
            assertEquals("acknowledged",db.shareInboxDao().item(capture)?.state)
            assertTrue("Retain copy after ACK for the configured retention period",
                File(directory,copy.fileName).exists())
            assertNull(vault.readProgress(capture))
        } finally {
            vault.clear()
            db.openHelper.writableDatabase.execSQL("DELETE FROM capture_queue WHERE captureId = ?",
                arrayOf(capture))
            db.openHelper.writableDatabase.execSQL("DELETE FROM share_inbox WHERE shareId = ?",
                arrayOf(capture))
            File(directory,copy.fileName).delete()
            server.shutdown()
        }
    }

    @Test fun lostTusSessionAndExistingObjectCompleteWithoutRepeatedCreate() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = (context.applicationContext as SigongnoteApp).queue
        val vault = TokenVault(context)
        val tenant = UUID.randomUUID().toString()
        val user = UUID.randomUUID().toString()
        val device = UUID.randomUUID().toString()
        val source = UUID.randomUUID().toString()
        val capture = UUID.randomUUID().toString()
        val ingestion = UUID.randomUUID().toString()
        val bytes = "fixture resume after complete".toByteArray()
        val directory = File(context.filesDir,"share-inbox")
        val copy = ShareCopyWriter(ShareCopyKey().get(),directory)
            .seal(bytes.inputStream(),bytes.size.toLong())
        val server = MockWebServer()
        var creates = 0
        var completes = 0
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/v1/capture-sources" ->
                    MockResponse().setBody(sourceBody(tenant,device,source))
                request.path == "/storage/v1/upload/resumable/session" &&
                    request.method == "HEAD" -> MockResponse().setResponseCode(404)
                request.path == "/storage/v1/upload/resumable" && request.method == "POST" -> {
                    creates++
                    MockResponse().setResponseCode(409)
                }
                request.path == "/v1/ingestions/$ingestion/complete" -> {
                    completes++
                    MockResponse().setBody(buildJsonObject {
                        put("ingestion_id",ingestion); put("state","queued")
                        put("blob_id",UUID.randomUUID().toString())
                        put("document_id",UUID.randomUUID().toString())
                        put("revision_id",UUID.randomUUID().toString())
                        put("job_id",UUID.randomUUID().toString())
                        put("deduplicated",false)
                    }.toString())
                }
                else -> MockResponse().setResponseCode(500)
            }
        }
        server.start()
        val now = System.currentTimeMillis()
        try {
            val address = server.url("/").toString()
            vault.store(UploadSession(address,address,address,"fixture-publishable",
                "fixture-access","fixture-refresh",Long.MAX_VALUE,
                tenant,user,device,source,1,now - 1000).validate(true).encode())
            db.shareInboxDao().insert(ShareInboxItem(capture,capture,"staged_unbound",
                "text/plain",copy.fileName,copy.sha256,copy.byteLength,null,now))
            val receipt = IngestionPrepareResponse(ingestion,"prepared",
                server.url("/storage/v1/object/upload/sign/$tenant/$ingestion?token=fixture").toString(),
                "2099-01-01T00:00:00.000Z",IngestionPrepareResponseUpload("tus",
                    server.url("/storage/v1/upload/resumable").toString(),"x".repeat(40),
                    "sigongnote-originals","$tenant/$ingestion",6291456,
                    "user_bearer+signature","bucketName,objectName,contentType",false))
            vault.storeProgress(capture,UploadAttempt(UUID.randomUUID().toString(),
                UUID.randomUUID().toString(),receipt,
                server.url("/storage/v1/upload/resumable/session").toString()).encode())
            val work = OneTimeWorkRequestBuilder<CaptureUploadWorker>().build()
            val manager = WorkManager.getInstance(context)
            manager.enqueue(work).result.get(20,TimeUnit.SECONDS)
            val deadline = System.currentTimeMillis() + 60_000
            var state: WorkInfo.State?
            do {
                state = manager.getWorkInfoById(work.id).get(10,TimeUnit.SECONDS)?.state
                if (state?.isFinished == true) break
                Thread.sleep(250)
            } while (System.currentTimeMillis() < deadline)
            assertEquals(WorkInfo.State.SUCCEEDED,state)
            assertEquals(1,creates)
            assertEquals(1,completes)
            assertEquals("acknowledged",db.queueDao().get(capture)?.state)
            assertNull(vault.readProgress(capture))
        } finally {
            vault.clear()
            db.openHelper.writableDatabase.execSQL("DELETE FROM capture_queue WHERE captureId = ?",
                arrayOf(capture))
            db.openHelper.writableDatabase.execSQL("DELETE FROM share_inbox WHERE shareId = ?",
                arrayOf(capture))
            File(directory,copy.fileName).delete()
            server.shutdown()
        }
    }

    private fun sourceBody(tenant: String, device: String, source: String): String =
        buildJsonObject { put("sources",buildJsonArray { add(buildJsonObject {
            put("id",source); put("tenant_id",tenant); put("device_id",device)
            put("kind","manual_share"); put("capability","manual_only")
            put("permission","granted"); put("reported_permission","granted")
            put("permission_trust","client_report_only"); put("health","current")
            put("scope_version",1); put("generation",1); put("version",1)
            put("active",true); put("device_active",true); put("upload_ready",true)
            put("local_selection_consent",true); put("server_upload_consent",true)
            put("external_ai_consent",false); put("permission_checked_at",null)
            put("coverage_from",null); put("last_successful_scan_at",null)
            put("last_event_at",null); put("last_server_ack_at",null)
            put("pending_count",0); put("bytes_pending",0); put("last_error_code",null)
        }) }) }.toString()
}
