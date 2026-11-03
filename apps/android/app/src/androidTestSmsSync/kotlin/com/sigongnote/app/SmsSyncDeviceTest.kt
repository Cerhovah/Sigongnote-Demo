package com.sigongnote.app

import android.content.*
import android.database.MatrixCursor
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
import kotlinx.serialization.json.*

class SmsSyncDeviceTest {
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext.also{check(it.packageName=="com.sigongnote.app.devtest.smssync")}
    private fun session()=UploadSession("https://fixture.invalid/","https://fixture.invalid/","https://fixture.invalid/","fixture","fixture","fixture",Long.MAX_VALUE,UUID.randomUUID().toString(),UUID.randomUUID().toString(),UUID.randomUUID().toString(),UUID.randomUUID().toString(),1,1)
    @Test fun allNewReadsOnlyAfterConsentAndNeverChangesProvider(){
        context;var writes=0
        val fake=object:ContentProvider(){
            override fun onCreate()=true
            override fun getType(uri:Uri)="text/plain"
            override fun insert(uri:Uri,values:ContentValues?):Uri?{writes++;error("READ_ONLY")}
            override fun delete(uri:Uri,selection:String?,args:Array<out String>?):Int{writes++;error("READ_ONLY")}
            override fun update(uri:Uri,values:ContentValues?,selection:String?,args:Array<out String>?):Int{writes++;error("READ_ONLY")}
            override fun query(uri:Uri,projection:Array<out String>?,selection:String?,args:Array<out String>?,sort:String?):android.database.Cursor =
                if(projection?.contentEquals(arrayOf("body"))==true) MatrixCursor(arrayOf("body")).apply{addRow(arrayOf("합성 신규 업무"))}
                else MatrixCursor(arrayOf("_id","date","type","address")).apply{
                    addRow(arrayOf(1,1000,1,"unknown"));addRow(arrayOf(2,3000,1,"unknown"));addRow(arrayOf(3,4000,2,"unknown"));addRow(arrayOf(4,5000,3,"unknown"))
                }
        }
        val reader=SmsSyncReader(ContentResolver.wrap(fake),{})
        assertEquals(listOf(2L,3L),reader.page("sms",0,2000,emptySet(),allNew=true).messages.map{it.providerId})
        assertTrue(reader.page("sms",0,2000,emptySet()).messages.isEmpty());assertEquals(0,writes)
        try{reader.page("sms",0,0,emptySet(),allNew=true);fail()}catch(_:IllegalArgumentException){}
    }
    @Test fun screeningQueuesHoldUncertainAndDoNotStarveWork(){
        val ctx=context;ctx.deleteDatabase("sms-sync.db");val s=session()
        SmsSyncStore(ctx).use{store->
            val id=store.add(s,buildJsonObject{put("source",UUID.randomUUID().toString());put("generation",1)})
            val messages=(1L..4L).map{SyncMessage(it,"sms",1000,"received","합성 $it",emptyList(),0)}
            fun key(m:SyncMessage)=m.providerId.toString().padStart(64,'0')
            store.page(id,"sms",SyncPage(messages,4,true,0),::key)
            store.nonWork(id,key(messages[0]));store.holdTriage(id,key(messages[1]));store.deferTriage(id,key(messages[2]))
            assertEquals(key(messages[3]),store.pending(id).single().getValue("key").jsonPrimitive.content)
            assertEquals(1,store.heldCount(id));assertTrue(store.summary(s).contains("일반 문자 제외 1건"))
            store.page(id,"sms",SyncPage(listOf(messages[0].copy(body="수정된 합성 업무")),4,true,0),::key)
            assertTrue(store.pending(id).any{it.getValue("key").jsonPrimitive.content==key(messages[0])})
            val next=store.add(s,buildJsonObject{put("source",UUID.randomUUID().toString());put("generation",1)})
            store.stopOtherReaders(s,next)
            assertTrue(store.active(id,s));assertTrue(store.scopes(s).single{it.first==id}.second.getValue("reading_stopped").jsonPrimitive.boolean)
            assertTrue(store.pending(id).isNotEmpty());assertEquals(1,store.heldCount(id))
            assertNull(store.scopes(s).single{it.first==next}.second["reading_stopped"])
        };ctx.deleteDatabase("sms-sync.db")
    }
    @Test fun missingExpiredRevokedOrWrongInstallationNeverOpensTheSmsProvider(){
        val ctx=context;var queries=0
        val fake=object:ContentProvider(){
            override fun onCreate()=true
            override fun getType(uri:Uri)="text/plain"
            override fun insert(uri:Uri,values:ContentValues?):Uri?=error("READ_ONLY")
            override fun delete(uri:Uri,selection:String?,args:Array<out String>?):Int=error("READ_ONLY")
            override fun update(uri:Uri,values:ContentValues?,selection:String?,args:Array<out String>?):Int=error("READ_ONLY")
            override fun query(uri:Uri,projection:Array<out String>?,selection:String?,args:Array<out String>?,sort:String?):android.database.Cursor{queries++;error("MUST_NOT_READ")}
        }
        for(state in listOf("evidence_missing","expired","revoked","scope_changed")){
            val reader=SmsSyncReader(ContentResolver.wrap(fake),{SmsSyncInstallation.requireAccess(ctx,buildJsonObject{put("state",state);put("ready",false);put("generation",1)},1)})
            try{reader.page("sms",0,0,setOf("01012340000"));fail()}catch(_:SecurityException){}
        }
        assertEquals(0,queries)
    }
    @Test fun revokedGateDuringMmsReadDoesNotBecomeAPartialSuccessfulPage(){
        context;var checks=0;var mime="text/plain"
        val fake=object:ContentProvider(){
            override fun onCreate()=true
            override fun getType(uri:Uri)="text/plain"
            override fun insert(uri:Uri,values:ContentValues?):Uri?=error("READ_ONLY")
            override fun delete(uri:Uri,selection:String?,args:Array<out String>?):Int=error("READ_ONLY")
            override fun update(uri:Uri,values:ContentValues?,selection:String?,args:Array<out String>?):Int=error("READ_ONLY")
            override fun query(uri:Uri,projection:Array<out String>?,selection:String?,args:Array<out String>?,sort:String?):android.database.Cursor=when{
                uri.path?.endsWith("/addr")==true->MatrixCursor(arrayOf("address","type")).apply{addRow(arrayOf("01012340000",137))}
                uri.path=="/part"->MatrixCursor(arrayOf("_id","ct","text","chset")).apply{addRow(arrayOf("1",mime,null,106))}
                else->MatrixCursor(arrayOf("_id","date","msg_box","m_type")).apply{addRow(arrayOf(1,1,1,132))}
            }
        }
        val reader=SmsSyncReader(ContentResolver.wrap(fake),{checks++;if(checks>=6)throw SecurityException("REVOKED")})
        for(type in listOf("text/plain","image/png")){mime=type;checks=0
            try{reader.page("mms",0,0,setOf("01012340000"));fail()}catch(_:SecurityException){}
            assertEquals(6,checks)
        }
    }
    @Test fun largeMmsDoesNotOverflowCursorWindowAndReselectionKeepsDocumentIdentity(){
        val ctx=context;ctx.deleteDatabase("sms-sync.db");val s=session();val key="b".repeat(64)
        val message=SyncMessage(1,"mms",1000,"received","합성 대용량",listOf(SyncPart("1","image/png",ByteArray(3*1024*1024){42})),0)
        val document=UUID.randomUUID().toString()
        SmsSyncStore(ctx).use{store->
            val id=store.add(s,buildJsonObject{put("source",UUID.randomUUID().toString());put("generation",1)})
            store.page(id,"mms",SyncPage(listOf(message),1,true,0)){key}
            store.page(id,"sms",SyncPage(listOf(SyncMessage(2,"sms",1000,"received","다음 문자",emptyList(),0)),2,true,0)){"c".repeat(64)}
            val pending=store.pending(id);assertEquals(2,pending.size);assertTrue(pending.first().getValue("payload").jsonPrimitive.content.length>4*1024*1024)
            store.acknowledge(id,key,buildJsonObject{put("document_id",document);put("revision_id",UUID.randomUUID().toString());put("document_version",1)}.toString())
            assertEquals("c".repeat(64),store.pending(id).single().getValue("key").jsonPrimitive.content)
            store.pauseAll(s)
            val next=store.add(s,buildJsonObject{put("source",UUID.randomUUID().toString());put("generation",1)})
            store.page(next,"mms",SyncPage(listOf(message),1,true,0)){key}
            assertEquals(document,store.pending(next).single().getValue("receipt").jsonObject.getValue("document_id").jsonPrimitive.content)
            val other=store.add(s.copy(userId=UUID.randomUUID().toString()),buildJsonObject{put("source",UUID.randomUUID().toString());put("generation",1)})
            store.page(other,"mms",SyncPage(listOf(message),1,true,0)){key}
            assertNull(store.pending(other).single()["receipt"])
        };ctx.deleteDatabase("sms-sync.db")
    }
    @Test fun mmsPageBudgetStopsBeforeNextMessageWithoutDroppingItsId(){
        context
        val fake=object:ContentProvider(){
            override fun onCreate()=true
            override fun getType(uri:Uri)="text/plain"
            override fun insert(uri:Uri,values:ContentValues?):Uri?=error("READ_ONLY")
            override fun delete(uri:Uri,selection:String?,args:Array<out String>?):Int=error("READ_ONLY")
            override fun update(uri:Uri,values:ContentValues?,selection:String?,args:Array<out String>?):Int=error("READ_ONLY")
            override fun query(uri:Uri,projection:Array<out String>?,selection:String?,args:Array<out String>?,sort:String?):android.database.Cursor=when {
                uri.path?.endsWith("/addr")==true->MatrixCursor(arrayOf("address","type")).apply{addRow(arrayOf("01012340000",137))}
                uri.path=="/part"->MatrixCursor(arrayOf("_id","ct","text","chset")).apply{addRow(arrayOf("1","text/plain","합성".repeat(30),106))}
                else->MatrixCursor(arrayOf("_id","date","msg_box","m_type")).apply{for(id in 1..3)if(id>(args?.first()?.toInt()?:0))addRow(arrayOf(id,1,1,132))}
            }
        }
        val reader=SmsSyncReader(ContentResolver.wrap(fake),{},130)
        val a=reader.page("mms",0,0,setOf("01012340000"));assertEquals(1,a.messages.size);assertEquals(1L,a.lastId);assertFalse(a.exhausted)
        val b=reader.page("mms",a.lastId,0,setOf("01012340000"));assertEquals(2L,b.messages.single().providerId)
        val c=reader.page("mms",b.lastId,0,setOf("01012340000"));assertEquals(3L,c.messages.single().providerId);assertTrue(c.exhausted)
    }
    @Test fun quotaKeepsTheCopiedPrefixAndResumesTheUncopiedMessage(){
        val ctx=context;ctx.deleteDatabase("sms-sync.db");val s=session()
        SmsSyncStore(ctx,2).use{store->
            val id=store.add(s,buildJsonObject{put("source",UUID.randomUUID().toString());put("generation",1)})
            val messages=(1L..3L).map{SyncMessage(it,"sms",1000,"received","합성 $it",emptyList(),0)}
            fun key(m:SyncMessage)=m.providerId.toString().padStart(64,'0')
            assertFalse(store.page(id,"sms",SyncPage(messages,3,false,0),::key))
            assertEquals(2L,store.cursor(id,"sms"));assertEquals(2,store.pending(id).size)
            store.acknowledge(id,key(messages[0]),"{}")
            assertTrue(store.page(id,"sms",SyncPage(listOf(messages[2]),3,true,0),::key))
            assertEquals(3L,store.cursor(id,"sms"));assertEquals(2,store.pending(id).size)
        };ctx.deleteDatabase("sms-sync.db")
    }
    @Test fun permanentFailurePreservesOriginalAndDoesNotStarveLaterMessages(){
        val ctx=context;ctx.deleteDatabase("sms-sync.db");val s=session()
        SmsSyncStore(ctx).use{store->
            val config=buildJsonObject{put("source",UUID.randomUUID().toString());put("generation",1)}
            val id=store.add(s,config)
            val messages=(1L..5L).map{SyncMessage(it,"sms",1000,"received","합성 $it",emptyList(),0)}
            fun key(m:SyncMessage)=m.providerId.toString().padStart(64,'0')
            assertTrue(store.page(id,"sms",SyncPage(messages,5,true,0),::key))
            store.failed(id,key(messages[0]),false)
            assertEquals(1,store.heldCount(id));assertEquals(key(messages[1]),store.pending(id).first().getValue("key").jsonPrimitive.content)
            val changed=messages[0].copy(body="후속 수정")
            assertTrue(store.page(id,"sms",SyncPage(listOf(changed,messages[4]),5,true,0),::key));assertEquals(1,store.heldCount(id))
            store.pauseAll(s);assertFalse(store.active(id,s))
            val other=store.add(s,buildJsonObject{put("source",UUID.randomUUID().toString());put("generation",1)})
            assertEquals(listOf(other),store.scopes(s).map{it.first})
            store.pauseAll(s);assertEquals(id,store.add(s,config));assertEquals(1,store.heldCount(id))
        };ctx.deleteDatabase("sms-sync.db")
    }
    @Test fun encryptedOutboxSurvivesRestartAndBindsAccountAndRevision(){
        val ctx=context;ctx.deleteDatabase("sms-sync.db");val s=session();val key="a".repeat(64)
        val first=SyncMessage(1,"sms",1000,"received","합성 업무 문자 원문",emptyList(),0)
        var id=""
        SmsSyncStore(ctx).use{store->
            id=store.add(s,buildJsonObject{put("source",UUID.randomUUID().toString());put("generation",1)})
            assertTrue(store.page(id,"sms",SyncPage(listOf(first),1,false,0)){key})
            assertEquals(1L,store.cursor(id,"sms"));assertEquals(1,store.pending(id).size)
        }
        SmsSyncStore(ctx).use{store->
            assertEquals(1,store.pending(id).size);assertEquals(0,store.scopes(s.copy(userId=UUID.randomUUID().toString())).size)
            assertTrue(store.page(id,"sms",SyncPage(listOf(first),1,false,0)){key});assertEquals(1,store.pending(id).size)
            assertTrue(store.page(id,"sms",SyncPage(listOf(first.copy(body="수정된 합성 문자")),2,false,0)){key});assertEquals(2L,store.cursor(id,"sms"))
            store.acknowledge(id,key,buildJsonObject{put("document_id",UUID.randomUUID().toString());put("revision_id",UUID.randomUUID().toString());put("document_version",1)}.toString())
            assertTrue(store.page(id,"sms",SyncPage(listOf(first.copy(body="수정된 합성 문자")),2,false,0)){key})
            assertEquals(1,store.pending(id).single().getValue("receipt").jsonObject.getValue("document_version").jsonPrimitive.int)
            store.pauseAll(s);assertFalse(store.active(id,s))
        }
        assertFalse(ctx.getDatabasePath("sms-sync.db").readBytes().toString(Charsets.UTF_8).contains("합성 업무 문자 원문"))
        ctx.deleteDatabase("sms-sync.db")
    }
    @Test fun readerNeverTouchesTheRealProviderAndPagesWithoutDroppingOldMessages(){
        context;var queries=0;var writes=0
        val fake=object:ContentProvider(){
            override fun onCreate()=true
            override fun getType(uri:Uri)="text/plain"
            override fun insert(uri:Uri,values:ContentValues?):Uri?{writes++;error("READ_ONLY")}
            override fun delete(uri:Uri,selection:String?,args:Array<out String>?) :Int{writes++;error("READ_ONLY")}
            override fun update(uri:Uri,values:ContentValues?,selection:String?,args:Array<out String>?):Int{writes++;error("READ_ONLY")}
            override fun query(uri:Uri,projection:Array<out String>?,selection:String?,args:Array<out String>?,sort:String?):android.database.Cursor {
                queries++;assertEquals("sms",uri.authority)
                if(projection?.toList()==listOf("body")){assertNotEquals("/2",uri.path);assertNotEquals("/3",uri.path);return MatrixCursor(arrayOf("body")).apply{addRow(arrayOf("합성 문자 ${uri.lastPathSegment}"))}}
                assertEquals("_id ASC",sort);assertFalse(projection.orEmpty().contains("body"))
                return MatrixCursor(arrayOf("_id","date","type","address","body")).apply{
                    for(id in 1..205)if(id>(args?.first()?.toInt()?:0))addRow(arrayOf(id,1000,if(id==3)3 else 1,if(id==2)"01099990000" else "+821012340000","합성 문자 $id"))
                }
            }
        }
        val resolver=ContentResolver.wrap(fake);var granted=true
        val reader=SmsSyncReader(resolver,{if(!granted)throw SecurityException()})
        val a=reader.page("sms",0,0,setOf("01012340000"));assertEquals(100L,a.lastId);assertFalse(a.exhausted);assertEquals(98,a.messages.size)
        val b=reader.page("sms",a.lastId,0,setOf("01012340000"));assertEquals(100,b.messages.size)
        val c=reader.page("sms",b.lastId,0,setOf("01012340000"));assertTrue(c.exhausted);assertEquals(5,c.messages.size)
        val before=queries;granted=false
        try{reader.page("sms",0,0,setOf("01012340000"));fail()}catch(_:SecurityException){}
        assertEquals(before,queries);assertEquals(0,writes)
    }
}
