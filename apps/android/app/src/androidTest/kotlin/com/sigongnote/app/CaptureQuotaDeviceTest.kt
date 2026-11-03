package com.sigongnote.app

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class CaptureQuotaDeviceTest {
    @Test fun accountPauseResumesKnownQuotaFailuresOnlyAndPreservesCopies() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).build()
        val ids=(1..12).map{UUID.randomUUID().toString()}
        val session=UploadSession("https://api.invalid/","https://storage.invalid/","https://storage.invalid/","synthetic","synthetic","synthetic",Long.MAX_VALUE,ids[0],ids[1],ids[2],ids[3],1,1)
        fun item(id:String,state:String="ready",tenant:String=session.tenantId,user:String=session.userId)=CaptureQueueItem(id,tenant,user,session.deviceId,session.manualSourceId,1,state,"$id.sealed","a".repeat(64),100,1,1)
        try {
            val queue=db.queueDao();val quota=CaptureStorageQuota(db)
            queue.insert(item(ids[4],"uploading"));queue.insert(item(ids[5]));queue.insert(item(ids[6],tenant=ids[9]));queue.insert(item(ids[7],user=ids[10]))
            queue.insert(item(ids[8],"failed_visible"));db.shareInboxDao().insert(ShareInboxItem(ids[8],ids[8],"failed_visible","text/plain","${ids[8]}.sealed","a".repeat(64),100,"storage_quota_paused",1))
            quota.pause(session)
            assertTrue(quota.paused(session));assertEquals(4,queue.quotaPausedCount(session.userId,session.deviceId))
            assertEquals("ready",queue.get(ids[7])?.state);assertTrue(queue.uploadCandidates(session.tenantId,session.userId,session.deviceId).isEmpty())
            queue.pauseForLogout(2);assertEquals("storage_quota_paused",queue.get(ids[4])?.state)
            assertFalse(quota.resume(session,99));assertEquals("failed_visible",db.shareInboxDao().item(ids[8])?.state)
            assertTrue(quota.resume(session,100));assertEquals("ready",queue.get(ids[4])?.state);assertEquals("ready",queue.get(ids[8])?.state)
            assertEquals("storage_quota_paused",queue.get(ids[6])?.state)
            assertEquals("staged_unbound",db.shareInboxDao().item(ids[8])?.state);assertNull(db.shareInboxDao().item(ids[8])?.failureCode)
            listOf(ids[4],ids[5],ids[6],ids[8]).forEach{assertEquals("$it.sealed",queue.get(it)?.encryptedCopyName)}
        }finally{db.close()}
    }
    @Test fun unprovedOldShareCopiesAreCountedPerAccountAndNeverReclaimCandidates() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).build()
        val ids=(1..8).map{UUID.randomUUID().toString()}
        try {
            for(index in 4..5) {
                val id=ids[index]
                db.queueDao().insert(CaptureQueueItem(id,ids[0],ids[1],ids[2],ids[3],1,"acknowledged","$id.sealed","a".repeat(64),100,1,2,2))
                db.shareInboxDao().insert(ShareInboxItem(id,id,"acknowledged","text/plain","$id.sealed","a".repeat(64),100,null,1))
            }
            db.copyReceiptDao().insert(CaptureCopyReceipt(ids[5],ids[6],ids[7]))
            assertEquals(1,db.copyReceiptDao().unprovedShareCount(ids[0],ids[1],ids[2]))
            assertEquals(0,db.copyReceiptDao().unprovedShareCount(ids[0],ids[6],ids[2]))
            assertEquals(listOf(ids[5]),db.copyReceiptDao().candidates(ids[0],ids[1],ids[2],10).map{it.captureId})
            assertNotNull(db.queueDao().get(ids[4])?.encryptedCopyName)
        }finally{db.close()}
    }
}
