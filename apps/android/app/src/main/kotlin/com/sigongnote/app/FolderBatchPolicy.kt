package com.sigongnote.app

import java.net.URI
import java.text.Normalizer
import kotlinx.serialization.json.*

/** Versioned encrypted handle: a child root keeps its original parent permission grant. */
data class FolderCaptureHandle(val grantUri:String,val rootDocumentId:String,
    val bindingScopeMode:String?=null,val parentDocumentId:String?=null,val displayName:String?=null,val externalAiConsent:Boolean=false) {
    fun encode():String=buildJsonObject {
        put("v",2);put("grantUri",grantUri);put("rootDocumentId",rootDocumentId)
        put("displayName",displayName?.let(::JsonPrimitive)?:JsonNull);put("externalAiConsent",externalAiConsent)
        put("bindingScopeMode",requireNotNull(bindingScopeMode));put("parentDocumentId",parentDocumentId?.let(::JsonPrimitive)?:JsonNull)
    }.toString()
    fun documentKey():String="${URI(grantUri).authority}\u0000$rootDocumentId"
    companion object {
        fun decode(raw:String,legacyRoot:(String)->String):FolderCaptureHandle {
            if(!raw.startsWith('{'))return FolderCaptureHandle(raw,legacyRoot(raw))
            val item=Json.parseToJsonElement(raw).jsonObject
            require(item.keys.containsAll(setOf("v","grantUri","rootDocumentId","bindingScopeMode","parentDocumentId")) && item.keys.all{it in setOf("v","grantUri","rootDocumentId","bindingScopeMode","parentDocumentId","displayName","externalAiConsent")} && item.getValue("v").jsonPrimitive.int==2)
            val handle=FolderCaptureHandle(item.getValue("grantUri").jsonPrimitive.content,item.getValue("rootDocumentId").jsonPrimitive.content,
                item.getValue("bindingScopeMode").jsonPrimitive.content,item.getValue("parentDocumentId").jsonPrimitive.contentOrNull,item["displayName"]?.jsonPrimitive?.contentOrNull,item["externalAiConsent"]?.jsonPrimitive?.booleanOrNull?:false)
            require(URI(handle.grantUri).scheme=="content" && !URI(handle.grantUri).authority.isNullOrBlank() && handle.rootDocumentId.isNotBlank())
            require(handle.displayName==null || handle.displayName.length in 1..180)
            require(handle.bindingScopeMode in setOf("project","company_common","unassigned"))
            return handle
        }
    }
}
data class DiscoveredFolder(val providerId:String,val name:String,val scope:String,val projectId:String?,val issue:String?)
data class FolderBatchDiscoveryResult(val folders:List<DiscoveredFolder>,val partial:Boolean)
object FolderBatchPolicy {
    const val MAX_FOLDERS=100
    fun historyStart(kind:String,now:Long):Long { require(FolderSourcePolicy.isFolderKind(kind)); return now }
    fun kind(name:String,requested:String):String {
        if(requested!="folder")return requested
        return when(name.trim().lowercase()) {
            "recordings","call recordings","통화 녹음","통화녹음"->"call_recording"
            "dcim","camera","camera roll"->"photos"
            else->"folder"
        }
    }
    fun suggest(name:String,projects:List<FolderProject>):Pair<String,String?> {
        fun normal(value:String)=Normalizer.normalize(value,Normalizer.Form.NFKC).trim().lowercase()
        val value=normal(name);val matching=projects.filter{normal(it.name)==value}
        if(matching.size==1)return "project" to matching.single().id
        if(value in setOf("공통","공통자료","회사 공통","회사공통","양식","서식"))return "company_common" to null
        return "unassigned" to null
    }
    fun discover(parent:String,reader:FolderChildrenReader,projects:List<FolderProject>,
        check:(FolderEntry)->String?):FolderBatchDiscoveryResult {
        val rows=mutableListOf<DiscoveredFolder>();var partial=false;var visited=0
        try {
            val complete=reader.visit(parent) { node ->
                visited++
                if(visited>1000 || rows.size>=MAX_FOLDERS){partial=true;false}
                else {
                    if(node.directory) {
                        val scope=suggest(node.entry.displayName,projects)
                        val issue=try{check(node.entry)}catch(_:Exception){partial=true;"permission_denied"}
                        rows.add(DiscoveredFolder(node.entry.documentId,node.entry.displayName,scope.first,scope.second,issue))
                    }
                    true
                }
            }
            if(!complete)partial=true
        }catch(_:Exception){partial=true}
        return FolderBatchDiscoveryResult(rows.distinctBy{it.providerId}.sortedWith(compareBy({it.name},{it.providerId})),partial)
    }
}
