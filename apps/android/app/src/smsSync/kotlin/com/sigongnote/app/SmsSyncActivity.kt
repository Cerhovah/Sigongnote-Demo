package com.sigongnote.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import android.widget.*
import kotlinx.serialization.json.*

/** First-use setup only. Normal scans never ask for each message or change the default SMS app. */
class SmsSyncActivity:Activity(){
    private lateinit var status:TextView
    private val executor=java.util.concurrent.Executors.newSingleThreadExecutor()
    private var projects:List<FolderProject> = emptyList()
    private enum class GatePhase(val label:String){
        SESSION("session"),LOCAL_SCOPE_READ("local_scope_read"),LOCAL_SCOPE_CHECK("local_scope_check"),ACCESS_REQUEST("access_request"),INSTALLATION_CHECK("installation_check"),
        PROJECTS_SESSION("projects_session"),PROJECTS_REQUEST("projects_request"),DEFAULT_PROJECT_REQUEST("default_project_request"),SUMMARY_SCOPE_READ("summary_scope_read"),SUMMARY_READ("summary_read")
    }
    private fun logGateFailure(phase:GatePhase,error:Throwable){
        val failure=when(error){
            is UploadApi.Fault->{
                val code=error.code.takeIf{it in setOf("INVALID_CONTRACT","UNAUTHENTICATED","FORBIDDEN","NOT_FOUND","SOURCE_EXPIRED","INTERNAL_ERROR","RATE_LIMITED")}?:"OTHER"
                "API status=${error.status.takeIf{it in 100..599}?:0} code=$code"
            }
            is UploadSessionManager.LoginRequired->"LOGIN_REQUIRED"
            is UploadSessionManager.Retryable->"SESSION_RETRYABLE"
            is SecurityException->"SECURITY"
            is kotlinx.serialization.SerializationException->"SERIALIZATION"
            is android.database.sqlite.SQLiteException->"LOCAL_DATABASE"
            is java.time.format.DateTimeParseException->"TIMESTAMP_PARSE"
            is java.io.IOException->"IO"
            is IllegalArgumentException->"INVALID_ARGUMENT"
            is IllegalStateException->"INVALID_STATE"
            is NoSuchElementException->"MISSING_VALUE"
            else->"OTHER"
        }
        Log.w("SigongnoteSmsGate","phase=${phase.label} failure=$failure")
    }
    override fun onCreate(saved:Bundle?){super.onCreate(saved)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val layout=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(24,24,24,24)}
        layout.addView(TextView(this).apply{text="문자 연결 준비";textSize=26f})
        status=TextView(this).apply{text="삼성 문자앱을 그대로 사용합니다. 새 문자를 AI가 살펴보고 업무만 일지에 남깁니다. 번호와 현장을 미리 입력할 필요가 없습니다. RCS·카카오 대화는 포함하지 않습니다.";textSize=18f};layout.addView(status)
        val allNew=CheckBox(this).apply{text="모든 새 문자에서 업무 자동 찾기";textSize=20f;isChecked=true};layout.addView(allNew)
        val selectedPanel=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;visibility=android.view.View.GONE};layout.addView(selectedPanel)
        allNew.setOnCheckedChangeListener{_,checked->selectedPanel.visibility=if(checked)android.view.View.GONE else android.view.View.VISIBLE}
        val numbers=EditText(this).apply{id=android.view.View.generateViewId();hint="여러 개는 쉼표로 구분";textSize=18f;importantForAutofill=android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS}
        selectedPanel.addView(TextView(this).apply{text="선택한 번호만 연결 (선택 기능)";labelFor=numbers.id;textSize=18f});selectedPanel.addView(numbers)
        layout.addView(TextView(this).apply{text="연결 이후 새로 주고받는 문자 본문을 서버와 AI에 보내 업무 여부를 판별합니다. 업무만 회사 일지에 보관하고 일반 문자는 삼성 문자앱에 그대로 둡니다. 애매한 내용·사진만 있는 문자는 휴대폰에 보류합니다. 필요한 이전 문자와 잘못 제외된 문자는 직접 공유할 수 있습니다.";textSize=17f})
        selectedPanel.addView(TextView(this).apply{text="이 번호의 업무를 모을 현장";textSize=18f})
        val site=Spinner(this);selectedPanel.addView(site)
        val aiConsent=CheckBox(this).apply{text="위 범위의 새 문자 본문을 외부 AI로 판별·해석하기";textSize=18f;isChecked=false}
        layout.addView(aiConsent)
        layout.addView(Button(this).apply{text="업무 범위 연결 준비";setOnClickListener {
            val automatic=allNew.isChecked
            val selected=numbers.text.toString().split(',').map{SmsSyncPolicy.normalize(it.trim())}.distinct()
            if(!automatic && (selected.isEmpty()||selected.size>30||selected.any{it.isBlank()})){status.text="업무 번호를 확인해 주세요.";return@setOnClickListener}
            val project=projects.getOrNull(site.selectedItemPosition)
            if(!automatic && project==null){status.text="먼저 업무 화면에서 현장을 만든 뒤 다시 열어 주세요.";return@setOnClickListener}
            val allowAi=aiConsent.isChecked
            if(automatic && !allowAi){status.text="모든 새 문자에서 업무를 찾으려면 위의 AI 처리 범위를 확인해 주세요.";return@setOnClickListener}
            isEnabled=false;val button=this
            executor.execute {try{
                val session=UploadSessionManager(TokenVault(this@SmsSyncActivity),BuildConfig.DEBUG).current()
                val api=UploadApi(session);val policy=api.connectionPolicy()
                require(!automatic || policy.external_processing)
                runOnUiThread {if(isFinishing||isDestroyed)return@runOnUiThread
                    AlertDialog.Builder(this@SmsSyncActivity).setTitle("처리 범위 확인")
                        .setMessage("${if(automatic) "모든 새 문자 · 현장은 자동 분류" else "${project!!.name} · 업무 번호 ${selected.size}개"}\n연결 시점 이후의 새 문자 · 과거 문자 제외 (같은 범위 재시도는 시작 시점 유지)\n${CapturePolicyNotice.text(policy)}\n${if(automatic) "업무로 판별된 문자만 회사 일지에 보관합니다. 일반 문자 원문은 휴대폰에 그대로 남습니다." else "사용자가 삭제할 때까지 보존"}\n${if(allowAi && policy.external_processing) "위 범위의 문자 본문을 현장·업무 정리 처리자로 보내 판별·해석합니다. 녹음 전사 처리자는 문자 판별에 사용하지 않습니다." else "외부 AI 전송은 허용하지 않습니다."}")
                        .setNegativeButton("취소"){_,_->button.isEnabled=true}
                        .setPositiveButton("이 범위로 준비"){_,_->executor.execute {try{
                            val current=UploadSessionManager(TokenVault(this@SmsSyncActivity),BuildConfig.DEBUG).current()
                            require(current.tenantId==session.tenantId && current.userId==session.userId && current.deviceId==session.deviceId)
                            val fingerprint=SmsSyncFingerprint.of("${session.tenantId}:${session.userId}:${session.deviceId}:${if(automatic) "all-new-ai-v1" else selected.sorted().joinToString(",")}:current-v1:${if(automatic) "automatic" else project!!.id}:${CapturePolicyNotice.snapshot(policy)}:ai=${allowAi && policy.external_processing}")
                            val starts=getSharedPreferences("sms-current-start",MODE_PRIVATE)
                            val since=starts.getLong(fingerprint,0).takeIf{it>0}?:System.currentTimeMillis().also{check(starts.edit().putLong(fingerprint,it).commit())}
                            val source=api.registerSms(fingerprint,since,policy,allowAi,automatic)
                            if(!automatic)api.bindSmsProject(source,fingerprint,project!!.id)
                            SmsSyncStore(this@SmsSyncActivity).use{store->
                                val next=store.add(session,buildJsonObject{
                                    put("source",source.id);put("generation",source.generation);put("since",since);put("all_new",automatic);put("project_id",if(automatic)JsonNull else JsonPrimitive(project!!.id))
                                    put("numbers",buildJsonArray{if(!automatic)selected.forEach{add(JsonPrimitive(it))}})
                                })
                                store.stopOtherReaders(session,next)
                            }
                            runOnUiThread {status.text="업무 범위를 준비했습니다. 승인 대기 중에는 문자 원문 읽기·전송 0건입니다."
                                button.isEnabled=true
                                if(source.upload_ready)status.text="업무 범위를 준비했습니다. 승인·읽기 권한 확인을 눌러 현재 설치본을 확인해 주세요."
                            }
                            SmsSyncWork.schedule(this@SmsSyncActivity)
                        }catch(_:Exception){runOnUiThread{button.isEnabled=true;status.text="연결을 준비하지 못했어요. 이전 기록과 대기 자료는 보존합니다. 로그인과 네트워크를 확인한 뒤 같은 범위로 다시 준비해 주세요."}}}}
                        .setOnCancelListener{button.isEnabled=true}.show()
                }
            }catch(_:Exception){runOnUiThread{button.isEnabled=true;status.text="먼저 로그인하고 연결을 확인해 주세요."}}}
        }})
        layout.addView(Button(this).apply{text="승인·읽기 권한 확인";setOnClickListener{val button=this;button.isEnabled=false;executor.execute{var phase=GatePhase.SESSION;try{
            val session=UploadSessionManager(TokenVault(this@SmsSyncActivity),BuildConfig.DEBUG).current();val api=UploadApi(session)
            phase=GatePhase.LOCAL_SCOPE_READ
            val scopes=SmsSyncStore(this@SmsSyncActivity).use{it.scopes(session)}.filter{it.second["reading_stopped"]?.jsonPrimitive?.booleanOrNull!=true};require(scopes.isNotEmpty())
            for((_,config) in scopes){
                phase=GatePhase.LOCAL_SCOPE_CHECK
                val source=config.getValue("source").jsonPrimitive.content;val generation=config.getValue("generation").jsonPrimitive.int
                phase=GatePhase.ACCESS_REQUEST
                val access=api.smsAccess(source)
                phase=GatePhase.INSTALLATION_CHECK
                SmsSyncInstallation.requireAccess(this@SmsSyncActivity,access,generation)
            }
            runOnUiThread{button.isEnabled=true;status.text="배포·설치 증빙을 확인했습니다. 문자 읽기를 허용하면 확인한 범위로 연결합니다.";requestPermissions(arrayOf(Manifest.permission.READ_SMS),18)}
        }catch(error:Exception){logGateFailure(phase,error);runOnUiThread{button.isEnabled=true;status.text="아직 읽기를 시작할 수 없어요. 업무 범위·증빙 만료·설치 종류를 확인해 주세요. 다른 자료는 계속 사용할 수 있습니다."}}}}})
        layout.addView(Button(this).apply{text="이 기기의 문자 연결 중지";setOnClickListener{executor.execute{runCatching{
            val s=UploadSessionManager(TokenVault(this@SmsSyncActivity),BuildConfig.DEBUG).current()
            SmsSyncStore(this@SmsSyncActivity).use{it.pauseAll(s)}
            runOnUiThread{status.text="이 기기에서 새 문자 읽기와 전송을 중지했습니다. 삼성 문자앱 원문과 이미 보관한 자료는 유지됩니다."}
        }}}})
        layout.addView(Button(this).apply{text="설치 확인 정보";setOnClickListener{
            runCatching {
                val info="앱: $packageName\n서명: ${SmsSyncInstallation.certificateHash(this@SmsSyncActivity)}\n설치 식별값: ${SmsSyncInstallation.fingerprint(this@SmsSyncActivity)}"
                val details=TextView(this@SmsSyncActivity).apply{text=info;textSize=14f;setPadding(24,24,24,24);setTextIsSelectable(true)}
                AlertDialog.Builder(this@SmsSyncActivity).setTitle("운영자 설치 확인").setView(details).setPositiveButton("닫기",null).show()
            }.onFailure{status.text="설치 정보를 읽지 못했어요. 다른 자료 연결은 계속 사용할 수 있습니다."}
        }})
        layout.addView(Button(this).apply{text="돌아가기";setOnClickListener{finish()}})
        setContentView(ScrollView(this).apply{addView(layout)})
        executor.execute {var phase=GatePhase.PROJECTS_SESSION;runCatching {
            val session=UploadSessionManager(TokenVault(this@SmsSyncActivity),BuildConfig.DEBUG).current()
            val api=UploadApi(session)
            phase=GatePhase.PROJECTS_REQUEST
            val options=api.folderProjects()
            phase=GatePhase.DEFAULT_PROJECT_REQUEST
            val first=api.firstSiteProject()
            runOnUiThread{if(!isFinishing&&!isDestroyed){projects=options;site.adapter=ArrayAdapter(this@SmsSyncActivity,android.R.layout.simple_spinner_dropdown_item,options.map{it.name});site.setSelection(options.indexOfFirst{it.id==first}.coerceAtLeast(0))}}
            phase=GatePhase.SUMMARY_SCOPE_READ
            SmsSyncStore(this@SmsSyncActivity).use{store->
                val existing=store.scopes(session).filter{it.second["reading_stopped"]?.jsonPrimitive?.booleanOrNull!=true}
                val automatic=existing.any{it.second["all_new"]?.jsonPrimitive?.booleanOrNull==true}
                val selected=existing.flatMap{it.second["numbers"]?.jsonArray.orEmpty().map{n->n.jsonPrimitive.content}}.distinct()
                phase=GatePhase.SUMMARY_READ
                val summary=store.summary(session)
                runOnUiThread{if(!isFinishing&&!isDestroyed){if(existing.isNotEmpty())allNew.isChecked=automatic;numbers.setText(selected.joinToString(", "));status.append("\n$summary")}}
            }
        }.onFailure{logGateFailure(phase,it)}}
    }
    override fun onRequestPermissionsResult(code:Int,permissions:Array<out String>,results:IntArray){super.onRequestPermissionsResult(code,permissions,results);if(code==18){status.text=if(results.firstOrNull()==android.content.pm.PackageManager.PERMISSION_GRANTED)"문자 읽기를 허용했습니다. 연결 상태를 확인하고 처리합니다." else "읽기 권한이 없습니다. 다른 업무자료는 계속 사용할 수 있습니다.";SmsSyncWork.now(this)}}
    override fun onDestroy(){super.onDestroy();executor.shutdown()}
}
