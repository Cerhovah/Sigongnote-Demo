package com.sigongnote.app

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase

@Entity(tableName = "capture_queue", indices = [
    Index(value = ["sourceId", "sourceGeneration", "state"]),
    Index(value = ["tenantId", "userId", "deviceId", "state"]),
])
data class CaptureQueueItem(
    @PrimaryKey val captureId: String,
    val tenantId: String,
    val userId: String,
    val deviceId: String,
    val sourceId: String,
    val sourceGeneration: Int,
    val state: String,
    val encryptedCopyName: String?,
    val sha256: String?,
    val byteLength: Long?,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
    val acknowledgedAtEpochMs: Long? = null,
)

@Dao
interface CaptureQueueDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insert(item: CaptureQueueItem)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertIfAbsent(item: CaptureQueueItem): Long

    @Query("SELECT * FROM capture_queue WHERE captureId = :captureId")
    fun get(captureId: String): CaptureQueueItem?

    @Query("SELECT COUNT(*) FROM capture_queue WHERE state NOT IN ('acknowledged','revoked_purged')")
    fun pendingCount(): Int

    @Query("SELECT COUNT(*) FROM capture_queue WHERE state IN ('membership_lost','failed_visible') AND captureId NOT IN (SELECT shareId FROM share_inbox WHERE failureCode='storage_quota_paused')")
    fun blockedCount(): Int

    @Query("SELECT COUNT(*) FROM capture_queue WHERE userId=:user AND deviceId=:device AND (state='storage_quota_paused' OR (state IN ('failed_visible','paused_logout','needs_revalidation') AND captureId IN (SELECT shareId FROM share_inbox WHERE failureCode='storage_quota_paused')))")
    fun quotaPausedCount(user:String,device:String):Int

    @Query("UPDATE capture_queue SET state='storage_quota_paused',updatedAtEpochMs=:now WHERE userId=:user AND deviceId=:device AND (state IN ('ready','retry_wait','needs_revalidation','uploading') OR (state IN ('failed_visible','paused_logout') AND captureId IN (SELECT shareId FROM share_inbox WHERE failureCode='storage_quota_paused')))")
    fun pauseStorageAccount(user:String,device:String,now:Long):Int

    @Query("UPDATE capture_queue SET state='ready',updatedAtEpochMs=:now WHERE tenantId=:tenant AND userId=:user AND deviceId=:device AND state='storage_quota_paused' AND byteLength>0 AND byteLength<=:available")
    fun resumeStorageQuota(tenant:String,user:String,device:String,available:Long,now:Long):Int

    @Query("SELECT * FROM capture_queue WHERE state = 'revoked_pending_purge' ORDER BY updatedAtEpochMs, captureId LIMIT :maxItems")
    fun revokedPending(maxItems: Int): List<CaptureQueueItem>

    @Query("UPDATE capture_queue SET updatedAtEpochMs = :now WHERE captureId = :id AND sourceGeneration = :generation AND state = 'revoked_pending_purge'")
    fun deferFailedPurge(id: String, generation: Int, now: Long): Int

    @Query("SELECT COUNT(*) FROM capture_queue WHERE state = 'revoked_pending_purge'")
    fun revokedPendingCount(): Int

    @Query("UPDATE capture_queue SET state = 'revoked_purged', encryptedCopyName = NULL, updatedAtEpochMs = :now WHERE captureId = :id AND sourceGeneration = :generation AND state = 'revoked_pending_purge'")
    fun markRevokedPurged(id: String, generation: Int, now: Long): Int

    @Query("SELECT * FROM capture_queue WHERE tenantId = :tenant AND userId = :user AND deviceId = :device AND state IN ('ready','retry_wait','needs_revalidation') AND captureId NOT IN (SELECT o.observationId FROM folder_observations o JOIN folder_sources s ON s.localSourceId=o.localSourceId WHERE s.state NOT IN ('current','scanning','scan_gap','quota_pause') OR (s.scopeFingerprint IS NOT NULL AND s.bindingState!='ready')) ORDER BY COALESCE((SELECT providerModifiedAtEpochMs FROM folder_observations o WHERE o.observationId=capture_queue.captureId),createdAtEpochMs) DESC LIMIT 10")
    fun uploadCandidates(tenant: String, user: String, device: String): List<CaptureQueueItem>

    @Query("UPDATE capture_queue SET encryptedCopyName = :name, updatedAtEpochMs = :now WHERE captureId = :captureId AND sha256 = :sha256 AND state IN ('ready','retry_wait','needs_revalidation')")
    fun refreshReadyCopy(captureId: String, sha256: String, name: String, now: Long): Int

    @Query("UPDATE capture_queue SET state = 'retry_wait', updatedAtEpochMs = :now WHERE state = 'uploading' AND updatedAtEpochMs < :before")
    fun requeueInterrupted(now: Long, before: Long): Int

    @Query("UPDATE capture_queue SET updatedAtEpochMs = :now WHERE captureId = :captureId AND sourceGeneration = :generation AND state = 'uploading'")
    fun heartbeat(captureId: String, generation: Int, now: Long): Int

    @Query("UPDATE capture_queue SET encryptedCopyName = NULL WHERE captureId = :captureId AND state = 'acknowledged'")
    fun clearAcknowledgedCopy(captureId: String): Int

    @Query("UPDATE capture_queue SET state = 'membership_lost', updatedAtEpochMs = :now WHERE tenantId = :tenant AND userId = :user AND deviceId = :device AND state NOT IN ('acknowledged','revoked_purged','membership_lost','failed_visible')")
    fun stopForMembership(tenant: String, user: String, device: String, now: Long): Int

    @Query("UPDATE capture_queue SET state = :next, updatedAtEpochMs = :now, acknowledgedAtEpochMs = CASE WHEN :next = 'acknowledged' THEN :now ELSE acknowledgedAtEpochMs END WHERE captureId = :captureId AND state = :current AND sourceGeneration = :generation")
    fun transition(captureId: String, generation: Int, current: String, next: String, now: Long): Int

    @Query("UPDATE capture_queue SET state = 'revoked_pending_purge', updatedAtEpochMs = :now WHERE sourceId = :sourceId AND sourceGeneration = :generation AND tenantId = :tenantId AND userId = :userId AND deviceId = :deviceId AND state NOT IN ('acknowledged','revoked_purged','revoked_pending_purge')")
    fun stopForRevocation(sourceId: String, generation: Int, tenantId: String,
        userId: String, deviceId: String, now: Long): Int

    @Query("UPDATE capture_queue SET state = 'revoked_pending_purge', updatedAtEpochMs = :now WHERE captureId IN (SELECT snapshotId FROM notification_snapshots WHERE packageName = :packageName AND conversationHash = :hash AND state = 'approved_local') AND state NOT IN ('acknowledged','revoked_purged','revoked_pending_purge')")
    fun stopForNotificationScope(packageName: String, hash: String, now: Long): Int

    @Query("UPDATE capture_queue SET state = 'revoked_pending_purge', updatedAtEpochMs = :now WHERE captureId IN (SELECT snapshotId FROM notification_snapshots WHERE packageName = :packageName) AND state NOT IN ('acknowledged','revoked_purged','revoked_pending_purge')")
    fun stopForNotificationPackage(packageName: String, now: Long): Int

    @Query("UPDATE capture_queue SET state = 'paused_logout', updatedAtEpochMs = :now WHERE state NOT IN ('acknowledged','revoked_purged','revoked_pending_purge','paused_logout','storage_quota_paused')")
    fun pauseForLogout(now: Long): Int

    @Query("UPDATE capture_queue SET state = 'needs_revalidation', updatedAtEpochMs = :now WHERE tenantId = :tenantId AND userId = :userId AND deviceId = :deviceId AND state = 'paused_logout'")
    fun resumeBound(tenantId: String, userId: String, deviceId: String, now: Long): Int

    @Query("SELECT COUNT(*) FROM capture_queue WHERE state = 'paused_logout' AND (tenantId != :tenantId OR userId != :userId OR deviceId != :deviceId)")
    fun otherAccountCount(tenantId: String, userId: String, deviceId: String): Int
}

