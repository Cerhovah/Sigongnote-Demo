package com.sigongnote.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import java.util.concurrent.Executors

/** Credentials and company selection stay native; only public status reaches the WebView. */
class AccountActivity : Activity() {
    private val io=Executors.newSingleThreadExecutor()
    private lateinit var vault: TokenVault
    private lateinit var panel: LinearLayout
    private lateinit var status: TextView
    private var busy=false
    private var discovering=false
    private var currentConfig=CloudAccountConfig.installed()
    private val config get()=currentConfig
    private val callback get()="$packageName.auth://callback"
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        vault=TokenVault(this)
        render()
        intent.dataString?.let {receive(it)}
        if(intent.dataString==null)refreshProviders()
    }
    override fun onNewIntent(intent: Intent) {super.onNewIntent(intent);setIntent(intent);intent.dataString?.let {receive(it)}}
    private fun refreshProviders() {
        val before=config?:return
        if(discovering || isDestroyed || isFinishing)return
        discovering=true;status.text="로그인 연결을 확인하고 있어요…"
        io.execute {
            val latest=runCatching {before.discoverProviders()}.getOrNull()
            runOnUiThread {
                discovering=false
                if(isDestroyed || isFinishing || busy)return@runOnUiThread
                if(latest==null){status.text="지금 연결을 확인하지 못했어요. 인터넷 연결 후 다시 눌러 주세요.";return@runOnUiThread}
                if(!runCatching {vault.pendingLogin()==null}.getOrDefault(false))return@runOnUiThread
                currentConfig=latest;render()
                if("custom:naver" !in latest.providers)status.text="아직 네이버 로그인 관리자 설정 중이에요. 연결 후 다시 확인해 주세요."
            }
        }
    }
    private fun text(value: String,size: Float=20f)=TextView(this).apply {text=value;textSize=size;setPadding(0,16,0,16)}
    private fun button(label: String,action: ()->Unit) {
        panel.addView(Button(this).apply {text=label;textSize=20f;minHeight=(56*resources.displayMetrics.density).toInt();setOnClickListener {if(!busy)action()}})
    }
    private fun render() {
        panel=LinearLayout(this).apply {orientation=LinearLayout.VERTICAL;setPadding(28,48,28,28)}
        setContentView(ScrollView(this).apply {addView(panel)})
        panel.addView(text("휴대폰과 PC를 함께 써요",26f))
        status=text("PC와 같은 계정으로 시작해 주세요.")
        panel.addView(status)
        if(config==null)status.text="이 설치본은 아직 온라인 계정 사용 준비 전이에요. 이 휴대폰의 자료는 그대로 보관해요."
        else if(vault.read()!=null) {
            status.text="로그인되어 있어요. 허용한 자료는 인터넷이 돌아오면 다시 보내요. 휴대폰이 전송을 늦출 수 있어요."
            button("지금 다시 보내기") {CaptureUploadWork.enqueue(this);status.text="전송을 요청했어요. 보낸 결과는 자료 화면에서 확인해 주세요."}
            panel.addView(text("본인 계정만 연결하세요. 연결한 계정은 지금과 같은 회사 권한으로 로그인돼요. 브라우저에 다른 사람이 로그인돼 있으면 먼저 로그아웃해 주세요. 직원 초대는 별도 기능이에요.",18f))
            for((provider,label) in listOf("custom:naver" to "내 네이버로도 로그인하기","custom:kakao" to "내 카카오로도 로그인하기","google" to "내 Google로도 로그인하기")) {
                if(provider in config!!.providers)button(label) {link(provider)}
            }
            if(vault.hasPendingIdentityLink())button("진행 중인 계정 연결 취소") {vault.clearPendingLogin();render();status.text="이 휴대폰의 연결 확인을 취소했어요. 기존 로그인과 자료는 유지돼요."}
        } else {
            for((provider,label) in listOf("custom:naver" to "네이버로 시작하기")) {
                val enabled=provider in config!!.providers
                if(enabled)button(label) {
                    val flow=GoogleLoginFlow.create(provider=provider);vault.clearPendingLogin();vault.saveLoginFlow(flow)
                    try {startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(flow.authorize(config!!.auth,callback))))}
                    catch(_:Exception) {vault.clearPendingLogin();status.text="인터넷 브라우저를 준비한 뒤 다시 눌러 주세요."}
                } else if(provider!="google")panel.addView(Button(this).apply {text="$label · 연결 준비 중";textSize=20f;minHeight=(56*resources.displayMetrics.density).toInt();isEnabled=false})
            }
            if(runCatching {vault.pendingLogin()!=null}.getOrDefault(false))button("로그인 다음 단계") {loadCompanies()}
            if("custom:naver" !in config!!.providers)button("로그인 연결 다시 확인") {refreshProviders()}
        }
        button("돌아가기") {finish()}
    }
    private fun task(work: ()->Unit) {
        if(busy)return
        busy=true
        io.execute {
            try {work()}
            catch(_:Exception) {runOnUiThread {if(!isDestroyed)status.text=if(runCatching {vault.read()!=null}.getOrDefault(false)) "계정 연결을 확인하지 못했어요. 기존 로그인과 자료 수집 설정은 유지돼요." else "계정이나 서버를 확인해 주세요. 자료는 보내지 않고 보관해요."}}
            finally {runOnUiThread {busy=false}}
        }
    }
    private fun link(provider:String)=task {
        val session=UploadSessionManager(vault,false).current()
        val flow=GoogleLoginFlow.create(provider=provider).copy(linkTarget=IdentityLinkTarget.from(session))
        val url=CloudAccount(config!!).identityAuthorization(session,flow,callback)
        vault.clearPendingLogin();vault.saveLoginFlow(flow)
        runOnUiThread {
            if(isDestroyed)return@runOnUiThread
            try {render();startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url)));status.text="브라우저에서 본인 계정인지 확인해 주세요. 연결하면 지금과 같은 회사 권한으로 로그인돼요."}
            catch(_:Exception) {vault.clearPendingLogin();status.text="인터넷 브라우저를 준비한 뒤 다시 눌러 주세요."}
        }
    }
    private fun receive(uri: String) {
        if(config==null)return
        task {
            val (flow,code)=vault.consumeLoginFlow(uri,callback)
            intent.data=null
            val login=CloudAccount(config!!).exchange(code,flow)
            if(flow.linkTarget!=null) {
                UploadSessionManager(vault,false).applyLinkedLogin(flow.linkTarget,login)
                vault.clearPendingLogin()
                runOnUiThread {if(!isDestroyed) {render();status.text="같은 회사와 자료를 이 계정으로도 볼 수 있게 연결했어요."}}
            } else {
                check(vault.read()==null) {"ACCOUNT_CHANGED"}
                vault.savePendingLogin(login);showCompanies(login)
            }
        }
    }
    private fun loadCompanies()=task {showCompanies(requireNotNull(vault.pendingLogin()))}
    private fun showCompanies(login: AccountLogin) {
        val companies=CloudAccount(config!!).companies(login)
        runOnUiThread {
            if(isFinishing || isDestroyed)return@runOnUiThread
            if(companies.isEmpty()) {showFirstCompany(login);return@runOnUiThread}
            panel.removeAllViews();panel.addView(text("어느 회사에서 쓸까요?",26f));panel.addView(status)
            status.text="자료를 함께 볼 회사를 골라 주세요."
            companies.forEach {company->button(company.name) {consent(login,company)}}
            button("돌아가기") {vault.clearPendingLogin();finish()}
        }
    }
    private fun showFirstCompany(login:AccountLogin) {
        panel.removeAllViews();panel.addView(text("회사 이름을 확인해 주세요",26f));panel.addView(status)
        status.text="처음 만든 회사와 현장 자료를 휴대폰·PC에서 함께 볼 수 있어요."
        val name=EditText(this).apply {setText(vault.workspaceName(login,config!!.api));textSize=20f;hint="회사 이름";contentDescription="회사 이름";filters=arrayOf(android.text.InputFilter.LengthFilter(120))}
        name.isEnabled=!vault.hasWorkspaceDraft(login,config!!.api)
        if(!name.isEnabled)status.text="전에 요청한 회사 이름으로 이어서 확인해요."
        panel.addView(name)
        button("회사 만들고 시작하기") {
            val label=name.text.toString().trim()
            if(label.isBlank()) {name.error="회사 이름을 입력해 주세요";return@button}
            task {
                try {
                    check(vault.pendingLogin()?.user==login.user)
                    val draft=vault.workspaceDraft(login,config!!.api,label)
                    runOnUiThread {name.setText(draft.name);name.isEnabled=false}
                    FirstWorkspace(config!!).create(login,draft) {vault.pendingLogin()?.user==login.user}
                    check(vault.pendingLogin()?.user==login.user)
                    vault.clearWorkspaceDraft();showCompanies(login)
                } catch(_:WorkspaceLoginExpired) {
                    vault.clearPendingLogin();runOnUiThread {if(!isDestroyed) {render();status.text="로그인이 만료됐어요. 다시 로그인해 주세요."}}
                } catch(_:WorkspaceInvitationRequired) {
                    runOnUiThread {if(!isDestroyed) {panel.removeAllViews();panel.addView(status);status.text="이전 회사 권한을 확인해야 해요. 회사 대표에게 초대를 요청하거나 전에 쓰던 계정으로 로그인해 주세요.";button("기존 계정으로 다시 로그인") {vault.clearPendingLogin();render()};button("돌아가기") {finish()}}}
                }
            }
        }
        button("기존 계정으로 다시 로그인") {vault.clearPendingLogin();render()}
        button("돌아가기") {finish()}
    }
    private fun consent(login: AccountLogin,company: AccountCompany) {
        AlertDialog.Builder(this).setTitle("공유한 자료를 PC에서도 볼까요?")
            .setMessage("지금부터 시공노트로 공유하는 자료를 ${company.name} 서버에 보내요. 같은 계정·회사에서 보내던 자료는 다시 시도해요. 다른 회사 자료와 로그인 전 자료는 보내지 않아요. 폴더·문자·알림과 외부 AI는 따로 허락을 받아요.")
            .setNegativeButton("나중에",null)
            .setPositiveButton("공유 자료 보내기") {_,_->task {
                val session=CloudAccount(config!!).enroll(login,company.id,DeviceKeyStore().publicJwk(),vault::enrollmentKey,true)
                vault.store(session.encode());vault.clearPendingLogin();CaptureUploadWork.schedule(this)
                runOnUiThread {if(!isFinishing && !isDestroyed)finish()}
            }}.show()
    }
    override fun onDestroy() {super.onDestroy();io.shutdown()}
}
