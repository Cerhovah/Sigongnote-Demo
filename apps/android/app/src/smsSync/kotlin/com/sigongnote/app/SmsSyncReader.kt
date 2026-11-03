package com.sigongnote.app

import android.content.ContentResolver
import android.net.Uri
import android.provider.Telephony
import java.time.Instant
import java.util.Base64
import kotlinx.serialization.json.*

data class SyncMessage(val providerId: Long, val kind: String, val timeMs: Long, val direction: String,
    val body: String, val parts: List<SyncPart>, val missing: Int)
data class SyncPart(val id: String, val mime: String, val bytes: ByteArray)
data class SyncPage(val messages: List<SyncMessage>, val lastId: Long, val exhausted: Boolean, val gaps: Int)

/** No write, role request, network MMS download or notification fallback. Cursor uses immutable provider IDs. */
class SmsSyncReader(private val resolver: ContentResolver, private val checkAllowed: () -> Unit,private val maxPageBytes:Int=8*1024*1024) {
    fun page(kind: String, after: Long, since: Long, selected: Set<String>, limit: Int = 100, allNew:Boolean=false): SyncPage {
        require(kind in setOf("sms","mms") && limit in 1..100 && after >= 0 && since >= 0)
        require(!allNew || since>0)
        checkAllowed()
        val uri=if(kind=="sms") Telephony.Sms.CONTENT_URI else Telephony.Mms.CONTENT_URI
        val columns=if(kind=="sms") arrayOf("_id","date","type","address") else arrayOf("_id","date","msg_box","m_type")
        val providerSince=if(kind=="mms")since/1000 else since
        var last=after;var count=0;var gaps=0;var exhausted=true;var pageBytes=0
        val result=mutableListOf<SyncMessage>()
        resolver.query(uri,columns,"_id > ? AND date >= ?",arrayOf(after.toString(),providerSince.toString()),"_id ASC")?.use { c ->
            while(c.moveToNext()){
                if(count==minOf(limit,if(kind=="mms")10 else 100)){exhausted=false;break};checkAllowed();count++
                val id=c.getLong(0);val time=if(kind=="mms") Math.multiplyExact(c.getLong(1),1000) else c.getLong(1)
                // Skip drafts/outbox/failures. Only delivered inbox and sent messages are business observations.
                val box=c.getInt(2)
                if(time<since || box !in setOf(1,2)){last=id;continue}
                if(kind=="sms"){
                    if(SmsSyncPolicy.readsMessage(allNew,listOf(c.getString(3).orEmpty()),selected)){
                        checkAllowed()
                        val body=resolver.query(Uri.parse("content://sms/$id"),arrayOf("body"),null,null,null)?.use { row->
                            if(!row.moveToFirst())throw IllegalStateException("MESSAGE_UNAVAILABLE")
                            row.getString(0).orEmpty()
                        }?:throw IllegalStateException("MESSAGE_PROVIDER_UNAVAILABLE")
                        if(body.length>65536){gaps++;last=id;continue}
                        result.add(SyncMessage(id,kind,time,if(box==1)"received" else "sent",body,emptyList(),0))
                    }
                }else{
                    if(c.getInt(3) !in setOf(128,132)){gaps++;last=id;continue}
                    val addresses=mutableListOf<String>();var recipients=0;var copied=0
                    checkAllowed();resolver.query(Uri.parse("content://mms/$id/addr"),arrayOf("address","type"),null,null,null)?.use { a ->
                        while(a.moveToNext()){
                            if(a.getInt(1)==151)recipients++
                            if(a.getInt(1) in setOf(130,129))copied++
                            if((box==1 && a.getInt(1)==137)||(box==2 && a.getInt(1) in setOf(151,130,129))) addresses.add(a.getString(0).orEmpty())
                        }
                    } ?: throw IllegalStateException("MESSAGE_PROVIDER_UNAVAILABLE")
                    if(!allNew && box==1 && (recipients>1||copied>0)){gaps++;last=id;continue}
                    if(SmsSyncPolicy.readsMessage(allNew,addresses,selected)){
                        try{
                            val message=readMms(id,time,box)
                            val size=message.parts.sumOf{it.bytes.size}+message.body.length*2
                            if(result.isNotEmpty() && pageBytes+size>maxPageBytes){exhausted=false;break}
                            result.add(message);pageBytes+=size
                        }catch(e:SecurityException){throw e}catch(e:SmsSyncGateUnavailable){throw e}catch(_:Exception){gaps++}
                    }
                }
                last=id
            }
        } ?: throw IllegalStateException("MESSAGE_PROVIDER_UNAVAILABLE")
        return SyncPage(result,last,exhausted,gaps)
    }
    private fun readMms(id: Long,time: Long,box: Int): SyncMessage {
        val text=StringBuilder();val parts=mutableListOf<SyncPart>();var missing=0;var total=0;var visited=0
        checkAllowed();resolver.query(Uri.parse("content://mms/part"),arrayOf("_id","ct","text","chset"),"mid=?",arrayOf(id.toString()),"_id ASC")?.use { c ->
            while(c.moveToNext()){
                checkAllowed();visited++
                if(visited>1000)throw IllegalStateException("MESSAGE_PART_LIMIT")
                val partId=c.getString(0);val mime=c.getString(1).orEmpty().lowercase()
                if(mime=="application/smil")continue
                if(mime=="text/plain"){
                    val inline=c.getString(2)
                    val value=if(inline!=null)inline else readPart {
                        val bytes=readBytes(partId,65536)
                        val charset=when(c.getInt(3)){106->Charsets.UTF_8;4->Charsets.ISO_8859_1;else->throw IllegalStateException("MESSAGE_CHARSET")}
                        charset.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
                    }
                    if(value==null||text.length+value.length+1>65536)missing++ else text.append(value).append('\n')
                }else if(mime in setOf("image/jpeg","image/png","image/webp") && parts.size<20){
                    val bytes=readPart {readBytes(partId,SmsSyncPolicy.maxPartBytes-total)}
                    if(bytes==null||bytes.isEmpty())missing++ else {total+=bytes.size;parts.add(SyncPart(partId,mime,bytes))}
                }else missing++
            }
        } ?: throw IllegalStateException("MESSAGE_PROVIDER_UNAVAILABLE")
        if(visited==0)missing++
        return SyncMessage(id,"mms",time,if(box==1)"received" else "sent",text.toString(),parts,missing)
    }
    private fun <T> readPart(read:()->T):T?=try{read()}catch(e:SecurityException){throw e}catch(e:SmsSyncGateUnavailable){throw e}catch(_:Exception){null}
    private fun readBytes(id: String,max: Int): ByteArray {
        require(max>0);checkAllowed()
        return resolver.openInputStream(Uri.parse("content://mms/part/$id"))?.use { stream ->
            val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(262144)
            while(true){checkAllowed();val n=stream.read(buffer);if(n<0)break;require(output.size()+n<=max);output.write(buffer,0,n)}
            output.toByteArray()
        } ?: throw IllegalStateException("MESSAGE_PART_UNAVAILABLE")
    }
}

fun SyncMessage.encode(key: String): String=buildJsonObject {
    put("schema","sms-sync-v1");put("kind",kind);put("message_key",key);put("direction",direction)
    put("occurred_at",Instant.ofEpochMilli(timeMs).toString());put("body",body);put("missing_parts",missing)
    put("parts",buildJsonArray {parts.forEach {p->add(buildJsonObject {
        put("id",p.id);put("mime",p.mime);put("bytes_base64",Base64.getEncoder().encodeToString(p.bytes))
    })}})
}.toString()
