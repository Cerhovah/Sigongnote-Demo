package com.sigongnote.app

import android.content.Context
import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(tableName="folder_scan_runs")
data class FolderScanRun(@PrimaryKey val sourceId:String,val generation:Int,
    val state:String,val discoveryAtEpochMs:Long)

@Entity(tableName="folder_scan_directories",primaryKeys=["sourceId","documentHash"],indices=[Index(value=["sourceId","generation","state","depth"])])
data class FolderScanDirectory(val sourceId:String,val documentHash:String,
    val encryptedDocumentId:String,val generation:Int,val depth:Int,val state:String,val error:String?,val lastVisitedAtEpochMs:Long=0)

@Entity(tableName="folder_scan_items",primaryKeys=["sourceId","documentHash"],indices=[
    Index(value=["sourceId","generation","state","providerModifiedAtEpochMs"])])
data class FolderScanItem(val sourceId:String,val documentHash:String,val generation:Int,
    val encryptedEntry:String,val providerSize:Long?,val providerModifiedAtEpochMs:Long?,
    val observedAtEpochMs:Long,val state:String,val scopeResult:String,val ruleVersion:Int,
    val error:String?,val attempts:Int=0)

@Dao
interface FolderScanDao {
    @Query("SELECT * FROM folder_scan_runs WHERE sourceId=:id") fun run(id:String):FolderScanRun?
    @Insert(onConflict=OnConflictStrategy.REPLACE) fun putRun(run:FolderScanRun)
    @Insert(onConflict=OnConflictStrategy.IGNORE) fun addDirectory(row:FolderScanDirectory):Long
    @Query("DELETE FROM folder_scan_directories WHERE sourceId=:id") fun clearDirectories(id:String)
    @Query("SELECT * FROM folder_scan_directories WHERE sourceId=:id AND generation=:generation AND state='todo' ORDER BY lastVisitedAtEpochMs,depth,documentHash LIMIT 1")
    fun nextDirectory(id:String,generation:Int):FolderScanDirectory?
    @Query("UPDATE folder_scan_directories SET state=:state,error=:error WHERE sourceId=:id AND documentHash=:hash AND generation=:generation")
    fun directoryState(id:String,hash:String,generation:Int,state:String,error:String?):Int
    @Query("SELECT COUNT(*) FROM folder_scan_directories WHERE sourceId=:id AND generation=:generation AND state=:state")
    fun directoryCount(id:String,generation:Int,state:String):Int
    @Query("UPDATE folder_scan_directories SET state='todo' WHERE sourceId=:id AND generation=:generation AND state='done'")
    fun refreshDirectories(id:String,generation:Int):Int
    @Query("UPDATE folder_scan_directories SET lastVisitedAtEpochMs=:now WHERE sourceId=:id AND documentHash=:hash")
    fun visited(id:String,hash:String,now:Long)
    @Query("UPDATE folder_scan_directories SET state='todo' WHERE sourceId=:id AND generation=:generation AND documentHash IN (SELECT documentHash FROM folder_scan_directories WHERE sourceId=:id AND generation=:generation AND state='done' AND depth<=1 ORDER BY lastVisitedAtEpochMs LIMIT 2)")
    fun refreshRecentDirectories(id:String,generation:Int):Int
    @Query("SELECT * FROM folder_scan_items WHERE sourceId=:id AND documentHash=:hash")
    fun item(id:String,hash:String):FolderScanItem?
    @Insert(onConflict=OnConflictStrategy.REPLACE) fun putItem(row:FolderScanItem)
    @Query("SELECT * FROM folder_scan_items WHERE sourceId=:id AND generation=:generation AND state IN ('pending','retry') ORDER BY providerModifiedAtEpochMs DESC,documentHash LIMIT :limit")
    fun pending(id:String,generation:Int,limit:Int):List<FolderScanItem>
    @Query("SELECT * FROM folder_scan_items WHERE sourceId=:id AND generation=:generation AND state IN ('pending','retry') ORDER BY providerModifiedAtEpochMs,documentHash LIMIT 1")
    fun oldestPending(id:String,generation:Int):List<FolderScanItem>
    @Query("UPDATE folder_scan_items SET state=:state,scopeResult=:scope,error=:error WHERE sourceId=:id AND documentHash=:hash AND generation=:generation")
    fun itemState(id:String,hash:String,generation:Int,state:String,scope:String,error:String?):Int
    @Query("UPDATE folder_scan_items SET attempts=attempts+1,state=CASE WHEN attempts>=2 THEN 'held' ELSE 'retry' END,error=:error WHERE sourceId=:id AND documentHash=:hash AND generation=:generation")
    fun failedAttempt(id:String,hash:String,generation:Int,error:String):Int
    @Query("SELECT COUNT(*) FROM folder_scan_items WHERE sourceId=:id AND generation=:generation")
    fun itemCount(id:String,generation:Int):Int
    @Query("SELECT COUNT(*) FROM folder_scan_items WHERE sourceId=:id AND generation=:generation AND state=:state")
    fun stateCount(id:String,generation:Int,state:String):Int
    @Query("SELECT COUNT(*) FROM folder_scan_items WHERE sourceId=:id AND generation=:generation AND state IN ('pending','retry')")
    fun pendingCount(id:String,generation:Int):Int
}

class FolderScanMigration(private val context:Context):Migration(8,9) {
    override fun migrate(db:SupportSQLiteDatabase) {
        context.assets.open("migrations/8-9.sql").bufferedReader().use { it.readText() }
            .split(';').map(String::trim).filter(String::isNotEmpty).forEach(db::execSQL)
    }
}
