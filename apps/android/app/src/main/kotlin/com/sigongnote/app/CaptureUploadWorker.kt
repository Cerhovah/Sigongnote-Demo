package com.sigongnote.app

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import java.io.File
import java.time.Instant
import java.util.concurrent.TimeUnit

object CaptureUploadWork {
    private val connected = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    fun continueUpload(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork("capture-upload-continuation",
            ExistingWorkPolicy.APPEND_OR_REPLACE,OneTimeWorkRequestBuilder<CaptureUploadWorker>()
                .setConstraints(connected).setInitialDelay(3,TimeUnit.SECONDS).build())
    }
    fun schedule(context: Context) {
        val manager = WorkManager.getInstance(context)
        manager.enqueueUniquePeriodicWork("capture-upload",ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<CaptureUploadWorker>(15,TimeUnit.MINUTES)
                .setConstraints(connected).build())
        enqueue(context)
    }
    fun enqueue(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork("capture-upload-now",
            ExistingWorkPolicy.KEEP,OneTimeWorkRequestBuilder<CaptureUploadWorker>()
                .setConstraints(connected).setBackoffCriteria(
                    androidx.work.BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build())
    }
}

/** Transfers only account-bound local observations whose server source still has upload consent. */
class CaptureUploadWorker(context: Context, parameters: WorkerParameters) :
    Worker(context,parameters) {
    private val app = applicationContext as SigongnoteApp
    private val db = app.queue
    private val vault = TokenVault(applicationContext)
    private val allowLocal = applicationContext.applicationInfo.flags and
        ApplicationInfo.FLAG_DEBUGGABLE != 0
    private val manager = UploadSessionManager(vault,allowLocal)
    private val status = applicationContext.getSharedPreferences("capture_upload",Context.MODE_PRIVATE)

    override fun doWork(): Result {
        status.edit().putLong("attempt_at",System.currentTimeMillis()).apply()
        return try {
            app.uploadExecutor.submit<Result> { runUploads() }.get()
        } catch (_: Exception) {
            status.edit().putString("error","upload_retry").apply()
            Result.retry()
        }
    }

    private fun runUploads(): Result {
        NotificationSourceGuard.enforce(applicationContext,db)
        var session = try { manager.current() }
            catch (_: UploadSessionManager.LoginRequired) {
                db.queueDao().pauseForLogout(System.currentTimeMillis())
                status.edit().putString("error","sign_in_required").apply()
                return Result.success()
            }
        fun sourceReady(sourceId: String, generation: Int, kind: String): Boolean {
            return try { UploadApi(session).sourceReady(sourceId,generation,kind) }
            catch (error: UploadApi.Fault) {
                if (error.status != 401) throw error
                session = manager.forceRefresh(session.accessToken)
                try { UploadApi(session).sourceReady(sourceId,generation,kind) }
                catch (second: UploadApi.Fault) {
                    if (second.status == 401) {
                        vault.clearSession()
                        throw UploadSessionManager.LoginRequired()
                    }
                    throw second
                }
            }
        }
        fun readyNotificationSource(): UploadApi.ReadySource? {
            return try { UploadApi(session).singleReadySource("notifications") }
            catch (error: UploadApi.Fault) {
                if (error.status != 401) throw error
                session = manager.forceRefresh(session.accessToken)
                try { UploadApi(session).singleReadySource("notifications") }
                catch (second: UploadApi.Fault) {
                    if (second.status == 401) {
                        vault.clearSession()
                        throw UploadSessionManager.LoginRequired()
                    }
                    throw second
                }
            }
        }
        FolderConnections(db).resume(session)
        val now = System.currentTimeMillis()
        db.queueDao().resumeBound(session.tenantId,session.userId,session.deviceId,now)
        db.queueDao().requeueInterrupted(now,now - 30 * 60_000L)
        db.shareInboxDao().uploadableSince(session.connectedAtEpochMs).forEach { share ->
            val copy = share.encryptedCopyName ?: return@forEach
            db.queueDao().insertIfAbsent(CaptureQueueItem(share.shareId,session.tenantId,
                session.userId,session.deviceId,session.manualSourceId,
                session.manualGeneration,"ready",copy,share.sha256,share.byteLength,
                share.createdAtEpochMs,now))
        }
        db.folderDao().uploadable().forEach { observation ->
            val source = db.folderDao().source(observation.localSourceId) ?: return@forEach
            if (!FolderBindingPolicy.matches(source,session.tenantId,session.userId,
                    session.deviceId)) return@forEach
            val serverId = source.serverSourceId ?: return@forEach
            val generation = source.serverGeneration ?: return@forEach
            db.queueDao().insertIfAbsent(CaptureQueueItem(observation.observationId,
                session.tenantId,session.userId,session.deviceId,serverId,generation,
                "ready",observation.encryptedCopyName,observation.sha256,
                observation.byteLength,observation.observedAtEpochMs,now))
            db.queueDao().refreshReadyCopy(observation.observationId,observation.sha256,
                observation.encryptedCopyName,now)
        }
        val approvedNotifications = db.notificationDao().uploadable(session.tenantId,
            session.userId,session.deviceId).filter {
                NotificationSourceGuard.selectable(applicationContext,it.packageName)
            }
        var notificationSourceUnavailable = false
        if (approvedNotifications.isNotEmpty() && notificationAccessGranted()) {
            val serverSource = try { readyNotificationSource() }
                catch (_: UploadSessionManager.LoginRequired) {
                    db.queueDao().pauseForLogout(System.currentTimeMillis())
                    status.edit().putString("error","sign_in_required").apply()
                    return Result.success()
                } catch (error: UploadApi.Fault) {
                    if (!error.retryable) {
                        db.queueDao().stopForMembership(session.tenantId,session.userId,
                            session.deviceId,System.currentTimeMillis())
                        status.edit().putString("error","membership_lost").apply()
                        return Result.success()
                    }
                    notificationSourceUnavailable = true
                    status.edit().putString("error","notification_source_retry").apply()
                    null
                }
            if (serverSource == null && !notificationSourceUnavailable) {
                notificationSourceUnavailable = true
                status.edit().putString("error","notification_source_not_ready").apply()
            }
            if (serverSource != null) approvedNotifications.forEach { snapshot ->
                val payload = try { NotificationUploadPayload.encode(snapshot,NotificationVault()) }
                    catch (_: Exception) {
                        db.notificationDao().markUploadFailed(snapshot.snapshotId)
                        status.edit().putString("error","notification_payload_invalid").apply()
                        return@forEach
                    }
                db.runInTransaction {
                    val live = db.notificationDao().snapshot(snapshot.snapshotId)
                    val scope = live?.conversationHash?.let {
                        db.notificationDao().scope(live.packageName,it)
                    }
                    if (live?.state == "approved_local" && live.encryptedPayload != null &&
                        NotificationSourceGuard.selectable(applicationContext,live.packageName) &&
                        scope != null && db.notificationDao().source(live.packageName)?.state == "selected" &&
                        NotificationAccount.matches(live.tenantId,live.userId,live.deviceId,session) &&
                        NotificationAccount.matches(scope.tenantId,scope.userId,scope.deviceId,session))
                        db.queueDao().insertIfAbsent(CaptureQueueItem(snapshot.snapshotId,
                            session.tenantId,session.userId,session.deviceId,serverSource.id,
                            serverSource.generation,"ready",null,
                            NotificationUploadPayload.sha256(payload),payload.size.toLong(),
                            snapshot.observedAtEpochMs,now))
                }
            }
        } else if (approvedNotifications.isNotEmpty()) {
            notificationSourceUnavailable = true
            status.edit().putString("error","notification_access_missing").apply()
        }
        val quota=CaptureStorageQuota(db)
        if(quota.paused(session)) {
            val available=try { UploadApi(session).storageAvailableBytes() }
                catch(error:UploadApi.Fault) {
                    if(error.status!=401)throw error
                    session=manager.forceRefresh(session.accessToken)
                    UploadApi(session).storageAvailableBytes()
                }
            if(!quota.resume(session,available)) {
                status.edit().putString("error","storage_quota_paused").apply()
                return Result.success()
            }
        }
        val candidates = db.queueDao().uploadCandidates(session.tenantId,session.userId,
            session.deviceId).take(3)
        var hadFailure = notificationSourceUnavailable
        var progressed=0
        for (candidate in candidates) {
            if (isStopped) return Result.retry()
            val current = db.queueDao().get(candidate.captureId) ?: continue
            val queue = CaptureQueueStore(db.queueDao())
            val kind = sourceKind(current,session)
            if (kind == null) {
                val folder = db.folderDao().sourceForServer(current.sourceId)
                if (folder != null && FolderBindingPolicy.matches(folder,session.tenantId,
                        session.userId,session.deviceId))
                    stopForRevocation(current)
                continue
            }
            if (FolderSourcePolicy.isFolderKind(kind) && !localFolderScopeAllows(current)) {
                db.runInTransaction {
                    if(queue.move(current.captureId,current.sourceGeneration,current.state,"failed_visible",
                            System.currentTimeMillis())==1)markUploadFailed(current,kind,"file_scope_mismatch")
                }
                status.edit().putString("error","file_scope_mismatch").apply()
                hadFailure=true;progressed++;continue
            }
            if (FolderSourcePolicy.isFolderKind(kind) && !localFolderReady(current)) {
                db.folderDao().sourceForServer(current.sourceId)?.let {
                    if(it.state in setOf("current","scanning","scan_gap","quota_pause") && folderGrant(it)==false) {
                        db.folderDao().scanFailed(it.localSourceId,"permission_lost","persisted_grant_missing")
                        progressed++;hadFailure=true
                    }
                }
                continue
            }
            if (kind == "notifications" && !localNotificationReady(current,session)) continue
            if (FolderSourcePolicy.isFolderKind(kind)) {
                val observation = db.folderDao().observation(current.captureId) ?: continue
                if (db.folderDao().olderInFlight(observation.localSourceId,
                        observation.documentIdHash,observation.observedAtEpochMs) > 0) continue
            }
            val ready = try { sourceReady(current.sourceId,current.sourceGeneration,kind) }
                catch (_: UploadSessionManager.LoginRequired) {
                    db.queueDao().pauseForLogout(System.currentTimeMillis())
                    status.edit().putString("error","sign_in_required").apply()
                    return Result.success()
                } catch (error: UploadApi.Fault) {
                    if (!error.retryable) {
                        db.queueDao().stopForMembership(session.tenantId,session.userId,
                            session.deviceId,System.currentTimeMillis())
                        status.edit().putString("error","membership_lost").apply()
                        return Result.success()
                    }
                    throw error
                }
            if (!ready) {
                stopForRevocation(current)
                continue
            }
            val nowClaim = System.currentTimeMillis()
            when (current.state) {
                "retry_wait" -> queue.move(current.captureId,current.sourceGeneration,
                    "retry_wait","ready",nowClaim)
                "needs_revalidation" -> {
                    if (queue.move(current.captureId,current.sourceGeneration,
                            "needs_revalidation","staging",nowClaim) == 1)
                        queue.move(current.captureId,current.sourceGeneration,"staging","ready",nowClaim)
                }
            }
            if (queue.move(current.captureId,current.sourceGeneration,
                    "ready","uploading",System.currentTimeMillis()) != 1) continue
            try {
                val error = processWithRefresh(current,session,kind)
                if (error != null) {
                    if(error.code=="STORAGE_QUOTA_EXCEEDED") {
                        quota.pause(session)
                        status.edit().putString("error","storage_quota_paused").apply()
                        return Result.success()
                    }
                    if (error.status == 403 || error.status == 404) {
                        db.queueDao().stopForMembership(session.tenantId,session.userId,
                            session.deviceId,System.currentTimeMillis())
                        status.edit().putString("error","membership_lost").apply()
                        return Result.success()
                    }
                    if (error.code == "SOURCE_EXPIRED") {
                        if (!sourceReady(current.sourceId,current.sourceGeneration,kind)) {
                            stopForRevocation(current)
                            continue
                        }
                        vault.clearProgress(current.captureId)
                    }
                    if (error.status == 422 && error.code == "DOMAIN_INVARIANT")
                        vault.clearProgress(current.captureId)
                    if (!error.retryable && error.code != "SOURCE_EXPIRED" &&
                        !(error.status == 422 && error.code == "DOMAIN_INVARIANT")) {
                        queue.move(current.captureId,current.sourceGeneration,
                            "uploading","failed_visible",System.currentTimeMillis())
                        val code = when (error.code) {
                            "IDEMPOTENCY_CONFLICT" -> "server_capture_conflict"
                            "VERSION_CONFLICT" -> "revision_conflict"
                            "SOURCE_SCOPE_MISMATCH" -> "file_scope_mismatch"
                            else -> "server_rejected"
                        }
                        markUploadFailed(current,kind,code)
                        status.edit().putString("error",code).apply()
                        hadFailure=true; progressed++
                        continue
                    }
                    queue.move(current.captureId,current.sourceGeneration,"uploading",
                        "retry_wait",System.currentTimeMillis())
                    status.edit().putString("error","server_${error.code}").apply()
                    return Result.retry()
                }
                if(db.queueDao().get(current.captureId)?.state=="acknowledged")progressed++
            } catch (_: UploadStopped) {
                // CAS leaves a concurrent logout/revoke untouched; a lost grant waits visibly.
                queue.move(current.captureId,current.sourceGeneration,"uploading","retry_wait",
                    System.currentTimeMillis())
            } catch (_: UploadSessionManager.LoginRequired) {
                db.queueDao().pauseForLogout(System.currentTimeMillis())
                status.edit().putString("error","sign_in_required").apply()
                return Result.success()
            } catch (_: TusTransfer.Rejected) {
                queue.move(current.captureId,current.sourceGeneration,"uploading","failed_visible",
                    System.currentTimeMillis())
                val code = if (kind == "notifications") "notification_payload_invalid"
                    else "local_copy_invalid"
                markUploadFailed(current,kind,code)
                status.edit().putString("error",code).apply()
                hadFailure = true
                continue
            } catch (_: RevisionDocumentMismatch) {
                queue.move(current.captureId,current.sourceGeneration,"uploading","failed_visible",
                    System.currentTimeMillis())
                markUploadFailed(current,kind,"revision_document_mismatch")
                status.edit().putString("error","revision_document_mismatch").apply()
                hadFailure = true
                continue
            } catch (_: Exception) {
                queue.move(current.captureId,current.sourceGeneration,"uploading","retry_wait",
                    System.currentTimeMillis())
                status.edit().putString("error","upload_retry").apply()
                return Result.retry()
            }
        }
        val statusEdit = status.edit().putLong("success_at",System.currentTimeMillis())
        if (!hadFailure && runCatching { db.queueDao().revokedPendingCount() == 0 }
                .getOrDefault(false))
            statusEdit.remove("error")
        statusEdit.apply()
        if(progressed>0) {
            CaptureMaintenanceWork.enqueue(applicationContext)
            if(db.queueDao().uploadCandidates(session.tenantId,session.userId,session.deviceId).isNotEmpty() ||
                db.folderDao().uploadable().isNotEmpty())CaptureUploadWork.continueUpload(applicationContext)
        }
        return Result.success()
    }

    private fun sourceKind(item: CaptureQueueItem, session: UploadSession): String? {
        if (item.sourceId == session.manualSourceId &&
            item.sourceGeneration == session.manualGeneration) return "manual_share"
        val notification = db.notificationDao().snapshot(item.captureId)
        if (notification != null && notification.state == "approved_local" &&
            NotificationAccount.matches(notification.tenantId,notification.userId,
                notification.deviceId,session)) return "notifications"
        val folder = db.folderDao().sourceForServer(item.sourceId)
        return if (folder != null && folder.serverGeneration == item.sourceGeneration &&
            FolderBindingPolicy.matches(folder,session.tenantId,session.userId,
                session.deviceId)) folder.kind else null
    }

    private fun stopForRevocation(item: CaptureQueueItem) {
        db.queueDao().stopForRevocation(item.sourceId,item.sourceGeneration,
            item.tenantId,item.userId,item.deviceId,System.currentTimeMillis())
        try {
            val purge = RevokedCapturePurger(db,applicationContext.filesDir,vault).purgePending()
            if (purge.failed > 0 || db.queueDao().revokedPendingCount() > 0) {
                status.edit().putString("error","revoked_purge_pending").apply()
                CaptureMaintenanceWork.enqueue(applicationContext)
            }
        } catch (_: Exception) {
            status.edit().putString("error","revoked_purge_retry").apply()
            runCatching { CaptureMaintenanceWork.enqueue(applicationContext) }
        }
    }

    private fun localFolderScopeAllows(item:CaptureQueueItem):Boolean {
        val source=db.folderDao().sourceForServer(item.sourceId) ?: return false
        val observation=db.folderDao().observation(item.captureId) ?: return false
        return FolderSourcePolicy.allows(source,FolderEntry("","",observation.declaredMime,
            observation.providerSize,observation.providerModifiedAtEpochMs))
    }

    private fun localFolderReady(item: CaptureQueueItem): Boolean {
        val folder = db.folderDao().sourceForServer(item.sourceId) ?: return false
        if (folder.serverGeneration != item.sourceGeneration ||
            folder.state !in setOf("current","scanning","scan_gap","quota_pause") ||
            (folder.scopeFingerprint != null && folder.bindingState != "ready")) return false
        if(!localFolderScopeAllows(item))return false
        return folderGrant(folder)==true
    }

    private fun folderGrant(folder:FolderSource):Boolean? {
        return try {
            val tree = FolderHandleAccess.grant(folder)
            applicationContext.contentResolver.persistedUriPermissions.any {
                it.uri == tree && it.isReadPermission
            }
        } catch (_: Exception) { null }
    }

    private fun notificationAccessGranted(): Boolean = try {
        Build.VERSION.SDK_INT >= 27 &&
            (applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .isNotificationListenerAccessGranted(
                    ComponentName(applicationContext,BusinessNotificationListener::class.java))
    } catch (_: Exception) { false }

    private fun localNotificationReady(item: CaptureQueueItem, session: UploadSession): Boolean {
        if (!notificationAccessGranted()) return false
        val snapshot = db.notificationDao().snapshot(item.captureId) ?: return false
        if (!NotificationSourceGuard.selectable(applicationContext,snapshot.packageName)) {
            NotificationSourceGuard.revokeIfBlocked(applicationContext,db,snapshot.packageName)
            return false
        }
        val conversation = snapshot.conversationHash ?: return false
        val scope = db.notificationDao().scope(snapshot.packageName,conversation) ?: return false
        return snapshot.state == "approved_local" && snapshot.encryptedPayload != null &&
            db.notificationDao().source(snapshot.packageName)?.state == "selected" &&
            NotificationAccount.matches(snapshot.tenantId,snapshot.userId,snapshot.deviceId,session) &&
            NotificationAccount.matches(scope.tenantId,scope.userId,scope.deviceId,session)
    }

    private fun markUploadFailed(item: CaptureQueueItem, kind: String, code: String) {
        if (FolderSourcePolicy.isFolderKind(kind)) db.folderDao().markUploadFailed(item.captureId)
        else if (kind == "notifications") db.notificationDao().markUploadFailed(item.captureId)
        else db.shareInboxDao().markUploadFailed(item.captureId,code)
    }

    private fun processWithRefresh(item: CaptureQueueItem,
        session: UploadSession, kind: String): UploadApi.Fault? {
        return try { process(item,session,kind); null }
        catch (first: UploadApi.Fault) {
            if (first.status != 401) return first
            val fresh = manager.forceRefresh(session.accessToken)
            try { process(item,fresh,kind); null }
            catch (second: UploadApi.Fault) {
                if (second.status == 401) {
                    vault.clearSession()
                    throw UploadSessionManager.LoginRequired()
                }
                second
            }
        }
    }

    private fun process(item: CaptureQueueItem, initial: UploadSession, kind: String) {
        val mime: String
        val copyFolder: String?
        var predecessor: FolderObservation? = null
        var inlinePayload: ByteArray? = null
        if (FolderSourcePolicy.isFolderKind(kind)) {
            val observation = db.folderDao().observation(item.captureId) ?: throw UploadStopped()
            if (observation.state !in setOf("staged_unbound","superseded_revision"))
                throw UploadStopped()
            if (db.folderDao().olderInFlight(observation.localSourceId,
                    observation.documentIdHash,observation.observedAtEpochMs) > 0)
                throw UploadStopped()
            predecessor = db.folderDao().latestAcknowledgedBefore(observation.localSourceId,
                observation.documentIdHash,observation.observedAtEpochMs)
            mime = observation.declaredMime
            copyFolder = "folder-copies"
        } else if (kind == "notifications") {
            if (!localNotificationReady(item,initial)) throw UploadStopped()
            val snapshot = db.notificationDao().snapshot(item.captureId) ?: throw UploadStopped()
            inlinePayload = try { NotificationUploadPayload.encode(snapshot,NotificationVault()) }
                catch (_: Exception) { throw TusTransfer.Rejected("notification_payload_invalid") }
            mime = NotificationUploadPayload.mime
            copyFolder = null
        } else {
            mime = db.shareInboxDao().item(item.captureId)?.declaredMime ?: throw UploadStopped()
            copyFolder = "share-inbox"
        }
        val sha = item.sha256 ?: throw UploadStopped()
        val length = item.byteLength ?: throw UploadStopped()
        val open: (java.io.OutputStream) -> Unit
        if (inlinePayload != null) {
            val payload = inlinePayload
            if (payload.size.toLong() != length || NotificationUploadPayload.sha256(payload) != sha)
                throw TusTransfer.Rejected("notification_payload_changed")
            open = { output -> output.write(payload) }
        } else {
            val name = item.encryptedCopyName ?: throw UploadStopped()
            val directory = File(applicationContext.filesDir,requireNotNull(copyFolder))
            val file = File(directory,name)
            if (!file.isFile || file.canonicalFile.parentFile !=
                directory.canonicalFile) throw TusTransfer.Rejected("local_copy_missing")
            open = { output ->
                file.inputStream().use { input ->
                    ShareCopyReader(ShareCopyKey().get()).unseal(input,output,sha,length)
                }
            }
        }
        var attempt = vault.readProgress(item.captureId)?.let(UploadAttempt::decode)
            ?: UploadAttempt.fresh().also { vault.storeProgress(item.captureId,it.encode()) }
        var session = initial
        var api = UploadApi(session)
        var receipt = attempt.receipt
        if (receipt == null) {
            checkLocal(item,session)
            receipt = api.prepare(item,mime,attempt.prepareKey,predecessor)
            attempt = attempt.copy(receipt=receipt)
            vault.storeProgress(item.captureId,attempt.encode())
        }
        val prepared = receipt
        val expired = Instant.parse(prepared.expires_at).toEpochMilli() <= System.currentTimeMillis()
        if (!expired) {
            val transfer = TusTransfer(allowLocal)
            val target = TusTarget(prepared.upload.endpoint,prepared.upload.signature,
                prepared.upload.bucket,prepared.upload.object_name,prepared.upload.chunk_bytes)
            val send: () -> Unit = {
                transfer.send(target,session.accessToken,mime,length,sha,open,
                    previousLocation=attempt.location,
                    rememberLocation={ location ->
                        attempt = attempt.copy(location=location)
                        vault.storeProgress(item.captureId,attempt.encode())
                    },checkAllowed={
                        checkLocal(item,session)
                        if (db.queueDao().heartbeat(item.captureId,item.sourceGeneration,
                                System.currentTimeMillis()) != 1) throw UploadStopped()
                    },onChunkAcknowledged={
                        if (db.queueDao().heartbeat(item.captureId,item.sourceGeneration,
                                System.currentTimeMillis()) != 1) throw UploadStopped()
                    })
            }
            try { send() }
            catch (_: TusTransfer.ObjectExists) { /* Completion verifies the stored object. */ }
            catch (_: TusTransfer.Expired) {
                session = manager.forceRefresh(session.accessToken)
                api = UploadApi(session)
                try { send() }
                catch (_: TusTransfer.ObjectExists) { /* Complete below. */ }
            }
        }
        checkLocal(item,session)
        if (!api.sourceReady(item.sourceId,item.sourceGeneration,kind)) {
            stopForRevocation(item)
            throw UploadStopped()
        }
        val completed = api.complete(prepared.ingestion_id,sha,length,attempt.completeKey)
        if (predecessor != null && completed.document_id != predecessor.serverDocumentId)
            throw RevisionDocumentMismatch()
        val acknowledged = CaptureReceiptAcker(db).acknowledge(item,kind,completed,
            predecessor?.serverDocumentVersion)
        if (acknowledged) vault.clearProgress(item.captureId)
        if (kind == "notifications") db.notificationDao().snapshot(item.captureId)?.let {
            NotificationSourceGuard.revokeIfBlocked(applicationContext,db,it.packageName)
        }
    }

    private fun checkLocal(item: CaptureQueueItem, session: UploadSession) {
        if (isStopped || db.queueDao().get(item.captureId)?.state != "uploading")
            throw UploadStopped()
        val active = vault.read()?.let { UploadSession.decode(it,allowLocal) }
            ?: throw UploadStopped()
        if (active.tenantId != session.tenantId || active.userId != session.userId ||
            active.deviceId != session.deviceId || sourceKind(item,active) == null ||
            (FolderSourcePolicy.isFolderKind(sourceKind(item,active)) && !localFolderReady(item)) ||
            (sourceKind(item,active) == "notifications" && !localNotificationReady(item,active)))
            throw UploadStopped()
    }

    private class UploadStopped : Exception()
    private class RevisionDocumentMismatch : Exception()
}
