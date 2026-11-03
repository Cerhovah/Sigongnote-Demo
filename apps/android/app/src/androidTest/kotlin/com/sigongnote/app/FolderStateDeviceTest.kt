package com.sigongnote.app

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sigongnote.contracts.IngestionReceiptResponse
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FolderStateDeviceTest {
    @Test fun acceptedReceiptClosesLocalFolderWithoutPersistedGrant() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val id = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
            val localId = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
            db.folderDao().insertSource(FolderSource(localId,"sealed",1,"permission_lost",1,
                1,1,1,1,0,0,null,null,null,1))
            db.folderDao().insertObservation(FolderObservation(id,localId,"a".repeat(64),
                "b".repeat(64),25,"text/plain","copy.sealed",25,1,1,"staged_unbound",1))
            val item = CaptureQueueItem(id,id,id,id,id,1,"uploading","copy.sealed",
                "b".repeat(64),25,1,1)
            db.queueDao().insert(item)
            val receipt = IngestionReceiptResponse(id,"queued",id,id,id,false)
            assertTrue(CaptureReceiptAcker(db).acknowledge(item,"folder",receipt,null))
            assertEquals("acknowledged",db.queueDao().get(id)?.state)
            assertNotNull(db.queueDao().get(id)?.acknowledgedAtEpochMs)
            assertEquals("acknowledged",db.folderDao().observation(id)?.state)
            assertEquals(id,db.folderDao().observation(id)?.serverRevisionId)
        } finally { db.close() }
    }

    @Test fun serverBoundFolderOnlyOffersStableRevisionsAndKeepsAckHistory() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val dao = db.folderDao()
            val localId = "0f8fad5b-d9cb-469f-a165-70867728950e"
            val serverId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
            val first = FolderObservation("first",localId,"a".repeat(64),"b".repeat(64),
                100,"application/pdf","first.sealed",100,1,1,"staged_unbound",1)
            dao.insertSource(FolderSource(localId,"sealed",1,"current",1,1,1,
                1,1,0,0,null,null,null,1))
            dao.insertObservation(first)
            assertTrue(dao.uploadable().isEmpty())
            assertEquals(1,dao.bindServerSource(localId,serverId,2,
                "f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
                "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
                "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"))
            assertEquals(2,dao.sourceForServer(serverId)?.serverGeneration)
            val bound = dao.sourceForServer(serverId)!!
            assertTrue(FolderBindingPolicy.matches(bound,
                "f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
                "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
                "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"))
            assertFalse(FolderBindingPolicy.matches(bound,
                "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
                "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
                "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"))
            assertEquals(listOf("first"),dao.uploadable().map { it.observationId })
            assertEquals(1,dao.markAcknowledged("first",
                "f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
                "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",1))
            assertEquals("first",dao.latestAcknowledgedBefore(localId,first.documentIdHash,2)
                ?.observationId)
            val second = first.copy(observationId="second",sha256="c".repeat(64),
                encryptedCopyName="second.sealed",state="staged_unbound",observedAtEpochMs=2)
            dao.insertObservation(second)
            assertEquals(1,dao.supersede(localId,first.documentIdHash,"second"))
            assertEquals("acknowledged_superseded",dao.observation("first")?.state)
            assertEquals(listOf("second"),dao.uploadable().map { it.observationId })
            val otherTenant = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
            val ownerTenant = "f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
            val ownerUser = "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
            val ownerDevice = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
            db.queueDao().insert(CaptureQueueItem("first",ownerTenant,ownerUser,ownerDevice,
                serverId,2,"paused_logout","first.sealed",first.sha256,first.byteLength,1,1))
            assertEquals(0,db.queueDao().stopForRevocation(serverId,2,otherTenant,
                ownerUser,ownerDevice,3))
            assertEquals("paused_logout",db.queueDao().get("first")?.state)
            db.queueDao().insert(CaptureQueueItem("second",ownerTenant,ownerUser,ownerDevice,
                serverId,2,"ready","second.sealed",second.sha256,second.byteLength,2,2))
            assertEquals(1,dao.olderInFlight(localId,first.documentIdHash,3))
            assertEquals(1,db.queueDao().transition("second",2,"ready","uploading",3))
            assertEquals(1,db.queueDao().transition("second",2,"uploading","failed_visible",4))
            assertEquals(0,dao.olderInFlight(localId,first.documentIdHash,3))
            assertEquals("first",dao.latestAcknowledgedBefore(localId,first.documentIdHash,3)
                ?.observationId)
            val third = second.copy(observationId="third",sha256="d".repeat(64),
                encryptedCopyName="third.sealed",observedAtEpochMs=3)
            dao.insertObservation(third)
            db.queueDao().insert(CaptureQueueItem("third",ownerTenant,ownerUser,ownerDevice,
                serverId,2,"retry_wait","third.sealed",third.sha256,third.byteLength,3,3))
            assertEquals(1,dao.olderInFlight(localId,first.documentIdHash,4))
            assertEquals(1,dao.pause(localId))
            assertTrue(dao.uploadable().isEmpty())
        } finally { db.close() }
    }

    @Test fun partialScanNeverTurnsMissingIntoDeletion() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val database = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val dao = database.folderDao()
            val sourceId = "0f8fad5b-d9cb-469f-a165-70867728950e"
            val observationId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
            dao.insertSource(FolderSource(sourceId,"sealed",1,"current",1,1,1,
                1,1,0,0,null,null,null,1))
            dao.insertObservation(FolderObservation(observationId,sourceId,"a".repeat(64),
                "b".repeat(64),100,"application/pdf","copy.sealed",100,1,1,
                "staged_unbound",1))
            assertEquals(1,dao.startScan(sourceId,2,1))
            assertEquals(1,dao.scanIncomplete(sourceId,0,0,0,1,"provider_loading"))
            assertEquals(1,dao.source(sourceId)?.scanGeneration)
            assertEquals("staged_unbound",dao.observation(observationId)?.state)
            assertEquals(1,dao.startScan(sourceId,3,2))
            database.runInTransaction {
                assertEquals(1,dao.scanSucceeded(sourceId,2,3,0,0,0))
                dao.markMissingAfterCompleteScan(sourceId,2)
            }
            assertEquals("missing_observation",dao.observation(observationId)?.state)
            assertEquals(2,dao.source(sourceId)?.scanGeneration)
        } finally { database.close() }
    }

    @Test fun selectedTreeHandleIsEncryptedOnDevice() {
        val uri = "content://com.android.externalstorage.documents/tree/primary%3AWork"
        val vault = FolderHandleVault()
        val sealed = vault.seal(uri)
        assertFalse(sealed.contains("Work"))
        assertEquals(uri,vault.open(sealed))
    }

    @Test fun missingPersistedGrantStopsScanWithoutAdvancingCursor() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val database = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val id = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
            val privateUri = "content://invalid.example/tree/not-granted"
            database.folderDao().insertSource(FolderSource(id,FolderHandleVault().seal(privateUri),
                1,"selected",0,null,null,0,0,0,0,null,null,null,System.currentTimeMillis()))
            FolderScanner(context,database).scan(database.folderDao().source(id)!!)
            assertEquals("permission_lost",database.folderDao().source(id)?.state)
            assertEquals(0,database.folderDao().source(id)?.scanGeneration)
        } finally { database.close() }
    }

    @Test fun revisionsAndMissingCopyRepairPreserveHistory() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val database = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val dao = database.folderDao()
            val sourceId = "0f8fad5b-d9cb-469f-a165-70867728950e"
            dao.insertSource(FolderSource(sourceId,"sealed",1,"current",1,1,1,
                1,1,0,0,null,null,null,1))
            val first = FolderObservation("first",sourceId,"a".repeat(64),"b".repeat(64),
                100,"application/pdf","lost.sealed",100,1,1,"staged_unbound",1)
            dao.insertObservation(first)
            assertEquals(1,dao.repairCopy("first","repaired.sealed",2,100,1))
            assertEquals("repaired.sealed",dao.observation("first")?.encryptedCopyName)
            val second = first.copy(observationId = "second",sha256 = "c".repeat(64),
                encryptedCopyName = "second.sealed",lastSeenGeneration = 2,observedAtEpochMs = 2)
            dao.insertObservation(second)
            assertEquals(1,dao.supersede(sourceId,first.documentIdHash,"second"))
            dao.markMissingAfterCompleteScan(sourceId,2)
            assertEquals("superseded_revision",dao.observation("first")?.state)
            assertEquals("second",dao.observation("first")?.supersededBy)
            assertEquals(0,dao.missingCount())
            val returned = first.copy(observationId = "third",lastSeenGeneration = 3,
                observedAtEpochMs = 3)
            dao.insertObservation(returned)
            assertEquals(1,dao.supersede(sourceId,first.documentIdHash,"third"))
            assertEquals("third",dao.observation("second")?.supersededBy)
            assertEquals("third",dao.exact(sourceId,first.documentIdHash,first.sha256)?.observationId)
            dao.putPending(FolderPending(sourceId,"d".repeat(64),1))
            assertEquals(1,dao.pendingAttempts(sourceId,"d".repeat(64)))
            dao.putPending(FolderPending(sourceId,"d".repeat(64),2))
            assertEquals(2,dao.pendingAttempts(sourceId,"d".repeat(64)))
            dao.clearPending(sourceId,"d".repeat(64))
            assertNull(dao.pendingAttempts(sourceId,"d".repeat(64)))
            dao.putPending(FolderPending(sourceId,"e".repeat(64),-1,100,123))
            assertEquals(-1,dao.pendingMarker(sourceId,"e".repeat(64))?.attempts)
            assertEquals(123L,dao.pendingMarker(sourceId,"e".repeat(64))?.providerModifiedAtEpochMs)
        } finally { database.close() }
    }
}
