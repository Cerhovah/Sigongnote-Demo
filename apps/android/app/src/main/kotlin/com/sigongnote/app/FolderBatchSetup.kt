package com.sigongnote.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.widget.*
import com.sigongnote.contracts.CapturePolicy
import java.util.UUID
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class FolderBatchSetup(private val activity:Activity,private val app:SigongnoteApp,
    private val finished:(Boolean,String)->Unit) {
    private fun sameOwner(source:FolderSource,session:UploadSession?)=source.boundTenantId==null ||
        (session!=null&&source.boundTenantId==session.tenantId&&source.boundUserId==session.userId&&source.boundDeviceId==session.deviceId)
    private data class Row(val folder:DiscoveredFolder,val selected:CheckBox,val scope:Spinner)
    fun show(uri:Uri,flags:Int,session:UploadSession?,policy:CapturePolicy?,projects:List<FolderProject>,requestedKind:String="folder") {
        val loading=AlertDialog.Builder(activity).setMessage("하위 업무 폴더를 찾고 있어요…").setCancelable(false).create();loading.show()
        app.setupExecutor.execute {
          try {
            val parent=DocumentsContract.getTreeDocumentId(uri)
            val inventory=FolderInventory(activity.contentResolver)
            val sources=app.queue.folderDao().activeSources().mapNotNull { source->runCatching{source to FolderHandleAccess.open(source)}.getOrNull() }
            val result=FolderBatchPolicy.discover(parent,FolderChildrenReader{root,consumer->inventory.visit(uri,root,consumer)},projects) { entry ->
                val handle=FolderCaptureHandle(uri.toString(),entry.documentId,"unassigned",parent)
                if(sources.any{it.first.state=="permission_lost"&&sameOwner(it.first,session)&&it.second.documentKey()==handle.documentKey()})"permission_restore"
                else if(sources.any{FolderHandleAccess.overlaps(activity.contentResolver,it.second,handle)}) "already_covered"
                else {inventory.visit(uri,entry.documentId){false};null}
            }
            activity.runOnUiThread {loading.dismiss();if(!activity.isFinishing&&!activity.isDestroyed)form(uri,flags,parent,result,session,policy,projects,requestedKind)}
          } catch (_:Exception) {
            activity.runOnUiThread {
                loading.dismiss()
                if(!activity.isFinishing&&!activity.isDestroyed)finished(false,"folder_connection_failed")
            }
          }
        }
    }
    private fun form(uri:Uri,flags:Int,parent:String,result:FolderBatchDiscoveryResult,session:UploadSession?,policy:CapturePolicy?,projects:List<FolderProject>,requestedKind:String) {
        val layout=LinearLayout(activity).apply{orientation=LinearLayout.VERTICAL;val p=(20*resources.displayMetrics.density).toInt();setPadding(p,p,p,p)}
        fun label(text:String){layout.addView(TextView(activity).apply{this.text=text;textSize=17f})}
        label("찾은 폴더를 한 번에 확인하세요. 상위 위치는 수집하지 않으며 현장이 아직 없으면 미확정으로 둘 수 있어요.")
        label(parent)
        label("새로 연결하는 폴더는 모두 지금부터 읽어요. 과거 범위는 개별 폴더 연결의 고급 설정에서 선택할 수 있어요.")
        if(result.partial)label("일부 폴더는 권한이나 목록을 확인하지 못했어요. 폴더가 많으면 더 작은 상위 위치를 선택하세요. 선택 가능한 폴더는 먼저 연결할 수 있어요.")
        val rows=result.folders.map{folder->
            val selected=CheckBox(activity).apply{text=folder.name;textSize=18f;isChecked=folder.issue==null||folder.issue=="permission_restore";isEnabled=isChecked};layout.addView(selected)
            label(folder.providerId)
            if(folder.issue!=null)label(when(folder.issue){"already_covered"->"이 위치 또는 겹치는 폴더가 이미 연결되어 있어요.";"permission_restore"->"기존 연결을 유지하며 읽기 권한을 복구해요.";else->"읽기 권한을 확인해 주세요."})
            val spinner=Spinner(activity).apply{
                adapter=ArrayAdapter(activity,android.R.layout.simple_spinner_dropdown_item,listOf("현장 미확정","회사 공통 자료")+projects.map{it.name}+listOf("새 현장 만들기 · ${folder.name}"))
                isEnabled=folder.issue==null && session!=null && policy!=null
                setSelection(when(folder.scope){"company_common"->1;"project"->projects.indexOfFirst{it.id==folder.projectId}.takeIf{it>=0}?.plus(2)?:0;else->0})
            };layout.addView(spinner);Row(folder,selected,spinner)
        }
        val online=session!=null&&policy!=null
        label("새로 연결한 폴더는 지금부터 생기거나 수정된 자료를 읽어요. 복구하는 기존 폴더는 전에 허용한 범위를 유지해요.")
        label(if(online)"현재 로그인한 회사에 보관합니다.\n${CapturePolicyNotice.text(policy!!)}"
            else "지금은 휴대폰에 보관합니다. 로그인 뒤 각 폴더를 연결하면 다른 기기에서도 볼 수 있어요.")
        val consent=CheckBox(activity).apply{text=if(policy?.external_processing==true)"선택한 폴더는 업무 자료이며 위 회사에 보관하고 안내한 목적별 외부 처리에 동의해요" else "선택한 폴더는 업무 자료이며 위 범위로 읽고 보관하는 데 동의해요";textSize=18f};layout.addView(consent)
        val dialog=AlertDialog.Builder(activity).setTitle("하위 업무 폴더 함께 연결").setView(ScrollView(activity).apply{addView(layout)})
            .setNegativeButton("나중에"){_,_->finished(false,"folder_cancelled")}.setPositiveButton("선택한 폴더 한 번에 연결",null).create()
        dialog.setOnCancelListener{finished(false,"folder_cancelled")}
        dialog.setOnShowListener{
            val save=dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            fun changed(){save.isEnabled=consent.isChecked&&rows.any{it.selected.isChecked}}
            consent.setOnCheckedChangeListener{_,_->changed()};rows.forEach{it.selected.setOnCheckedChangeListener{_,_->changed()}};changed()
            save.setOnClickListener{
                val selected=rows.filter{it.selected.isChecked}.map{row->
                    val index=row.scope.selectedItemPosition
                    val project=projects.getOrNull(index-2)
                    Triple(row.folder,when {index==1->"company_common";project!=null||index==projects.size+2->"project";else->"unassigned"},
                        if(project!=null)project else if(index==projects.size+2)FolderProject("",row.folder.name.take(180)) else null)
                }
                try{require(flags and Intent.FLAG_GRANT_READ_URI_PERMISSION!=0);activity.contentResolver.takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION)}
                catch(_:Exception){finished(false,"folder_grant_missing");dialog.dismiss();return@setOnClickListener}
                dialog.dismiss();persist(uri,parent,selected,session,policy,requestedKind,policy?.external_processing==true&&consent.isChecked)
            }
        };dialog.show()
    }
    private fun persist(uri:Uri,parent:String,selected:List<Triple<DiscoveredFolder,String,FolderProject?>>,session:UploadSession?,policy:CapturePolicy?,requestedKind:String,externalAiConsent:Boolean) {
        app.setupExecutor.execute {
            var added=0;var failed=0;var skipped=0;val vault=FolderHandleVault()
            for((folder,scope,project) in selected)try {
                val handle=FolderCaptureHandle(uri.toString(),folder.providerId,scope,parent,folder.name.take(180),externalAiConsent)
                val existing=app.queue.folderDao().activeSources().mapNotNull{source->runCatching{source to FolderHandleAccess.open(source)}.getOrNull()}
                val restore=existing.firstOrNull{it.first.state=="permission_lost"&&sameOwner(it.first,session)&&it.second.documentKey()==handle.documentKey()}
                if(restore!=null){
                    val old=restore.first;val restoredHandle=restore.second.copy(grantUri=uri.toString(),parentDocumentId=parent,displayName=folder.name.take(180),bindingScopeMode=restore.second.bindingScopeMode?:if(old.projectId!=null)"project" else "company_common")
                    app.queue.runInTransaction{check(app.queue.folderDao().restoreChildGrant(old.localSourceId,vault.seal(restoredHandle.encode()))==1);app.queue.folderDao().scanFailed(old.localSourceId,"selected","permission_restored")}
                    added++;continue
                }
                if(existing.any{FolderHandleAccess.overlaps(activity.contentResolver,it.second,handle)}){skipped++;continue}
                val kind=FolderBatchPolicy.kind(folder.name,requestedKind);val fingerprint=FolderScopeFingerprint().of(handle.documentKey(),kind)
                val online=session!=null&&policy!=null;val now=System.currentTimeMillis()
                val historyStart=FolderBatchPolicy.historyStart(kind,now)
                val source=FolderSource(UUID.randomUUID().toString(),vault.seal(handle.encode()),2,"selected",0,null,null,0,0,0,0,null,null,null,now,
                    session?.tenantId,session?.userId,session?.deviceId,kind,"since",historyStart,"work_dedicated",fingerprint,online,policy?.id,policy?.let{Json.encodeToString(it)},
                    project?.id?.takeIf{it.isNotEmpty()},project?.takeIf{it.id.isEmpty()}?.name?.let(vault::seal),if(online)"pending" else "local_only")
                app.queue.folderDao().insertSource(source);added++
            }catch(_:Exception){failed++}
            CaptureUploadWork.enqueue(activity);CaptureMaintenanceWork.enqueue(activity)
            activity.runOnUiThread {
                if(!activity.isFinishing&&!activity.isDestroyed)AlertDialog.Builder(activity).setTitle("폴더 연결")
                    .setMessage("${added}개 폴더를 연결했어요."+(if(skipped>0)" ${skipped}개는 이미 연결된 범위예요." else "")+(if(failed>0)" ${failed}개는 다시 확인해 주세요. 다른 폴더는 계속 읽습니다." else " 새 폴더는 같은 상위 위치에서 다시 찾을 수 있어요."))
                    .setPositiveButton("확인"){_,_->finished(added>0,if(added>0)"folder_connected" else "folder_connection_failed")}.show()
            }
        }
    }
}
