package com.sigongnote.app

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import android.content.Context

@Entity(tableName = "notification_sources")
data class NotificationSource(
    @PrimaryKey val packageName: String,
    val state: String,
    val selectedAtEpochMs: Long,
    val lastEventAtEpochMs: Long?,
)

@Entity(tableName = "notification_scopes", primaryKeys = ["packageName", "conversationHash"])
data class NotificationScope(
    val packageName: String,
    val conversationHash: String,
    val approvedAtEpochMs: Long,
    val encryptedLabel: String,
    val tenantId: String? = null,
    val userId: String? = null,
    val deviceId: String? = null,
)

@Entity(tableName = "notification_health")
data class NotificationHealth(
    @PrimaryKey val singletonId: Int,
    val state: String,
    val lastConnectedAtEpochMs: Long?,
    val lastDisconnectedAtEpochMs: Long?,
    val gapCount: Int,
    val lastGapStartAtEpochMs: Long?,
    val lastGapEndAtEpochMs: Long?,
)

@Entity(tableName = "notification_snapshots", indices = [
    Index(value = ["packageName", "keyHash", "updateIndex"], unique = true),
    Index(value = ["packageName", "conversationHash", "state"]),
    Index(value = ["expiresAtEpochMs"]),
])
data class NotificationSnapshot(
    @PrimaryKey val snapshotId: String,
    val packageName: String,
    val keyHash: String,
    val conversationHash: String?,
    val contentFingerprint: String,
    val updateIndex: Int,
    val encryptedPayload: String?,
    val observedAtEpochMs: Long,
    val expiresAtEpochMs: Long?,
    val state: String,
    val fromActiveAtReconnect: Boolean = false,
    val tenantId: String? = null,
    val userId: String? = null,
    val deviceId: String? = null,
)

@Dao
interface NotificationDao {
    @Query("SELECT packageName FROM notification_sources UNION SELECT packageName FROM notification_snapshots UNION SELECT packageName FROM notification_scopes")
    fun retainedPackages(): List<String>

    @Query("SELECT EXISTS(SELECT 1 FROM notification_sources WHERE packageName = :packageName AND state = 'selected') OR EXISTS(SELECT 1 FROM notification_scopes WHERE packageName = :packageName) OR EXISTS(SELECT 1 FROM notification_snapshots WHERE packageName = :packageName AND encryptedPayload IS NOT NULL)")
    fun hasRetainedPackageData(packageName: String): Boolean

    @Query("DELETE FROM notification_scopes WHERE packageName = :packageName")
    fun removePackageScopes(packageName: String): Int

    @Query("UPDATE notification_snapshots SET state = CASE WHEN state = 'acknowledged' THEN state ELSE 'revoked_purged' END, encryptedPayload = NULL, expiresAtEpochMs = NULL WHERE packageName = :packageName")
    fun purgePackage(packageName: String): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun putSource(source: NotificationSource)

    @Query("SELECT * FROM notification_sources WHERE packageName = :packageName")
    fun source(packageName: String): NotificationSource?

    @Query("SELECT COUNT(*) FROM notification_sources WHERE state = 'selected'")
    fun selectedCount(): Int

    @Query("SELECT * FROM notification_sources ORDER BY selectedAtEpochMs DESC")
    fun allSources(): List<NotificationSource>

    @Query("UPDATE notification_sources SET state = 'paused' WHERE packageName = :packageName")
    fun pause(packageName: String): Int

    @Query("UPDATE notification_sources SET state = :state WHERE packageName = :packageName")
    fun setState(packageName: String, state: String): Int

    @Query("UPDATE notification_sources SET state = 'paused' WHERE state = 'selected'")
    fun pauseAll(): Int

    @Query("UPDATE notification_sources SET lastEventAtEpochMs = :now WHERE packageName = :packageName AND state = 'selected'")
    fun recordEvent(packageName: String, now: Long): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertScope(scope: NotificationScope): Long

    @Query("SELECT COUNT(*) FROM notification_scopes WHERE packageName = :packageName AND conversationHash = :hash")
    fun hasScope(packageName: String, hash: String): Int

