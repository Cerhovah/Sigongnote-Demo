package com.sigongnote.app

import com.sigongnote.contracts.CapturePolicy
import com.sigongnote.contracts.CaptureSourceResponse
import com.sigongnote.contracts.CaptureSourcesResponse
import com.sigongnote.contracts.CaptureStorageUsage
import com.sigongnote.contracts.IngestionPrepareResponse
import com.sigongnote.contracts.IngestionReceiptResponse
import java.net.URI
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.encodeToJsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class UploadApi(private val session: UploadSession,
    private val client: OkHttpClient = OkHttpClient.Builder().followRedirects(false)
        .connectTimeout(20,TimeUnit.SECONDS).readTimeout(90,TimeUnit.SECONDS).build(),
    private val openFolderHandle:(String)->String={FolderHandleVault().open(it)}) : FolderConnectionRemote {
    class Fault(val status: Int, val code: String, val retryable: Boolean) : Exception()
    data class ReadySource(val id: String, val generation: Int)
    private val json = Json { ignoreUnknownKeys = true }
    private val origin = URI(session.apiBaseUrl.trimEnd('/') + "/")

    fun firstSiteProject():String? = json.parseToJsonElement(call("GET","v1/work/setup")).jsonObject["project_id"]?.jsonPrimitive?.contentOrNull

    fun connectionPolicy(): CapturePolicy = json.decodeFromString(call("GET","v1/capture-policy"))
    fun storageAvailableBytes():Long {
        val usage=json.decodeFromString<CaptureStorageUsage>(call("GET","v1/capture-storage"))
        require(usage.limit_bytes==100_000_000_000L&&usage.used_bytes>=0&&usage.reserved_bytes>=0)
        return (usage.limit_bytes-usage.used_bytes.coerceAtMost(usage.limit_bytes)-usage.reserved_bytes.coerceAtMost(usage.limit_bytes)).coerceAtLeast(0)
    }

    fun registerSms(fingerprint:String,since:Long,policy:CapturePolicy,externalAiConsent:Boolean=false,allNew:Boolean=false):CaptureSourceResponse {
        require(!allNew || (since>0 && externalAiConsent && policy.external_processing))
        val snapshot=CapturePolicyNotice.snapshot(policy)
        if(json.parseToJsonElement(call("GET","v1/capture-policy"))!=snapshot)throw Fault(410,"SOURCE_EXPIRED",false)
        val known=json.decodeFromString<CaptureSourcesResponse>(call("GET","v1/capture-sources")).sources.filter {
            it.tenant_id==session.tenantId && it.device_id==session.deviceId && it.kind=="sms" && it.scope_fingerprint==fingerprint
        }
        known.singleOrNull{it.active}?.let{
            if(it.processing_policy?.let{stored->Json.encodeToJsonElement(stored)}!=snapshot || it.external_ai_consent!=(externalAiConsent&&policy.external_processing))throw Fault(410,"SOURCE_EXPIRED",false)
            return json.decodeFromString<CaptureSourceResponse>(Json.encodeToString(it))
        }
        val scope=buildJsonObject {
            put("capture_method","sms_provider");put("history_mode",if(since==0L)"all" else "since")
            put("history_since",if(since==0L)JsonNull else kotlinx.serialization.json.JsonPrimitive(java.time.Instant.ofEpochMilli(since).toString()))
            put("scope_mode",if(allNew)"ai_screened" else "work_dedicated");put("rule_version",1);put("processing_policy_id",policy.id)
            put("fingerprint_algorithm","hmac-sha256-device-v1")
        }
        val raw=call("POST","v1/capture-sources",buildJsonObject {
            put("device_id",session.deviceId);put("kind","sms");put("scope_fingerprint",fingerprint)
            put("consent_version",2);put("local_selection_consent",true);put("server_upload_consent",true)
            put("external_ai_consent",externalAiConsent && policy.external_processing);put("scope",scope);put("processing_policy",snapshot)
        }.toString(),UUID.nameUUIDFromBytes("sms-sync:$fingerprint:${known.map{it.id}.sorted().joinToString(":")}".toByteArray()).toString())
        return json.decodeFromString<CaptureSourceResponse>(raw).also {
            require(it.tenant_id==session.tenantId && it.device_id==session.deviceId && it.kind=="sms")
            require(json.parseToJsonElement(raw).jsonObject["processing_policy"]==snapshot)
        }
    }

    fun revokeOtherSmsScopes(fingerprint:String) {
        val scopes=json.decodeFromString<CaptureSourcesResponse>(call("GET","v1/capture-sources")).sources
        for(source in scopes.filter{it.tenant_id==session.tenantId && it.device_id==session.deviceId && it.kind=="sms" && it.active && it.scope_fingerprint!=fingerprint}){
            call("POST","v1/capture-sources/${source.id}/revoke","{}",UUID.nameUUIDFromBytes("sms-revoke:${source.id}:${source.version}".toByteArray()).toString(),source.version)
        }
    }

    fun screenSms(source:String,generation:Int,payload:String,hash:String):JsonObject {
        val message=json.parseToJsonElement(payload).jsonObject
        return json.parseToJsonElement(call("POST","v1/capture-sources/$source/sms-triage",buildJsonObject {
            put("generation",generation);put("payload_sha256",hash)
            for(key in listOf("message_key","kind","direction","occurred_at","body","missing_parts"))put(key,message.getValue(key))
            put("has_parts",message.getValue("parts").jsonArray.isNotEmpty())
        }.toString())).jsonObject
    }

    fun bindSmsProject(source:CaptureSourceResponse,fingerprint:String,projectId:String) {
        call("POST","v1/site-folder-bindings",buildJsonObject {
            put("source_id",source.id);put("source_generation",source.generation)
            put("scope_fingerprint",fingerprint);put("scope_mode","project");put("project_id",projectId)
            put("display_name","업무 문자")
        }.toString(),UUID.nameUUIDFromBytes("sms-site:${source.id}:${source.generation}:$projectId".toByteArray()).toString())
    }

    fun folderProjects(): List<FolderProject> = json.parseToJsonElement(call("GET","v1/projects"))
        .jsonObject.getValue("projects").jsonArray.map {
            FolderProject(it.jsonObject.getValue("id").jsonPrimitive.content,
                it.jsonObject.getValue("display_name").jsonPrimitive.content)
        }

    override fun createFolderProject(name: String, key: String): String {
        val result = call("POST","v1/projects",buildJsonObject { put("display_name",name) }.toString(),key)
        return json.parseToJsonElement(result).jsonObject.getValue("id").jsonPrimitive.content.also {
            require(UUID.fromString(it).toString() == it)
        }
    }

    fun revokeFolder(source: FolderSource) {
        require(source.boundTenantId==session.tenantId && source.boundUserId==session.userId &&
            source.boundDeviceId==session.deviceId)
        val sources=json.decodeFromString<CaptureSourcesResponse>(call("GET","v1/capture-sources")).sources
        val old=sources.singleOrNull { it.tenant_id==session.tenantId && it.device_id==session.deviceId &&
            it.kind==source.kind && it.active && (it.id==source.serverSourceId ||
                (source.scopeFingerprint!=null && it.scope_fingerprint==source.scopeFingerprint)) } ?: return
        call("POST","v1/capture-sources/${old.id}/revoke","{}",
            FolderSourcePolicy.requestKey(source.localSourceId,"revoke:${old.version}"),old.version)
    }

    override fun registerFolder(source: FolderSource): ReadySource {
        require(source.boundTenantId == session.tenantId && source.boundUserId == session.userId &&
            source.boundDeviceId == session.deviceId && source.serverUploadConsent)
        val currentPolicy = json.parseToJsonElement(call("GET","v1/capture-policy"))
        if (currentPolicy != json.parseToJsonElement(requireNotNull(source.processingPolicySnapshot)))
            throw Fault(410,"SOURCE_EXPIRED",false)
        val scope = FolderSourcePolicy.scope(source)
        val raw = call("POST","v1/capture-sources",buildJsonObject {
            put("device_id",session.deviceId); put("kind",source.kind)
            put("scope_fingerprint",requireNotNull(source.scopeFingerprint)); put("consent_version",2)
            put("local_selection_consent",true); put("server_upload_consent",true)
            put("processing_policy",currentPolicy)
            put("external_ai_consent",source.scopeVersion>=2 && FolderCaptureHandle.decode(openFolderHandle(source.encryptedTreeUri)){error("Child handle required")}.externalAiConsent); put("scope",scope)
        }.toString(),FolderSourcePolicy.requestKey(source.localSourceId,"source"))
        val response = json.decodeFromString<CaptureSourceResponse>(raw)
        val wire = json.parseToJsonElement(raw).jsonObject
        require(response.tenant_id == session.tenantId && response.device_id == session.deviceId &&
            response.kind == source.kind && wire["scope"] == scope && wire["processing_policy"] == currentPolicy)
        if (!sourceReady(response.id,response.generation,source.kind))throw Fault(410,"SOURCE_EXPIRED",false)
        return ReadySource(response.id,response.generation)
    }

    override fun bindFolderProject(source: FolderSource, remote: ReadySource) {
        val mode=if(source.projectId!=null)"project" else if(source.scopeVersion>=2)
            FolderCaptureHandle.decode(openFolderHandle(source.encryptedTreeUri)){error("Child handle required")}.bindingScopeMode
            else "company_common"
        require(mode in setOf("project","company_common","unassigned") && (mode=="project")== (source.projectId!=null))
        val payload = buildJsonObject {
            put("source_id",remote.id); put("source_generation",remote.generation)
            put("scope_fingerprint",requireNotNull(source.scopeFingerprint))
            put("scope_mode",mode)
            if(source.scopeVersion>=2)FolderCaptureHandle.decode(openFolderHandle(source.encryptedTreeUri)){error("Child handle required")}.displayName?.let{put("display_name",it)}
            put("project_id",source.projectId?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: JsonNull)
        }
        val raw = call("POST","v1/site-folder-bindings",payload.toString(),
            FolderSourcePolicy.requestKey(source.localSourceId,"binding"))
        val id = json.parseToJsonElement(raw).jsonObject.getValue("id")
        val bindings = json.parseToJsonElement(call("GET","v1/site-folder-bindings"))
            .jsonObject.getValue("bindings").jsonArray
        if (bindings.none { row -> val item = row.jsonObject
            item["id"] == id && payload.all { (key,value) -> item[key] == value }
        }) throw Fault(410,"SOURCE_EXPIRED",false)
    }

    fun sourceReady(sourceId: String, generation: Int, kind: String): Boolean {
        val raw = call("GET","v1/capture-sources")
        val sources = json.decodeFromString<CaptureSourcesResponse>(raw).sources
        return sources.any { it.id == sourceId && it.tenant_id == session.tenantId &&
            it.device_id == session.deviceId && it.kind == kind &&
            it.generation == generation && it.upload_ready && it.server_upload_consent }
    }

    fun smsAccess(sourceId:String,messageKey:String?=null):JsonObject {
        require(messageKey==null||Regex("[a-f0-9]{64}").matches(messageKey))
        return json.parseToJsonElement(call("GET","v1/capture-sources/$sourceId/sms-access"+(messageKey?.let{"?message_key=$it"}?:""))).jsonObject
    }

    fun singleReadySource(kind: String): ReadySource? {
        val raw = call("GET","v1/capture-sources")
        val matches = json.decodeFromString<CaptureSourcesResponse>(raw).sources.filter {
            it.tenant_id == session.tenantId && it.device_id == session.deviceId &&
                it.kind == kind && it.upload_ready && it.server_upload_consent
        }
        return matches.singleOrNull()?.let { ReadySource(it.id,it.generation) }
    }

    fun prepare(capture: CaptureQueueItem, mime: String, key: String,
        predecessor: FolderObservation? = null, messagePredecessor: Triple<String,String,Int>? = null): IngestionPrepareResponse {
        require(capture.tenantId == session.tenantId && capture.userId == session.userId &&
            capture.deviceId == session.deviceId)
        require(capture.sha256 != null && capture.byteLength != null)
        val raw = call("POST","v1/ingestions",buildJsonObject {
            put("client_capture_id",capture.captureId)
            put("sha256",capture.sha256)
            put("byte_length",capture.byteLength)
            put("declared_mime",mime)
            put("source_id",capture.sourceId)
            put("source_generation",capture.sourceGeneration)
            if(messagePredecessor!=null){
                require(predecessor==null)
                put("document_id",messagePredecessor.first);put("predecessor_revision_id",messagePredecessor.second)
                put("expected_version",messagePredecessor.third)
            }
            if (predecessor != null) {
                put("document_id",requireNotNull(predecessor.serverDocumentId))
                put("predecessor_revision_id",requireNotNull(predecessor.serverRevisionId))
                put("expected_version",requireNotNull(predecessor.serverDocumentVersion))
            }
        }.toString(),key)
        return json.decodeFromString<IngestionPrepareResponse>(raw).also { response ->
            val expectedStorage = URI(session.storageOrigin)
            fun onStorageOrigin(rawUrl: String): Boolean {
                val url = URI(rawUrl)
                return url.scheme == expectedStorage.scheme && url.host == expectedStorage.host &&
                    url.port == expectedStorage.port && url.userInfo == null && url.rawFragment == null
            }
            require(response.state == "prepared" && response.upload.protocol == "tus" &&
                onStorageOrigin(response.upload.endpoint) && onStorageOrigin(response.upload_url) &&
                response.upload.authorization == "user_bearer+signature" &&
                response.upload.metadata_keys == "bucketName,objectName,contentType" &&
                !response.upload.upsert && response.upload.chunk_bytes == 6 * 1024 * 1024 &&
                response.upload.bucket == "sigongnote-originals" &&
                response.upload.object_name == "${session.tenantId}/${response.ingestion_id}")
        }
    }

    fun complete(ingestionId: String, sha256: String, length: Long,
        key: String): IngestionReceiptResponse {
        require(UUID.fromString(ingestionId).toString() == ingestionId)
        val raw = call("POST","v1/ingestions/$ingestionId/complete",buildJsonObject {
            put("sha256",sha256)
            put("byte_length",length)
        }.toString(),key)
        return json.decodeFromString<IngestionReceiptResponse>(raw).also {
            require(it.ingestion_id == ingestionId && it.state in setOf("verified","queued"))
        }
    }

    /** Reads the signed original without bearer credentials and validates the full recovery hash. */
    fun verifyRecovery(receipt:CaptureCopyReceipt,item:CaptureQueueItem,downloadAllowed:()->Boolean={true}):Long? {
        if(!downloadAllowed())return null
        require(item.tenantId==session.tenantId&&item.userId==session.userId&&item.deviceId==session.deviceId)
        val route=if(receipt.ingestionId==null)"v1/revisions/${receipt.revisionId}/durability" else "v1/ingestions/${receipt.ingestionId}/durability"
        val proof=json.parseToJsonElement(call("POST",route,buildJsonObject {
            put("sha256",item.sha256);put("byte_length",item.byteLength)
        }.toString())).jsonObject
        fun value(name:String)=proof.getValue(name).jsonPrimitive.content
        val rawGeneration=proof["source_generation"]?:return null
        val generation=rawGeneration.jsonPrimitive.contentOrNull?.toIntOrNull()
        // Current manual shares are source-bound too. Only an explicitly unscoped legacy record may accept null.
        val generationMatches=if(item.sourceId.isEmpty()&&item.sourceGeneration==0) rawGeneration===JsonNull
            else generation==item.sourceGeneration&&item.sourceGeneration>0
        if(value("state")!="recoverable"||(receipt.ingestionId!=null&&value("ingestion_id")!=receipt.ingestionId)||value("revision_id")!=receipt.revisionId||
            value("sha256")!=item.sha256||value("byte_length").toLong()!=item.byteLength||!generationMatches)return null
        val url=URI(value("restore_url"));val expected=URI(session.storageOrigin)
        require(url.scheme==expected.scheme&&url.host==expected.host&&url.port==expected.port&&url.userInfo==null&&url.fragment==null&&
            url.path.startsWith("/storage/v1/object/sign/sigongnote-originals/${session.tenantId}/"))
        if(!downloadAllowed())return null
        client.newCall(Request.Builder().url(url.toURL()).get().build()).execute().use { response ->
            if(!response.isSuccessful)return null
            val input=response.body?.byteStream()?:return null;val hash=java.security.MessageDigest.getInstance("SHA-256")
            var length=0L;val buffer=ByteArray(1024*1024)
            input.use { while(true){if(!downloadAllowed())return null;val read=it.read(buffer);if(read<0)break;length+=read;if(length>requireNotNull(item.byteLength))return null;hash.update(buffer,0,read)} }
            if(length!=item.byteLength||hash.digest().joinToString(""){"%02x".format(it)}!=item.sha256)return null
        }
        java.time.Instant.parse(value("verified_at")) // Validate format, never compare server and device clocks.
        return System.nanoTime()/1_000_000
    }

    private fun call(method: String, path: String, payload: String? = null,
        key: String? = null, version: Int? = null): String {
        val body = payload?.toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url(origin.resolve(path).toURL()).method(method,body)
            .header("Authorization","Bearer ${session.accessToken}")
            .header("X-Tenant-ID",session.tenantId)
            .apply { if (key != null) header("Idempotency-Key",key); if(version!=null) header("If-Match","\"$version\"") }.build()
        return client.newCall(request).execute().use { response ->
            val raw = response.body?.string() ?: ""
            if (response.code !in 200..299) {
                val error = try {
                    json.parseToJsonElement(raw).jsonObject.getValue("error").jsonObject
                } catch (_: Exception) { null }
                val code = error?.get("code")?.jsonPrimitive?.content ?: "HTTP_${response.code}"
                val retryable = error?.get("retryable")?.jsonPrimitive?.content?.toBooleanStrictOrNull()
                    ?: (response.code == 429 || response.code >= 500)
                throw Fault(response.code,code,retryable)
            }
            raw
        }
    }
}
