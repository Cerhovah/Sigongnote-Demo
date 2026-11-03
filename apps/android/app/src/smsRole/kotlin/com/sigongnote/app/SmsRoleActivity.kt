package com.sigongnote.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.role.RoleManager
import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.provider.Telephony
import android.telephony.SubscriptionManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.TextView
import java.util.concurrent.Executors

/** SMS-role flavor is a usable local messenger; no message is sent to the work server here. */
class SmsRoleActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var root: LinearLayout
    private lateinit var status: TextView
    private lateinit var conversationList: LinearLayout
    private lateinit var messages: LinearLayout
    private lateinit var recipient: EditText
    private lateinit var body: EditText
    private lateinit var sim: Spinner
    private lateinit var attachmentStatus: TextView
    private lateinit var businessStatus: TextView
    private lateinit var businessNumber: TextView
    private lateinit var actionNotice: TextView
    private var lastSendNotice = ""
    private var selectedMmsId: Long? = null
    private var attachmentGeneration = 0
    private var selectedAddress: String? = null
    private var selectedAttachment: Uri? = null
    private var preferMms = false
    private var renderGeneration = 0
    private var subscriptions: List<Int> = emptyList()

    private lateinit var contentParent: LinearLayout
    private lateinit var screenTitle: TextView
    private lateinit var backButton: Button
    private lateinit var sendButton: Button
    private lateinit var simLabel: TextView
    private lateinit var scroll: ScrollView
    private val panels = mutableMapOf<SmsScreen, LinearLayout>()
    private var currentScreen = SmsScreen.INBOX
    private var confirmationOpen = false
    private var sending = false
    private var sendUncertain = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(20.dp,24.dp,20.dp,24.dp)
            setBackgroundColor(android.graphics.Color.rgb(246,247,249))
            setOnApplyWindowInsetsListener { _, insets ->
                setPadding(20.dp,insets.systemWindowInsetTop + 12.dp,20.dp,insets.systemWindowInsetBottom + 20.dp)
                insets
            }
        }
        scroll = ScrollView(this).apply { isFillViewport = true; addView(root) }
        setContentView(scroll)
        contentParent = root
        backButton = button("← 문자함") { showPage(SmsScreen.INBOX) }
        screenTitle = heading("문자",28f)
        status = heading("문자 준비를 확인하고 있어요",18f)
        actionNotice=heading("",18f).apply { visibility=android.view.View.GONE }
        button("설정·도움말") { showPage(SmsScreen.SETTINGS) }
        fun panel(page: SmsScreen) {
            contentParent = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            panels[page] = contentParent
            root.addView(contentParent)
        }
        panel(SmsScreen.INBOX)
        button("새 문자",true) { openComposer(null) }
        conversationList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        contentParent.addView(conversationList)

        panel(SmsScreen.THREAD)
        messages = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        contentParent.addView(messages)
        button("답장 쓰기",true) { openComposer(selectedAddress) }

        panel(SmsScreen.COMPOSE)
        heading("받는 번호",18f)
        recipient = EditText(this).apply { textSize=20f; minHeight=56.dp; inputType=android.text.InputType.TYPE_CLASS_PHONE; contentDescription="받는 번호" }
        contentParent.addView(recipient)
        heading("보낼 내용",18f)
        body = EditText(this).apply {
            textSize=20f; minLines=3; contentDescription="보낼 내용"
            inputType=android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
        }
        contentParent.addView(body)
        simLabel = heading("보낼 회선",18f)
        sim = Spinner(this).apply { minimumHeight=56.dp; contentDescription="보낼 회선" }
        contentParent.addView(sim)
        attachmentStatus = heading("사진 없음",18f)
        button("사진 고르기") {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE); type="image/*"
            },1703)
        }
        button("사진 빼기") { attachmentGeneration++;selectedAttachment=null; preferMms=false; attachmentStatus.text="사진 없음" }
        sendButton = button("보내기 확인",true) { confirmSend() }

        panel(SmsScreen.SETTINGS)
        button("문자 사용 준비") { requestRole() }
        button("업무 번호 고르기") { showPage(SmsScreen.BUSINESS) }
        button("사용법") { showPage(SmsScreen.HELP) }
        button("기본 문자앱 바꾸기") { startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) }
        button("시공노트 자료") { startActivity(Intent(this,MainActivity::class.java)) }
        button("받지 못한 사진 다시 받기") {
            io.execute {
                val count=MmsRoleRuntime.retryFailedDownloads(this)
                runOnUiThread { if(!isDestroyed) status.text=if(count==0) "다시 받을 사진 문자가 없어요" else "사진 문자 ${count}건을 다시 요청했어요" }
            }
        }
        button("보관한 문자 다시 확인") {
            io.execute {
                val count=SmsPendingStore.recover(this)
                runOnUiThread { if(!isDestroyed) { status.text="보관한 문자 ${count}건을 다시 확인했어요";refresh() } }
            }
        }
        button("새로 확인") { refresh() }

        panel(SmsScreen.BUSINESS)
        businessNumber=heading("문자함에서 번호를 먼저 골라주세요",20f)
        businessStatus = heading("문자함에서 업무 대화를 먼저 골라주세요",18f)
        heading("고른 번호와 기간만 이 휴대폰에 복사해요. 문자 원문은 서버로 보내지 않아요.",18f)
        button("이 번호를 업무기록으로",true) { approveBusinessScope() }
        button("이 번호의 복사 중지") { revokeBusinessScope() }

        panel(SmsScreen.HELP)
        heading("읽기 → 답장 → 확인",24f)
        heading("문자함에서 대화를 고르세요. 답장을 쓴 뒤 받는 번호와 내용을 한 번 더 확인해요.",18f)
        heading("채팅+·스팸 차단은 지원하지 않아요. 사진 문자 받기는 아직 확인 중이에요.",18f)
        button("문자함 보기",true) { showPage(SmsScreen.INBOX) }

        savedInstanceState?.let {
            selectedAddress=it.getString("selected_address")
            selectedMmsId=it.getLong("selected_mms",-1).takeIf { id -> id>=0 }
            recipient.setText(it.getString("draft_recipient",""));body.setText(it.getString("draft_body",""))
            selectedAttachment=it.getString("draft_attachment")?.let(Uri::parse)
            preferMms=it.getBoolean("prefer_mms",false)
            sendUncertain=it.getBoolean("send_pending",false)
            lastSendNotice=it.getString("send_notice","")
            attachmentStatus.text=if(selectedAttachment==null) "사진 없음" else "사진 1개 선택됨"
        }
        showPage(runCatching { SmsScreen.valueOf(savedInstanceState?.getString("screen") ?: "INBOX") }.getOrDefault(SmsScreen.INBOX))
        notice(if(sendUncertain) "앞서 보낸 문자가 갔는지 문자함에서 확인해 주세요." else lastSendNotice)
        if(Build.VERSION.SDK_INT>=33) onBackInvokedDispatcher.registerOnBackInvokedCallback(
            android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        if(savedInstanceState==null) acceptSendTo(intent)
    }

    private fun showPage(page: SmsScreen) {
        currentScreen=page
        panels.forEach { (key,panel) -> panel.visibility=if(key==page) android.view.View.VISIBLE else android.view.View.GONE }
        backButton.visibility=if(page==SmsScreen.INBOX) android.view.View.GONE else android.view.View.VISIBLE
        screenTitle.text=when(page) {
            SmsScreen.INBOX -> "문자"
            SmsScreen.THREAD -> selectedAddress ?: "대화"
            SmsScreen.COMPOSE -> "문자 쓰기"
            SmsScreen.SETTINGS -> "설정과 도움말"
            SmsScreen.BUSINESS -> "업무 번호"
            SmsScreen.HELP -> "사용법"
        }
        if(page==SmsScreen.BUSINESS) businessNumber.text="고른 번호: ${selectedAddress ?: recipient.text.toString().ifBlank { "아직 고르지 않았어요" }}"
        scroll.post { scroll.smoothScrollTo(0,0); screenTitle.sendAccessibilityEvent(android.view.accessibility.AccessibilityEvent.TYPE_VIEW_FOCUSED) }
    }

    private fun openComposer(address: String?) {
        if(sending) { notice("보내기 결과를 기다려 주세요.");return }
        val hasDraft=body.text.isNotBlank() || selectedAttachment!=null
        val differs=recipient.text.toString().trim()!=(address ?: "")
        if(hasDraft && differs) {
            AlertDialog.Builder(this).setTitle("쓰던 문자가 있어요")
                .setMessage("이전에 쓰던 내용을 계속 볼까요? 새로 쓰면 그 내용은 지워져요.")
                .setNegativeButton("계속 쓰기") { _,_ -> showPage(SmsScreen.COMPOSE) }
                .setPositiveButton("새로 쓰기") { _,_ -> body.setText("");selectedAttachment=null;preferMms=false;attachmentStatus.text="사진 없음";recipient.setText(address ?: "");showPage(SmsScreen.COMPOSE) }.show()
        } else { recipient.setText(address ?: "");showPage(SmsScreen.COMPOSE) }
    }

    private fun prepareDraft(address: String, text: String, mms: Boolean) {
        if(sending) { notice("보내기 결과를 기다려 주세요.");return }
        val replace = { recipient.setText(address);body.setText(text);selectedAttachment=null;preferMms=mms;attachmentStatus.text="사진 없음";showPage(SmsScreen.COMPOSE) }
        if(body.text.isNotBlank() || selectedAttachment!=null) AlertDialog.Builder(this)
            .setTitle("쓰던 문자를 바꿀까요?").setMessage("기존에 쓰던 내용은 지워져요.")
            .setNegativeButton("유지") { _,_ -> showPage(SmsScreen.COMPOSE) }
            .setPositiveButton("새 내용 쓰기") { _,_ -> replace() }.show()
        else replace()
    }

    @Deprecated("Activity back navigation")
    override fun onBackPressed() {
        handleBack()
    }
    private fun handleBack() { if(currentScreen==SmsScreen.INBOX) finish() else showPage(SmsScreen.back(currentScreen,selectedAddress!=null)) }
    private fun notice(text: String) { lastSendNotice=text;actionNotice.text=text;actionNotice.visibility=if(text.isBlank()) android.view.View.GONE else android.view.View.VISIBLE }
    private fun setComposeEnabled(enabled: Boolean) {
        fun update(view: android.view.View) { view.isEnabled=enabled;if(view is android.view.ViewGroup) (0 until view.childCount).forEach { update(view.getChildAt(it)) } }
        panels[SmsScreen.COMPOSE]?.let(::update)
    }

    override fun onSaveInstanceState(out: Bundle) {
        out.putString("screen",currentScreen.name);out.putString("selected_address",selectedAddress)
        out.putString("draft_recipient",recipient.text.toString());out.putString("draft_body",body.text.toString())
        out.putString("draft_attachment",selectedAttachment?.toString());out.putBoolean("prefer_mms",preferMms)
        out.putBoolean("send_pending",sending || sendUncertain)
        out.putString("send_notice",lastSendNotice);out.putLong("selected_mms",selectedMmsId ?: -1)
        super.onSaveInstanceState(out)
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        acceptSendTo(intent)
    }

    @Deprecated("Android role and document picker callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode,resultCode,data)
        if (requestCode == 1703 && resultCode == RESULT_OK) {
            val uri=data?.data ?: return
            val generation=++attachmentGeneration
            selectedAttachment=null;preferMms=false;attachmentStatus.text="사진 크기를 확인해요";setComposeEnabled(false)
            io.execute {
                val accepted=runCatching {
                    val declared=contentResolver.query(uri,arrayOf(android.provider.OpenableColumns.SIZE),null,null,null)?.use { cursor ->
                        if(cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
                    }
                    if(declared!=null && !MmsAttachmentPolicy.fits(declared)) false
                    else contentResolver.openInputStream(uri)?.use { input ->
                        val buffer=ByteArray(8192);var count=0L
                        while(count<=MmsAttachmentPolicy.maxBytes) { val n=input.read(buffer);if(n<0)break;count+=n }
                        MmsAttachmentPolicy.fits(count)
                    } ?: false
                }.getOrDefault(false)
                runOnUiThread {
                    if(isDestroyed || generation!=attachmentGeneration)return@runOnUiThread
                    setComposeEnabled(!sending)
                    selectedAttachment=uri.takeIf { accepted };preferMms=accepted
                    attachmentStatus.text=if(accepted) "사진 1개 선택됨" else "사진을 첨부하지 않았어요"
                    if(!accepted)notice("이 사진은 크거나 읽을 수 없어 문자로 보낼 수 없어요. 작은 사진을 고르거나 사진 앱에서 공유해 주세요.")
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
        if (SmsRoleRuntime.canRead(this)) io.execute {
            if (SmsPendingStore.recover(this) > 0) runOnUiThread {
                if (!isDestroyed) refresh()
            }
        }
        io.execute {
            val session = NotificationAccount.current(this)
            val result = if (session != null && SmsRoleRuntime.canRead(this))
                runCatching { SmsBusinessCapture(this).scanApproved(session) }.getOrNull()
            else null
            val count = if (session != null) runCatching {
                SmsBusinessCapture(this).observationCount(session)
            }.getOrNull() else null
            runOnUiThread {
                if (!isDestroyed) businessStatus.text = when {
                    session == null -> "로그인 후 업무 번호를 고를 수 있어요"
                    result == null -> "업무기록을 아직 확인하지 못했어요. 원문은 서버로 보내지 않아요."
                    else -> "업무 기록 로컬 ${count ?: 0}건 · ${if (result.partial) "일부 구간 미확인" else "허용 범위 확인"} · 서버 전송 잠김"
                }
            }
        }
    }

    override fun onDestroy() {
        renderGeneration++
        io.shutdown()
        super.onDestroy()
    }

    private fun heading(value: String, size: Float): TextView = TextView(this).apply {
        text = value
        textSize = size
        setPadding(0,14,0,12)
        contentParent.addView(this)
    }

    private fun button(label: String, primary: Boolean = false, action: () -> Unit): Button {
        return Button(this).apply {
            text = label
            textSize = 18f
            minHeight = 56.dp
            if(primary) { backgroundTintList=android.content.res.ColorStateList.valueOf(android.graphics.Color.rgb(23,88,68));setTextColor(android.graphics.Color.WHITE) }
            contentParent.addView(this)
            setOnClickListener { action() }
        }
    }

    private val Int.dp: Int get() = (this * resources.displayMetrics.density).toInt()

    private fun acceptSendTo(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SENDTO) return
        val scheme = intent.data?.scheme ?: return
        if (scheme !in setOf("sms","smsto","mms","mmsto")) return
        val useMms = scheme == "mms" || scheme == "mmsto"
        val address = intent.data?.schemeSpecificPart?.substringBefore('?') ?: ""
        val draft = intent.getStringExtra("sms_body") ?: intent.getStringExtra(Intent.EXTRA_TEXT)
        if(address.length<=80 && (draft?.length ?: 0)<=20_000) prepareDraft(address,draft ?: "",useMms)
    }

    private fun requestRole() {
        startActivity(Intent(this, SmsPermissionActivity::class.java))
    }

    private fun refresh() {
        val role = SmsRoleRuntime.isDefault(this)
        val canRead = SmsRoleRuntime.canRead(this)
        val connection = when {
            !SmsRoleRuntime.isAvailable(this) -> "문자 기능이 없는 기기예요. 자료는 공유로 가져오세요."
            !role -> "문자앱 선택이 필요해요. 설정에서 준비해 주세요."
            !canRead -> "문자 권한이 필요해요. 설정에서 준비해 주세요."
            else -> "사진 문자 받기는 아직 확인 중이에요."
        }
        val pending = SmsPendingStore.pendingCount(this)
        val health = getSharedPreferences("sms_role_health",MODE_PRIVATE)
            .getString("last_receive",null)
        status.text = connection + (if(pending>0) " · 저장 대기 ${pending}건" else "") +
            if (health == "pending_save_failed") " · 저장공간 오류" else ""
        if (!canRead) {
            conversationList.removeAllViews()
            messages.removeAllViews()
            subscriptions = emptyList()
            return
        }
        val generation = ++renderGeneration
        io.execute {
            try {
            val rows = SmsRoleRuntime.recentMessages(this,150)
            val mmsRows = MmsRoleRuntime.recentMessages(this,50)
            val simResult = runCatching { SmsRoleRuntime.availableSubscriptions(this) }
            val sims = simResult.getOrDefault(emptyList())
            runOnUiThread {
                if (isDestroyed || generation != renderGeneration || !SmsRoleRuntime.canRead(this))
                    return@runOnUiThread
                val selectedSim = subscriptions.getOrNull(sim.selectedItemPosition) ?: SubscriptionManager.getDefaultSmsSubscriptionId()
                subscriptions = sims.map { it.first }
                sim.adapter = ArrayAdapter(this,android.R.layout.simple_spinner_dropdown_item,
                    sims.map { it.second })
                selectedSim?.let { old -> subscriptions.indexOf(old).takeIf { it>=0 }?.let(sim::setSelection) }
                sim.visibility=if(subscriptions.size>1) android.view.View.VISIBLE else android.view.View.GONE
                simLabel.visibility=sim.visibility
                showConversations(rows)
                showMms(mmsRows.messages)
                val notices = mutableListOf(connection)
                if (mmsRows.unread > 0) notices.add("내용을 읽지 못한 사진 문자 ${mmsRows.unread}건 · 이 앱에서 복사를 확인하지 못했습니다")
                if (mmsRows.awaitingDownload > 0) notices.add("내용을 아직 받지 못한 사진 문자 ${mmsRows.awaitingDownload}건 · 다운로드가 안 되면 보낸 분에게 다시 요청해 주세요")
                if (simResult.isFailure) notices.add("통신 회선 확인 필요 · 보내기 전에 확인해 주세요")
                status.text = notices.joinToString(" · ")
            }
            } catch (_: Exception) {
                runOnUiThread { if (!isDestroyed && generation == renderGeneration)
                    status.text = "문자를 읽지 못했습니다. 권한을 확인한 뒤 다시 열어 주세요. 원문은 바꾸지 않았습니다." }
            }
        }
    }

    private fun showMms(rows: List<MmsRoleRuntime.LocalMms>) {
        if(rows.isNotEmpty()) conversationList.addView(TextView(this).apply { text="사진 문자";textSize=21f })
        for(row in rows) conversationList.addView(Button(this).apply {
            text="${row.address}\n${row.text.take(48)}${if(row.attachments.isEmpty()) "" else " · 첨부 ${row.attachments.size}개"}"
            textSize=18f;minHeight=56.dp;maxLines=2;ellipsize=android.text.TextUtils.TruncateAt.END
            gravity=android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL
            setOnClickListener {
                selectedAddress=row.address;selectedMmsId=row.id;notice("")
                renderMms(row);showPage(SmsScreen.THREAD)
            }
        })
        selectedMmsId?.let { id -> rows.find { it.id==id }?.let(::renderMms) }
    }

    private fun renderMms(row: MmsRoleRuntime.LocalMms) {
        messages.removeAllViews()
        messages.addView(TextView(this).apply {
            text="${if(row.status==Telephony.Mms.MESSAGE_BOX_FAILED) "전송 실패 · 다시 써주세요\n" else ""}${row.text}\n첨부 ${row.attachments.size}개"
            textSize=18f
        })
        for(part in row.attachments) {
            val uri=part.uri ?: continue
            messages.addView(Button(this).apply {
                text=if(part.mime.startsWith("image/")) "사진 열기" else "첨부파일 열기"
                textSize=18f;minHeight=56.dp
                setOnClickListener {
                    try { startActivity(Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri,part.mime);addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }) }
                    catch(_:Exception) { notice("이 첨부를 열 앱이 없어요.") }
                }
            })
        }
        if(row.status==Telephony.Mms.MESSAGE_BOX_FAILED) messages.addView(Button(this).apply {
            text="사진 문자 다시 쓰기";textSize=18f;minHeight=56.dp
            setOnClickListener { prepareDraft(row.address,row.text,true) }
        })
    }
    private fun showConversations(rows: List<SmsRoleRuntime.LocalMessage>) {
        conversationList.removeAllViews()
        for ((address,thread) in rows.groupBy { it.address }) {
            val latest = thread.first()
            conversationList.addView(Button(this).apply {
                text = "$address\n${latest.preview()}"
                textSize = 18f
                minHeight = 56.dp
                maxLines=2;ellipsize=android.text.TextUtils.TruncateAt.END
                gravity=android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL
                setOnClickListener {
                    selectedAddress = address
                    selectedMmsId=null;notice("")
                    businessStatus.text = "고른 번호 $address · 업무기록은 별도 허용"
                    showMessages(thread)
                    showPage(SmsScreen.THREAD)
                }
            })
        }
        if(selectedMmsId==null) selectedAddress?.let { selected ->
            rows.filter { it.address == selected }.takeIf { it.isNotEmpty() }?.let(::showMessages)
        }
    }

    private fun showMessages(thread: List<SmsRoleRuntime.LocalMessage>) {
        messages.removeAllViews()
        for (message in thread.asReversed()) {
            messages.addView(TextView(this).apply {
                text = "${if (message.failed) "전송 실패" else if (message.sent) "보냄" else "받음"} · ${message.body}"
                textSize = 18f
                setPadding(8,12,8,12)
            })
            if (message.failed) messages.addView(Button(this).apply {
                text = "실패한 문자 수동 재시도"
                textSize = 18f
                minHeight = 56.dp
                setOnClickListener {
                    prepareDraft(message.address,message.body,false)
                }
            })
        }
    }

    private fun approveBusinessScope() {
        val address = selectedAddress ?: recipient.text.toString().trim()
        if (!SmsRoleRuntime.validAddress(address) || !SmsRoleRuntime.canRead(this)) {
            businessStatus.text = "문자함에서 대화를 먼저 골라주세요"
            return
        }
        val session = NotificationAccount.current(this)
        if (session == null) {
            businessStatus.text = "시공노트에서 먼저 로그인해 주세요"
            return
        }
        AlertDialog.Builder(this).setTitle("업무 기록 범위")
            .setItems(arrayOf("지금부터", "지난 30일과 앞으로")) { _,choice ->
                val since = if (choice == 0) System.currentTimeMillis() else
                    System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000
                AlertDialog.Builder(this).setTitle("이 번호만 업무 기록으로 복사할까요?")
                    .setMessage("번호: $address\n선택한 기간의 SMS·MMS만 이 기기에 암호화해 보존합니다. 현재 문자 원문 서버 전송은 정책 승인 전이라 잠겨 있습니다. 개인 대화는 고르지 마세요.")
                    .setNegativeButton("취소",null)
                    .setPositiveButton("업무기록 허용") { _,_ ->
                        io.execute {
                            val result = runCatching {
                                val capture = SmsBusinessCapture(this)
                                capture.approve(address,since,session)
                                capture.scanApproved(session)
                            }
                            runOnUiThread {
                                if (!isDestroyed) businessStatus.text = result.fold(
                                    { "이 휴대폰에 업무기록 보관 · SMS ${it.sms}건 · MMS ${it.mms}건${if (it.partial) " · 일부 구간 미확인" else ""} · 서버 전송 잠김" },
                                    { "업무기록을 보관하지 못했어요 · 권한과 저장공간을 확인해 주세요" })
                            }
                        }
                    }.show()
            }.show()
    }

    private fun revokeBusinessScope() {
        val address = selectedAddress ?: recipient.text.toString().trim()
        val session = NotificationAccount.current(this)
        if (session == null || !SmsRoleRuntime.validAddress(address)) return
        AlertDialog.Builder(this).setTitle("이 번호의 복사를 중지할까요?")
            .setMessage("이 번호의 새 업무기록 복사를 중단합니다. 이미 보존한 기록 삭제는 별도 작업입니다.")
            .setNegativeButton("취소",null)
            .setPositiveButton("해제") { _,_ ->
                io.execute {
                    val removed = runCatching {
                        SmsBusinessCapture(this).revoke(address,session)
                    }.getOrDefault(false)
                    runOnUiThread {
                        if (!isDestroyed) businessStatus.text = if (removed)
                            "이 번호의 새 업무기록 복사 중단됨" else "고른 업무 번호가 없어요"
                    }
                }
            }.show()
    }

    private fun confirmSend() {
        if(confirmationOpen || sending) return
        if(sendUncertain) {
            AlertDialog.Builder(this).setTitle("앞선 전송을 확인해 주세요")
                .setMessage("화면이 바뀌기 전에 보내기를 요청했어요. 문자함에서 결과를 확인한 뒤 다시 써주세요. 중복 발송될 수 있어요.")
                .setNegativeButton("문자함 보기") { _,_ -> showPage(SmsScreen.INBOX) }
                .setPositiveButton("확인했어요") { _,_ -> sendUncertain=false }.show()
            return
        }
        if (!SmsRoleRuntime.canSend(this)) {
            status.text = "설정에서 문자앱과 전송 권한을 허용해 주세요."
            return
        }
        val to = recipient.text.toString().trim()
        val text = body.text.toString()
        val attachment = selectedAttachment
        val useMms = preferMms || attachment != null
        if (!SmsRoleRuntime.validAddress(to) || (text.isBlank() && attachment == null) ||
            text.length > 20_000) {
            status.text = "번호와 내용을 확인해 주세요."
            return
        }
        val subId = subscriptions.getOrNull(sim.selectedItemPosition)
            ?: SubscriptionManager.getDefaultSmsSubscriptionId()
        confirmationOpen=true
        AlertDialog.Builder(this).setTitle(if (useMms) "이 사진 문자를 보낼까요?" else "이 문자를 보낼까요?")
            .setMessage("받는 번호: $to\n회선: ${sim.selectedItem ?: "휴대폰 기본 회선"}\n${if(attachment!=null) "사진 1개\n" else ""}내용: $text\n통신사 이용료가 들 수 있어요.")
            .setNegativeButton("취소",null)
            .setOnDismissListener { confirmationOpen=false }
            .setPositiveButton("보내기") { _,_ ->
                sending=true;setComposeEnabled(false)
                status.text = "전송 준비 중"
                io.execute {
                    try {
                        if (useMms) {
                            val mime = attachment?.let { contentResolver.getType(it) }
                            val bytes = attachment?.let { uri ->
                                contentResolver.openInputStream(uri)?.use { stream ->
                                    val output = java.io.ByteArrayOutputStream()
                                    val buffer = ByteArray(8192)
                                    while (true) {
                                        val read = stream.read(buffer)
                                        if (read < 0) break
                                        output.write(buffer,0,read)
                                        require(output.size() <= 1024 * 1024)
                                    }
                                    output.toByteArray()
                                } ?: throw IllegalStateException("Cannot read image")
                            }
                            MmsRoleRuntime.send(this,to,text,mime,bytes,subId)
                        } else SmsRoleRuntime.sendText(this,to,text,subId)
                        runOnUiThread {
                            if (isDestroyed) return@runOnUiThread
                            sending=false;setComposeEnabled(true)
                            body.setText("")
                            selectedAttachment = null
                            preferMms = false
                            attachmentStatus.text = "첨부 없음"
                            notice("보내기를 요청했어요. 도착 여부는 다시 확인해 주세요.")
                            selectedAddress=to;selectedMmsId=null
                            messages.removeAllViews()
                            refresh()
                            showPage(if(useMms) SmsScreen.INBOX else SmsScreen.THREAD)
                        }
                    } catch (_: Exception) {
                        runOnUiThread {
                            if (!isDestroyed) { sending=false;setComposeEnabled(true);notice("전송하지 못했어요. 번호·회선·사진 크기를 확인해 주세요.") }
                        }
                    }
                }
            }.show()
    }
}
