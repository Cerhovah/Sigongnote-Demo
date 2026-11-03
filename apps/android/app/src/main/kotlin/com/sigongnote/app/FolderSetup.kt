package com.sigongnote.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.provider.DocumentsContract
import android.widget.ArrayAdapter
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Button
import android.widget.Spinner
import android.widget.TextView
import com.sigongnote.contracts.CapturePolicy
import java.util.UUID
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** One initial choice of folder, history and company. Normal files need no prompts. */
class FolderSetup(private val activity: Activity, private val app: SigongnoteApp,
    private val finished: (Boolean,String) -> Unit) {
    private fun existing(uri: Uri, kind: String): FolderSource? = FolderConnectionLookup.find(
        app.queue.folderDao(),uri.toString(),FolderScopeFingerprint().of(uri.toString(),kind)) {
        FolderHandleVault().open(it)
    }

    private var startingProject:String?=null
    fun show(uri: Uri, flags: Int, requestedKind: String) {
        val loading=AlertDialog.Builder(activity).setMessage("폴더 확인 중…")
            .setCancelable(false).create(); loading.show()
        app.setupExecutor.execute {
          try {
            val root = DocumentsContract.getTreeDocumentId(uri)
            val kind = if (requestedKind == "folder") when {
                Regex("(?i)(^|[:/])(recordings?|통화|call)(/|$)").containsMatchIn(root) -> "call_recording"
                Regex("(?i)(^|[:/])(dcim|camera)(/|$)").containsMatchIn(root) -> "photos"
                else -> "folder"
            } else requestedKind
            val name = runCatching {
                activity.contentResolver.query(DocumentsContract.buildDocumentUriUsingTree(uri,root),
                    arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),null,null,null)?.use {
                    if (it.moveToFirst()) it.getString(0) else null
                }
            }.getOrNull()?.takeIf { it.isNotBlank() } ?: "새 현장"
            val existing=existing(uri,kind)
            val session = runCatching { TokenVault(activity).read()?.let { UploadSession.decode(it,
                activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) } }.getOrNull()
            val setupClient=okhttp3.OkHttpClient.Builder().followRedirects(false)
                .connectTimeout(3,java.util.concurrent.TimeUnit.SECONDS).readTimeout(5,java.util.concurrent.TimeUnit.SECONDS)
                .callTimeout(8,java.util.concurrent.TimeUnit.SECONDS).build()
            val api=session?.let { UploadApi(it,setupClient) }
            val policy = runCatching { api?.connectionPolicy() }.getOrNull()
            startingProject=runCatching { api?.firstSiteProject() }.getOrNull()
            val projects = runCatching { api?.folderProjects() }.getOrNull().orEmpty()
            activity.runOnUiThread {
                loading.dismiss()
                if (!activity.isFinishing && !activity.isDestroyed) form(uri,flags,kind,name,session,policy,projects,existing)
            }
          } catch (_: Exception) { activity.runOnUiThread { loading.dismiss(); finished(false,"folder_connection_failed") } }
        }
    }

    private fun form(uri: Uri, flags: Int, kind: String, name: String, session: UploadSession?,
        policy: CapturePolicy?, projects: List<FolderProject>, existing: FolderSource?, replacing: Boolean=false) {
        if(existing!=null && (existing.bindingState!="local_only" || existing.serverSourceId!=null) && !replacing) {
            val other=existing.boundTenantId!=session?.tenantId || existing.boundUserId!=session?.userId || existing.boundDeviceId!=session?.deviceId
            val needs=existing.bindingState=="needs_attention" || other
            val message=when {
                session==null -> "이 폴더를 연결한 계정으로 로그인하면 이어 쓸 수 있어요."
                other -> "다른 회사나 계정에 연결된 폴더예요. 현재 로그인한 회사로 새로 연결할 수 있어요."
                existing.state=="permission_lost" -> "폴더 읽기 권한이 해제되어 수집을 멈췄어요. 같은 폴더의 읽기 권한을 다시 허용하면 기존 자료에 이어서 읽습니다."
                needs -> "연결 설정을 다시 확인해야 해요. 보관한 자료는 그대로 있습니다."
                existing.bindingState=="ready" -> "새 자료를 계속 읽고 있어요."
                else -> "연결을 이어서 확인하고 있어요. 자료 화면에서 상태를 확인할 수 있어요."
            }
            val dialog=AlertDialog.Builder(activity).setTitle("폴더 연결").setMessage(message)
                .setNegativeButton("닫기") { _,_ -> finished(true,"folder_already_connected") }
            if(existing.state=="permission_lost"&&!other)dialog.setPositiveButton("읽기 권한 다시 허용") { _,_ ->
                try {
                    activity.contentResolver.takePersistableUriPermission(uri,flags and Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    app.scanExecutor.execute {
                        app.queue.runInTransaction {
                            if(existing.scopeVersion>=2) {
                                val handle=FolderHandleAccess.open(existing).copy(grantUri=uri.toString(),parentDocumentId=null)
                                check(app.queue.folderDao().restoreChildGrant(existing.localSourceId,FolderHandleVault().seal(handle.encode()))==1)
                            }
                            app.queue.folderDao().scanFailed(existing.localSourceId,"selected","permission_restored")
                        }
                        CaptureMaintenanceWork.enqueue(activity)
                    }
                    finished(true,"folder_permission_restored")
                }catch(_:Exception){finished(false,"folder_grant_missing")}
            }
            if(session!=null && policy!=null && (existing.state!="permission_lost" || other)) dialog.setPositiveButton("연결 다시 설정") { _,_ ->
                form(uri,flags,kind,name,session,policy,projects,existing,true)
            }
            dialog.show(); return
        }
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (20 * resources.displayMetrics.density).toInt(); setPadding(pad,pad,pad,pad)
        }
        fun label(text: String) { layout.addView(TextView(activity).apply { this.text=text; textSize=18f }) }
        label("$name\n새 자료와 수정된 자료를 자동으로 읽고 원본은 그대로 둡니다.")
        if (kind == "photos") label("이 연결에서는 업무 사진만 읽습니다. 문서가 함께 있으면 업무 폴더에서 연결해 주세요.")
        if (kind == "call_recording") label("이 연결에서는 접근 가능한 녹음 파일만 보관합니다. 통화를 자동으로 녹음하지 않습니다. 음성 내용 읽기는 별도 처리 준비가 필요합니다.")
        val dedicated = CheckBox(activity).apply { text="이 폴더와 하위 폴더에는 업무 자료만 있어요"; textSize=18f }
        layout.addView(dedicated)
        label("새 연결은 지금부터 생기거나 수정된 자료를 가져옵니다. 필요한 과거 자료는 공유로 한 개씩 추가할 수 있어요.")
        val existingHistoryChoice=existing?.let { when {
            it.historyMode !in setOf("since","legacy_recent") -> 0
            it.historySinceEpochMs==it.selectedAtEpochMs -> 2
            else -> 1
        } }
        val history = Spinner(activity).apply {
            adapter=ArrayAdapter(activity,android.R.layout.simple_spinner_dropdown_item,listOf("전체 자료","최근 30일과 앞으로 생길 자료","지금부터 생기는 자료"))
            setSelection(2)
            if(existingHistoryChoice!=null) { setSelection(existingHistoryChoice); isEnabled=replacing }
        }; history.visibility=if(existing!=null) android.view.View.VISIBLE else android.view.View.GONE
        layout.addView(Button(activity).apply {text="고급 · 과거 자료 포함 범위";setOnClickListener {history.visibility=if(history.visibility==android.view.View.VISIBLE) android.view.View.GONE else android.view.View.VISIBLE}})
        layout.addView(history)
        val online = session != null && policy != null
        val upload = CheckBox(activity).apply {
            text="현재 로그인한 회사에 보관하고 다른 기기에서도 보기"; textSize=18f
            isEnabled=online; isChecked=online
        }; layout.addView(upload)
        label(if (!online) "지금은 휴대폰에만 보관합니다. 로그인·연결 후 이 폴더를 다시 선택하면 다른 기기에서도 이어 쓸 수 있어요."
            else CapturePolicyNotice.text(policy!!))
        val aiConsent=CheckBox(activity).apply { text="이 범위의 자료를 외부 AI로 해석하기"; textSize=18f; isChecked=false; isEnabled=online && policy?.external_processing==true }; layout.addView(aiConsent)
        upload.setOnCheckedChangeListener { _,checked -> aiConsent.isEnabled=checked && policy?.external_processing==true; if(!checked)aiConsent.isChecked=false }
        label("어느 현장 자료인가요?")
        val project = Spinner(activity).apply {
            adapter=ArrayAdapter(activity,android.R.layout.simple_spinner_dropdown_item,
                projects.map { it.name } + listOf("여러 현장에 쓰는 자료","새 현장 만들기"))
            val candidate=projects.indexOfFirst { it.id==startingProject }.takeIf { it>=0 } ?: projects.indexOfFirst { it.name.trim()==name.trim() }
            setSelection(if (candidate >= 0) candidate else projects.size)
            isEnabled=online
        }; layout.addView(project)
        val projectName=EditText(activity).apply { hint="새 현장 이름"; setText(name.take(180)); isSingleLine=true }
        layout.addView(projectName)
        project.onItemSelectedListener=object:android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent:android.widget.AdapterView<*>?) {}
            override fun onItemSelected(parent:android.widget.AdapterView<*>?,view:android.view.View?,position:Int,id:Long) {
                projectName.visibility=if(position==projects.size+1) android.view.View.VISIBLE else android.view.View.GONE
            }
        }
        val nextHint=TextView(activity).apply {text="위의 업무 전용 폴더 확인에 체크하면 연결할 수 있어요.";textSize=18f}
        layout.addView(nextHint)
        val dialog=AlertDialog.Builder(activity).setTitle(when(kind) {
            "photos" -> "업무 사진 폴더 연결"; "call_recording" -> "업무 녹음 폴더 연결"; else -> "업무 폴더 연결"
        }).setView(ScrollView(activity).apply { addView(layout) })
            .setNegativeButton("나중에") { _,_ -> finished(false,"folder_cancelled") }
            .setNeutralButton("고급 · 하위 폴더 여러 개") { _,_ ->
                FolderBatchSetup(activity,app,finished).show(uri,flags,session,policy,projects,kind)
            }
            .setPositiveButton("이 폴더 연결",null).create()
        dialog.setOnCancelListener { finished(false,"folder_cancelled") }
        dialog.setOnShowListener {
            val button=dialog.getButton(AlertDialog.BUTTON_POSITIVE); button.minHeight=(56*activity.resources.displayMetrics.density).toInt(); button.isEnabled=false
            dedicated.setOnCheckedChangeListener { _,checked ->
                button.isEnabled=checked
                nextHint.text=if(checked) "아래 이 폴더 연결을 누르면 시작 화면으로 돌아가요. 새 자료 하나로 도착을 확인하세요." else "위의 업무 전용 폴더 확인에 체크하면 연결할 수 있어요."
            }
            button.setOnClickListener {
                val createNew=online && project.selectedItemPosition==projects.size+1
                val title=projectName.text.toString().trim()
                if(createNew && (title.isEmpty() || title.length>180 || title.any { it.code<32 })) {
                    projectName.error="현장 이름을 확인해 주세요"; return@setOnClickListener
                }
                dialog.dismiss()
                persist(uri,flags,kind,history.selectedItemPosition,
                    if(upload.isChecked) session else null,if(upload.isChecked) policy else null,
                    if(online) projects.getOrNull(project.selectedItemPosition)?.id else null,
                    if(createNew) title else null,if(replacing) existing?.localSourceId else null,
                    upload.isChecked && aiConsent.isChecked && policy?.external_processing==true,
                    if(replacing && history.selectedItemPosition==existingHistoryChoice) existing?.historySinceEpochMs else null)
            }
        }; dialog.show()
    }

    private fun persist(uri: Uri, flags: Int, kind: String, historyChoice: Int, session: UploadSession?,
        policy: CapturePolicy?, projectId: String?, projectName: String?, replaceId: String?, externalAiConsent:Boolean, preservedHistorySince:Long?) {
        try {
            require(flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
            activity.contentResolver.takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) { finished(false,"folder_grant_missing"); return }
        app.setupExecutor.execute {
            try {
                val now=System.currentTimeMillis(); val vault=FolderHandleVault()
                val fingerprint=FolderScopeFingerprint().of(uri.toString(),kind)
                var existing=existing(uri,kind)
                val selectedHandle=FolderHandleAccess.decode(uri.toString()).copy(bindingScopeMode=if(projectId!=null||projectName!=null) "project" else "company_common",externalAiConsent=externalAiConsent)
                val overlapping=app.queue.folderDao().activeSources().any { source->
                    runCatching {
                        val handle=FolderHandleAccess.open(source)
                        handle.documentKey()!=selectedHandle.documentKey() && FolderHandleAccess.overlaps(activity.contentResolver,handle,selectedHandle)
                    }.getOrDefault(false)
                }
                if(overlapping){activity.runOnUiThread{finished(false,"folder_overlapping_scope")};return@execute}
                if(replaceId!=null) {
                    check(existing?.localSourceId==replaceId && session!=null)
                    if(existing!!.boundTenantId==session.tenantId && existing.boundUserId==session.userId && existing.boundDeviceId==session.deviceId)
                        UploadApi(session).revokeFolder(existing)
                    app.queue.folderDao().pause(replaceId)
                    existing=null
                }
                if(existing!=null) {
                    if(session!=null && policy!=null) {
                      app.queue.runInTransaction {
                        run {
                            val handle=selectedHandle
                            check(app.queue.folderDao().prepareLocalChildHandle(existing.localSourceId,vault.seal(handle.encode()))==1)
                        }
                        check(app.queue.folderDao().connectLocalSource(existing.localSourceId,
                            session.tenantId,session.userId,session.deviceId,policy.id,Json.encodeToString(policy),
                            projectId,projectName?.let(vault::seal),kind,fingerprint,
                            if(existing.historyMode=="legacy_recent") "since" else existing.historyMode,
                            if(existing.historyMode=="legacy_recent") existing.selectedAtEpochMs-30L*24*60*60*1000 else existing.historySinceEpochMs) == 1)
                      }
                        CaptureUploadWork.enqueue(activity)
                    }
                    activity.runOnUiThread { finished(true,"folder_connected") }; return@execute
                }
                val source=FolderSource(UUID.randomUUID().toString(),vault.seal(selectedHandle.encode()),
                    2,"selected",0,null,null,0,0,0,0,null,null,null,now,
                    session?.tenantId,session?.userId,session?.deviceId,kind,
                    if(historyChoice>0) "since" else "all",preservedHistorySince ?: when(historyChoice) { 1 -> now-30L*24*60*60*1000; 2 -> now; else -> null },
                    "work_dedicated",fingerprint,session!=null,policy?.id,
                    policy?.let { Json.encodeToString(it) },projectId,projectName?.let(vault::seal),
                    if(session==null) "local_only" else "pending")
                app.queue.folderDao().insertSource(source)
                CaptureUploadWork.enqueue(activity)
                activity.runOnUiThread { finished(true,"folder_connected") }
                app.scanExecutor.execute {
                    if(FolderScanner(activity.applicationContext,app.queue).scan(source))
                        CaptureMaintenanceWork.continueScan(activity)
                    CaptureUploadWork.enqueue(activity)
                }
            } catch (_: Exception) { activity.runOnUiThread { finished(false,"folder_connection_failed") } }
        }
    }
}
