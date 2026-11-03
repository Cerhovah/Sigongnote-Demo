package com.sigongnote.app

import android.content.Context
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(tableName = "folder_sources", indices = [Index(value = ["serverSourceId"], unique = true)])
data class FolderSource(
    @PrimaryKey val localSourceId: String,
    val encryptedTreeUri: String,
    val scopeVersion: Int,
    val state: String,
    val scanGeneration: Int,
    val lastAttemptAtEpochMs: Long?,
    val lastSuccessfulScanAtEpochMs: Long?,
    val observedCount: Int,
    val eligibleCount: Int,
    val excludedCount: Int,
    val pendingCount: Int,
    val lastErrorCode: String?,
    val serverSourceId: String?,
    val serverGeneration: Int?,
    val selectedAtEpochMs: Long,
    val boundTenantId: String? = null,
    val boundUserId: String? = null,
    val boundDeviceId: String? = null,
    @androidx.room.ColumnInfo(defaultValue = "'folder'") val kind: String = "folder",
    @androidx.room.ColumnInfo(defaultValue = "'legacy_recent'") val historyMode: String = "legacy_recent",
    val historySinceEpochMs: Long? = null,
    @androidx.room.ColumnInfo(defaultValue = "'work_dedicated'") val scopeMode: String = "work_dedicated",
    val scopeFingerprint: String? = null,
    @androidx.room.ColumnInfo(defaultValue = "0") val serverUploadConsent: Boolean = false,
    val processingPolicyId: String? = null,
    val processingPolicySnapshot: String? = null,
    val projectId: String? = null,
    val encryptedProjectName: String? = null,
    @androidx.room.ColumnInfo(defaultValue = "'local_only'") val bindingState: String = "local_only",
    val bindingError: String? = null,
)

@Entity(tableName = "folder_observations", indices = [
    Index(value = ["localSourceId", "documentIdHash", "sha256"]),
    Index(value = ["localSourceId", "lastSeenGeneration"]),
])
data class FolderObservation(
    @PrimaryKey val observationId: String,
    val localSourceId: String,
    val documentIdHash: String,
    val sha256: String,
    val byteLength: Long,
    val declaredMime: String,
    val encryptedCopyName: String,
    val providerSize: Long?,
    val providerModifiedAtEpochMs: Long?,
    val lastSeenGeneration: Int,
    val state: String,
    val observedAtEpochMs: Long,
    val supersededBy: String? = null,
    val serverDocumentId: String? = null,
    val serverRevisionId: String? = null,
    val serverDocumentVersion: Int? = null,
)

@Entity(tableName = "folder_pending", primaryKeys = ["localSourceId", "documentIdHash"])
data class FolderPending(
    val localSourceId: String,
    val documentIdHash: String,
    val attempts: Int,
    val providerSize: Long? = null,
    val providerModifiedAtEpochMs: Long? = null,
)

