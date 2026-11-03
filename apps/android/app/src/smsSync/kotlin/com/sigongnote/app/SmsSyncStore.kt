package com.sigongnote.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.security.MessageDigest
import java.util.UUID
import kotlinx.serialization.json.*

/** Separate, encrypted outbox: source scope, originals, upload credentials and receipts never enter logs. */
class SmsSyncStore(context: Context,private val maxPending:Int=500):SQLiteOpenHelper(context,"sms-sync.db",null,3) {
    private val vault=FolderHandleVault()
    override fun onCreate(db:SQLiteDatabase){
        db.execSQL("CREATE TABLE scopes(id TEXT PRIMARY KEY,owner TEXT NOT NULL,config TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,sms_cursor INTEGER NOT NULL DEFAULT 0,mms_cursor INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'waiting',sms_sweep_at INTEGER NOT NULL DEFAULT 0,mms_sweep_at INTEGER NOT NULL DEFAULT 0,gaps INTEGER NOT NULL DEFAULT 0)")
        db.execSQL("CREATE TABLE messages(scope_id TEXT NOT NULL,message_key TEXT NOT NULL,hash TEXT NOT NULL,capture_id TEXT NOT NULL,payload TEXT,state TEXT NOT NULL,transfer TEXT,receipt TEXT,failures INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope_id,message_key))")
    }
    override fun onUpgrade(db:SQLiteDatabase,old:Int,new:Int){check(old in 1..2&&new==3);if(old<2){db.execSQL("ALTER TABLE messages ADD COLUMN failures INTEGER NOT NULL DEFAULT 0");db.execSQL("ALTER TABLE messages ADD COLUMN next_attempt INTEGER NOT NULL DEFAULT 0")};db.execSQL("ALTER TABLE scopes ADD COLUMN sms_sweep_at INTEGER NOT NULL DEFAULT 0");db.execSQL("ALTER TABLE scopes ADD COLUMN mms_sweep_at INTEGER NOT NULL DEFAULT 0")}
    fun owner(s:UploadSession)="${s.tenantId}:${s.userId}:${s.deviceId}"
    fun scopes(s:UploadSession):List<Pair<String,JsonObject>> = readableDatabase.rawQuery("SELECT id,config FROM scopes WHERE owner=? AND active=1",arrayOf(owner(s))).use {c->
        buildList {while(c.moveToNext())add(c.getString(0) to Json.parseToJsonElement(vault.open(c.getString(1))).jsonObject)}
    }
    fun add(s:UploadSession,config:JsonObject):String {
        val id=UUID.nameUUIDFromBytes("${owner(s)}:${config.getValue("source")}:${config.getValue("generation")}".toByteArray()).toString()
        writableDatabase.insertWithOnConflict("scopes",null,ContentValues().apply {put("id",id);put("owner",owner(s));put("config",vault.seal(config.toString()))},SQLiteDatabase.CONFLICT_IGNORE)
        writableDatabase.execSQL("UPDATE scopes SET active=1,status='waiting',config=? WHERE id=? AND owner=?",arrayOf(vault.seal(config.toString()),id,owner(s)))
        return id
    }
    /** Replacing a reader preserves prior consent, evidence and queued copies; only new scanning stops. */
    fun stopOtherReaders(s:UploadSession,keep:String){
        writableDatabase.beginTransaction()
        try{for((id,config) in scopes(s))if(id!=keep){
            val next=buildJsonObject{config.forEach{(k,v)->put(k,v)};put("reading_stopped",true)}
            writableDatabase.execSQL("UPDATE scopes SET config=? WHERE id=? AND owner=?",arrayOf(vault.seal(next.toString()),id,owner(s)))
        };writableDatabase.setTransactionSuccessful()}finally{writableDatabase.endTransaction()}
    }
    fun active(id:String,s:UploadSession)=readableDatabase.rawQuery("SELECT 1 FROM scopes WHERE id=? AND owner=? AND active=1",arrayOf(id,owner(s))).use {it.moveToFirst()}
    fun pauseAll(s:UploadSession){writableDatabase.execSQL("UPDATE scopes SET active=0,status='paused' WHERE owner=?",arrayOf(owner(s)))}
    fun status(id:String,value:String){require(value in setOf("waiting","policy_gated","permission_missing","syncing","current","partial","quota_pause","retry","paused"));writableDatabase.execSQL("UPDATE scopes SET status=? WHERE id=?",arrayOf(value,id))}
    fun progress(s:UploadSession):String=readableDatabase.rawQuery("SELECT status,count(*),sum(gaps) FROM scopes WHERE owner=? GROUP BY status",arrayOf(owner(s))).use {c->buildList {while(c.moveToNext())add("${c.getString(0)}:${c.getInt(1)}:${c.getInt(2)}")}.joinToString(",")}
    fun cursor(id:String,kind:String):Long {
        require(kind in setOf("sms","mms"));val now=System.currentTimeMillis()
        val row=readableDatabase.rawQuery("SELECT ${kind}_cursor,${kind}_sweep_at FROM scopes WHERE id=?",arrayOf(id)).use{if(it.moveToFirst())it.getLong(0) to it.getLong(1) else 0L to 0L}
        // New records are incremental; edits and later MMS downloads reconcile at most daily.
        if(SmsSyncPolicy.reconcileDue(row.second,now)){writableDatabase.execSQL("UPDATE scopes SET ${kind}_cursor=0,${kind}_sweep_at=? WHERE id=?",arrayOf(now,id));return 0}
        return row.first
    }
    fun page(id:String,kind:String,page:SyncPage,key:(SyncMessage)->String):Boolean {
        require(kind in setOf("sms","mms"));val db=writableDatabase;db.beginTransaction()
        try{
            var copiedThrough=cursor(id,kind)
            fun pausePage():Boolean {
                db.execSQL("UPDATE scopes SET ${kind}_cursor=?,status='quota_pause' WHERE id=?",arrayOf(copiedThrough,id))
                db.setTransactionSuccessful();return false
            }
            for(message in page.messages){
                val messageKey=key(message);val payload=message.encode(messageKey);val hash=hash(payload)
                val prior=row(id,messageKey)
                // A number selection changes permission scope, not the identity of the message.
                // Rebind the existing document via a new revision under the newly permitted source.
                val inherited=if(prior==null)db.rawQuery("SELECT m.receipt FROM messages m JOIN scopes old ON old.id=m.scope_id JOIN scopes current ON current.owner=old.owner WHERE current.id=? AND m.message_key=? AND m.state='acknowledged' AND m.receipt IS NOT NULL ORDER BY m.rowid DESC LIMIT 1",arrayOf(id,messageKey)).use{if(it.moveToFirst())it.getString(0) else null} else null
                if(prior?.get("hash")?.jsonPrimitive?.content==hash){copiedThrough=message.providerId;continue}
                // Preserve a pending original. The next full reconciliation captures its later revision after acknowledgment.
                if(prior!=null && prior.getValue("state").jsonPrimitive.content !in setOf("acknowledged","non_work")){copiedThrough=message.providerId;continue}
                val size=db.rawQuery("SELECT coalesce(sum(length(payload)),0),count(*) FROM messages WHERE payload IS NOT NULL",null).use {it.moveToFirst();it.getLong(0) to it.getInt(1)}
                if(size.first+payload.length*2>128*1024*1024||size.second>=maxPending)return pausePage()
                val values=ContentValues().apply {
                    put("scope_id",id);put("message_key",messageKey);put("hash",hash)
                    put("capture_id",UUID.nameUUIDFromBytes("$id:$messageKey:$hash".toByteArray()).toString())
                    put("payload",vault.seal(payload));put("state","pending");putNull("transfer")
                    put("failures",0);put("next_attempt",0)
                    if(inherited!=null)put("receipt",inherited)
                }
                if(prior==null)db.insertOrThrow("messages",null,values) else db.update("messages",values,"scope_id=? AND message_key=?",arrayOf(id,messageKey))
                copiedThrough=message.providerId
            }
            db.execSQL("UPDATE scopes SET ${kind}_cursor=?,gaps=gaps+?,status=? WHERE id=?",arrayOf(page.lastId,page.gaps,if(page.gaps>0||page.messages.any {it.missing>0})"partial" else "syncing",id))
            db.setTransactionSuccessful();return true
        }finally{db.endTransaction()}
    }
    private fun row(id:String,key:String):JsonObject?=readableDatabase.rawQuery("SELECT hash,state FROM messages WHERE scope_id=? AND message_key=?",arrayOf(id,key)).use {c->if(c.moveToFirst())buildJsonObject {put("hash",c.getString(0));put("state",c.getString(1))} else null}
    // Never place a multi-megabyte encrypted MMS in one CursorWindow row.
    private fun payload(id:String,key:String,length:Int):String {
        require(length in 1..16*1024*1024)
        val sealed=StringBuilder(length);var offset=1
        while(offset<=length){
            readableDatabase.rawQuery("SELECT substr(payload,?,262144) FROM messages WHERE scope_id=? AND message_key=?",arrayOf(offset.toString(),id,key)).use{check(it.moveToFirst());sealed.append(it.getString(0))}
            offset+=262144
        }
        check(sealed.length==length);return vault.open(sealed.toString())
    }
    fun pending(id:String):List<JsonObject> = readableDatabase.rawQuery("SELECT message_key,hash,capture_id,length(payload),transfer,receipt FROM messages WHERE scope_id=? AND state='pending' AND next_attempt<=? ORDER BY failures,next_attempt,rowid LIMIT 3",arrayOf(id,System.currentTimeMillis().toString())).use {c->buildList {while(c.moveToNext())add(buildJsonObject {
        put("key",c.getString(0));put("hash",c.getString(1));put("capture",c.getString(2));put("payload",payload(id,c.getString(0),c.getInt(3)))
        if(!c.isNull(4))put("transfer",Json.parseToJsonElement(vault.open(c.getString(4))))
        if(!c.isNull(5))put("receipt",Json.parseToJsonElement(vault.open(c.getString(5))))
    })}}
    fun transfer(id:String,key:String,value:JsonObject){writableDatabase.execSQL("UPDATE messages SET transfer=? WHERE scope_id=? AND message_key=? AND state='pending'",arrayOf(vault.seal(value.toString()),id,key))}
    fun base(id:String,key:String,receipt:JsonObject){writableDatabase.execSQL("UPDATE messages SET receipt=? WHERE scope_id=? AND message_key=? AND state='pending' AND receipt IS NULL AND transfer IS NULL",arrayOf(vault.seal(receipt.toString()),id,key))}
    fun acknowledge(id:String,key:String,receipt:String){writableDatabase.execSQL("UPDATE messages SET state='acknowledged',payload=NULL,transfer=NULL,receipt=? WHERE scope_id=? AND message_key=? AND state='pending'",arrayOf(vault.seal(receipt),id,key))}
    fun failed(id:String,key:String,retryable:Boolean){
        writableDatabase.execSQL("UPDATE messages SET failures=failures+1,state=CASE WHEN ?=0 OR failures>=2 THEN 'held' ELSE 'pending' END,next_attempt=? WHERE scope_id=? AND message_key=? AND state='pending'",arrayOf(if(retryable)1 else 0,System.currentTimeMillis()+30_000,id,key))
        status(id,"partial")
    }
    // Remove only our transient screening copy; the Samsung SMS original is never touched.
    fun nonWork(id:String,key:String){writableDatabase.execSQL("UPDATE messages SET state='non_work',payload=NULL,transfer=NULL WHERE scope_id=? AND message_key=? AND state='pending'",arrayOf(id,key))}
    fun holdTriage(id:String,key:String){writableDatabase.execSQL("UPDATE messages SET state='held' WHERE scope_id=? AND message_key=? AND state='pending'",arrayOf(id,key));status(id,"partial")}
    fun deferTriage(id:String,key:String){writableDatabase.execSQL("UPDATE messages SET next_attempt=? WHERE scope_id=? AND message_key=? AND state='pending'",arrayOf(System.currentTimeMillis()+600000,id,key));status(id,"retry")}
    fun heldCount(id:String)=readableDatabase.rawQuery("SELECT count(*) FROM messages WHERE scope_id=? AND state='held'",arrayOf(id)).use{it.moveToFirst();it.getInt(0)}
    fun summary(s:UploadSession):String {
        val held=readableDatabase.rawQuery("SELECT count(*) FROM messages m JOIN scopes s ON s.id=m.scope_id WHERE s.owner=? AND m.state='held'",arrayOf(owner(s))).use{it.moveToFirst();it.getInt(0)}
        val counts=readableDatabase.rawQuery("SELECT m.state,count(*) FROM messages m JOIN scopes s ON s.id=m.scope_id WHERE s.owner=? GROUP BY m.state",arrayOf(owner(s))).use{c->buildMap{while(c.moveToNext())put(c.getString(0),c.getInt(1))}}
        val progress="업무 일지 ${counts["acknowledged"]?:0}건 · 일반 문자 제외 ${counts["non_work"]?:0}건 · 처리 대기 ${counts["pending"]?:0}건"
        return progress+if(held>0)"\n판단을 보류한 문자 ${held}건은 이 기기에 보호하여 보관합니다. 필요한 문자는 삼성 문자앱에서 시공노트로 공유해 주세요." else ""
    }
    companion object {fun hash(value:String)=MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}}
}
