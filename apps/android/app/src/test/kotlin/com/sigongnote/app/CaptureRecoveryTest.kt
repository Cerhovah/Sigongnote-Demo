package com.sigongnote.app

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonNull
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.util.UUID

class CaptureRecoveryTest {
    @Test fun recoveryChecksOriginalBytesAndNeverSendsBearerToSignedDownload() {
        val server=MockWebServer();server.start()
        try {
            val ids=(1..7).map { UUID.randomUUID().toString() };val bytes="N04 synthetic".toByteArray()
            val hash=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
            val session=UploadSession(server.url("/").toString(),server.url("/").toString(),server.url("/").toString(),"publishable","bearer","refresh",Long.MAX_VALUE,ids[0],ids[1],ids[2],ids[3],1,1).validate(true)
            val item=CaptureQueueItem(ids[4],ids[0],ids[1],ids[2],ids[3],1,"acknowledged",ids[4]+".sealed",hash,bytes.size.toLong(),1,2,2)
            val receipt=CaptureCopyReceipt(ids[4],ids[5],ids[6]);val now=System.currentTimeMillis()
            val proof=buildJsonObject {put("state","recoverable");put("ingestion_id",ids[5]);put("revision_id",ids[6]);put("source_generation",1);put("sha256",hash);put("byte_length",bytes.size);put("verified_at",java.time.Instant.ofEpochMilli(now+86_400_000).toString());put("restore_url",server.url("/storage/v1/object/sign/sigongnote-originals/${ids[0]}/original?token=synthetic").toString());put("expires_in",60)}.toString()
            server.enqueue(MockResponse().setBody(proof));server.enqueue(MockResponse().setBody(String(bytes)))
            val before=System.nanoTime()/1_000_000;val verified=requireNotNull(UploadApi(session).verifyRecovery(receipt,item));assertTrue(verified>=before&&verified<=System.nanoTime()/1_000_000);assertEquals("Bearer bearer",server.takeRequest().getHeader("Authorization"));assertNull(server.takeRequest().getHeader("Authorization"))
            server.enqueue(MockResponse().setBody(proof));server.enqueue(MockResponse().setBody("wrong bytes"))
            assertNull(UploadApi(session).verifyRecovery(receipt,item))
        }finally{server.shutdown()}
    }
    @Test fun boundaryReservesEncryptionAndConstructionFormatsRemainDistinctFromCad() {
        val gib=1024L*1024*1024;val now=100L*24*60*60*1000
        assertEquals("app_copy_cap",FolderStagingPolicy.capacity(2*gib-1024,1024,now,now,20*gib,20*gib))
        assertNull(ShareInputPolicy.limit("application/octet-stream","plan.dwg"))
        assertEquals(200L*1024*1024,ShareInputPolicy.limit("video/mp4","site.mp4"))
        assertEquals(200L*1024*1024,ShareInputPolicy.limit("application/octet-stream","contract.docx"))
        assertEquals(200L*1024*1024,ShareInputPolicy.limit("text/plain","site.csv"))
        assertEquals(200L*1024*1024,ShareInputPolicy.limit("text/plain","notes.txt"))
        assertEquals(65_536L,ShareInputPolicy.limit("text/plain",null))
    }
    @Test fun meteredRecoveryNeverDownloadsAndNullGenerationCannotBypassBoundSource() {
        val server=MockWebServer();server.start()
        try {
            val ids=(1..7).map{UUID.randomUUID().toString()};val bytes="recovery".toByteArray()
            val hash=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
            val session=UploadSession(server.url("/").toString(),server.url("/").toString(),server.url("/").toString(),"publishable","bearer","refresh",Long.MAX_VALUE,ids[0],ids[1],ids[2],ids[3],1,1).validate(true)
            val item=CaptureQueueItem(ids[4],ids[0],ids[1],ids[2],ids[3],1,"acknowledged",ids[4]+".sealed",hash,bytes.size.toLong(),1,2,2)
            val receipt=CaptureCopyReceipt(ids[4],ids[5],ids[6]);val now=System.currentTimeMillis()
            val proof=buildJsonObject {put("state","recoverable");put("ingestion_id",ids[5]);put("revision_id",ids[6]);put("source_generation",JsonNull);put("sha256",hash);put("byte_length",bytes.size);put("verified_at",java.time.Instant.ofEpochMilli(now+86_400_000).toString());put("restore_url",server.url("/storage/v1/object/sign/sigongnote-originals/${ids[0]}/original?token=synthetic").toString());put("expires_in",60)}.toString()
            assertNull(UploadApi(session).verifyRecovery(receipt,item){false});assertEquals(0,server.requestCount)
            server.enqueue(MockResponse().setBody(proof))
            assertNull(UploadApi(session).verifyRecovery(receipt,item));assertEquals(1,server.requestCount)
            server.enqueue(MockResponse().setBody(proof));var checks=0
            assertNull(UploadApi(session).verifyRecovery(receipt,item.copy(sourceId="",sourceGeneration=0)){++checks==1});assertEquals(2,server.requestCount)
            server.enqueue(MockResponse().setBody(proof));server.enqueue(MockResponse().setBody(String(bytes)))
            assertNotNull(UploadApi(session).verifyRecovery(receipt,item.copy(sourceId="",sourceGeneration=0)));assertEquals(4,server.requestCount)
        }finally{server.shutdown()}
    }
    @Test fun storageUsageUsesLongsAndOnlyTheAccountApi() {
        val server=MockWebServer();server.start()
        try {
            val ids=(1..4).map{UUID.randomUUID().toString()}
            val session=UploadSession(server.url("/").toString(),server.url("/").toString(),server.url("/").toString(),"publishable","bearer","refresh",Long.MAX_VALUE,ids[0],ids[1],ids[2],ids[3],1,1).validate(true)
            server.enqueue(MockResponse().setBody("{\"limit_bytes\":100000000000,\"used_bytes\":99000000000,\"reserved_bytes\":800000000}"))
            assertEquals(200_000_000L,UploadApi(session).storageAvailableBytes())
            val request=server.takeRequest();assertEquals("GET",request.method);assertEquals("/v1/capture-storage",request.path);assertEquals(ids[0],request.getHeader("X-Tenant-ID"))
            server.enqueue(MockResponse().setBody("{\"limit_bytes\":100000000000,\"used_bytes\":100000000000,\"reserved_bytes\":1}"))
            assertEquals(0L,UploadApi(session).storageAvailableBytes())
        }finally{server.shutdown()}
    }
}