@Dao
interface FolderDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertSource(source: FolderSource)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertObservation(observation: FolderObservation): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun putPending(pending: FolderPending)

    @Query("SELECT attempts FROM folder_pending WHERE localSourceId = :sourceId AND documentIdHash = :docHash")
    fun pendingAttempts(sourceId: String, docHash: String): Int?

    @Query("SELECT * FROM folder_pending WHERE localSourceId = :sourceId AND documentIdHash = :docHash")
    fun pendingMarker(sourceId: String, docHash: String): FolderPending?

    @Query("DELETE FROM folder_pending WHERE localSourceId = :sourceId AND documentIdHash = :docHash")
    fun clearPending(sourceId: String, docHash: String)

    @Query("SELECT * FROM folder_sources WHERE localSourceId = :id")
    fun source(id: String): FolderSource?

    @Query("SELECT * FROM folder_sources WHERE serverSourceId = :serverId LIMIT 1")
    fun sourceForServer(serverId: String): FolderSource?

    @Query("UPDATE folder_sources SET serverSourceId = :serverId, serverGeneration = :generation, boundTenantId = :tenant, boundUserId = :user, boundDeviceId = :device WHERE localSourceId = :localId AND state IN ('selected','scanning','current','scan_gap') AND serverSourceId IS NULL")
    fun bindServerSource(localId: String, serverId: String, generation: Int,
        tenant: String, user: String, device: String): Int

    @Query("SELECT * FROM folder_sources WHERE scopeFingerprint = :fingerprint AND state != 'paused' LIMIT 1")
    fun sourceForScope(fingerprint: String): FolderSource?

    @Query("UPDATE folder_sources SET boundTenantId = :tenant, boundUserId = :user, boundDeviceId = :device, serverUploadConsent = 1, processingPolicyId = :policyId, processingPolicySnapshot = :policySnapshot, projectId = :project, encryptedProjectName = :projectName, kind = :kind, scopeFingerprint = :fingerprint, historyMode = :history, historySinceEpochMs = :since, bindingState = 'pending', bindingError = NULL WHERE localSourceId = :id AND bindingState = 'local_only' AND boundTenantId IS NULL AND serverSourceId IS NULL AND state != 'paused'")
    fun connectLocalSource(id: String, tenant: String, user: String, device: String,
        policyId: String, policySnapshot: String, project: String?, projectName: String?,
        kind: String, fingerprint: String, history: String, since: Long?): Int

    @Query("UPDATE folder_sources SET encryptedTreeUri = :handle, scopeVersion = 2 WHERE localSourceId = :id AND bindingState = 'local_only' AND boundTenantId IS NULL AND serverSourceId IS NULL AND state != 'paused'")
    fun prepareLocalChildHandle(id: String, handle: String): Int

    @Query("UPDATE folder_sources SET encryptedTreeUri = :handle, scopeVersion = 2 WHERE localSourceId = :id AND state = 'permission_lost'")
    fun restoreChildGrant(id: String, handle: String): Int

    @Query("SELECT * FROM folder_sources WHERE serverUploadConsent = 1 AND bindingState IN ('pending','retry') AND state != 'paused' AND boundTenantId = :tenant AND boundUserId = :user AND boundDeviceId = :device")
    fun pendingBindings(tenant: String, user: String, device: String): List<FolderSource>

    @Query("UPDATE folder_sources SET projectId = :project WHERE localSourceId = :id AND projectId IS NULL AND bindingState IN ('pending','retry') AND state != 'paused'")
    fun recordProject(id: String, project: String): Int

    @Query("UPDATE folder_sources SET serverSourceId = :serverId, serverGeneration = :generation WHERE localSourceId = :id AND boundTenantId = :tenant AND boundUserId = :user AND boundDeviceId = :device AND (serverSourceId IS NULL OR (serverSourceId = :serverId AND serverGeneration = :generation))")
    fun recordRegistration(id: String, serverId: String, generation: Int,
        tenant: String, user: String, device: String): Int

    @Query("UPDATE folder_sources SET serverSourceId = :serverId, serverGeneration = :generation, bindingState = 'ready', bindingError = NULL WHERE localSourceId = :id AND serverUploadConsent = 1 AND bindingState IN ('pending','retry') AND state != 'paused' AND boundTenantId = :tenant AND boundUserId = :user AND boundDeviceId = :device")
    fun finishBinding(id: String, serverId: String, generation: Int, tenant: String, user: String, device: String): Int

    @Query("UPDATE folder_sources SET bindingState = :state, bindingError = :error WHERE localSourceId = :id AND bindingState IN ('pending','retry') AND state != 'paused'")
    fun bindingFailed(id: String, state: String, error: String): Int

    @Query("SELECT o.* FROM folder_observations AS o JOIN folder_sources AS s ON s.localSourceId = o.localSourceId WHERE o.state = 'staged_unbound' AND s.serverSourceId IS NOT NULL AND s.serverGeneration IS NOT NULL AND s.state IN ('current','scanning','scan_gap','quota_pause') AND (s.scopeFingerprint IS NULL OR s.bindingState = 'ready') ORDER BY o.observedAtEpochMs LIMIT 30")
    fun uploadable(): List<FolderObservation>

    @Query("UPDATE folder_observations SET state = CASE WHEN supersededBy IS NULL THEN 'acknowledged' ELSE 'acknowledged_superseded' END, serverDocumentId = :documentId, serverRevisionId = :revisionId, serverDocumentVersion = :version WHERE observationId = :id AND state IN ('staged_unbound','superseded_revision')")
    fun markAcknowledged(id: String, documentId: String, revisionId: String, version: Int): Int

    @Query("SELECT * FROM folder_observations WHERE localSourceId = :localId AND documentIdHash = :docHash AND observedAtEpochMs < :before AND serverRevisionId IS NOT NULL ORDER BY observedAtEpochMs DESC LIMIT 1")
    fun latestAcknowledgedBefore(localId: String, docHash: String, before: Long): FolderObservation?

    @Query("SELECT COUNT(*) FROM folder_observations AS o JOIN capture_queue AS q ON q.captureId = o.observationId WHERE o.localSourceId = :localId AND o.documentIdHash = :docHash AND o.observedAtEpochMs < :before AND o.serverRevisionId IS NULL AND q.state IN ('ready','retry_wait','needs_revalidation','uploading','paused_logout','storage_quota_paused')")
    fun olderInFlight(localId: String, docHash: String, before: Long): Int

    @Query("UPDATE folder_observations SET state = 'failed_visible' WHERE observationId = :id AND state IN ('staged_unbound','superseded_revision')")
    fun markUploadFailed(id: String): Int

    @Query("SELECT COUNT(*) FROM folder_observations WHERE encryptedCopyName = :name AND observationId != :id AND state != 'revoked_purged'")
    fun otherCopyReferences(name: String, id: String): Int

    @Query("UPDATE folder_observations SET state = 'revoked_purged' WHERE observationId = :id AND state IN ('staged_unbound','superseded_revision','missing_observation','failed_visible')")
    fun markRevokedPurged(id: String): Int

    @Query("SELECT * FROM folder_sources WHERE state != 'paused' ORDER BY selectedAtEpochMs")
    fun activeSources(): List<FolderSource>

    @Query("SELECT COUNT(*) FROM folder_sources WHERE state IN ('current','scanning','selected')")
    fun connectedCount(): Int

    @Query("SELECT COUNT(*) FROM folder_sources WHERE state IN ('permission_lost','source_offline','scan_gap','quota_pause')")
    fun issueCount(): Int

    @Query("SELECT MAX(lastSuccessfulScanAtEpochMs) FROM folder_sources")
    fun latestSuccessfulScanAt(): Long?

    @Query("UPDATE folder_sources SET state = 'paused' WHERE localSourceId = :id AND state != 'paused'")
    fun pause(id: String): Int

    @Query("UPDATE folder_sources SET state='scan_gap',lastErrorCode='scan_interrupted' WHERE state='scanning'")
    fun recoverInterrupted():Int

    @Query("UPDATE folder_sources SET state = 'scanning', lastAttemptAtEpochMs = :now, lastErrorCode = NULL WHERE localSourceId = :id AND state != 'paused' AND (state != 'scanning' OR lastAttemptAtEpochMs < :staleBefore)")
    fun startScan(id: String, now: Long, staleBefore: Long): Int

    @Query("UPDATE folder_sources SET state = :state, lastErrorCode = :error WHERE localSourceId = :id AND state != 'paused'")
    fun scanFailed(id: String, state: String, error: String): Int

    @Query("UPDATE folder_sources SET state = 'current', scanGeneration = :generation, lastSuccessfulScanAtEpochMs = :now, observedCount = :observed, eligibleCount = :eligible, excludedCount = :excluded, pendingCount = 0, lastErrorCode = NULL WHERE localSourceId = :id AND state = 'scanning'")
    fun scanSucceeded(id: String, generation: Int, now: Long,
        observed: Int, eligible: Int, excluded: Int): Int

    @Query("UPDATE folder_sources SET state = :state, observedCount = :observed, eligibleCount = :eligible, excludedCount = :excluded, pendingCount = :pending, lastErrorCode = :error WHERE localSourceId = :id AND state = 'scanning'")
    fun scanIncomplete(id: String, observed: Int, eligible: Int, excluded: Int,
        pending: Int, error: String, state: String = "scan_gap"): Int

    @Query("SELECT * FROM folder_observations WHERE localSourceId = :sourceId AND documentIdHash = :documentIdHash AND providerSize = :size AND providerModifiedAtEpochMs = :modified AND state IN ('staged_unbound','missing_observation','acknowledged') ORDER BY observedAtEpochMs DESC LIMIT 1")
    fun unchanged(sourceId: String, documentIdHash: String, size: Long,
        modified: Long): FolderObservation?

    @Query("SELECT * FROM folder_observations WHERE localSourceId = :sourceId AND documentIdHash = :documentIdHash AND sha256 = :sha256 AND state IN ('staged_unbound','missing_observation','acknowledged') ORDER BY observedAtEpochMs DESC LIMIT 1")
    fun exact(sourceId: String, documentIdHash: String, sha256: String): FolderObservation?

    @Query("UPDATE folder_observations SET state = CASE WHEN state = 'acknowledged' THEN 'acknowledged_superseded' ELSE 'superseded_revision' END, supersededBy = :newId WHERE localSourceId = :sourceId AND documentIdHash = :docHash AND observationId != :newId AND state IN ('staged_unbound','missing_observation','acknowledged')")
    fun supersede(sourceId: String, docHash: String, newId: String): Int

    @Query("UPDATE folder_observations SET encryptedCopyName = :copyName, providerSize = :size, providerModifiedAtEpochMs = :modified, lastSeenGeneration = :generation, state = CASE WHEN state = 'missing_observation' THEN 'staged_unbound' ELSE state END WHERE observationId = :id AND state IN ('staged_unbound','missing_observation','acknowledged')")
    fun repairCopy(id: String, copyName: String, generation: Int, size: Long?, modified: Long?): Int

    @Query("SELECT * FROM folder_observations WHERE observationId = :id")
    fun observation(id: String): FolderObservation?

    @Query("UPDATE folder_observations SET lastSeenGeneration = :generation, providerSize = :size, providerModifiedAtEpochMs = :modified, state = CASE WHEN state = 'missing_observation' THEN 'staged_unbound' ELSE state END WHERE observationId = :id AND state IN ('staged_unbound','missing_observation','acknowledged')")
    fun seen(id: String, generation: Int, size: Long?, modified: Long?): Int

    @Query("UPDATE folder_observations SET state = 'missing_observation' WHERE localSourceId = :sourceId AND lastSeenGeneration < :generation AND state = 'staged_unbound'")
    fun markMissingAfterCompleteScan(sourceId: String, generation: Int): Int

    @Query("SELECT COALESCE(SUM(byteLength),0) FROM folder_observations WHERE state IN ('staged_unbound','missing_observation')")
    fun stagedBytes(): Long

    @Query("SELECT COALESCE(SUM(byteLength),0) FROM folder_observations WHERE state IN ('staged_unbound','missing_observation','superseded_revision')")
    fun retainedBytes(): Long

    @Query("SELECT COUNT(*) FROM folder_observations WHERE state IN ('staged_unbound','missing_observation','superseded_revision')")
    fun retainedCount(): Int

    @Query("SELECT COUNT(*) FROM folder_observations WHERE state IN ('staged_unbound','missing_observation')")
    fun stagedCount(): Int

    @Query("SELECT COUNT(*) FROM folder_observations WHERE state = 'missing_observation'")
    fun missingCount(): Int

    @Query("SELECT encryptedCopyName FROM folder_observations WHERE state != 'revoked_purged'")
    fun referencedCopyNames(): List<String>
}

class FolderMigration(private val context: Context) : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
        val statements = context.assets.open("migrations/2-3.sql").bufferedReader().use { it.readText() }
        statements.split(';').map(String::trim).filter(String::isNotEmpty).forEach(db::execSQL)
    }
}

class FolderBindingMigration(private val context: Context) : Migration(5, 6) {
    override fun migrate(db: SupportSQLiteDatabase) {
        val statements = context.assets.open("migrations/5-6.sql").bufferedReader().use { it.readText() }
        statements.split(';').map(String::trim).filter(String::isNotEmpty).forEach(db::execSQL)
    }
}

object FolderBindingPolicy {
    fun matches(source: FolderSource, tenant: String, user: String, device: String): Boolean =
        source.serverSourceId != null && source.serverGeneration != null &&
        source.boundTenantId == tenant && source.boundUserId == user &&
        source.boundDeviceId == device
}

class FolderScopeMigration(private val context: Context) : Migration(7,8) {
    override fun migrate(db: SupportSQLiteDatabase) {
        context.assets.open("migrations/7-8.sql").bufferedReader().use { it.readText() }
            .split(';').map(String::trim).filter(String::isNotEmpty).forEach(db::execSQL)
    }
}
