package com.sigongnote.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sigongnote.contracts.CapturePolicy
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Real SAF/native UI regression. Only the separate devtest app and this test's empty folders change. */
@RunWith(AndroidJUnit4::class)
class FolderBatchDeviceTest {
    private val instrumentation=InstrumentationRegistry.getInstrumentation()
    private val context=instrumentation.targetContext
    private val authority="com.android.externalstorage.documents"
    private val read=Intent.FLAG_GRANT_READ_URI_PERMISSION
    private fun shell(command:String)=instrumentation.uiAutomation.executeShellCommand(command)
        .use{android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().readText()}
    private fun waitFor(message:String,timeout:Long=20_000,condition:()->Boolean) {
        val end=System.currentTimeMillis()+timeout
        while(System.currentTimeMillis()<end){if(condition())return;Thread.sleep(150)}
        fail(message)
    }
    private fun node(vararg labels:String):AccessibilityNodeInfo? {
        val root=instrumentation.uiAutomation.rootInActiveWindow?:return null
        for(label in labels)root.findAccessibilityNodeInfosByText(label)
            .firstOrNull{it.text?.toString()==label || it.contentDescription?.toString()==label}?.let{return it}
        return null
    }
    private fun click(vararg labels:String) {
        waitFor("Expected test control: ${labels.first()}"){node(*labels)?.isEnabled==true}
        var found=node(*labels)!!
        while(!found.isClickable && found.parent!=null)found=found.parent
        assertTrue("Test control must accept click",found.performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }
    private fun tree(documentId:String)=DocumentsContract.buildTreeDocumentUri(authority,documentId)
    private fun selectTree(activity:Activity,documentId:String):Uri {
        val uri=tree(documentId)
        instrumentation.runOnMainSync {
            // The real system picker delivers a temporary grant to the isolated product Activity.
            // A private test request code avoids injecting a fake JavaScript reply into the bridge.
            activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                .putExtra(DocumentsContract.EXTRA_INITIAL_URI,DocumentsContract.buildDocumentUri(authority,documentId))
                .addFlags(read or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION),7808)
        }
        waitFor("System picker must enter the unique fixture folder") {node(documentId.substringAfterLast('/'))!=null}
        click("이 폴더 사용","USE THIS FOLDER","Use this folder")
        waitFor("System folder grant must be approved") {
            node("허용","ALLOW","Allow")?.let{it.performAction(AccessibilityNodeInfo.ACTION_CLICK)}
            runCatching{context.contentResolver.takePersistableUriPermission(uri,read)}.isSuccess
        }
        assertTrue(context.contentResolver.persistedUriPermissions.any{it.uri==uri&&it.isReadPermission})
        return uri
    }
    private fun screenshot(name:String) {
        instrumentation.uiAutomation.takeScreenshot().let{image->
            File(context.getExternalFilesDir(null),name).outputStream().use{image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
        }
    }

    @Test fun nativeBatchUsesParentGrantAndRestoresLegacySourceWithoutChangingPriorConsent() {
        check(context.packageName=="com.sigongnote.app.devtest")
        // Never borrow or replace a saved account, including an account left in the test app.
        check(TokenVault(context).read()==null){"Isolated test app already has an account; preserve it"}
        val app=context.applicationContext as SigongnoteApp
        val rootName="Sigongnote-N08-${UUID.randomUUID().toString().take(8)}"
        val rootPath="/sdcard/Documents/$rootName"
        val parentId="primary:Documents/$rootName"
        val names=listOf("N08Site","공통자료","N08Unassigned","N08Legacy")
        val legacyDocument="$parentId/${names[3]}"
        val testIds=mutableSetOf<String>()
        val initialIds=app.queue.folderDao().activeSources().map{it.localSourceId}.toSet()
        val vault=FolderHandleVault()
        var activity:Activity?=null
        val granted=mutableListOf<Uri>()
        assertTrue(rootName.matches(Regex("Sigongnote-N08-[a-f0-9]{8}")))
        // executeShellCommand tokenizes directly; every fixture path deliberately has no spaces.
        assertEquals("",shell("mkdir -p "+names.joinToString(" "){"$rootPath/$it"}).trim())
        assertEquals(rootPath,shell("ls -d $rootPath").trim())
        try {
            activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val childGrant=selectTree(activity,legacyDocument);granted.add(childGrant)
            val owner=UUID.randomUUID().toString();val oldId=UUID.randomUUID().toString();testIds.add(oldId)
            val old=FolderSource(oldId,vault.seal(childGrant.toString()),1,"selected",0,null,null,0,0,0,0,null,UUID.randomUUID().toString(),7,1,
                owner,owner,owner,"folder","since",123L,"work_dedicated","a".repeat(64),false,"n08-existing-policy","{\"existing\":true}",
                UUID.randomUUID().toString(),null,"ready")
            app.queue.folderDao().insertSource(old)
            context.contentResolver.releasePersistableUriPermission(childGrant,read)
            app.scanExecutor.submit{FolderScanner(context,app.queue).scan(app.queue.folderDao().source(oldId)!!)}.get()
            assertEquals("permission_lost",app.queue.folderDao().source(oldId)!!.state)
            val parentGrant=selectTree(activity,parentId);granted.add(parentGrant)

            // Exercise the actual single-folder setup entry into the new native batch form.
            instrumentation.runOnMainSync{FolderSetup(activity,app){_,_->}.show(parentGrant,read,"folder")}
            click("하위 폴더 여러 개")
            waitFor("Native batch entry must appear"){node("하위 업무 폴더 함께 연결")!=null}
            assertFalse(node("선택한 폴더 한 번에 연결")!!.isEnabled)
            click("나중에")

            // Supply scoped synthetic catalog/session values directly; no vault or server is used.
            val project=UUID.randomUUID().toString()
            val session=UploadSession("https://fixture.invalid","https://fixture.invalid","https://fixture.invalid",
                "fixture","fixture","fixture",Long.MAX_VALUE,owner,owner,owner,owner,1,1)
            val policy=CapturePolicy("n08-new-policy","synthetic native UI check","N08 시험 공급자","시험 처리 위치","시험 보관 위치","직접 삭제",true)
            instrumentation.runOnMainSync{FolderBatchSetup(activity,app){_,_->}.show(parentGrant,read,session,policy,listOf(FolderProject(project,names[0])))}
            waitFor("Batch must show legacy permission recovery"){node("기존 연결을 유지하며 읽기 권한을 복구해요.")!=null}
            assertFalse(node("선택한 폴더 한 번에 연결")!!.isEnabled)
            click("선택한 폴더는 업무 자료이며 위 회사에 보관하고 안내한 N08 시험 공급자 외부 처리에 동의해요")
            assertTrue(node("선택한 폴더 한 번에 연결")!!.isEnabled)
            screenshot("n08-native-batch-consent.png")
            click("선택한 폴더 한 번에 연결")
            waitFor("Four independent child sources must persist") {
                app.queue.folderDao().activeSources().count{source->runCatching{FolderHandleAccess.open(source).rootDocumentId.startsWith("$parentId/")}.getOrDefault(false)}==4
            }
            val captured=app.queue.folderDao().activeSources().filter{source->runCatching{FolderHandleAccess.open(source).rootDocumentId.startsWith("$parentId/")}.getOrDefault(false)}
            testIds.addAll(captured.map{it.localSourceId})
            assertEquals(initialIds+testIds,app.queue.folderDao().activeSources().map{it.localSourceId}.toSet())
            assertFalse(captured.any{FolderHandleAccess.open(it).rootDocumentId==parentId})
            assertTrue(captured.all{FolderHandleAccess.open(it).grantUri==parentGrant.toString()})
            assertTrue(captured.all{FolderHandleAccess.open(it).parentDocumentId==parentId})
            val site=captured.single{FolderHandleAccess.open(it).displayName==names[0]}
            assertEquals(project,site.projectId);assertEquals("project",FolderHandleAccess.open(site).bindingScopeMode)
            assertEquals("company_common",FolderHandleAccess.open(captured.single{FolderHandleAccess.open(it).displayName==names[1]}).bindingScopeMode)
            assertEquals("unassigned",FolderHandleAccess.open(captured.single{FolderHandleAccess.open(it).displayName==names[2]}).bindingScopeMode)
            assertTrue(captured.filter{it.localSourceId!=oldId}.all{it.serverUploadConsent&&FolderHandleAccess.open(it).externalAiConsent})
            val restored=app.queue.folderDao().source(oldId)!!
            assertEquals(2,restored.scopeVersion);assertNotEquals("permission_lost",restored.state)
            assertEquals(old.serverSourceId,restored.serverSourceId);assertEquals(old.serverGeneration,restored.serverGeneration)
            assertEquals(old.scopeFingerprint,restored.scopeFingerprint);assertEquals(old.projectId,restored.projectId)
            assertEquals(old.historyMode,restored.historyMode);assertEquals(old.historySinceEpochMs,restored.historySinceEpochMs)
            assertEquals(old.processingPolicyId,restored.processingPolicyId);assertEquals(old.processingPolicySnapshot,restored.processingPolicySnapshot)
            assertEquals(old.serverUploadConsent,restored.serverUploadConsent);assertFalse(FolderHandleAccess.open(restored).externalAiConsent)
            assertEquals(oldId,FolderConnectionLookup.find(app.queue.folderDao(),childGrant.toString(),"not-the-old-fingerprint",vault::open)?.localSourceId)
            assertTrue(context.contentResolver.persistedUriPermissions.none{it.uri==childGrant})
            assertTrue(context.contentResolver.persistedUriPermissions.any{it.uri==parentGrant&&it.isReadPermission})
            app.scanExecutor.submit{captured.forEach{FolderScanner(context,app.queue).scan(app.queue.folderDao().source(it.localSourceId)!!)}}.get()
            assertTrue(testIds.all{app.queue.folderDao().source(it)?.state!="permission_lost"})
            screenshot("n08-native-batch-restored.png")
            assertNull(TokenVault(context).read())
        } finally {
            // Only pause sources created under this unique fixture; no existing queue is reset.
            app.queue.folderDao().activeSources().filter{it.localSourceId in testIds || runCatching{FolderHandleAccess.open(it).rootDocumentId.startsWith("$parentId/")}.getOrDefault(false)}.forEach{app.queue.folderDao().pause(it.localSourceId)}
            granted.forEach{runCatching{context.contentResolver.releasePersistableUriPermission(it,read)}}
            activity?.let{instrumentation.runOnMainSync{it.finish()}}
            // Non-recursive rmdir cannot remove a file or any non-empty user folder.
            names.forEach{shell("rmdir $rootPath/$it")};shell("rmdir $rootPath")
        }
    }
}
