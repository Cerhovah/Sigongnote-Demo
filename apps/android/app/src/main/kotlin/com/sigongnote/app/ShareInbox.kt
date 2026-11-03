package com.sigongnote.app

import android.content.Context
import androidx.room.Dao
import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(tableName = "share_inbox", indices = [Index(value = ["state", "createdAtEpochMs"])])
data class ShareInboxItem(
    @PrimaryKey val shareId: String,
    val batchId: String,
    val state: String,
    val declaredMime: String,
    val encryptedCopyName: String?,
    val sha256: String?,
    val byteLength: Long?,
    val failureCode: String?,
    val createdAtEpochMs: Long,
    val duplicateOfShareId: String? = null,
    val uploadPath: String = "undetermined",
    @ColumnInfo(defaultValue = "0") val retentionHold: Boolean = false,
)

@Dao
interface ShareInboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insert(item: ShareInboxItem)

    @Query("SELECT * FROM share_inbox WHERE shareId = :id")
    fun item(id: String): ShareInboxItem?

    @Query("SELECT COUNT(*) FROM share_inbox WHERE state = 'staged_unbound'")
    fun stagedCount(): Int

    @Query("SELECT * FROM share_inbox WHERE state = 'staged_unbound' AND createdAtEpochMs >= :since AND encryptedCopyName IS NOT NULL AND sha256 IS NOT NULL AND byteLength IS NOT NULL ORDER BY createdAtEpochMs LIMIT 30")
    fun uploadableSince(since: Long): List<ShareInboxItem>

    @Query("UPDATE share_inbox SET state = 'acknowledged' WHERE shareId = :id AND state = 'staged_unbound'")
    fun markAcknowledged(id: String): Int

    @Query("SELECT share_inbox.* FROM share_inbox JOIN capture_queue ON capture_queue.captureId = share_inbox.shareId WHERE share_inbox.state = 'acknowledged' AND share_inbox.retentionHold = 0 AND share_inbox.encryptedCopyName IS NOT NULL AND capture_queue.state = 'acknowledged' AND capture_queue.acknowledgedAtEpochMs <= :before LIMIT 30")
    fun expiredAcknowledged(before: Long): List<ShareInboxItem>

    @Query("SELECT COUNT(*) FROM share_inbox WHERE encryptedCopyName = :name AND shareId != :id")
    fun otherCopyReferences(name: String, id: String): Int

    @Query("UPDATE share_inbox SET state = 'revoked_purged', encryptedCopyName = NULL WHERE shareId = :id AND state IN ('staged_unbound','failed_visible')")
    fun markRevokedPurged(id: String): Int

    @Query("UPDATE share_inbox SET retentionHold = :hold WHERE shareId = :id AND state IN ('acknowledged','staged_unbound')")
    fun setRetentionHold(id: String, hold: Boolean): Int

    @Query("UPDATE share_inbox SET state = 'ack_purged', encryptedCopyName = NULL WHERE shareId = :id AND state = 'acknowledged' AND retentionHold = 0 AND encryptedCopyName = :name")
    fun markAcknowledgedCopyPurged(id: String, name: String): Int

    @Query("UPDATE share_inbox SET state = 'failed_visible', failureCode = :code WHERE shareId = :id AND state = 'staged_unbound'")
    fun markUploadFailed(id: String, code: String): Int

    @Query("UPDATE share_inbox SET state='staged_unbound',failureCode=NULL WHERE state='failed_visible' AND failureCode='storage_quota_paused' AND shareId IN (SELECT captureId FROM capture_queue WHERE tenantId=:tenant AND userId=:user AND deviceId=:device AND state='ready')")
    fun resumeStorageQuota(tenant:String,user:String,device:String):Int

    @Query("SELECT COUNT(*) FROM share_inbox WHERE state = 'failed_visible' AND COALESCE(failureCode,'')!='storage_quota_paused'")
    fun failedCount(): Int

    @Query("SELECT COUNT(*) FROM share_inbox WHERE state = 'failed_visible' AND failureCode = 'storage_full'")
    fun storageFailedCount(): Int

    @Query("SELECT COUNT(*) FROM share_inbox WHERE state = 'receiving'")
    fun receivingCount(): Int

    @Query("SELECT COUNT(*) FROM share_inbox WHERE state = 'duplicate_of'")
    fun duplicateCount(): Int

    @Query("SELECT COUNT(*) FROM share_inbox WHERE state = 'staged_unbound' AND uploadPath = 'pending_resumable'")
    fun pendingResumableCount(): Int

    @Query("SELECT COALESCE(SUM(byteLength),0) FROM share_inbox WHERE state = 'staged_unbound'")
    fun stagedBytes(): Long

    @Query("SELECT shareId FROM share_inbox WHERE state = 'staged_unbound' AND sha256 = :sha256 AND byteLength = :length LIMIT 1")
    fun findExactStaged(sha256: String, length: Long): String?

    @Query("UPDATE share_inbox SET state = 'staged_unbound', encryptedCopyName = :name, sha256 = :sha256, byteLength = :length, uploadPath = :uploadPath WHERE shareId = :id AND state = 'receiving'")
    fun markStaged(id: String, name: String, sha256: String, length: Long, uploadPath: String): Int

    @Query("UPDATE share_inbox SET state = 'failed_visible', failureCode = :code WHERE shareId = :id AND state = 'receiving'")
    fun markFailed(id: String, code: String): Int

    @Query("UPDATE share_inbox SET state='receiving',failureCode=NULL,duplicateOfShareId=NULL WHERE shareId=:id AND state IN ('failed_visible','duplicate_of')")
    fun retryCapture(id:String):Int

    @Query("UPDATE share_inbox SET state = 'failed_visible', failureCode = 'interrupted' WHERE state = 'receiving' AND createdAtEpochMs < :before")
    fun failStaleReceiving(before: Long): Int

    @Query("SELECT encryptedCopyName FROM share_inbox WHERE encryptedCopyName IS NOT NULL AND state != 'revoked_purged'")
    fun referencedCopyNames(): List<String>

    @Query("UPDATE share_inbox SET state = 'duplicate_of', duplicateOfShareId = :existingId, uploadPath = 'duplicate_reference' WHERE shareId = :id AND state = 'receiving'")
    fun markDuplicate(id: String, existingId: String): Int
}

