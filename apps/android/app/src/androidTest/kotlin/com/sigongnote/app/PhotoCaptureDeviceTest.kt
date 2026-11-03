package com.sigongnote.app

import android.app.Activity
import android.app.KeyguardManager
import android.content.ContentValues
import android.content.ContentUris
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.os.PowerManager
import android.provider.MediaStore
import android.view.accessibility.AccessibilityNodeInfo
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Select only this test's fresh synthetic image through the real OS picker. */
@RunWith(AndroidJUnit4::class)
class PhotoCaptureDeviceTest {
    private val instrumentation=InstrumentationRegistry.getInstrumentation()
    private val context=instrumentation.targetContext
    private fun guard(){
        check(context.packageName=="com.sigongnote.app.devtest");check(TokenVault(context).read()==null)
        check(File(context.cacheDir,"camera").listFiles().isNullOrEmpty())
        // A killed instrumentation process cannot run finally. Recover only our own generated images.
        val media=MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val owned=mutableListOf<android.net.Uri>()
        context.contentResolver.query(media,arrayOf(MediaStore.MediaColumns._ID,MediaStore.MediaColumns.DISPLAY_NAME),
            "${MediaStore.MediaColumns.OWNER_PACKAGE_NAME} = ? AND ${MediaStore.MediaColumns.RELATIVE_PATH} = ? AND ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?",
            arrayOf(context.packageName,"Pictures/","N31-%.png"),null)?.use{rows->
            while(rows.moveToNext())if(Regex("N31-[a-f0-9-]{36}\\.png").matches(rows.getString(1)))owned.add(ContentUris.withAppendedId(media,rows.getLong(0)))
        }
        owned.forEach{context.contentResolver.delete(it,null,null)}
    }
    private fun waitFor(message:String,condition:()->Boolean){
        val until=System.currentTimeMillis()+20_000
        while(System.currentTimeMillis()<until){if(condition())return;Thread.sleep(150)}
        if(instrumentation.uiAutomation.rootInActiveWindow?.packageName==context.packageName)screenshot("photo-control-failure.png")
        val interactive=context.getSystemService(PowerManager::class.java).isInteractive
        val locked=context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
        val foreground=when(instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()){null->"UNAVAILABLE";context.packageName->"APP";else->"SYSTEM"}
        fail("$message (interactive=$interactive, keyguard=$locked, foreground=$foreground)")
    }
    private fun node(label:String,exact:Boolean=true):AccessibilityNodeInfo?=instrumentation.uiAutomation.rootInActiveWindow
        ?.findAccessibilityNodeInfosByText(label)?.firstOrNull{!it.isEditable&&listOfNotNull(it.text?.toString(),it.contentDescription?.toString()).any{value->if(exact)value==label else value.contains(label)}}
    private fun click(label:String,exact:Boolean=true){
        waitFor("Missing photo control: $label"){node(label,exact)?.isEnabled==true}
        var found=node(label,exact)!!;while(!found.isClickable&&found.parent!=null)found=found.parent
        assertTrue("Control must accept a click: $label",found.performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }
    // App controls belong to the Activity under test; a stale accessibility root can still point at the launcher.
    // Require the actual visible, focused native screen, then dispatch its real onClick handler. OS camera/picker
    // interaction below still uses UiAutomation and receives an actual granted URI, never an injected result.
    private fun nativeView(root:View,label:String):TextView? {
        if(root is TextView&&root.text.toString()==label)return root
        if(root is ViewGroup)for(index in 0 until root.childCount)nativeView(root.getChildAt(index),label)?.let{return it}
        return null
    }
    private fun onPhotoScreen(activity:Activity,condition:()->Boolean):Boolean {
        var result=false
        instrumentation.runOnMainSync{result=!activity.isFinishing&&!activity.isDestroyed&&
            ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(activity)==Stage.RESUMED&&
            activity.hasWindowFocus()&&activity.window.decorView.isShown&&activity.window.decorView.width>0&&condition()}
        return result
    }
    private fun nativeText(activity:Activity,label:String)=onPhotoScreen(activity){nativeView(activity.window.decorView,label)?.isShown==true}
    private fun nativeButton(activity:Activity,label:String)=onPhotoScreen(activity){(nativeView(activity.window.decorView,label) as? Button)?.let{it.isShown&&it.isEnabled&&it.getGlobalVisibleRect(Rect())}==true}
    private fun clickNative(activity:Activity,label:String){
        waitFor("Visible photo button must be enabled: $label"){nativeButton(activity,label)}
        instrumentation.runOnMainSync{
            assertTrue("Photo Activity must own the foreground before a native action",activity.hasWindowFocus()&&activity.window.decorView.isShown)
            assertEquals(Stage.RESUMED,ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(activity))
            val button=nativeView(activity.window.decorView,label) as? Button
            assertNotNull(button);assertTrue(button!!.isShown&&button.isEnabled&&button.isClickable&&button.getGlobalVisibleRect(Rect()));assertTrue(button.performClick())
        }
    }
    private fun back(){instrumentation.uiAutomation.executeShellCommand("input keyevent KEYCODE_BACK").close()}
    private fun closePicker(){repeat(5){val pkg=instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString();if(pkg=="android"||pkg?.contains("documentsui")==true){back();Thread.sleep(300)}}}
    private fun open():Activity {
        val activity=instrumentation.startActivitySync(Intent(context,PhotoCaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        try {
            instrumentation.waitForIdleSync()
            waitFor("Photo Activity must become visible and focused"){onPhotoScreen(activity){true}}
            return activity
        } catch(failure:Throwable){instrumentation.runOnMainSync{activity.finish()};throw failure}
    }
    private fun hash(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
    private fun screenshot(name:String){instrumentation.waitForIdleSync();Thread.sleep(500);instrumentation.uiAutomation.takeScreenshot().let{image->
        File(context.getExternalFilesDir(null),name).outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}
    }}

    @Test fun cameraAndGalleryCancellationKeepExistingQueue(){
        guard();val dao=(context.applicationContext as SigongnoteApp).queue.shareInboxDao()
        val before=dao.referencedCopyNames().sorted();val staged=dao.stagedCount();val activity=open()
        try {
            for(label in listOf("사진 찍기","갤러리에서 고르기")){
                clickNative(activity,label)
                waitFor("Real OS camera/picker must open") {instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.let{it!=context.packageName}==true}
                back()
                waitFor("Cancellation must return to the photo screen"){nativeText(activity,"촬영 취소")}
                assertEquals(staged,dao.stagedCount());assertEquals(before,dao.referencedCopyNames().sorted())
                assertTrue(File(context.cacheDir,"camera").listFiles().isNullOrEmpty())
                assertTrue(File(context.filesDir,"camera-pending").listFiles().isNullOrEmpty())
            }
            screenshot("photo-cancel.png")
        } finally {instrumentation.runOnMainSync{activity.finish()}}
    }

    @Test fun realGalleryGrantCreatesDecryptableCopyAndPreservesOriginal(){
        guard();val resolver=context.contentResolver;val name="N31-${UUID.randomUUID()}.png"
        val image=Bitmap.createBitmap(32,32,Bitmap.Config.ARGB_8888)
        val marker=name.toByteArray();for(x in 0 until 32)image.setPixel(x,0,android.graphics.Color.rgb(marker[x].toInt() and 255,91,147))
        val bytes=ByteArrayOutputStream().also{image.compress(Bitmap.CompressFormat.PNG,100,it)}.toByteArray();image.recycle()
        val original=resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,ContentValues().apply{
            put(MediaStore.MediaColumns.DISPLAY_NAME,name);put(MediaStore.MediaColumns.MIME_TYPE,"image/png")
            put(MediaStore.MediaColumns.RELATIVE_PATH,"Pictures/");put(MediaStore.MediaColumns.IS_PENDING,1)
        })!!
        val dao=(context.applicationContext as SigongnoteApp).queue.shareInboxDao();val before=dao.referencedCopyNames().toSet()
        var activity:Activity?=null;var ownCopy:ShareInboxItem?=null
        try {
            resolver.openOutputStream(original)!!.use{it.write(bytes)}
            resolver.update(original,ContentValues().apply{put(MediaStore.MediaColumns.IS_PENDING,0)},null,null)
            val opened=open();activity=opened;clickNative(opened,"갤러리에서 고르기")
            waitFor("System image picker must open"){instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.contains("documentsui")==true}
            // Always narrow the picker to this unique filename before selecting anything.
            run {
                val searchLabels=listOf("검색","Search")
                waitFor("System picker search action must be available"){searchLabels.any{node(it)?.isEnabled==true}}
                click(searchLabels.first{node(it)?.isEnabled==true})
                waitFor("Picker search field must open"){instrumentation.uiAutomation.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.isEditable==true}
                val field=instrumentation.uiAutomation.rootInActiveWindow.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                assertTrue(field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,Bundle().apply{putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,name)}))
                instrumentation.uiAutomation.executeShellCommand("input keyevent KEYCODE_ENTER").close()
            }
            waitFor("Synthetic image search must complete"){node(name,false)?.isVisibleToUser==true}
            // Use the file-name row, not the grid's separate preview/open-with button.
            listOf("목록 보기","List view").firstOrNull{node(it)!=null}?.let{click(it)}
            click(name)
            // Some DocumentsUI versions keep a multiple-selection confirmation after selecting a row.
            val confirmations=listOf("열기","선택","완료","OPEN","Open","SELECT","Select")
            val end=System.currentTimeMillis()+5_000
            while(System.currentTimeMillis()<end&&instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.contains("documentsui")==true){
                confirmations.firstOrNull{node(it)?.isEnabled==true}?.let{click(it)};Thread.sleep(150)
            }
            waitFor("Selected image must reach the actual encrypted inbox"){dao.findExactStaged(hash(bytes),bytes.size.toLong())!=null}
            ownCopy=dao.item(dao.findExactStaged(hash(bytes),bytes.size.toLong())!!)!!
            val recovered=ByteArrayOutputStream()
            File(context.filesDir,"share-inbox/${ownCopy.encryptedCopyName}").inputStream().use{
                ShareCopyReader(ShareCopyKey().get()).unseal(it,recovered,ownCopy.sha256!!,ownCopy.byteLength!!)
            }
            assertArrayEquals(bytes,recovered.toByteArray())
            assertArrayEquals(bytes,resolver.openInputStream(original)!!.use{it.readBytes()})
            assertTrue(dao.referencedCopyNames().containsAll(before));assertNull(TokenVault(context).read())
            waitFor("Photo status must confirm local preservation"){nativeText(opened,"사진 1개 보관 · 전송 대기")}
            screenshot("photo-gallery.png")
        } finally {
            closePicker()
            activity?.let{instrumentation.runOnMainSync{it.finish()}}
            // Only this test's URI and the exact newly owned local copy are eligible for cleanup.
            ownCopy?.let{item->if(item.encryptedCopyName !in before&&dao.markRevokedPurged(item.shareId)==1)File(context.filesDir,"share-inbox/${item.encryptedCopyName}").delete()}
            resolver.delete(original,null,null)
        }
    }

