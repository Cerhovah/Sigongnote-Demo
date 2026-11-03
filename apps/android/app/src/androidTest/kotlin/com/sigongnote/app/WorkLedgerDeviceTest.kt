package com.sigongnote.app

import android.content.Intent
import android.webkit.WebView
import android.view.View
import android.view.ViewGroup
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Real WebView/native bridge/loopback API; isolated app only, no product account changes. */
class WorkLedgerDeviceTest {
 @Test fun uploadsIsolatedPhotoToActualLocalApi(){
  val context=InstrumentationRegistry.getInstrumentation().targetContext;check(context.packageName=="com.sigongnote.app.devtest")
  val raw=context.openFileInput("work-fixture-session.json").bufferedReader().use{it.readText()};val session=UploadSession.decode(raw,true)
  check(Regex("""^http://127\.0\.0\.1:\d+/$""").matches(session.apiBaseUrl));val vault=TokenVault(context);check(vault.read()==null)
  val db=(context.applicationContext as SigongnoteApp).queue;val capture=java.util.UUID.randomUUID().toString()
  val image=android.graphics.Bitmap.createBitmap(96,96,android.graphics.Bitmap.Config.ARGB_8888);image.eraseColor(android.graphics.Color.BLUE)
  val bytes=java.io.ByteArrayOutputStream().also{image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}.toByteArray();image.recycle()
  val copy=ShareCopyWriter(ShareCopyKey().get(),java.io.File(context.filesDir,"share-inbox")).seal(bytes.inputStream(),1024*1024)
  try{
   vault.store(raw);db.shareInboxDao().insert(ShareInboxItem(capture,capture,"staged_unbound","image/png",copy.fileName,copy.sha256,copy.byteLength,null,System.currentTimeMillis()))
   val manager=androidx.work.WorkManager.getInstance(context);val work=androidx.work.OneTimeWorkRequestBuilder<CaptureUploadWorker>().build();manager.enqueue(work).result.get(20,TimeUnit.SECONDS)
   val end=System.currentTimeMillis()+90_000
   while(System.currentTimeMillis()<end&&db.queueDao().get(capture)?.state!="acknowledged")Thread.sleep(250)
   assertEquals("Actual API must acknowledge the encrypted local photo", "acknowledged",db.queueDao().get(capture)?.state)
   val receipt=db.copyReceiptDao().get(capture)!!
   java.io.File(context.getExternalFilesDir(null),"mobile-transfer.json").writeText(org.json.JSONObject().put("capture_id",capture).put("revision_id",receipt.revisionId).put("sha256",copy.sha256).put("bytes",copy.byteLength).toString())
  }finally{vault.clear()}
 }
 @Test fun ledgerDocumentsAndTodayRemainReachableAtLargeText(){
  val inst=InstrumentationRegistry.getInstrumentation();val context=inst.targetContext
  check(context.packageName=="com.sigongnote.app.devtest")
  val raw=context.openFileInput("work-fixture-session.json").bufferedReader().use{it.readText()}
  check(Regex("""^http://127\.0\.0\.1:\d+/$""").matches(UploadSession.decode(raw,true).apiBaseUrl))
  val vault=TokenVault(context);check(vault.read()==null);vault.store(raw)
  val activity=inst.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  fun web(v:View):WebView?{if(v is WebView)return v;if(v is ViewGroup)for(i in 0 until v.childCount)web(v.getChildAt(i))?.let{return it};return null}
  fun js(script:String):String{val latch=CountDownLatch(1);var result="";inst.runOnMainSync{web(activity.window.decorView)!!.evaluateJavascript(script){result=it;latch.countDown()}};check(latch.await(5,TimeUnit.SECONDS));return result}
  fun waitFor(script:String){var ok=false;repeat(100){if(!ok){Thread.sleep(150);ok=js(script)=="true"}};assertTrue(script,ok)}
  fun fit(){assertEquals("Horizontal content must fit", "true",js("document.documentElement.scrollWidth<=innerWidth+1"));assertEquals("One screen title","1",js("document.querySelectorAll('main h1').length"))}
  fun todayReady(){
   waitFor("Boolean(document.querySelector('#today-next'))")
   waitFor("Boolean(document.querySelector('#today-next[aria-busy=false]'))")
   // Only fixed labels leave the app. Never include DOM text, identifiers or an API response.
   val diagnosis=js("(()=>{const s=document.querySelector('#today-next')?.textContent||'',d=[];if(s.includes('오늘 확인할 일을 아직 가져오지 못했어요.'))d.push('SN_DIAG:questions.list:READ_FAILED');if(s.includes('챙길 일을 갱신하지 못했어요.'))d.push('SN_DIAG:journal.tasks:READ_FAILED');if(s.includes('최신 기록을 확인하지 못했어요.'))d.push('SN_DIAG:agenda.read:READ_FAILED');if(s.includes('현재 기록을 열람할 수 없어요.'))d.push('SN_DIAG:agenda.read:ACCESS_DENIED');return d.join(' ')||'SN_DIAG:today:UNKNOWN_ALERT'})()")
   assertEquals("No authority/transport error after the real agenda, task and question APIs settle; "+diagnosis,"0",js("document.querySelectorAll('#today-next [role=alert]').length"))
  }
  try{
   todayReady()
   for(zoom in listOf(100,200)){
    inst.runOnMainSync{web(activity.window.decorView)!!.settings.textZoom=zoom};Thread.sleep(300)
    js("location.hash='#/materials/site'")
    waitFor("Boolean(document.querySelector('.ledger-home'))")
    waitFor("!document.querySelector('.ledger-home [role=status]')")
    assertEquals("Native bridge must allow the real ledger API","0",js("document.querySelectorAll('.ledger-home [role=alert]').length"));fit()
    for(label in listOf("약속","도면·자재","납품·작업","청구·지급","점검·하자","모든 기록")){
     js("Array.from(document.querySelectorAll('.work-category-tabs button')).find(b=>b.textContent==='$label').click()")
     waitFor("Array.from(document.querySelectorAll('.work-category-tabs button')).some(b=>b.textContent==='$label'&&b.getAttribute('aria-pressed')==='true')");fit()
    }
    inst.uiAutomation.takeScreenshot().let{image->java.io.File(context.getExternalFilesDir(null),"ledger-$zoom.png").outputStream().use{image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}}
    waitFor("Boolean(document.querySelector('.ledger-home .ledger-row'))")
    js("document.querySelector('.ledger-home .ledger-row').click()")
    waitFor("Boolean(document.querySelector('.ledger-detail'))");fit()
    assertEquals("The real API must return linked evidence","true",js("document.querySelectorAll('.ledger-detail .ledger-evidence-link').length>0"))
    js("location.hash='#/documents'");waitFor("Boolean(document.querySelector('.work-document-history'))")
    for(label in listOf("초안","발행본","받은 자료")){
     js("Array.from(document.querySelectorAll('.work-category-tabs button')).find(b=>b.textContent.startsWith('$label')).click()")
     waitFor("Array.from(document.querySelectorAll('.work-category-tabs button')).some(b=>b.textContent.startsWith('$label')&&b.getAttribute('aria-pressed')==='true')");fit()
    }
    js("location.hash='#/today'");todayReady();fit()
   }
  }finally{inst.runOnMainSync{web(activity.window.decorView)?.settings?.textZoom=100;activity.finish()};vault.clear()}
 }
}