@Database(entities = [CaptureQueueItem::class, ShareInboxItem::class,
    FolderSource::class, FolderObservation::class, FolderPending::class,
    NotificationSource::class, NotificationScope::class, NotificationSnapshot::class,
    NotificationHealth::class,FolderScanRun::class,FolderScanDirectory::class,FolderScanItem::class,CaptureCopyReceipt::class],
    version = 10, exportSchema = true)
abstract class CaptureQueueDatabase : RoomDatabase() {
    abstract fun copyReceiptDao(): CaptureCopyReceiptDao
    abstract fun queueDao(): CaptureQueueDao
    abstract fun shareInboxDao(): ShareInboxDao
    abstract fun folderScanDao(): FolderScanDao
    abstract fun folderDao(): FolderDao
    abstract fun notificationDao(): NotificationDao
}

/** All callers must use this gate instead of making arbitrary DAO state changes. */
class CaptureQueueStore(private val dao: CaptureQueueDao) {
    fun move(captureId: String, generation: Int, current: String, next: String, now: Long): Int {
        if (!QueueTransitions.canMove(current, next)) return 0
        return dao.transition(captureId, generation, current, next, now)
    }

    fun resume(tenantId: String, userId: String, deviceId: String, now: Long): Int =
        dao.resumeBound(tenantId, userId, deviceId, now)

    fun otherAccountCount(tenantId: String, userId: String, deviceId: String): Int =
        dao.otherAccountCount(tenantId, userId, deviceId)
}

object QueueTransitions {
    private val allowed = mapOf(
        "discovered" to setOf("staging", "permission_lost", "source_unavailable", "revoked_pending_purge"),
        "staging" to setOf("ready", "retry_wait", "permission_lost", "source_unavailable", "revoked_pending_purge"),
        "ready" to setOf("uploading", "retry_wait", "failed_visible", "revoked_pending_purge"),
        "uploading" to setOf("acknowledged", "retry_wait", "failed_visible", "membership_lost", "revoked_pending_purge", "storage_quota_paused"),
        "storage_quota_paused" to setOf("ready", "revoked_pending_purge"),
        "retry_wait" to setOf("staging", "ready", "failed_visible", "revoked_pending_purge"),
        "permission_lost" to setOf("staging", "revoked_pending_purge"),
        "source_unavailable" to setOf("staging", "revoked_pending_purge"),
        "paused_logout" to setOf("needs_revalidation", "revoked_pending_purge"),
        "needs_revalidation" to setOf("staging", "failed_visible", "permission_lost", "source_unavailable", "revoked_pending_purge"),
        "revoked_pending_purge" to setOf("revoked_purged"),
    )
    fun canMove(current: String, next: String): Boolean = next in (allowed[current] ?: emptySet())
}
