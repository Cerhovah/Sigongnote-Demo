package com.sigongnote.app

data class FolderProject(val id: String, val name: String)

interface FolderConnectionRemote {
    fun createFolderProject(name: String, key: String): String
    fun registerFolder(source: FolderSource): UploadApi.ReadySource
    fun bindFolderProject(source: FolderSource, remote: UploadApi.ReadySource)
}

/** Durable request keys recover a success even when the app died before saving it. */
class FolderConnections(private val db: CaptureQueueDatabase,
    private val openName: (String) -> String = { FolderHandleVault().open(it) }) {
    fun resume(session: UploadSession, remote: FolderConnectionRemote = UploadApi(session)) {
        val dao = db.folderDao()
        for (candidate in dao.pendingBindings(session.tenantId,session.userId,session.deviceId)) {
            try {
                var source = dao.source(candidate.localSourceId) ?: continue
                if (source.projectId == null && source.encryptedProjectName != null) {
                    val project = remote.createFolderProject(openName(source.encryptedProjectName),
                        FolderSourcePolicy.requestKey(source.localSourceId,"project"))
                    if (dao.recordProject(source.localSourceId,project) != 1) continue
                    source = dao.source(source.localSourceId) ?: continue
                }
                val registered = remote.registerFolder(source)
                check(dao.recordRegistration(source.localSourceId,registered.id,registered.generation,
                    session.tenantId,session.userId,session.deviceId) == 1)
                val live=dao.source(source.localSourceId) ?: continue
                if(live.state == "paused" || live.bindingState !in setOf("pending","retry")) continue
                remote.bindFolderProject(source,registered)
                dao.finishBinding(source.localSourceId,registered.id,registered.generation,
                    session.tenantId,session.userId,session.deviceId)
            } catch (error: UploadApi.Fault) {
                val retry = error.retryable || error.status == 401
                dao.bindingFailed(candidate.localSourceId,if (retry) "retry" else "needs_attention",
                    if (retry) "connection_retry" else "connection_scope_changed")
            } catch (_: java.io.IOException) {
                dao.bindingFailed(candidate.localSourceId,"retry","network_unavailable")
            } catch (_: Exception) {
                dao.bindingFailed(candidate.localSourceId,"needs_attention","connection_check_needed")
            }
        }
    }
}

object FolderConnectionLookup {
    fun find(dao: FolderDao, uri: String, fingerprint: String,
        open: (String)->String): FolderSource? = dao.sourceForScope(fingerprint) ?:
        dao.activeSources().firstOrNull { runCatching {
            FolderHandleAccess.decode(open(it.encryptedTreeUri)).documentKey()==FolderHandleAccess.decode(uri).documentKey()
        }.getOrDefault(false) }
}
