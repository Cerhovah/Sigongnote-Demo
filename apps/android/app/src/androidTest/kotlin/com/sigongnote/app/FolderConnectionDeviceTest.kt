package com.sigongnote.app

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FolderConnectionDeviceTest {
    private val id="a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
    private fun session()=UploadSession("https://fixture.invalid","https://fixture.invalid",
        "https://fixture.invalid","fixture","fixture","fixture",Long.MAX_VALUE,id,id,id,id,1,1)
    private fun source()=FolderSource(id,"sealed",1,"selected",0,null,null,0,0,0,0,null,null,null,1,
        id,id,id,"photos","all",null,"work_dedicated","a".repeat(64),true,"local-fixture-v1",
        "{}",null,"encrypted-name","pending")

    @Test fun restartReplaysSameRequestAndOtherAccountsCannotBindPendingFolder() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).allowMainThreadQueries().build()
        try {
            db.folderDao().insertSource(source())
            val keys=mutableListOf<String>(); var fail=true; var projects=0
            val remote=object:FolderConnectionRemote {
                override fun createFolderProject(name:String,key:String):String { projects++; return id }
                override fun registerFolder(source:FolderSource):UploadApi.ReadySource {
                    keys.add(FolderSourcePolicy.requestKey(source.localSourceId,"source"))
                    if(fail)throw java.io.IOException()
                    return UploadApi.ReadySource(id,3)
                }
                override fun bindFolderProject(source:FolderSource,remote:UploadApi.ReadySource) {
                    assertEquals(id,source.projectId); assertEquals("photos",source.kind)
                }
            }
            FolderConnections(db) { "fixture project" }.resume(session().copy(tenantId="b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"),remote)
            assertTrue(keys.isEmpty())
            FolderConnections(db) { "fixture project" }.resume(session(),remote)
            assertEquals("retry",db.folderDao().source(id)?.bindingState)
            fail=false
            FolderConnections(db) { "fixture project" }.resume(session(),remote)
            val bound=db.folderDao().source(id)!!
            assertEquals(1,projects); assertEquals(2,keys.size); assertEquals(keys[0],keys[1])
            assertEquals("ready",bound.bindingState); assertEquals(3,bound.serverGeneration)
            assertEquals("photos",bound.kind); assertEquals("all",bound.historyMode)
        } finally { db.close() }
    }

    @Test fun pauseDuringRegistrationCannotResurrectSourceAndLocalUpgradeHasOneOwner() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).allowMainThreadQueries().build()
        try {
            db.folderDao().insertSource(source().copy(boundTenantId=null,boundUserId=null,boundDeviceId=null,
                serverUploadConsent=false,bindingState="local_only",encryptedProjectName=null))
            assertEquals(1,db.folderDao().connectLocalSource(id,id,id,id,"local-fixture-v1","{}",null,null,"photos","a".repeat(64),"all",null))
            assertEquals(0,db.folderDao().connectLocalSource(id,"other",id,id,"local-fixture-v1","{}",null,null,"photos","a".repeat(64),"all",null))
            val remote=object:FolderConnectionRemote {
                override fun createFolderProject(name:String,key:String)=error("Unexpected project")
                override fun registerFolder(source:FolderSource):UploadApi.ReadySource {
                    db.folderDao().pause(id); return UploadApi.ReadySource(id,1)
                }
                override fun bindFolderProject(source:FolderSource,remote:UploadApi.ReadySource) {}
            }
            FolderConnections(db).resume(session(),remote)
            assertEquals("paused",db.folderDao().source(id)?.state)
            assertEquals(id,db.folderDao().source(id)?.serverSourceId)
            assertTrue(db.folderDao().uploadable().isEmpty())
        } finally { db.close() }
    }

    @Test fun selectingLegacyFolderAgainFindsExistingSourceInsteadOfDuplicatingIt() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).allowMainThreadQueries().build()
        try {
            val uri="content://fixture/tree/recordings"
            val old=source().copy(encryptedTreeUri=FolderHandleVault().seal(uri),kind="folder",
                scopeFingerprint=null,historyMode="legacy_recent",processingPolicyId=null,
                serverSourceId=id,bindingState="ready")
            db.folderDao().insertSource(old)
            val found=FolderConnectionLookup.find(db.folderDao(),uri,FolderScopeFingerprint().of(uri,"call_recording")) {
                FolderHandleVault().open(it)
            }
            assertEquals(id,found?.localSourceId); assertEquals("folder",found?.kind)
            assertEquals("ready",found?.bindingState); assertEquals(1,db.folderDao().activeSources().size)
        } finally { db.close() }
    }

    @Test fun scopeUsesStableDeviceSecretAndSeparatesPurposes() {
        val first=FolderScopeFingerprint().of("content://fixture/tree/work","folder")
        assertEquals(64,first.length)
        assertEquals(first,FolderScopeFingerprint().of("content://fixture/tree/work","folder"))
        assertNotEquals(first,FolderScopeFingerprint().of("content://fixture/tree/work","photos"))
        assertNotEquals(FolderScanPolicy.documentIdHash("content://fixture/tree/work"),first)
    }

    @Test fun multipleFoldersKeepIndependentProjectsWhenOneConnectionRetries() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val db=Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).allowMainThreadQueries().build()
        val second="b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12"
        try {
            db.folderDao().insertSource(source().copy(projectId=id,encryptedProjectName=null))
            db.folderDao().insertSource(source().copy(localSourceId=second,projectId=second,
                encryptedProjectName=null,scopeFingerprint="b".repeat(64)))
            var firstFails=true
            val bound=mutableListOf<String>()
            val remote=object:FolderConnectionRemote {
                override fun createFolderProject(name:String,key:String)=error("Existing projects must be kept")
                override fun registerFolder(source:FolderSource):UploadApi.ReadySource {
                    if(firstFails && source.localSourceId==id)throw java.io.IOException()
                    return UploadApi.ReadySource(source.localSourceId,1)
                }
                override fun bindFolderProject(source:FolderSource,remote:UploadApi.ReadySource) {
                    assertEquals(source.localSourceId,source.projectId);bound.add(source.localSourceId)
                }
            }
            FolderConnections(db).resume(session(),remote)
            assertEquals("retry",db.folderDao().source(id)?.bindingState)
            assertEquals("ready",db.folderDao().source(second)?.bindingState)
            firstFails=false;FolderConnections(db).resume(session(),remote)
            assertEquals("ready",db.folderDao().source(id)?.bindingState)
            assertEquals(2,db.folderDao().activeSources().size)
            assertEquals(setOf(id,second),bound.toSet());assertEquals(2,bound.size)
        } finally {db.close()}
    }

    @Test fun upgradeFromVersionSevenPreservesExistingSourceAndReceipt() {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val context=instrumentation.targetContext
        val name="d02-migration-${java.util.UUID.randomUUID()}.db"
        val schema=org.json.JSONObject(instrumentation.context.assets.open(
            "com.sigongnote.app.CaptureQueueDatabase/7.json").bufferedReader().use { it.readText() })
            .getJSONObject("database")
        try {
            context.openOrCreateDatabase(name,0,null).use { old ->
                val tables=schema.getJSONArray("entities")
                for(i in 0 until tables.length()) {
                    val table=tables.getJSONObject(i); val tableName=table.getString("tableName")
                    old.execSQL(table.getString("createSql").replace("\${TABLE_NAME}",tableName))
                    val indexes=table.optJSONArray("indices") ?: org.json.JSONArray()
                    for(j in 0 until indexes.length()) old.execSQL(indexes.getJSONObject(j)
                        .getString("createSql").replace("\${TABLE_NAME}",tableName))
                }
                val setup=schema.getJSONArray("setupQueries")
                for(i in 0 until setup.length())old.execSQL(setup.getString(i))
                old.execSQL("INSERT INTO folder_sources(localSourceId,encryptedTreeUri,scopeVersion,state,scanGeneration,observedCount,eligibleCount,excludedCount,pendingCount,selectedAtEpochMs) VALUES (?, 'sealed',1,'current',1,1,1,0,0,123)",arrayOf(id))
                old.execSQL("INSERT INTO capture_queue(captureId,tenantId,userId,deviceId,sourceId,sourceGeneration,state,createdAtEpochMs,updatedAtEpochMs,acknowledgedAtEpochMs) VALUES (?,?,?,?,?,1,'acknowledged',1,2,2)",arrayOf(id,id,id,id,id))
                old.execSQL("INSERT INTO folder_observations(observationId,localSourceId,documentIdHash,sha256,byteLength,declaredMime,encryptedCopyName,lastSeenGeneration,state,observedAtEpochMs,serverRevisionId) VALUES (?,?,'hash','hash',24,'text/plain','synthetic.sealed',1,'acknowledged',1,?)",arrayOf(id,id,id))
                old.version=7
            }
            val upgraded=Room.databaseBuilder(context,CaptureQueueDatabase::class.java,name)
                .addMigrations(FolderScopeMigration(context),FolderScanMigration(context),CaptureCopyReceiptMigration()).allowMainThreadQueries().build()
            try {
                assertEquals("legacy_recent",upgraded.folderDao().source(id)?.historyMode)
                assertEquals("folder",upgraded.folderDao().source(id)?.kind)
                assertEquals("local_only",upgraded.folderDao().source(id)?.bindingState)
                assertEquals(2L,upgraded.queueDao().get(id)?.acknowledgedAtEpochMs)
                assertEquals(id,upgraded.copyReceiptDao().get(id)?.revisionId)
                assertNull(upgraded.copyReceiptDao().get(id)?.ingestionId)
            } finally { upgraded.close() }
        } finally { context.deleteDatabase(name) }
    }
}