class ShareInboxCommitter(private val dao: ShareInboxDao, private val directory: java.io.File,
    private val verifyExisting: ((ShareInboxItem) -> Boolean)? = null) {
    companion object { private val lock = Any() }
    fun commit(id: String, sealed: SealedCopy): Boolean = synchronized(lock) {
        var existing = dao.findExactStaged(sealed.sha256, sealed.byteLength)
        if (existing != null && verifyExisting != null && dao.item(existing)?.let(verifyExisting) != true) {
            check(dao.markUploadFailed(existing,"copy_integrity_failed") == 1)
            existing = null
        }
        if (existing != null) {
            check(java.io.File(directory, sealed.fileName).delete())
            check(dao.markDuplicate(id, existing) == 1)
            false
        } else {
            val path = if (sealed.byteLength <= 10_485_760) "direct" else "pending_resumable"
            check(dao.markStaged(id, sealed.fileName, sealed.sha256, sealed.byteLength, path) == 1)
            true
        }
    }
}

class ShareInboxMigration(private val context: Context) : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        val statements = context.assets.open("migrations/1-2.sql").bufferedReader().use { it.readText() }
        statements.split(';').map(String::trim).filter(String::isNotEmpty).forEach(db::execSQL)
    }
}

class ShareRetentionMigration(private val context: Context) : Migration(4, 5) {
    override fun migrate(db: SupportSQLiteDatabase) {
        val statements = context.assets.open("migrations/4-5.sql").bufferedReader().use { it.readText() }
        statements.split(';').map(String::trim).filter(String::isNotEmpty).forEach(db::execSQL)
    }
}
