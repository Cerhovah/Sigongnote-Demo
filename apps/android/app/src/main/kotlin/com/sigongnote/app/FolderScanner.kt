package com.sigongnote.app

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID

/** Durable enumeration and per-file staging are separate from complete coverage. */
class FolderScanner(private val context: Context, private val database: CaptureQueueDatabase) {
    private val folders=database.folderDao()
    private val scans=database.folderScanDao()
    private val inventory=FolderInventory(context.contentResolver)
    private val vault=FolderHandleVault()
    private val codec=FolderEntryCodec(vault::seal,vault::open)
    private val copyDirectory=File(context.filesDir,"folder-copies")

    private fun hasGrant(tree:Uri)=context.contentResolver.persistedUriPermissions.any { it.uri==tree && it.isReadPermission }

    fun scanAll():Boolean {
        var more=false
        for(source in folders.activeSources())more=scan(source) || more
        return more
    }

    fun scan(source:FolderSource):Boolean {
        val id=source.localSourceId; val started=System.currentTimeMillis()
        if(folders.startScan(id,started,started-30L*60*1000)!=1)return false
        try {
            val handle=FolderHandleAccess.open(source)
            val tree=Uri.parse(handle.grantUri)
            if(context.contentResolver.persistedUriPermissions.none { it.uri==tree && it.isReadPermission }) {
                folders.scanFailed(id,"permission_lost","persisted_grant_missing");return false
            }
            val discovery=FolderDiscovery(scans,FolderChildrenReader { parent,visitor ->
                inventory.visit(tree,parent,visitor)
            },vault::seal,vault::open)
            lateinit var run:FolderScanRun
            database.runInTransaction {
                run=discovery.begin(id,handle.rootDocumentId,source.scanGeneration)
                // A long backlog must not hide newer files in directories already visited.
                if(started-run.discoveryAtEpochMs>60_000) {
                    scans.refreshRecentDirectories(id,run.generation)
                    run=run.copy(discoveryAtEpochMs=started);scans.putRun(run)
                }
            }
            discovery.discover(run)
            if(!hasGrant(tree))throw SecurityException()
            var physicalBytes=copyDirectory.listFiles()?.sumOf { it.length() } ?: 0L
            val writer=ShareCopyWriter(ShareCopyKey().get(),copyDirectory)
            var quota=false
            var quotaReason="app_copy_cap"
            val recent=scans.pending(id,run.generation,100)
            val batch=(recent.take(3)+scans.oldestPending(id,run.generation)+recent.drop(3)).distinctBy { it.documentHash }.take(100)
            for(item in batch) {
                if(folders.source(id)?.state!="scanning")return false
                if(System.currentTimeMillis()-started>60_000)break
                val entry=try { codec.decode(item.encryptedEntry) } catch(_:Exception) {
                    scans.itemState(id,item.documentHash,run.generation,"held","needs_local_review","metadata_unreadable");continue
                }
                val mime=FolderSourcePolicy.mediaMime(source,entry)
                val limit=ShareInputPolicy.limit(mime,entry.displayName)
                val marker=folders.pendingMarker(id,item.documentHash)
                val legacyOutside=FolderStagingPolicy.legacyOutside(source,entry,marker)
                if(legacyOutside && marker?.attempts!=-1)folders.putPending(FolderPending(id,item.documentHash,-1,entry.size,entry.modifiedAtEpochMs))
                if(source.historyMode=="since" && entry.modifiedAtEpochMs==null) {
                    scans.itemState(id,item.documentHash,run.generation,"held","needs_local_review","date_unavailable");continue
                }
                if(!FolderSourcePolicy.allows(source,entry) || legacyOutside || limit==null || entry.size==0L ||
                    (entry.size!=null && entry.size>limit)) {
                    val reason=when {
                        entry.displayName.substringAfterLast('.').lowercase() in setOf("dwg","dxf","dgn","rvt","ifc") -> "cad_excluded"
                        limit==null -> "format_not_supported"
                        entry.size!=null&&limit!=null&&entry.size>limit -> "file_too_large"
                        else -> "outside_scope"
                    }
                    scans.itemState(id,item.documentHash,run.generation,"excluded","outside",reason);continue
                }
                if(entry.size==null || entry.modifiedAtEpochMs==null || entry.modifiedAtEpochMs<=0) {
                    scans.itemState(id,item.documentHash,run.generation,"held","needs_local_review","metadata_unavailable");continue
                }
                if(System.currentTimeMillis()-item.observedAtEpochMs<2_000)continue
                var sealed:SealedCopy?=null
                try {
                    val before=inventory.currentMetadata(tree,entry.documentId)
                    if(before.first!=entry.size || before.second!=entry.modifiedAtEpochMs) {
                        scans.putItem(item.copy(encryptedEntry=codec.encode(entry.copy(size=before.first,modifiedAtEpochMs=before.second)),
                            providerSize=before.first,providerModifiedAtEpochMs=before.second,
                            observedAtEpochMs=System.currentTimeMillis(),state="pending",attempts=0))
                        continue
                    }
                    val previous=folders.unchanged(id,item.documentHash,entry.size,entry.modifiedAtEpochMs)
                    if(previous!=null && (File(copyDirectory,previous.encryptedCopyName).isFile ||
                        (previous.state=="acknowledged" && database.copyReceiptDao().get(previous.observationId)?.reclaimedAt!=null))) {
                        folders.seen(previous.observationId,run.generation,entry.size,entry.modifiedAtEpochMs)
                        scans.itemState(id,item.documentHash,run.generation,"done","allowed",null);continue
                    }
                    val block=FolderStagingPolicy.capacity(physicalBytes+database.shareInboxDao().stagedBytes(),
                        entry.size,entry.modifiedAtEpochMs,started,context.filesDir.usableSpace,context.filesDir.totalSpace)
                    if(block!=null) { quota=true;quotaReason=block;continue }
                    val uri=DocumentsContract.buildDocumentUriUsingTree(tree,entry.documentId)
                    val input=context.contentResolver.openInputStream(uri) ?: throw FileNotFoundException()
                    sealed=writer.seal(input,limit)
                    val after=inventory.currentMetadata(tree,entry.documentId)
                    if(folders.source(id)?.state!="scanning") {
                        File(copyDirectory,sealed.fileName).delete();return false
                    }
                    if(after!=before || sealed.byteLength!=entry.size) {
                        File(copyDirectory,sealed.fileName).delete();sealed=null
                        scans.failedAttempt(id,item.documentHash,run.generation,"changed_during_copy");continue
                    }
                    val copy=requireNotNull(sealed)
                    val same=folders.exact(id,item.documentHash,copy.sha256)
                    database.runInTransaction {
                        if(same!=null) {
                            if(File(copyDirectory,same.encryptedCopyName).isFile) {
                                File(copyDirectory,copy.fileName).delete()
                                folders.seen(same.observationId,run.generation,entry.size,entry.modifiedAtEpochMs)
                            } else check(folders.repairCopy(same.observationId,copy.fileName,
                                run.generation,entry.size,entry.modifiedAtEpochMs)==1)
                        } else {
                            val row=FolderObservation(UUID.randomUUID().toString(),id,item.documentHash,copy.sha256,
                                copy.byteLength,mime,copy.fileName,entry.size,entry.modifiedAtEpochMs,run.generation,
                                "staged_unbound",System.currentTimeMillis())
                            check(folders.insertObservation(row)>=0)
                            folders.supersede(id,item.documentHash,row.observationId)
                        }
                        scans.itemState(id,item.documentHash,run.generation,"done","allowed",null)
                    }
                    physicalBytes+=File(copyDirectory,copy.fileName).takeIf { it.isFile }?.length() ?: 0L
                    sealed=null // The copy now has a durable reference.
                } catch(error:SecurityException) {
                    if(!hasGrant(tree))throw error
                    scans.failedAttempt(id,item.documentHash,run.generation,"document_denied")
                }
                catch(_:FileNotFoundException) { scans.failedAttempt(id,item.documentHash,run.generation,"document_unavailable") }
                catch(_:Exception) { scans.failedAttempt(id,item.documentHash,run.generation,"copy_failed") }
                finally { sealed?.let { File(copyDirectory,it.fileName).delete() } }
            }
            val directories=scans.directoryCount(id,run.generation,"todo")
            val gaps=scans.directoryCount(id,run.generation,"gap")
            val pending=scans.pendingCount(id,run.generation)
            val held=scans.stateCount(id,run.generation,"held")
            val observed=scans.itemCount(id,run.generation)
            val eligible=scans.stateCount(id,run.generation,"done")
            val excluded=scans.stateCount(id,run.generation,"excluded")
            val finished=directories==0 && pending==0
            database.runInTransaction {
                if(finished)scans.putRun(run.copy(state="finished"))
                if(finished && gaps==0 && held==0) {
                    if(folders.scanSucceeded(id,run.generation,System.currentTimeMillis(),observed,eligible,excluded)==1)
                        folders.markMissingAfterCompleteScan(id,run.generation)
                } else folders.scanIncomplete(id,observed,eligible,excluded,pending+held+directories+gaps,
                    if(quota) quotaReason else if(finished) "files_need_check" else "backlog_pending",
                    if(quota) "quota_pause" else "scan_gap")
            }
            CaptureUploadWork.enqueue(context)
            return directories>0 || (!finished && !quota)
        } catch(_:SecurityException) { folders.scanFailed(id,"permission_lost","read_permission_lost") }
        catch(_:FileNotFoundException) { folders.scanFailed(id,"source_offline","tree_unavailable") }
        catch(gap:FolderScanGap) { folders.scanFailed(id,"scan_gap",gap.reason) }
        catch(_:Exception) { folders.scanFailed(id,"scan_gap","provider_error") }
        return false
    }
}
