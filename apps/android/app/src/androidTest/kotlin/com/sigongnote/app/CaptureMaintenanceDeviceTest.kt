package com.sigongnote.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CaptureMaintenanceDeviceTest {
    @Test fun sevenDayAckAloneNeverAuthorizesCopyRemoval() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = (context.applicationContext as SigongnoteApp).queue
        val directory = File(context.filesDir,"share-inbox").also { it.mkdirs() }
        val now = System.currentTimeMillis()
        val cutoff = now - 7L * 24 * 60 * 60 * 1000
        val ids = (0..3).map { UUID.randomUUID().toString() }
        val files = ids.map { File(directory,"${UUID.randomUUID()}.sealed") }
        val states = listOf("acknowledged","acknowledged","acknowledged","ready")
        val times = listOf(cutoff,cutoff + 1,cutoff - 1,cutoff - 1)
        try {
            ids.forEachIndexed { index, id ->
                files[index].writeText("synthetic sealed fixture")
                db.shareInboxDao().insert(ShareInboxItem(id,id,
                    if (index == 3) "staged_unbound" else "acknowledged",
                    "text/plain",files[index].name,"a".repeat(64),24,null,now))
                db.queueDao().insert(CaptureQueueItem(id,id,id,id,id,1,states[index],
                    files[index].name,"a".repeat(64),24,now,times[index],
                    if (index == 3) null else times[index]))
            }
            assertEquals(1,db.shareInboxDao().setRetentionHold(ids[2],true))
            assertEquals(0,AcknowledgedCopyRetention(db,directory).purgeExpired(now))
            assertTrue(files[0].exists())
            assertNotNull(db.queueDao().get(ids[0])?.encryptedCopyName)
            assertEquals("acknowledged",db.shareInboxDao().item(ids[0])?.state)
            assertTrue(files[1].exists())
            assertTrue(files[2].exists())
            assertTrue(files[3].exists())
            assertEquals(1,db.shareInboxDao().setRetentionHold(ids[2],false))
            assertEquals(0,AcknowledgedCopyRetention(db,directory).purgeExpired(now))
            assertTrue(files[2].exists())
            assertTrue(files[3].exists())
            assertEquals(0,AcknowledgedCopyRetention(db,directory).purgeExpired(now))
        } finally {
            ids.forEach { id ->
                db.openHelper.writableDatabase.execSQL("DELETE FROM capture_queue WHERE captureId = ?",
                    arrayOf(id))
                db.openHelper.writableDatabase.execSQL("DELETE FROM share_inbox WHERE shareId = ?",
                    arrayOf(id))
            }
            files.forEach(File::delete)
        }
    }

    @Test fun heartbeatPreventsStaleUploadRequeue() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dao = (context.applicationContext as SigongnoteApp).queue.queueDao()
        val id = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        try {
            dao.insert(CaptureQueueItem(id,id,id,id,id,1,"uploading",null,null,null,now,
                now - 31 * 60_000L))
            assertEquals(1,dao.heartbeat(id,1,now))
            assertEquals(0,dao.requeueInterrupted(now,now - 30 * 60_000L))
            assertEquals("uploading",dao.get(id)?.state)
            assertEquals(0,dao.heartbeat(id,2,now))
        } finally {
            (context.applicationContext as SigongnoteApp).queue.openHelper.writableDatabase
                .execSQL("DELETE FROM capture_queue WHERE captureId = ?",arrayOf(id))
        }
    }

    @Test fun deferrableRunRecoversStaleQueueAndPreservesReferencedCopy() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val database = (context.applicationContext as SigongnoteApp).queue
        val directory = File(context.filesDir,"share-inbox").also { it.mkdirs() }
        val orphan = File(directory,"staging-${UUID.randomUUID()}.tmp")
        val retained = File(directory,"${UUID.randomUUID()}.sealed")
        val now = System.currentTimeMillis()
        val staleId = UUID.randomUUID().toString()
        val retainedId = UUID.randomUUID().toString()
        orphan.writeText("synthetic orphan")
        retained.writeText("synthetic retained")
        assertTrue(orphan.setLastModified(now - 2 * 60L * 60 * 1000))
        database.shareInboxDao().insert(ShareInboxItem(staleId,staleId,"receiving",
            "text/plain",null,null,null,null,now - 2 * 60L * 60 * 1000))
        database.shareInboxDao().insert(ShareInboxItem(retainedId,retainedId,"staged_unbound",
            "text/plain",retained.name,"a".repeat(64),18,null,now - 2 * 60L * 60 * 1000))
        assertTrue(retained.setLastModified(now - 2 * 60L * 60 * 1000))
        val scanGate = CountDownLatch(1)
        val scanEntered = CountDownLatch(1)
        val blockedScan = (context.applicationContext as SigongnoteApp).scanExecutor.submit {
            scanEntered.countDown()
            scanGate.await()
        }
        try {
            assertTrue(scanEntered.await(5,TimeUnit.SECONDS))
            val work = OneTimeWorkRequestBuilder<CaptureMaintenanceWorker>().build()
            val manager = WorkManager.getInstance(context)
            manager.enqueue(work).result.get(20,TimeUnit.SECONDS)
            Thread.sleep(500)
            assertNotEquals("Worker must wait behind the foreground scan",
                WorkInfo.State.SUCCEEDED,manager.getWorkInfoById(work.id).get()?.state)
            scanGate.countDown()
            blockedScan.get(5,TimeUnit.SECONDS)
            val deadline = System.currentTimeMillis() + 45_000
            var state: WorkInfo.State?
            do {
                state = manager.getWorkInfoById(work.id).get(10,TimeUnit.SECONDS)?.state
                if (state == WorkInfo.State.SUCCEEDED) break
                Thread.sleep(250)
            } while (System.currentTimeMillis() < deadline)
            assertEquals(WorkInfo.State.SUCCEEDED,state)
            assertFalse(orphan.exists())
            assertTrue(retained.exists())
            assertEquals("failed_visible",database.shareInboxDao().item(staleId)?.state)
            assertTrue(context.getSharedPreferences("capture_maintenance",0)
                .getLong("success_at",0) >= now)
        } finally {
            scanGate.countDown()
            orphan.delete()
            retained.delete()
            database.openHelper.writableDatabase.execSQL(
                "DELETE FROM share_inbox WHERE shareId IN (?,?)",arrayOf(staleId,retainedId))
        }
    }
}
