package com.sigongnote.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.work.*
import com.sigongnote.contracts.IngestionPrepareResponse
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

object SmsSyncWork {
    @JvmStatic fun schedule(context:Context){
        val manager=WorkManager.getInstance(context)
        manager.enqueueUniquePeriodicWork("sms-sync-periodic",ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SmsSyncWorker>(15,TimeUnit.MINUTES).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
        now(context)
    }
    fun now(context:Context){WorkManager.getInstance(context).enqueueUniqueWork("sms-sync-now",ExistingWorkPolicy.APPEND_OR_REPLACE,
        OneTimeWorkRequestBuilder<SmsSyncWorker>().setInitialDelay(3,TimeUnit.SECONDS).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())}
}

class SmsSyncWorker(context:Context,params:WorkerParameters):Worker(context,params){
    companion object {private val runLock=Any()}
    override fun doWork():Result=synchronized(runLock){runSync()}
    private fun runSync():Result {
        val manager=UploadSessionManager(TokenVault(applicationContext),BuildConfig.DEBUG)
        val session=try{manager.current()}catch(_:Exception){return Result.success()}
        var more=false;var retry=false
        SmsSyncStore(applicationContext).use {store->for((id,config) in store.scopes(session)){
            try{
                val source=config.getValue("source").jsonPrimitive.content;val generation=config.getValue("generation").jsonPrimitive.int
                val api=UploadApi(session)
                // Trusted distribution evidence and the actual installation are independent of READ_SMS.
                if(applicationContext.checkSelfPermission(Manifest.permission.READ_SMS)!=PackageManager.PERMISSION_GRANTED){store.status(id,"permission_missing");continue}
                var evidenceExpires=Long.MAX_VALUE
                fun localAllowed(){
                    if(System.currentTimeMillis()>=evidenceExpires)throw SecurityException("SMS_EVIDENCE_EXPIRED")
                    if(isStopped || !store.active(id,session))throw SecurityException("SMS_STOPPED")
                    val current=try{manager.current()}catch(_:Exception){throw SmsSyncGateUnavailable()};if(store.owner(current)!=store.owner(session))throw SecurityException("SMS_ACCOUNT_CHANGED")
                    if(applicationContext.checkSelfPermission(Manifest.permission.READ_SMS)!=PackageManager.PERMISSION_GRANTED)throw SecurityException("SMS_PERMISSION_MISSING")
                }
                val gate=SmsSyncGate(::localAllowed,{
                    val access=try{api.smsAccess(source)}catch(e:UploadApi.Fault){
                        if(e.status in setOf(403,404,410))throw SecurityException("SMS_POLICY_GATED")
                        if(e.status==401)manager.forceRefresh(session.accessToken)
                        throw SmsSyncGateUnavailable()
                    }catch(_:Exception){throw SmsSyncGateUnavailable()}
                    SmsSyncInstallation.requireAccess(applicationContext,access,generation)
                    evidenceExpires=java.time.Instant.parse(access.getValue("expires_at").jsonPrimitive.content).toEpochMilli()
                },android.os.SystemClock::elapsedRealtime)
                fun allowed(){gate.check()}
                val selected=config.getValue("numbers").jsonArray.map{SmsSyncPolicy.normalize(it.jsonPrimitive.content)}.filter{it.isNotEmpty()}.toSet()
                val allNew=config["all_new"]?.jsonPrimitive?.booleanOrNull==true
                require(allNew || selected.isNotEmpty())
                val reader=SmsSyncReader(applicationContext.contentResolver,::allowed)
                for(kind in if(config["reading_stopped"]?.jsonPrimitive?.booleanOrNull==true)emptyList() else listOf("sms","mms")){
                    gate.check(true)
                    val page=reader.page(kind,store.cursor(id,kind),config.getValue("since").jsonPrimitive.long,selected,allNew=allNew)
                    gate.check(true);if(!store.page(id,kind,page){m->SmsSyncPolicy.messageKey(session.tenantId,session.userId,SmsSyncInstallation.fingerprint(applicationContext),m.kind,m.providerId,m.timeMs)}){store.status(id,"quota_pause")}else more=more||!page.exhausted
                }
                for(row in store.pending(id)){
                    val key=row.getValue("key").jsonPrimitive.content
                    try{
                    gate.check(true)
                    val capture=row.getValue("capture").jsonPrimitive.content
                    val hash=row.getValue("hash").jsonPrimitive.content;val bytes=row.getValue("payload").jsonPrimitive.content.toByteArray(Charsets.UTF_8)
                    if(allNew){
                        if(Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject.getValue("body").jsonPrimitive.content.isBlank()){
                            store.holdTriage(id,key);continue
                        }
                        val screened=api.screenSms(source,generation,bytes.toString(Charsets.UTF_8),hash)
                        gate.check(true)
                        val triageState=screened["state"]?.jsonPrimitive?.content
                        if(triageState!="classified"){
                            if(triageState in setOf("review","unknown","withdrawn","scope_blocked"))store.holdTriage(id,key) else store.deferTriage(id,key)
                            continue
                        }
                        when(screened["decision"]?.jsonPrimitive?.content){
                            "work" -> Unit
                            "non_work" -> {store.nonWork(id,key);continue}
                            else -> {store.holdTriage(id,key);continue}
                        }
                    }
                    val queue=CaptureQueueItem(capture,session.tenantId,session.userId,session.deviceId,source,generation,"ready",null,hash,bytes.size.toLong(),0,0)
                    var receipt=row["receipt"]?.jsonObject
                    if(receipt==null&&row["transfer"]==null){
                        val access=api.smsAccess(source,key);SmsSyncInstallation.requireAccess(applicationContext,access,generation)
                        val previous=access["previous"]?.takeIf{it!=JsonNull}?.jsonObject
                        if(previous!=null){
                            receipt=buildJsonObject{put("document_id",previous.getValue("document_id"));put("revision_id",previous.getValue("revision_id"));put("document_version",previous.getValue("revision_number"))}
                            if(previous["sha256"]?.jsonPrimitive?.content==hash&&previous["source_id"]?.jsonPrimitive?.content==source){store.acknowledge(id,key,receipt.toString());continue}
                            store.base(id,key,receipt)
                        }
                    }
                    val predecessor=receipt?.let{Triple(it.getValue("document_id").jsonPrimitive.content,it.getValue("revision_id").jsonPrimitive.content,it.getValue("document_version").jsonPrimitive.int)}
                    var transfer=row["transfer"]?.jsonObject
                    val attempt=transfer?.get("attempt")?.jsonPrimitive?.int?:0
                    val prepared=api.prepare(queue,SmsSyncPolicy.mime,UUID.nameUUIDFromBytes("$capture:prepare:$attempt".toByteArray()).toString(),messagePredecessor=predecessor)
                    if(transfer?.get("ingestion")?.jsonPrimitive?.content!=prepared.ingestion_id)transfer=null
                    fun checkTransfer(){allowed()}
                    try{if(java.time.Instant.parse(prepared.expires_at).toEpochMilli()>System.currentTimeMillis())TusTransfer(BuildConfig.DEBUG).send(TusTarget(prepared.upload.endpoint,prepared.upload.signature,prepared.upload.bucket,prepared.upload.object_name),session.accessToken,SmsSyncPolicy.mime,bytes.size.toLong(),hash,
                        {it.write(bytes)},transfer?.get("location")?.jsonPrimitive?.content,
                        {location->store.transfer(id,key,buildJsonObject{put("attempt",attempt);put("ingestion",prepared.ingestion_id);put("location",location)})},::checkTransfer)
                    }catch(_:TusTransfer.ObjectExists){/* Server verifies hash and length below. */}
                    gate.check(true)
                    val complete=try{api.complete(prepared.ingestion_id,hash,bytes.size.toLong(),UUID.nameUUIDFromBytes("$capture:complete:$attempt".toByteArray()).toString())}catch(e:UploadApi.Fault){
                        if(e.code=="SOURCE_EXPIRED" && api.sourceReady(source,generation,"sms"))store.transfer(id,key,buildJsonObject{put("attempt",attempt+1)})
                        throw e
                    }
                    check(predecessor==null||complete.document_id==predecessor.first)
                    allowed();store.acknowledge(id,key,buildJsonObject {
                        put("document_id",complete.document_id);put("revision_id",complete.revision_id)
                        put("document_version",complete.revision_number)
                    }.toString())
                    }catch(_:SmsSyncGateUnavailable){store.status(id,"retry");retry=true;break
                    }catch(_:SecurityException){store.status(id,"policy_gated");break
                    }catch(e:UploadApi.Fault){
                        if(e.status==401){manager.forceRefresh(session.accessToken);retry=true;break}
                        store.failed(id,key,e.retryable||e.code=="SOURCE_EXPIRED");retry=retry||e.retryable||e.code=="SOURCE_EXPIRED"
                    }catch(_:TusTransfer.Rejected){store.failed(id,key,false)
                    }catch(_:TusTransfer.Expired){manager.forceRefresh(session.accessToken);store.failed(id,key,true);retry=true
                    }catch(_:Exception){store.failed(id,key,true);retry=true}
                }
                if(store.heldCount(id)>0)store.status(id,"partial")
                if(store.pending(id).isNotEmpty())more=true
            }catch(_:SmsSyncGateUnavailable){store.status(id,"retry");retry=true
            }catch(_:SecurityException){store.status(id,"policy_gated")
            }catch(_:Exception){store.status(id,"retry");retry=true}
        }}
        if(more)SmsSyncWork.now(applicationContext)
        return if(retry)Result.retry() else Result.success()
    }
}

object SmsSyncFingerprint {
    @Synchronized fun of(value:String):String {
        val alias="sigongnote.sms.sync.scope.v1";val store=java.security.KeyStore.getInstance("AndroidKeyStore").apply{load(null)}
        val key=(store.getKey(alias,null) as? javax.crypto.SecretKey)?:javax.crypto.KeyGenerator.getInstance(android.security.keystore.KeyProperties.KEY_ALGORITHM_HMAC_SHA256,"AndroidKeyStore").apply{
            init(android.security.keystore.KeyGenParameterSpec.Builder(alias,android.security.keystore.KeyProperties.PURPOSE_SIGN).setDigests(android.security.keystore.KeyProperties.DIGEST_SHA256).build())
        }.generateKey()
        return javax.crypto.Mac.getInstance("HmacSHA256").run{init(key);doFinal(value.toByteArray()).joinToString(""){"%02x".format(it)}}
    }
}
