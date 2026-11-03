package com.sigongnote.app

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RevokedCapturePurgerDeviceTest {
    @Test fun malformedCopyNameCannotDeleteOutsidePrivateCopyDirectory() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        val id = UUID.randomUUID().toString()
        val validId = UUID.randomUUID().toString()
        val original = File(context.cacheDir,"original-${UUID.randomUUID()}.txt")
        val validCopy = File(File(context.filesDir,"share-inbox").also { it.mkdirs() },
            "${UUID.randomUUID()}.sealed")
        try {
            original.writeText("keep")
            validCopy.writeText("synthetic")
            db.shareInboxDao().insert(ShareInboxItem(id,id,"staged_unbound","text/plain",
                "../${original.name}","a".repeat(64),4,null,1))
            db.queueDao().insert(CaptureQueueItem(id,id,id,id,id,1,
                "revoked_pending_purge","../${original.name}","a".repeat(64),4,1,1))
            db.shareInboxDao().insert(ShareInboxItem(validId,validId,"staged_unbound",
                "text/plain",validCopy.name,"b".repeat(64),9,null,1))
            db.queueDao().insert(CaptureQueueItem(validId,validId,validId,validId,validId,1,
                "revoked_pending_purge",validCopy.name,"b".repeat(64),9,1,2))
            val purger = RevokedCapturePurger(db,context.filesDir)
            assertEquals(RevokedCapturePurger.Result(0,1),
                purger.purgePending(10,maxItems = 1))
            assertEquals(10L,db.queueDao().get(id)?.updatedAtEpochMs)
            assertEquals(RevokedCapturePurger.Result(1,0),
                purger.purgePending(11,maxItems = 1))
            assertEquals("keep",original.readText())
            assertEquals("revoked_pending_purge",db.queueDao().get(id)?.state)
            assertEquals("revoked_purged",db.queueDao().get(validId)?.state)
            assertFalse(validCopy.exists())
        } finally { db.close(); original.delete(); validCopy.delete() }
    }

    @Test fun revokedCopiesAndNotificationBodyArePurgedButAckAndProviderOriginalRemain() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        val tenant = UUID.randomUUID().toString()
        val user = UUID.randomUUID().toString()
        val device = UUID.randomUUID().toString()
        val sourceId = UUID.randomUUID().toString()
        val localId = UUID.randomUUID().toString()
        val ids = (0..3).map { UUID.randomUUID().toString() }
        val shareDir = File(context.filesDir,"share-inbox").also { it.mkdirs() }
        val folderDir = File(context.filesDir,"folder-copies").also { it.mkdirs() }
        val shareCopy = File(shareDir,"${UUID.randomUUID()}.sealed")
        val folderCopy = File(folderDir,"${UUID.randomUUID()}.sealed")
        val ackCopy = File(shareDir,"${UUID.randomUUID()}.sealed")
        val providerOriginal = File(context.cacheDir,"provider-${UUID.randomUUID()}.txt")
        try {
            listOf(shareCopy,folderCopy,ackCopy,providerOriginal).forEach {
                it.writeText("synthetic fixture")
            }
            db.shareInboxDao().insert(ShareInboxItem(ids[0],ids[0],"staged_unbound",
                "text/plain",shareCopy.name,"a".repeat(64),17,null,1))
            db.folderDao().insertSource(FolderSource(localId,"sealed",1,"current",1,
                1,1,1,1,0,0,null,null,null,1))
            assertEquals(1,db.folderDao().bindServerSource(localId,sourceId,2,
                tenant,user,device))
            db.folderDao().insertObservation(FolderObservation(ids[1],localId,"b".repeat(64),
                "c".repeat(64),17,"text/plain",folderCopy.name,17,1,1,"staged_unbound",1))
            db.notificationDao().insertSnapshot(NotificationSnapshot(ids[2],"com.example.work",
                "d".repeat(64),"e".repeat(64),"f".repeat(64),1,"sealed-fixture",1,
                null,"approved_local",false,tenant,user,device))
            db.shareInboxDao().insert(ShareInboxItem(ids[3],ids[3],"acknowledged",
                "text/plain",ackCopy.name,"a".repeat(64),17,null,1))
            ids.forEachIndexed { index, id ->
                val name = listOf(shareCopy.name,folderCopy.name,null,ackCopy.name)[index]
                db.queueDao().insert(CaptureQueueItem(id,tenant,user,device,
                    if (index == 1) sourceId else UUID.randomUUID().toString(),
                    if (index == 1) 2 else 1,
                    if (index == 3) "acknowledged" else "revoked_pending_purge",
                    name,"a".repeat(64),17,1,1))
            }
            assertEquals(RevokedCapturePurger.Result(1,0),
                RevokedCapturePurger(db,context.filesDir).purgePending(10,maxItems = 1))
            assertEquals(2,db.queueDao().revokedPendingCount())
            assertEquals(RevokedCapturePurger.Result(2,0),
                RevokedCapturePurger(db,context.filesDir).purgePending(10))
            assertFalse(shareCopy.exists())
            assertFalse(folderCopy.exists())
            assertNull(db.notificationDao().snapshot(ids[2])?.encryptedPayload)
            assertEquals("revoked_purged",db.notificationDao().snapshot(ids[2])?.state)
            ids.take(3).forEach { assertEquals("revoked_purged",db.queueDao().get(it)?.state) }
            assertTrue(ackCopy.exists())
            assertEquals("acknowledged",db.queueDao().get(ids[3])?.state)
            assertTrue(providerOriginal.exists())
            assertEquals("synthetic fixture",providerOriginal.readText())
            assertEquals(RevokedCapturePurger.Result(0,0),
                RevokedCapturePurger(db,context.filesDir).purgePending(11))
        } finally {
            db.close()
            listOf(shareCopy,folderCopy,ackCopy,providerOriginal).forEach(File::delete)
        }
    }
}