    @Query("SELECT * FROM notification_scopes WHERE packageName = :packageName AND conversationHash = :hash")
    fun scope(packageName: String, hash: String): NotificationScope?

    @Query("SELECT * FROM notification_scopes ORDER BY approvedAtEpochMs DESC")
    fun allScopes(): List<NotificationScope>

    @Query("DELETE FROM notification_scopes WHERE packageName = :packageName AND conversationHash = :hash")
    fun removeScope(packageName: String, hash: String): Int

    @Query("DELETE FROM notification_scopes")
    fun clearScopes(): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertSnapshot(snapshot: NotificationSnapshot): Long

    @Query("SELECT * FROM notification_snapshots WHERE packageName = :packageName AND keyHash = :keyHash ORDER BY updateIndex DESC LIMIT 1")
    fun latest(packageName: String, keyHash: String): NotificationSnapshot?

    @Query("SELECT * FROM notification_snapshots AS n WHERE n.packageName = :packageName AND n.conversationHash IS NOT NULL AND n.state = 'candidate_local' AND n.snapshotId = (SELECT m.snapshotId FROM notification_snapshots AS m WHERE m.packageName = n.packageName AND m.conversationHash = n.conversationHash AND m.state = 'candidate_local' ORDER BY m.observedAtEpochMs DESC LIMIT 1) ORDER BY n.observedAtEpochMs DESC LIMIT 20")
    fun scopeCandidates(packageName: String): List<NotificationSnapshot>

    @Query("SELECT * FROM notification_snapshots AS n WHERE n.packageName = :packageName AND n.conversationHash IS NOT NULL AND ((n.state = 'candidate_local' AND n.observedAtEpochMs >= :since) OR (n.state = 'paused_logout' AND n.tenantId = :tenant AND n.userId = :user AND n.deviceId = :device)) AND n.snapshotId = (SELECT m.snapshotId FROM notification_snapshots AS m WHERE m.packageName = n.packageName AND m.conversationHash = n.conversationHash AND ((m.state = 'candidate_local' AND m.observedAtEpochMs >= :since) OR (m.state = 'paused_logout' AND m.tenantId = :tenant AND m.userId = :user AND m.deviceId = :device)) ORDER BY m.observedAtEpochMs DESC LIMIT 1) ORDER BY n.observedAtEpochMs DESC LIMIT 20")
    fun scopeCandidatesForAccount(packageName: String, since: Long, tenant: String,
        user: String, device: String): List<NotificationSnapshot>

    @Query("SELECT * FROM notification_snapshots WHERE snapshotId = :id")
    fun snapshot(id: String): NotificationSnapshot?

    @Query("UPDATE notification_snapshots SET state = 'approved_local', expiresAtEpochMs = NULL WHERE packageName = :packageName AND conversationHash = :hash AND state = 'candidate_local'")
    fun approveCandidates(packageName: String, hash: String): Int

    @Query("UPDATE notification_snapshots SET state = 'approved_local', expiresAtEpochMs = NULL, tenantId = :tenant, userId = :user, deviceId = :device WHERE packageName = :packageName AND conversationHash = :hash AND ((state = 'candidate_local' AND observedAtEpochMs >= :since) OR (state = 'paused_logout' AND tenantId = :tenant AND userId = :user AND deviceId = :device))")
    fun approveCandidatesBound(packageName: String, hash: String, since: Long,
        tenant: String, user: String, device: String): Int

    @Query("SELECT n.* FROM notification_snapshots AS n JOIN notification_sources AS s ON s.packageName = n.packageName JOIN notification_scopes AS c ON c.packageName = n.packageName AND c.conversationHash = n.conversationHash WHERE n.state = 'approved_local' AND n.encryptedPayload IS NOT NULL AND n.tenantId = :tenant AND n.userId = :user AND n.deviceId = :device AND s.state = 'selected' AND c.tenantId = :tenant AND c.userId = :user AND c.deviceId = :device ORDER BY n.observedAtEpochMs LIMIT 30")
    fun uploadable(tenant: String, user: String, device: String): List<NotificationSnapshot>