    @Test fun interruptedCameraOutputSurvivesReopenAndRetryVerifiesEncryptedBytes(){
        guard();val dao=(context.applicationContext as SigongnoteApp).queue.shareInboxDao()
        val before=dao.referencedCopyNames().toSet()
        val store=PendingPhotos(File(context.filesDir,"camera-pending"),File(context.cacheDir,"camera"))
        check(store.pending().isEmpty())
        val bytes=("N31-camera-${UUID.randomUUID()}").toByteArray();val original=store.create().apply{writeBytes(bytes)}
        var activity:Activity?=null;var ownCopy:ShareInboxItem?=null;var damagedCopy:ShareInboxItem?=null
        val empty=store.create();val emptyId=empty.nameWithoutExtension
        try{
            assertFalse(store.preserve(original){_,_,_->false})
            assertTrue(runCatching{store.preserve(original){_,_,_->throw java.io.IOException("synthetic storage failure")}}.isFailure)
            assertArrayEquals(bytes,original.readBytes())
            // An interrupted attempt may have left an unusable duplicate row. Never trust its metadata alone.
            val inbox=File(context.filesDir,"share-inbox")
            val receiver=ShareReceiver(context.contentResolver,dao,ShareCopyWriter(ShareCopyKey().get(),inbox),inbox)
            val emptyShare=Intent(Intent.ACTION_SEND).setType("image/jpeg").putExtra(Intent.EXTRA_STREAM,androidx.core.content.FileProvider.getUriForFile(context,context.packageName+".capture",empty))
            val failedBefore=dao.failedCount()
            assertEquals(0,receiver.receive(emptyShare,emptyId));assertEquals(0,receiver.receive(emptyShare,emptyId))
            assertEquals(failedBefore+1,dao.failedCount())
            empty.writeText("N31-retry-${UUID.randomUUID()}");assertEquals(1,receiver.receive(emptyShare,emptyId))
            assertEquals(failedBefore,dao.failedCount());empty.delete()
            val shared=Intent(Intent.ACTION_SEND).setType("image/jpeg").putExtra(Intent.EXTRA_STREAM,
                androidx.core.content.FileProvider.getUriForFile(context,context.packageName+".capture",original))
            assertEquals(1,ShareReceiver(context.contentResolver,dao,ShareCopyWriter(ShareCopyKey().get(),inbox),inbox).receive(shared))
            damagedCopy=dao.item(dao.findExactStaged(hash(bytes),bytes.size.toLong())!!)!!
            File(inbox,damagedCopy.encryptedCopyName!!).writeText("synthetic damaged encryption")
            activity=open();waitFor("Pending camera output must be visible"){nativeButton(activity!!,"보관 대기 사진 다시 보관")}
            instrumentation.runOnMainSync{activity!!.finish()};activity=open()
            clickNative(activity!!,"보관 대기 사진 다시 보관")
            waitFor("Verified camera output must leave pending storage"){!original.exists()}
            ownCopy=dao.item(dao.findExactStaged(hash(bytes),bytes.size.toLong())!!)!!
            val recovered=ByteArrayOutputStream()
            File(context.filesDir,"share-inbox/${ownCopy.encryptedCopyName}").inputStream().use{ShareCopyReader(ShareCopyKey().get()).unseal(it,recovered,hash(bytes),bytes.size.toLong())}
            assertArrayEquals(bytes,recovered.toByteArray());assertTrue(dao.referencedCopyNames().containsAll(before));assertNull(TokenVault(context).read())
            assertEquals("copy_integrity_failed",dao.item(damagedCopy.shareId)!!.failureCode)
            screenshot("photo-recovered.png")
        }finally{
            activity?.let{instrumentation.runOnMainSync{it.finish()}}
            ownCopy?.let{if(it.encryptedCopyName !in before&&dao.markRevokedPurged(it.shareId)==1)File(context.filesDir,"share-inbox/${it.encryptedCopyName}").delete()}
            damagedCopy?.let{if(it.encryptedCopyName !in before&&dao.markRevokedPurged(it.shareId)==1)File(context.filesDir,"share-inbox/${it.encryptedCopyName}").delete()}
            dao.item(emptyId)?.let{if(it.encryptedCopyName !in before&&dao.markRevokedPurged(it.shareId)==1&&it.encryptedCopyName!=null)File(context.filesDir,"share-inbox/${it.encryptedCopyName}").delete()}
            empty.delete()
            original.delete()
        }
    }
}
