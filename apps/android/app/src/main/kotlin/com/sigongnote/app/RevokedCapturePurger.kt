package com.sigongnote.app

import java.io.File

/** A revoked queue row releases only its app-private copy; provider originals are never opened. */
class RevokedCapturePurger(private val db: CaptureQueueDatabase,
    private val privateFiles: File, private val vault: TokenVault? = null) {
    private val copyName = Regex("^[0-9a-fA-F-]{36}\\.sealed$")

    data class Result(val purged: Int, val failed: Int)

    fun purgePending(now: Long = System.currentTimeMillis(), maxItems: Int = 100): Result {
        require(maxItems > 0)
        var purged = 0
        var failed = 0
        for (candidate in db.queueDao().revokedPending(maxItems)) {
            var closed = false
            try {
                db.runInTransaction {
                    val queue = db.queueDao().get(candidate.captureId)
                    if (queue?.state != "revoked_pending_purge" ||
                        queue.sourceGeneration != candidate.sourceGeneration) return@runInTransaction
                    val share = db.shareInboxDao().item(queue.captureId)
                    val folder = db.folderDao().observation(queue.captureId)
                    val notification = db.notificationDao().snapshot(queue.captureId)
                    check(listOf(share,folder,notification).count { it != null } == 1) {
                        "revoked_capture_unresolved"
                    }
                    when {
                        share != null -> {
                            check(share.state in setOf("staged_unbound","failed_visible"))
                            releaseCopy("share-inbox",share.encryptedCopyName,
                                share.encryptedCopyName?.let {
                                    db.shareInboxDao().otherCopyReferences(it,share.shareId)
                                } ?: 0)
                            check(db.shareInboxDao().markRevokedPurged(queue.captureId) == 1)
                        }
                        folder != null -> {
                            check(folder.state in setOf("staged_unbound","superseded_revision",
                                "missing_observation","failed_visible"))
                            val source = db.folderDao().source(folder.localSourceId)
                            check(source != null && FolderBindingPolicy.matches(source,queue.tenantId,
                                queue.userId,queue.deviceId))
                            releaseCopy("folder-copies",folder.encryptedCopyName,
                                db.folderDao().otherCopyReferences(folder.encryptedCopyName,
                                    folder.observationId))
                            check(db.folderDao().markRevokedPurged(queue.captureId) == 1)
                        }
                        notification != null -> {
                            check(notification.tenantId == queue.tenantId &&
                                notification.userId == queue.userId &&
                                notification.deviceId == queue.deviceId)
                            check(db.notificationDao().markRevokedPurged(queue.captureId) == 1)
                        }
                    }
                    check(db.queueDao().markRevokedPurged(queue.captureId,
                        queue.sourceGeneration,now) == 1)
                    closed = true
                }
            } catch (_: Exception) {
                failed++
                runCatching {
                    db.queueDao().deferFailedPurge(candidate.captureId,
                        candidate.sourceGeneration,maxOf(now,candidate.updatedAtEpochMs + 1))
                }
            }
            if (closed) {
                try { vault?.clearProgress(candidate.captureId) }
                catch (_: Exception) { /* A stale encrypted attempt is never reused by a new ID. */ }
                purged++
            }
        }
        return Result(purged,failed)
    }

    private fun releaseCopy(folder: String, name: String?, otherReferences: Int) {
        if (name == null || otherReferences > 0) return
        check(copyName.matches(name)) { "revoked_copy_name_invalid" }
        val directory = File(privateFiles,folder)
        val copy = File(directory,name)
        check(copy.canonicalFile.parentFile == directory.canonicalFile) {
            "revoked_copy_path_invalid"
        }
        if (copy.exists()) check(copy.isFile && copy.delete()) { "revoked_copy_delete_failed" }
    }
}