    @Query("UPDATE notification_snapshots SET state = 'acknowledged' WHERE snapshotId = :id AND state = 'approved_local'")
    fun markAcknowledged(id: String): Int

    @Query("UPDATE notification_snapshots SET state = 'failed_visible' WHERE snapshotId = :id AND state = 'approved_local'")
    fun markUploadFailed(id: String): Int

    @Query("UPDATE notification_snapshots SET state = 'revoked_purged', encryptedPayload = NULL, expiresAtEpochMs = NULL WHERE snapshotId = :id AND state IN ('approved_local','failed_visible','paused_logout','revoked_purged')")
    fun markRevokedPurged(id: String): Int

    @Query("UPDATE notification_snapshots SET encryptedPayload = NULL WHERE snapshotId = :id AND state = 'acknowledged'")
    fun clearAcknowledgedPayload(id: String): Int

    @Query("SELECT n.* FROM notification_snapshots AS n JOIN capture_queue AS q ON q.captureId = n.snapshotId WHERE n.state = 'acknowledged' AND n.encryptedPayload IS NOT NULL AND q.state = 'acknowledged' AND q.acknowledgedAtEpochMs <= :before LIMIT 30")
    fun expiredAcknowledged(before: Long): List<NotificationSnapshot>

    @Query("UPDATE notification_snapshots SET state = 'revoked_purged', encryptedPayload = NULL, expiresAtEpochMs = NULL WHERE packageName = :packageName AND conversationHash = :hash AND state IN ('approved_local','candidate_local','no_body','failed_visible')")
    fun purgeConversation(packageName: String, hash: String): Int

    @Query("UPDATE notification_snapshots SET encryptedPayload = NULL WHERE packageName = :packageName AND conversationHash = :hash AND state = 'acknowledged'")
    fun clearAcknowledgedConversation(packageName: String, hash: String): Int

    @Query("DELETE FROM notification_snapshots WHERE state IN ('candidate_local','no_body')")
    fun clearUnconfirmed(): Int

    @Query("UPDATE notification_snapshots SET state = 'paused_logout' WHERE state = 'approved_local'")
    fun holdApprovedForLogout(): Int

    @Query("DELETE FROM notification_snapshots WHERE state IN ('candidate_local','no_body') AND expiresAtEpochMs <= :now")
    fun purgeExpiredCandidates(now: Long): Int

    @Query("SELECT COUNT(*) FROM notification_snapshots WHERE state IN ('candidate_local','no_body')")
    fun unconfirmedCount(): Int

    @Query("SELECT COUNT(*) FROM notification_snapshots WHERE state IN ('candidate_local','no_body','approved_local','paused_logout','failed_visible')")
    fun retainedCount(): Int

    @Query("SELECT COUNT(*) FROM notification_snapshots WHERE state = 'candidate_local'")
    fun candidateCount(): Int

    @Query("SELECT COUNT(*) FROM notification_snapshots WHERE state = 'approved_local'")
    fun approvedCount(): Int

    @Query("SELECT COUNT(*) FROM notification_snapshots WHERE state = 'failed_visible'")
    fun failedCount(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun putHealth(health: NotificationHealth)

    @Query("SELECT * FROM notification_health WHERE singletonId = 1")
    fun health(): NotificationHealth?
}

class NotificationMigration(private val context: Context) : Migration(3,4) {
    override fun migrate(db: SupportSQLiteDatabase) {
        val statements = context.assets.open("migrations/3-4.sql").bufferedReader().use { it.readText() }
        statements.split(';').map(String::trim).filter(String::isNotEmpty).forEach(db::execSQL)
    }
}

class NotificationUploadMigration(private val context: Context) : Migration(6,7) {
    override fun migrate(db: SupportSQLiteDatabase) {
        val statements = context.assets.open("migrations/6-7.sql").bufferedReader().use { it.readText() }
        statements.split(';').map(String::trim).filter(String::isNotEmpty).forEach(db::execSQL)
    }
}
