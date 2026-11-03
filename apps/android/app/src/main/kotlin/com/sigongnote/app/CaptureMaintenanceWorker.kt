package com.sigongnote.app

import android.content.Context
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import java.io.File

object CaptureMaintenanceWork {
    fun continueScan(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork("capture-scan-continuation",
            ExistingWorkPolicy.APPEND_OR_REPLACE,OneTimeWorkRequestBuilder<CaptureMaintenanceWorker>()
                .setInitialDelay(3,java.util.concurrent.TimeUnit.SECONDS).build())
    }

    fun enqueue(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork("capture-maintenance-revocation",
            ExistingWorkPolicy.KEEP,OneTimeWorkRequestBuilder<CaptureMaintenanceWorker>().build())
    }
}

/** Deferrable reconciliation; Android may delay it under Doze or after force-stop. */
class CaptureMaintenanceWorker(context: Context, parameters: WorkerParameters) :
    Worker(context,parameters) {
    override fun doWork(): Result {
        val app = applicationContext as SigongnoteApp
        val preferences = applicationContext.getSharedPreferences("capture_maintenance",
            Context.MODE_PRIVATE)
        preferences.edit().putLong("attempt_at",System.currentTimeMillis()).apply()
        return try {
            val db = app.queue
            val now = System.currentTimeMillis()
            app.notificationExecutor.submit {
                NotificationSourceGuard.enforce(applicationContext,db)
                db.notificationDao().purgeExpiredCandidates(now)
            }.get()
            db.shareInboxDao().failStaleReceiving(now - 60L * 60 * 1000)
            val more=app.scanExecutor.submit<Boolean> {
                runCatching { CaptureCopyRetention(applicationContext,db).reclaim() }
                FolderScanner(applicationContext,db).scanAll()
            }.get()
            removeOrphans(File(applicationContext.filesDir,"share-inbox"),
                db.shareInboxDao().referencedCopyNames().toSet(),now)
            removeOrphans(File(applicationContext.filesDir,"folder-copies"),
                db.folderDao().referencedCopyNames().toSet(),now)
            val revoked = try {
                RevokedCapturePurger(db,applicationContext.filesDir,
                    TokenVault(applicationContext)).purgePending(now)
            } catch (_: Exception) { null }
            // ACK alone cannot authorize removal. CaptureCopyRetention proves recovery first.
            AcknowledgedNotificationRetention(db).purgeExpired(now)
            val status = preferences.edit().putLong("success_at",System.currentTimeMillis())
            if (revoked?.failed == 0 &&
                runCatching { db.queueDao().revokedPendingCount() == 0 }.getOrDefault(false))
                status.remove("error")
            else status.putString("error","revoked_purge_retry")
            status.apply()
            if(more)CaptureMaintenanceWork.continueScan(applicationContext)
            Result.success()
        } catch (_: Exception) {
            preferences.edit().putString("error","maintenance_retry").apply()
            Result.retry()
        }
    }

    private fun removeOrphans(directory: File, references: Set<String>, now: Long) {
        if (!directory.isDirectory) return
        directory.listFiles()?.forEach { file ->
            if (file.isFile && CaptureOrphanPolicy.shouldDelete(file.name,
                    file.lastModified(),references,now)) file.delete()
        }
    }
}

class AcknowledgedNotificationRetention(private val db: CaptureQueueDatabase) {
    fun purgeExpired(now: Long): Int {
        val cutoff = now - 7L * 24 * 60 * 60 * 1000
        var cleared = 0
        for (snapshot in db.notificationDao().expiredAcknowledged(cutoff)) {
            db.runInTransaction {
                val queue = db.queueDao().get(snapshot.snapshotId)
                if (queue?.state == "acknowledged" &&
                    (queue.acknowledgedAtEpochMs ?: Long.MAX_VALUE) <= cutoff &&
                    db.notificationDao().clearAcknowledgedPayload(snapshot.snapshotId) == 1)
                    cleared++
            }
        }
        return cleared
    }
}

/** Only app-private sealed copies can expire; provider originals are never addressed here. */
class AcknowledgedCopyRetention(private val db: CaptureQueueDatabase,
    private val directory: File,private val recoveryVerified:(String)->Boolean={false}) {
    fun purgeExpired(now: Long): Int {
        val cutoff = now - 7L * 24 * 60 * 60 * 1000
        var purged = 0
        for (candidate in db.shareInboxDao().expiredAcknowledged(cutoff)) {
            db.runInTransaction {
                val item = db.shareInboxDao().item(candidate.shareId)
                val queue = db.queueDao().get(candidate.shareId)
                val name = item?.encryptedCopyName
                if (item?.state != "acknowledged" || item.retentionHold || name == null ||
                    queue?.state != "acknowledged" ||
                    (queue.acknowledgedAtEpochMs ?: Long.MAX_VALUE) > cutoff ||
                    db.shareInboxDao().otherCopyReferences(name,item.shareId) != 0 || !recoveryVerified(item.shareId))
                    return@runInTransaction
                check(Regex("^[0-9a-fA-F-]{36}\\.sealed$").matches(name))
                val copy = File(directory,name)
                check(copy.canonicalFile.parentFile == directory.canonicalFile)
                if (copy.exists()) check(copy.isFile && copy.delete())
                check(db.shareInboxDao().markAcknowledgedCopyPurged(item.shareId,name) == 1)
                check(db.queueDao().clearAcknowledgedCopy(item.shareId) == 1)
                purged++
            }
        }
        return purged
    }
}

object CaptureOrphanPolicy {
    fun shouldDelete(name: String, modifiedAt: Long, references: Set<String>, now: Long): Boolean =
        name !in references &&
        (name.endsWith(".sealed") ||
            (name.startsWith("staging-") && name.endsWith(".tmp"))) &&
        modifiedAt < now - 60L * 60 * 1000
}
