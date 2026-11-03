package com.sigongnote.app

import kotlinx.serialization.json.*

data class FolderNode(val entry:FolderEntry,val directory:Boolean)
fun interface FolderChildrenReader {
    /** False means the consumer stopped early; never treat that as complete enumeration. */
    fun visit(parent:String,consumer:(FolderNode)->Boolean):Boolean
}

class FolderEntryCodec(private val seal:(String)->String,private val open:(String)->String) {
    fun encode(entry:FolderEntry):String=seal(buildJsonObject {
        put("id",entry.documentId);put("name",entry.displayName);put("mime",entry.mime)
        put("size",entry.size?.let(::JsonPrimitive) ?: JsonNull)
        put("modified",entry.modifiedAtEpochMs?.let(::JsonPrimitive) ?: JsonNull)
    }.toString())
    fun decode(value:String):FolderEntry {
        val row=Json.parseToJsonElement(open(value)).jsonObject
        return FolderEntry(row.getValue("id").jsonPrimitive.content,row.getValue("name").jsonPrimitive.content,
            row.getValue("mime").jsonPrimitive.content,row.getValue("size").jsonPrimitive.longOrNull,
            row.getValue("modified").jsonPrimitive.longOrNull)
    }
}

/** Re-query by provider identity, never persist a row offset as if it were a stable cursor. */
class FolderDiscovery(private val dao:FolderScanDao,private val reader:FolderChildrenReader,
    private val seal:(String)->String,private val open:(String)->String,
    private val now:()->Long={System.currentTimeMillis()}) {
    private val codec=FolderEntryCodec(seal,open)
    fun begin(sourceId:String,root:String,lastCompleteGeneration:Int):FolderScanRun {
        val old=dao.run(sourceId)
        if(old!=null && old.state=="running")return old
        val generation=maxOf(old?.generation ?: 0,lastCompleteGeneration)+1
        val run=FolderScanRun(sourceId,generation,"running",now())
        dao.clearDirectories(sourceId)
        dao.addDirectory(FolderScanDirectory(sourceId,FolderScanPolicy.documentIdHash(root),seal(root),
            generation,0,"todo",null))
        dao.putRun(run)
        return run
    }

    fun discover(run:FolderScanRun,maxNewEntries:Int=400,maxDirectories:Int=20):Int {
        require(maxNewEntries>0 && maxDirectories>0)
        var discovered=0;var visited=0
        while(discovered<maxNewEntries && visited<maxDirectories) {
            val directory=dao.nextDirectory(run.sourceId,run.generation) ?: break
            visited++
            if(directory.depth>12) {
                dao.directoryState(run.sourceId,directory.documentHash,run.generation,"gap","depth_limit");continue
            }
            try {
                val complete=reader.visit(open(directory.encryptedDocumentId)) { node ->
                    if(discovered>=maxNewEntries)return@visit false
                    val entry=node.entry;val hash=FolderScanPolicy.documentIdHash(entry.documentId)
                    if(node.directory) {
                        if(dao.addDirectory(FolderScanDirectory(run.sourceId,hash,seal(entry.documentId),
                                run.generation,directory.depth+1,"todo",null))!=-1L)discovered++
                    } else {
                        val old=dao.item(run.sourceId,hash)
                        if(old==null || old.generation!=run.generation || old.providerSize!=entry.size ||
                            old.providerModifiedAtEpochMs!=entry.modifiedAtEpochMs ||
                            runCatching { codec.decode(old.encryptedEntry).let { it.displayName!=entry.displayName || it.mime!=entry.mime } }.getOrDefault(true)) {
                            dao.putItem(FolderScanItem(run.sourceId,hash,run.generation,codec.encode(entry),
                                entry.size,entry.modifiedAtEpochMs,now(),"pending","unchecked",1,null))
                            discovered++
                        }
                    }
                    true
                }
                if(complete)dao.directoryState(run.sourceId,directory.documentHash,run.generation,"done",null)
            } catch(error:Exception) {
                if(directory.depth==0 && error is SecurityException)throw error
                dao.directoryState(run.sourceId,directory.documentHash,run.generation,"gap",
                    if(error is FolderScanGap)error.reason else "directory_unavailable")
            } finally { dao.visited(run.sourceId,directory.documentHash,now()) }
        }
        return discovered
    }
}
