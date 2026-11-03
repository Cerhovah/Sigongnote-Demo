package com.sigongnote.app

import android.content.Context
import android.net.ConnectivityManager
import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import java.io.File
import java.time.Instant

@Entity(tableName="capture_copy_receipts")
data class CaptureCopyReceipt(@PrimaryKey val captureId:String,val ingestionId:String?,val revisionId:String,
    val reclaimedAt:Long?=null,val hold:Boolean=false,@ColumnInfo(defaultValue="0") val nextAttemptAt:Long=0)
@Dao interface CaptureCopyReceiptDao {
    @Insert(onConflict=OnConflictStrategy.IGNORE) fun insert(value:CaptureCopyReceipt)
    @Query("SELECT * FROM capture_copy_receipts WHERE captureId=:id") fun get(id:String):CaptureCopyReceipt?
    @Query("SELECT r.* FROM capture_copy_receipts r JOIN capture_queue q ON q.captureId=r.captureId WHERE q.tenantId=:tenant AND q.userId=:user AND q.deviceId=:device AND q.state='acknowledged' AND q.encryptedCopyName IS NOT NULL AND r.reclaimedAt IS NULL AND r.hold=0 AND r.nextAttemptAt<=:now ORDER BY q.acknowledgedAtEpochMs LIMIT 4")
    fun candidates(tenant:String,user:String,device:String,now:Long):List<CaptureCopyReceipt>
    @Query("SELECT COUNT(*) FROM capture_queue q JOIN share_inbox s ON s.shareId=q.captureId LEFT JOIN capture_copy_receipts r ON r.captureId=q.captureId WHERE q.tenantId=:tenant AND q.userId=:user AND q.deviceId=:device AND q.state='acknowledged' AND s.state='acknowledged' AND q.encryptedCopyName IS NOT NULL AND r.captureId IS NULL")
    fun unprovedShareCount(tenant:String,user:String,device:String):Int
    @Query("UPDATE capture_copy_receipts SET nextAttemptAt=:next WHERE captureId=:id") fun defer(id:String,next:Long)
    @Query("UPDATE capture_copy_receipts SET reclaimedAt=:now WHERE captureId=:id AND reclaimedAt IS NULL AND hold=0") fun reclaimed(id:String,now:Long):Int
}
class CaptureCopyReceiptMigration:Migration(9,10){override fun migrate(db:SupportSQLiteDatabase){
    db.execSQL("CREATE TABLE IF NOT EXISTS capture_copy_receipts(captureId TEXT NOT NULL PRIMARY KEY,ingestionId TEXT,revisionId TEXT NOT NULL,reclaimedAt INTEGER,hold INTEGER NOT NULL,nextAttemptAt INTEGER NOT NULL DEFAULT 0)")
    db.execSQL("INSERT OR IGNORE INTO capture_copy_receipts(captureId,ingestionId,revisionId,reclaimedAt,hold,nextAttemptAt) SELECT o.observationId,NULL,o.serverRevisionId,NULL,0,0 FROM folder_observations o JOIN capture_queue q ON q.captureId=o.observationId WHERE q.state='acknowledged' AND o.serverRevisionId IS NOT NULL")
}}

/** Serial with folder scans. Proof failure retains every local byte. Source URIs are never deleted. */
class CaptureCopyRetention(private val context:Context,private val db:CaptureQueueDatabase){
    fun reclaim():Int {
        fun unmetered():Boolean=runCatching {
            val network=context.getSystemService(ConnectivityManager::class.java)
            network.activeNetwork!=null&&!network.isActiveNetworkMetered
        }.getOrDefault(false)
        if(!unmetered())return 0
        val vault=TokenVault(context)
        val manager=UploadSessionManager(vault,BuildConfig.DEBUG)
        val session=manager.current();val api=UploadApi(session)
        fun bytes()=listOf("folder-copies","share-inbox").sumOf { File(context.filesDir,it).listFiles()?.sumOf { file->file.length() }?:0L }
        var count=0
        for(receipt in db.copyReceiptDao().candidates(session.tenantId,session.userId,session.deviceId,System.currentTimeMillis())) {
            if(bytes()<1024L*1024*1024)break
            try {
                val deferred=receipt.copy(nextAttemptAt=System.currentTimeMillis()+600_000)
                db.copyReceiptDao().defer(receipt.captureId,deferred.nextAttemptAt)
                val item=db.queueDao().get(receipt.captureId)?:continue
                val proof=api.verifyRecovery(receipt,item,::unmetered)?:continue
                db.runInTransaction {
                    val current=db.queueDao().get(item.captureId)?:return@runInTransaction
                    if(current.state!="acknowledged"||current!=item||db.copyReceiptDao().get(item.captureId)!=deferred||receipt.hold||
                        System.nanoTime()/1_000_000-proof !in 0..60_000)return@runInTransaction
                    val latest=manager.current()
                    if(latest.tenantId!=session.tenantId||latest.userId!=session.userId||latest.deviceId!=session.deviceId)return@runInTransaction
                    val folder=db.folderDao().observation(item.captureId)
                    val share=db.shareInboxDao().item(item.captureId)
                    val directory=when {
                        folder!=null -> {
                            val source=db.folderDao().source(folder.localSourceId)?:return@runInTransaction
                            val tree=FolderHandleAccess.grant(source)
                            if(context.contentResolver.persistedUriPermissions.none { it.uri==tree&&it.isReadPermission }||
                                source.state in setOf("paused","permission_lost")||source.serverGeneration!=item.sourceGeneration||
                                db.folderDao().otherCopyReferences(requireNotNull(item.encryptedCopyName),item.captureId)!=0)return@runInTransaction
                            File(context.filesDir,"folder-copies")
                        }
                        share!=null&&!share.retentionHold -> {
                            if(db.shareInboxDao().otherCopyReferences(requireNotNull(item.encryptedCopyName),item.captureId)!=0)return@runInTransaction
                            File(context.filesDir,"share-inbox")
                        }
                        else -> return@runInTransaction
                    }
                    val name=requireNotNull(item.encryptedCopyName)
                    check(Regex("^[0-9a-fA-F-]{36}\\.sealed$").matches(name))
                    val copy=File(directory,name);check(copy.canonicalFile.parentFile==directory.canonicalFile)
                    if(copy.exists())check(copy.isFile&&copy.delete())
                    check(db.copyReceiptDao().reclaimed(item.captureId,System.currentTimeMillis())==1)
                    check(db.queueDao().clearAcknowledgedCopy(item.captureId)==1)
                    if(share!=null)check(db.shareInboxDao().markAcknowledgedCopyPurged(item.captureId,name)==1)
                    count++
                }
            }catch(_:Exception){/* Missing, changed or inaccessible server copies are retained. */}
        }
        return count
    }
}
