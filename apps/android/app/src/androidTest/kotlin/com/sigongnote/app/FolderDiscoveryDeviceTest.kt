package com.sigongnote.app

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FolderDiscoveryDeviceTest {
    @Test fun inaccessibleSubtreesDoNotStopOtherDirectoriesAndRecentRefreshHasBoundedBudget() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).allowMainThreadQueries().build()
        try {
            val reader=FolderChildrenReader { parent,visit ->
                if(parent=="denied")throw SecurityException()
                if(parent=="broken")throw IllegalArgumentException()
                val children=if(parent=="root") listOf(node("denied",true),node("broken",true),node("okay",true)) else listOf(node("valid-file"))
                children.all(visit)
            }
            val dao=db.folderScanDao();val engine=FolderDiscovery(dao,reader,{it},{it})
            val run=engine.begin("source","root",0)
            engine.discover(run)
            assertEquals(2,dao.directoryCount("source",run.generation,"gap"))
            assertEquals(1,dao.itemCount("source",run.generation))
            assertEquals(2,dao.refreshRecentDirectories("source",run.generation))
        } finally { db.close() }
    }
    private fun node(id:String,directory:Boolean=false)=FolderNode(FolderEntry(id,"$id.pdf",
        if(directory) "vnd.android.document/directory" else "application/pdf",1,1),directory)

    @Test fun persistedIdentityEnumerationCrossesOldLimitsAndProviderReordering() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).allowMainThreadQueries().build()
        try {
            for(count in listOf(1999,2000,2001,10000)) {
                val source="fixture-$count";val files=(1..count).map { node("file-$it") };var reverse=false
                val reader=FolderChildrenReader { _,visit ->
                    var complete=true
                    for(item in if(reverse) files.asReversed() else files)if(!visit(item)) { complete=false;break }
                    complete
                }
                val dao=db.folderScanDao()
                val initial=FolderDiscovery(dao,reader,{it.reversed()},{it.reversed()})
                lateinit var run:FolderScanRun
                db.runInTransaction { run=initial.begin(source,"root",0) }
                var calls=0
                while(dao.nextDirectory(source,run.generation)!=null) {
                    // Re-create the engine every step: the cursor must be in Room, not in memory.
                    val resumed=FolderDiscovery(dao,reader,{it.reversed()},{it.reversed()})
                    assertEquals(run,resumed.begin(source,"root",0))
                    assertTrue(resumed.discover(run,400)<=400)
                    reverse=!reverse;calls++;assertTrue("No progress after restart",calls<count/400+3)
                }
                assertEquals(count,dao.itemCount(source,run.generation))
                assertEquals(count,dao.pendingCount(source,run.generation))
                assertEquals(0,dao.directoryCount(source,run.generation,"gap"))
                assertTrue(dao.pending(source,run.generation,1).single().encryptedEntry.startsWith("}"))
            }
        } finally { db.close() }
    }

    @Test fun manyDirectoriesAndOneDeepGapDoNotCancelOtherFiles() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).allowMainThreadQueries().build()
        try {
            val reader=FolderChildrenReader { parent,visit ->
                val children=when {
                    parent=="root" -> (1..2100).map { node("dir-$it",true) }+node("deep-0",true)+node("root-file")
                    parent.startsWith("dir-") -> listOf(node("file-$parent"))
                    else -> listOf(node("deep-${parent.substringAfter('-').toInt()+1}",true))
                }
                var complete=true;for(child in children)if(!visit(child)) { complete=false;break };complete
            }
            val dao=db.folderScanDao();val engine=FolderDiscovery(dao,reader,{it},{it})
            lateinit var run:FolderScanRun;db.runInTransaction { run=engine.begin("source","root",0) }
            var rounds=0
            while(dao.nextDirectory("source",run.generation)!=null) {
                engine.discover(run,400,200);assertTrue(++rounds<40)
            }
            assertEquals(2101,dao.itemCount("source",run.generation))
            assertEquals(1,dao.directoryCount("source",run.generation,"gap"))
            assertEquals(2101,dao.pendingCount("source",run.generation))
        } finally { db.close() }
    }

    @Test fun verifiedCopiesRemainUploadableDuringQuotaPauseAndBlockedFoldersDoNotHeadBlockQueue() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).allowMainThreadQueries().build()
        try {
            for((index,state) in listOf("permission_lost","quota_pause").withIndex()) {
                val id="source-$index"
                db.folderDao().insertSource(FolderSource(id,"sealed",1,state,0,null,null,1,1,0,1,null,id,1,1,
                    "tenant","user","device"))
                db.folderDao().insertObservation(FolderObservation(id,id,"hash","sha",10,"application/pdf",
                    "copy-$index.sealed",10,1,1,"staged_unbound",index.toLong()))
                db.queueDao().insert(CaptureQueueItem(id,"tenant","user","device",id,1,"ready",null,"sha",10,index.toLong(),1))
            }
            assertEquals(listOf("source-1"),db.folderDao().uploadable().map { it.observationId })
            assertEquals(listOf("source-1"),db.queueDao().uploadCandidates("tenant","user","device").map { it.captureId })
            assertEquals(20L,db.folderDao().retainedBytes())
            db.folderDao().markAcknowledged("source-1","document","revision",1)
            assertEquals(10L,db.folderDao().retainedBytes())
            assertEquals("copy-1.sealed",db.folderDao().observation("source-1")?.encryptedCopyName)
        } finally { db.close() }
    }

    @Test fun resumedDiscoveryReopensChangedFilesWithoutDuplicatingTheirIdentity() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).allowMainThreadQueries().build()
        try {
            var current=node("same-file")
            val reader=FolderChildrenReader { _,visit -> visit(current) }
            val dao=db.folderScanDao();val engine=FolderDiscovery(dao,reader,{it},{it})
            lateinit var run:FolderScanRun;db.runInTransaction { run=engine.begin("source","root",0) }
            engine.discover(run)
            val hash=FolderScanPolicy.documentIdHash("same-file")
            dao.itemState("source",hash,run.generation,"done","allowed",null)
            current=current.copy(entry=current.entry.copy(size=2,modifiedAtEpochMs=2))
            dao.refreshDirectories("source",run.generation)
            FolderDiscovery(dao,reader,{it},{it}).discover(run)
            assertEquals(1,dao.itemCount("source",run.generation))
            assertEquals(2L,dao.item("source",hash)?.providerSize)
            assertEquals("pending",dao.item("source",hash)?.state)
            assertEquals(run.generation,dao.run("source")?.generation)
        } finally { db.close() }
    }
}
