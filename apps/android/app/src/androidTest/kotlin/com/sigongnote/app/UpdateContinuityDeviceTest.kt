package com.sigongnote.app
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File
class UpdateContinuityDeviceTest {
 @Test fun packageReplacementPreservesVaultKeyAndPendingQueue(){
  val inst=InstrumentationRegistry.getInstrumentation();val context=inst.targetContext
  check(context.packageName=="com.sigongnote.app.devtest")
  val phase=InstrumentationRegistry.getArguments().getString("phase")
  require(phase in setOf("seed","verify")){"Run phase=seed, replace only the isolated app with a higher versionCode APK, then run phase=verify"}
  // Read the installed target package. BuildConfig constants may be inlined into the old test APK.
  val installed=context.packageManager.getPackageInfo(context.packageName,0)
  @Suppress("DEPRECATION") val installedVersion=if(android.os.Build.VERSION.SDK_INT>=28)installed.longVersionCode else installed.versionCode.toLong()
  val id="d1900000-0000-4000-8000-000000000001";val vault=TokenVault(context)
  val db=(context.applicationContext as SigongnoteApp).queue;val file=File(context.filesDir,"d19-protected-copy")
  val checkpoint=context.getSharedPreferences("d19-test",0)
  if(phase=="seed"){
   check(vault.read()==null){"Preserve an existing isolated-app account"}
   check(!file.exists()&&db.queueDao().get(id)==null){"Preserve an unfinished continuity fixture"}
   vault.store("D19 synthetic account marker")
   file.writeText(FolderHandleVault().seal("D19 synthetic unuploaded original"))
   db.queueDao().insertIfAbsent(CaptureQueueItem(id,id,id,id,id,1,"paused_logout",file.name,"0".repeat(64),36,0,0))
   check(checkpoint.edit().putLong("version",installedVersion).commit())
  }else{
   assertTrue("A successful seed phase must precede package replacement",checkpoint.contains("version"))
   assertTrue("The installed app must have a higher versionCode after adb install -r",installedVersion>checkpoint.getLong("version",Long.MAX_VALUE))
   assertEquals("D19 synthetic account marker",vault.read())
   assertEquals("D19 synthetic unuploaded original",FolderHandleVault().open(file.readText()))
   assertEquals("Pending queue bytes, ownership and logout state must survive replacement",CaptureQueueItem(id,id,id,id,id,1,"paused_logout",file.name,"0".repeat(64),36,0,0),db.queueDao().get(id))
   // Only this isolated fixture is cleared after every continuity assertion succeeds.
   db.openHelper.writableDatabase.execSQL("DELETE FROM capture_queue WHERE captureId = ?",arrayOf(id))
   assertTrue(file.delete());vault.clear();check(checkpoint.edit().clear().commit())
  }
 }
}
