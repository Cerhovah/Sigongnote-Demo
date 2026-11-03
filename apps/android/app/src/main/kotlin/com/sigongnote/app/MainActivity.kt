package com.sigongnote.app

import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationManager
import android.service.notification.NotificationListenerService
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.Settings
import android.provider.Telephony
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.JavaScriptReplyProxy
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.put

class MainActivity : Activity() {
    private val folderPickerRequest = 1701
    private val photoCaptureRequest = 1702
    private val workFileRequest = 1703
    private var workFileReply: android.webkit.ValueCallback<Array<Uri>>? = null
    private var workCameraName: String? = null
    private val workPhotos by lazy { PendingPhotos(java.io.File(filesDir,"camera-pending"),java.io.File(cacheDir,"camera")) }
    private var photoCaptureOpen = false
    private val io = Executors.newSingleThreadExecutor()
    private val workIo = Executors.newFixedThreadPool(2)
    private val workSlots = java.util.concurrent.Semaphore(4)
    private lateinit var queue: CaptureQueueDatabase
    private lateinit var vault: TokenVault
    private val voice by lazy {VoiceInput(this)}
    private lateinit var workApi: WorkApi
    private var webView: WebView? = null
    private var audioPermission:android.webkit.PermissionRequest?=null
    private var pendingFolderReply: Pair<BridgeCommand,JavaScriptReplyProxy>? = null
    private var returningFromNotificationSettings = false
    private var hasResumed = false
    private var folderPickerReturn = false
    private val setupAttempted = java.util.concurrent.CopyOnWriteArraySet<String>()
    private val notificationRefresh: () -> Unit = {
        runOnUiThread { if (!isFinishing && !isDestroyed) webView?.reload() }
    }
    @Volatile private var shareFatal = false

    private fun openWorkOriginal(url:String) {
        val task=java.util.concurrent.FutureTask<Unit> {
            check(!isFinishing&&!isDestroyed)
            startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url)))
        }
        runOnUiThread(task)
        try {task.get(10,java.util.concurrent.TimeUnit.SECONDS)} catch(e:Exception){task.cancel(false);throw e}
    }

    private fun openWorkDocument(json:String,format:String,action:String,scope:String):String {
        val file=OutgoingDocument.prepare(java.io.File(filesDir,"outgoing"),scope,format,json)
        val task=java.util.concurrent.FutureTask<Unit>{
            check(!isFinishing&&!isDestroyed)
            val current=vault.read()?.let{UploadSession.decode(it,BuildConfig.DEBUG)}?:throw WorkAccessException("account_changed")
            if(current.tenantId+":"+current.userId!=scope)throw WorkAccessException("account_changed")
            startActivity(OutgoingDocument.intent(this,file,format,action))
        }
        runOnUiThread(task)
        try{task.get(10,java.util.concurrent.TimeUnit.SECONDS)}catch(e:Exception){task.cancel(false);throw e}
        return "{\"outcome\":\"unknown\",\"message\":\"문서를 열 앱을 선택해 주세요. 상대의 수신 여부는 아직 확인되지 않았어요.\"}"
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        photoCaptureOpen = savedInstanceState?.getBoolean("photo_capture_open") ?: false
        workCameraName = savedInstanceState?.getString("work_camera_name")
        setupAttempted.addAll(savedInstanceState?.getStringArrayList("setup_attempted").orEmpty())
        setupAttempted.addAll(getSharedPreferences("permission_setup",MODE_PRIVATE).getStringSet("attempted",emptySet()).orEmpty())
        queue = (application as SigongnoteApp).queue
        NotificationRuntime.onChange = notificationRefresh
        vault = TokenVault(applicationContext)
        workApi = WorkApi(vault,BuildConfig.DEBUG,opener=::openWorkOriginal,fileAction=::openWorkDocument)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(TextView(this).apply {
                text = "기기 웹 구성요소를 업데이트하면 시공노트를 열 수 있습니다. 저장된 대기 자료는 유지됩니다."
                textSize = 20f
                setPadding(28,40,28,28)
            })
            return
        }
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/",WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        val view = WebView(this)
        webView = view
        // WebView ignores its own padding when laying out the page, so the system bars are kept
        // clear by a plain frame around it. The page's bottom menu stays above the phone's buttons.
        val frame = android.widget.FrameLayout(this).apply {
            setBackgroundColor(android.graphics.Color.rgb(0xf6,0xf4,0xef))
            addView(view, android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT, android.widget.FrameLayout.LayoutParams.MATCH_PARENT))
            setOnApplyWindowInsetsListener { container, insets ->
                container.setPadding(insets.systemWindowInsetLeft,insets.systemWindowInsetTop,insets.systemWindowInsetRight,insets.systemWindowInsetBottom)
                if (Build.VERSION.SDK_INT >= 30) android.view.WindowInsets.CONSUMED else insets
            }
        }
        if(Build.VERSION.SDK_INT>=33) onBackInvokedDispatcher.registerOnBackInvokedCallback(
            android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        view.settings.javaScriptEnabled = true
        view.settings.textZoom = (resources.configuration.fontScale * 100).toInt().coerceAtLeast(100)
        // The fixed appassets UI keeps consented offline activity and display preferences here.
        // Account credentials remain in TokenVault; remote pages never load in this WebView.
        view.settings.domStorageEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.settings.allowFileAccessFromFileURLs = false
        view.settings.allowUniversalAccessFromFileURLs = false
        view.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                loader.shouldInterceptRequest(request.url)?.let { return it }
                if (WorkUploadPolicy.allows(request.url.toString(),BuildConfig.CLOUD_AUTH_ORIGIN,request.method)) return null
                return WebResourceResponse("text/plain","UTF-8",403,"Forbidden",
                    emptyMap(),ByteArrayInputStream(byteArrayOf()))
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net") return false
                if (request.isForMainFrame && request.hasGesture() &&
                    (uri.scheme == "https" || uri.scheme == "http")) {
                    startActivity(Intent(Intent.ACTION_VIEW,uri))
                }
                return true
            }
        }
        view.webChromeClient=object:android.webkit.WebChromeClient(){
            override fun onShowFileChooser(webView:WebView,reply:android.webkit.ValueCallback<Array<Uri>>,params:FileChooserParams):Boolean {
                workFileReply?.onReceiveValue(null)
                workFileReply=reply
                try {
                    val intent = if(params.isCaptureEnabled && params.acceptTypes.any { it.startsWith("image/") }) {
                        val file=workPhotos.create();workCameraName=file.name
                        val uri=androidx.core.content.FileProvider.getUriForFile(this@MainActivity,BuildConfig.APPLICATION_ID+".capture",file)
                        Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).putExtra(android.provider.MediaStore.EXTRA_OUTPUT,uri)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                            .apply { clipData=android.content.ClipData.newRawUri("photo",uri) }
                    } else params.createIntent().apply { addCategory(Intent.CATEGORY_OPENABLE) }
                    startActivityForResult(intent,workFileRequest)
                } catch(_:Exception) {workFileReply=null;reply.onReceiveValue(null);workPhotos.cancel(workPhotos.find(workCameraName));workCameraName=null}
                return true
            }
            override fun onPermissionRequest(request:android.webkit.PermissionRequest){runOnUiThread{
                if(request.origin.toString().trimEnd('/')!=BridgePolicy.trustedOrigin||view.url?.substringBefore('#')!="${BridgePolicy.trustedOrigin}/assets/work/index.html"||request.resources.toSet()!=setOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)){request.deny();return@runOnUiThread}
                if(checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)==android.content.pm.PackageManager.PERMISSION_GRANTED)request.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                else {audioPermission?.deny();audioPermission=request;requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO),1711)}
            }}
            override fun onPermissionRequestCanceled(request:android.webkit.PermissionRequest){if(audioPermission===request)audioPermission=null}
        }
        WebViewCompat.addWebMessageListener(view,"SigongnoteNative",
            setOf(BridgePolicy.trustedOrigin)) { _,message,origin,isMainFrame,reply ->
            // Chromium can deliver one queued message after the Activity's collectors have stopped.
            if(isFinishing || isDestroyed || io.isShutdown || workIo.isShutdown)return@addWebMessageListener
            val command = BridgePolicy.decode(origin.toString(),isMainFrame,message.data ?: "")
            if (command == null) return@addWebMessageListener
            if(command.method=="openPhotoCapture"){runOnUiThread{
                if(!photoCaptureOpen){
                    photoCaptureOpen=true
                    try{startActivityForResult(Intent(this,PhotoCaptureActivity::class.java).putExtra("openCamera",true),photoCaptureRequest)}
                    catch(_:Exception){photoCaptureOpen=false;sendReply(command,reply,false,"camera_unavailable");return@runOnUiThread}
                }
                sendReply(command,reply,true,"photos_opened")
            };return@addWebMessageListener}
            if(command.method=="startVoiceInput"){runOnUiThread{voice.start(command.requestId){result->if(!isFinishing&&!isDestroyed)sendReply(command,reply,true,result)}};return@addWebMessageListener}
            if(command.method=="cancelVoiceInput"){runOnUiThread{voice.cancel(command.argument);sendReply(command,reply,true,"cancelled")};return@addWebMessageListener}
            if(command.method=="workRequest") {
                if(!workSlots.tryAcquire()){sendReply(command,reply,false,"work_busy");return@addWebMessageListener}
                workIo.execute {
                    val result=try {Pair(true,workApi.request(
                        kotlinx.serialization.json.Json.parseToJsonElement(command.argument!!) as kotlinx.serialization.json.JsonObject))}
                        catch(e:WorkAccessException){Pair(false,e.code)}
                        catch(_:UploadSessionManager.LoginRequired){Pair(false,"login_required")}
                        catch(_:Exception){Pair(false,"connection_wait")}
                    finally{workSlots.release()}
                    runOnUiThread {if(!isFinishing&&!isDestroyed)sendReply(command,reply,result.first,result.second)}
                }
                return@addWebMessageListener
            }
            if (command.method == "openAccount") {
                runOnUiThread {startActivity(Intent(this,AccountActivity::class.java));sendReply(command,reply,true,"account_opened")}
                return@addWebMessageListener
            }
            if (command.method == "connectSource" && FolderSourcePolicy.isFolderKind(command.argument)) {
                markSetupAttempt("folder")
                runOnUiThread { openFolderPicker(command,reply) }
                return@addWebMessageListener
            }
            if (command.method == "connectSource" && command.argument == "notifications") {
                markSetupAttempt("notifications")
                runOnUiThread { openNotificationAppPicker(command,reply) }
                return@addWebMessageListener
            }
            if (command.method == "connectSource" && command.argument == "sms") {
                markSetupAttempt("sms")
                runOnUiThread {
                    if (packageName.endsWith(".smssync")) {
                        startActivity(Intent().setClassName(packageName,"com.sigongnote.app.SmsSyncActivity"))
                        sendReply(command,reply,true,"sms_sync_setup_opened")
                    } else if (!packageName.endsWith(".smsrole"))
                        sendReply(command,reply,false,"sms_unavailable_in_standard")
                    else try {
                        startActivity(Intent().setClassName(packageName,
                            "com.sigongnote.app.SmsPermissionActivity"))
                        sendReply(command,reply,true,"sms_role_screen_opened")
                    } catch (_: Exception) {
                        sendReply(command,reply,false,"sms_role_screen_unavailable")
                    }
                }
                return@addWebMessageListener
            }
            if (command.method == "reviewNotificationScopes") {
                reviewNotificationScopes(command,reply)
                return@addWebMessageListener
            }
            if (command.method == "openSmsInbox") {
                runOnUiThread {
                    if (packageName.endsWith(".smsrole")) {
                        startActivity(Intent().setClassName(packageName,"com.sigongnote.app.SmsRoleActivity"))
                        sendReply(command,reply,true,"sms_inbox_opened")
                    } else sendReply(command,reply,false,"sms_unavailable_in_standard")
                }
                return@addWebMessageListener
            }
            if (command.method == "manageNotificationSources") {
                manageNotificationSources(command,reply)
                return@addWebMessageListener
            }
            io.execute {
                val result = try {
                    when (command.method) {
                        "getConnectionState" -> Pair(true,buildJsonObject {
                            put("setupAttempted",setupAttempted.joinToString(","))
                            val folderSources = queue.folderDao().activeSources()
                            val grantedTrees = contentResolver.persistedUriPermissions
                                .filter { it.isReadPermission }.map { it.uri }.toSet()
                            val readableFolders = folderSources.filter { source ->
                                runCatching { grantedTrees.contains(FolderHandleAccess.grant(source)) }
                                    .getOrDefault(false)
                            }
                            val checkedAt = System.currentTimeMillis()
                            val freshFolders = readableFolders.filter { it.state == "current" &&
                                it.lastSuccessfulScanAtEpochMs != null &&
                                checkedAt - it.lastSuccessfulScanAtEpochMs in 0..2L * 60 * 60 * 1000 }
                            put("photoFolders",freshFolders.count { it.kind == "photos" })
                            put("recordingFolders",freshFolders.count { it.kind == "call_recording" })
                            put("folderScanning",folderSources.count { it.state in setOf("selected","scanning") || it.lastErrorCode == "backlog_pending" })
                            put("folderQuotaPaused",folderSources.count { it.state == "quota_pause" })
                            put("folderDeviceLow",folderSources.count { it.lastErrorCode == "device_low" })
                            put("folderNeedsCheck",folderSources.count { it.lastErrorCode == "files_need_check" })
                            put("folderCloudReady",folderSources.count { it.bindingState == "ready" })
                            put("folderCloudPending",folderSources.count { it.bindingState in setOf("pending","retry") })
                            put("folderCloudAttention",folderSources.count { it.bindingState == "needs_attention" })
                            put("folders",freshFolders.size)
                            put("folderSelected",folderSources.size)
                            // Local names stay inside the trusted native settings page, never a server log.
                            put("folderConnections",buildJsonArray {
                                folderSources.forEach { source -> add(buildJsonObject {
                                    put("name",runCatching {
                                        FolderHandleAccess.open(source).let{it.displayName?:it.rootDocumentId.substringAfterLast('/').substringAfterLast(':').take(180)}
                                    }.getOrDefault("업무 폴더"))
                                    put("readable",source in readableFolders)
                                    put("bindingState",source.bindingState)
                                }) }
                            })
                            put("folderReadable",readableFolders.size)
                            put("folderObserved",readableFolders.sumOf { it.observedCount })
                            put("folderEligible",readableFolders.sumOf { it.eligibleCount })
                            put("folderExcluded",readableFolders.sumOf { it.excludedCount })
                            put("folderPending",readableFolders.sumOf { it.pendingCount })
                            put("permissionCheckedAt",checkedAt)
                            put("folderIssues",queue.folderDao().issueCount())
                            put("lastScanAt",queue.folderDao().latestSuccessfulScanAt() ?: 0)
                            val maintenance = getSharedPreferences("capture_maintenance",MODE_PRIVATE)
                            put("backgroundLastRunAt",maintenance.getLong("success_at",0))
                            put("backgroundLastAttemptAt",maintenance.getLong("attempt_at",0))
                            put("backgroundError",maintenance.getString("error",null) ?: "")
                            val upload = getSharedPreferences("capture_upload",MODE_PRIVATE)
                            put("uploadLastRunAt",upload.getLong("success_at",0))
                            put("uploadLastAttemptAt",upload.getLong("attempt_at",0))
                            put("uploadError",upload.getString("error",null) ?: "")
                            put("notificationApps",queue.notificationDao().selectedCount())
                            val selectedPackages = queue.notificationDao().allSources()
                                .filter { it.state == "selected" }.map { it.packageName }.toSet()
                            put("notificationScopes",queue.notificationDao().allScopes()
                                .count { it.packageName in selectedPackages })
                            val access = notificationAccess()
                            val health = queue.notificationDao().health()
                            put("notificationAccess",access)
                            put("notificationListening",access && NotificationRuntime.connected)
                            put("notificationLastConnectedAt",health?.lastConnectedAtEpochMs ?: 0)
                            put("notificationLastGapStartAt",health?.lastGapStartAtEpochMs ?: 0)
                            put("notificationGapCount",health?.gapCount ?: 0)
                            val smsRoleBuild = packageName.endsWith(".smsrole")
                            val smsRoleHeld = smsRoleBuild && if (Build.VERSION.SDK_INT >= 29)
                                getSystemService(android.app.role.RoleManager::class.java)
                                    .isRoleHeld(android.app.role.RoleManager.ROLE_SMS)
                            else Telephony.Sms.getDefaultSmsPackage(this@MainActivity) == packageName
                            put("smsRoleHeld",smsRoleHeld)
                            put("smsNotificationsReady",smsRoleHeld && MessageNotificationReadiness.ready(this@MainActivity))
                            val smsReadGranted = smsRoleHeld && checkSelfPermission(
                                android.Manifest.permission.READ_SMS) ==
                                android.content.pm.PackageManager.PERMISSION_GRANTED
                            val smsProviderReadable = smsReadGranted && runCatching {
                                contentResolver.query(Telephony.Sms.CONTENT_URI,
                                    arrayOf(Telephony.Sms._ID),null,null,null)?.use {
                                    it.moveToFirst()
                                    true
                                } ?: false
                            }.getOrDefault(false)
                            put("smsOriginal",when {
                                BuildConfig.FLAVOR=="smsSync" -> "policy_gated"
                                !smsRoleBuild -> "unsupported_standard"
                                smsProviderReadable -> "provider_readable"
                                smsReadGranted -> "role_granted_unverified"
                                else -> "role_missing"
                            })
                            put("networkConnected",networkConnected())
                        }.toString())
                        "getQueueSummary" -> Pair(true,buildJsonObject {
                            (application as SigongnoteApp).notificationExecutor.submit {
                                queue.notificationDao().purgeExpiredCandidates(System.currentTimeMillis())
                            }.get()
                            val account=NotificationAccount.current(applicationContext)
                            put("unprovedShareCopies",account?.let { queue.copyReceiptDao().unprovedShareCount(it.tenantId,it.userId,it.deviceId) }?:0)
                            put("quotaPaused",account?.let { queue.queueDao().quotaPausedCount(it.userId,it.deviceId) }?:0)
                            put("pending",queue.queueDao().pendingCount())
                            put("uploadBlocked",queue.queueDao().blockedCount())
                            put("revokedPurgePending",queue.queueDao().revokedPendingCount())
                            put("shared",queue.shareInboxDao().stagedCount())
                            put("failed",queue.shareInboxDao().failedCount())
                            put("receiving",queue.shareInboxDao().receivingCount())
                            put("duplicate",queue.shareInboxDao().duplicateCount())
                            put("largePending",queue.shareInboxDao().pendingResumableCount())
                            put("folderStaged",queue.folderDao().stagedCount())
                            put("folderMissing",queue.folderDao().missingCount())
                            put("notificationCandidates",queue.notificationDao().candidateCount())
                            put("notificationApproved",queue.notificationDao().approvedCount())
                            put("notificationFailed",queue.notificationDao().failedCount())
                            put("notificationLimited",queue.notificationDao().retainedCount() >= 2_000)
                            put("storageError",shareFatal)
                            put("storageFailures",queue.shareInboxDao().storageFailedCount())
                            put("networkConnected",networkConnected())
                            put("uploadError",getSharedPreferences("capture_upload",MODE_PRIVATE)
                                .getString("error",null) ?: "")
                        }.toString())
                        "logout" -> {
                            queue.queueDao().pauseForLogout(System.currentTimeMillis())
                            (application as SigongnoteApp).notificationExecutor.submit {
                                queue.runInTransaction {
                                    val notifications = queue.notificationDao()
                                    notifications.pauseAll()
                                    notifications.clearScopes()
                                    notifications.clearUnconfirmed()
                                    notifications.holdApprovedForLogout()
                                }
                            }.get()
                            vault.logout()
                            Pair(true,"logged_out")
                        }
                        "pauseSource" -> Pair(queue.folderDao().pause(command.argument!!) == 1,
                            "folder_paused_local")
                        else -> Pair(false,"native_flow_not_ready")
                    }
                } catch (_: Exception) { Pair(false,"native_operation_failed") }
                runOnUiThread {
                    if(command.method=="logout" && result.first && !isFinishing && !isDestroyed) {
                        view.evaluateJavascript("window.dispatchEvent(new Event('sigongnote:activity-clear'));Object.keys(localStorage).filter(k=>k.startsWith('sigongnote.activity.v')).forEach(k=>localStorage.removeItem(k));",null)
                    }
                    if (!isFinishing && !isDestroyed) sendReply(command,reply,result.first,result.second)
                }
            }
        }
        setContentView(frame)
        // Android 15+ draws edge to edge over transparent bars, so dark icons keep the paper-coloured bars readable.
        if (Build.VERSION.SDK_INT >= 35) window.insetsController?.setSystemBarsAppearance(
            android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
            android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
        view.loadUrl(startPage(intent))
        if (savedInstanceState == null) openRequestedSmsSetup(intent)
        if (ShareIntentPolicy.shouldReceive(intent.action,savedInstanceState != null,intent.flags))
            receiveShare(intent)
        (application as SigongnoteApp).scanExecutor.execute {
            if (queue.folderDao().activeSources().isNotEmpty()) {
                FolderScanner(applicationContext,queue).scanAll()
                runOnUiThread { if (!isFinishing && !isDestroyed) webView?.reload() }
            }
        }
    }

    private fun notificationAccess(): Boolean {
        val component = ComponentName(this,BusinessNotificationListener::class.java)
        return if (Build.VERSION.SDK_INT >= 27)
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .isNotificationListenerAccessGranted(component)
        else Settings.Secure.getString(contentResolver,"enabled_notification_listeners")
            ?.split(':')?.any { ComponentName.unflattenFromString(it) == component } == true
    }

    private fun openNotificationAppPicker(command: BridgeCommand, reply: JavaScriptReplyProxy) {
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(launcher,0)
            .map { it.activityInfo.packageName to it.loadLabel(packageManager).toString() }
            .filter { it.first != packageName && NotificationSourceGuard.selectable(this,it.first) &&
                !Regex("(?i)(bank|은행|뱅크|보험|병원|의료|건강|증권|카드|인증)")
                    .containsMatchIn(it.second) }
            .distinctBy { it.first }.sortedBy { it.second }
        if (apps.isEmpty()) {
            sendReply(command,reply,false,"no_selectable_apps")
            return
        }
        AlertDialog.Builder(this).setTitle("새 알림을 볼 업무 앱 선택")
            .setItems(apps.map { "${it.second} (${it.first})" }.toTypedArray()) { _,index ->
                val selected = apps[index].first
                AlertDialog.Builder(this).setTitle("${apps[index].second} 알림 연결")
                    .setMessage("이 앱의 새 알림을 기기에 암호화해 후보로 보관합니다. 인증번호는 제외하고, 미확정 후보는 24시간 뒤 삭제 대상으로 처리합니다. 업무 대화를 따로 고르기 전에는 서버로 보내지 않습니다. Android의 시스템 승인도 필요합니다.")
                    .setNegativeButton("나중에") { _,_ ->
                        sendReply(command,reply,false,"notification_app_not_selected")
                    }
                    .setPositiveButton("동의하고 설정 열기") { _,_ ->
                        (application as SigongnoteApp).notificationExecutor.execute {
                            val dao = queue.notificationDao()
                            if (!NotificationSourceGuard.selectable(applicationContext,selected)) {
                                runOnUiThread { sendReply(command,reply,false,"notification_app_excluded") }
                                return@execute
                            }
                            dao.putSource(NotificationSource(selected,"selected",System.currentTimeMillis(),
                                dao.source(selected)?.lastEventAtEpochMs))
                            runOnUiThread {
                                sendReply(command,reply,true,"notification_app_selected")
                                webView?.reload()
                                if (!notificationAccess()) {
                                    returningFromNotificationSettings = true
                                    try { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
                                    catch (_: Exception) { returningFromNotificationSettings = false }
                                }
                            }
                        }
                    }.show()
            }
            .setNegativeButton("나중에") { _,_ ->
                sendReply(command,reply,false,"notification_app_not_selected")
            }.show()
    }

    private fun reviewNotificationScopes(command: BridgeCommand, reply: JavaScriptReplyProxy) {
        (application as SigongnoteApp).notificationExecutor.execute {
            val dao = queue.notificationDao()
            NotificationSourceGuard.enforce(applicationContext,queue)
            dao.purgeExpiredCandidates(System.currentTimeMillis())
            val account = NotificationAccount.current(applicationContext)
            val candidates = dao.allSources().filter { it.state == "selected" }
                .flatMap { source -> if (account == null) dao.scopeCandidates(source.packageName)
                    else dao.scopeCandidatesForAccount(source.packageName,
                        account.connectedAtEpochMs,account.tenantId,account.userId,
                        account.deviceId) }
            val scopes = dao.allScopes().filter { scope -> scope.tenantId == null ||
                (account != null && NotificationAccount.matches(scope.tenantId,
                    scope.userId,scope.deviceId,account)) }
            val vault = NotificationVault()
            val labels = scopes.map { scope ->
                val title = try { vault.title(scope.encryptedLabel).orEmpty() }
                    catch (_: Exception) { "제목 확인 불가" }
                "해제 · ${scope.packageName} · ${title.take(32).ifBlank { "제목 없음" }}"
            } + candidates.map { snapshot ->
                val title = try { vault.title(snapshot.encryptedPayload).orEmpty() }
                    catch (_: Exception) { "제목 확인 불가" }
                "선택 · ${snapshot.packageName} · ${title.take(32).ifBlank { "제목 없음" }}"
            }
            runOnUiThread {
                if (labels.isEmpty()) {
                    AlertDialog.Builder(this).setTitle("업무 대화 후보 없음")
                        .setMessage("선택한 앱에서 안정적으로 구분되는 대화 알림을 기다립니다. 구분할 수 없는 알림은 서버로 보내지 않으니 원문은 공유로 보내 주세요.")
                        .setPositiveButton("확인",null).show()
                    sendReply(command,reply,true,"no_scoped_candidates")
                    return@runOnUiThread
                }
                AlertDialog.Builder(this).setTitle("업무 대화만 선택")
                    .setItems(labels.toTypedArray()) { _,index ->
                        if (index < scopes.size) {
                            val scope = scopes[index]
                            AlertDialog.Builder(this).setTitle("이 대화 연결 해제")
                                .setMessage("이 대화에서 보관한 미전송 알림 본문을 기기에서 지웁니다. 이후 새 알림은 다시 미확정 후보로 취급합니다.")
                                .setNegativeButton("유지",null)
                                .setPositiveButton("해제") { _,_ ->
                                    (application as SigongnoteApp).notificationExecutor.execute {
                                        queue.runInTransaction {
                                            queue.queueDao().stopForNotificationScope(
                                                scope.packageName,scope.conversationHash,
                                                System.currentTimeMillis())
                                            dao.removeScope(scope.packageName,scope.conversationHash)
                                            dao.purgeConversation(scope.packageName,scope.conversationHash)
                                            dao.clearAcknowledgedConversation(scope.packageName,
                                                scope.conversationHash)
                                        }
                                        val closed = try {
                                            val purged = RevokedCapturePurger(queue,filesDir,
                                                this@MainActivity.vault).purgePending()
                                            purged.failed == 0 && queue.queueDao().revokedPendingCount() == 0
                                        } catch (_: Exception) { false }
                                        if (!closed) runCatching {
                                            CaptureMaintenanceWork.enqueue(this@MainActivity)
                                        }
                                        runOnUiThread {
                                            sendReply(command,reply,true,if (closed)
                                                "notification_scope_revoked" else
                                                "notification_scope_revoked_purge_pending")
                                            webView?.reload()
                                        }
                                    }
                                }.show()
                            return@setItems
                        }
                        val candidate = candidates[index - scopes.size]
                        (application as SigongnoteApp).notificationExecutor.execute {
                            if (!NotificationSourceGuard.selectable(applicationContext,candidate.packageName)) {
                                NotificationSourceGuard.revokeIfBlocked(applicationContext,queue,candidate.packageName)
                                runOnUiThread { sendReply(command,reply,false,"notification_app_excluded") }
                                return@execute
                            }
                            val active = NotificationAccount.current(applicationContext)
                            if (account?.tenantId != active?.tenantId ||
                                account?.userId != active?.userId ||
                                account?.deviceId != active?.deviceId) {
                                runOnUiThread { sendReply(command,reply,false,"account_changed") }
                                return@execute
                            }
                            val hash = candidate.conversationHash ?: return@execute
                            val previousScope = dao.scope(candidate.packageName,hash)
                            if (previousScope != null && previousScope.tenantId != null &&
                                (active == null || !NotificationAccount.matches(
                                    previousScope.tenantId,previousScope.userId,
                                    previousScope.deviceId,active))) {
                                runOnUiThread {
                                    AlertDialog.Builder(this).setTitle("다른 계정의 연결")
                                        .setMessage("이 대화는 이전 계정에 연결돼 있습니다. 해당 계정에서 연결을 해제한 뒤 다시 선택해 주세요.")
                                        .setPositiveButton("확인",null).show()
                                    sendReply(command,reply,false,"notification_scope_other_account")
                                }
                                return@execute
                            }
                            val label = vault.seal(vault.title(candidate.encryptedPayload),null)
                            queue.runInTransaction {
                                dao.insertScope(NotificationScope(candidate.packageName,hash,
                                    System.currentTimeMillis(),label,account?.tenantId,
                                    account?.userId,account?.deviceId))
                                if (account == null) dao.approveCandidates(candidate.packageName,hash)
                                else dao.approveCandidatesBound(candidate.packageName,hash,
                                    account.connectedAtEpochMs,account.tenantId,account.userId,
                                    account.deviceId)
                            }
                            runOnUiThread {
                                sendReply(command,reply,true,"notification_scope_selected")
                                webView?.reload()
                            }
                            if (active != null) CaptureUploadWork.enqueue(applicationContext)
                        }
                    }.setNegativeButton("나중에") { _,_ ->
                        sendReply(command,reply,false,"notification_scope_not_selected")
                    }.show()
            }
        }
    }

    private fun manageNotificationSources(command: BridgeCommand, reply: JavaScriptReplyProxy) {
        (application as SigongnoteApp).notificationExecutor.execute {
            NotificationSourceGuard.enforce(applicationContext,queue)
            val sources = queue.notificationDao().allSources().filter {
                NotificationSourceGuard.selectable(applicationContext,it.packageName)
            }
            runOnUiThread {
                AlertDialog.Builder(this).setTitle("알림 연결 관리")
                    .setItems(sources.map { "${it.packageName} · ${if (it.state == "selected") "수집 중" else "중지됨"}" }
                        .toTypedArray()) { _,index ->
                        val source = sources[index]
                        (application as SigongnoteApp).notificationExecutor.execute {
                            if (!NotificationSourceGuard.selectable(applicationContext,source.packageName)) {
                                NotificationSourceGuard.revokeIfBlocked(applicationContext,queue,source.packageName)
                                runOnUiThread { sendReply(command,reply,false,"notification_app_excluded") }
                                return@execute
                            }
                            queue.notificationDao().setState(source.packageName,
                                if (source.state == "selected") "paused" else "selected")
                            runOnUiThread {
                                sendReply(command,reply,true,"notification_source_updated")
                                webView?.reload()
                            }
                        }
                    }
                    .setNeutralButton("시스템 권한 설정") { _,_ ->
                        returningFromNotificationSettings = true
                        startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                    }.setNegativeButton("닫기") { _,_ ->
                        sendReply(command,reply,true,"notification_management_closed")
                    }.show()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        (application as SigongnoteApp).notificationExecutor.execute {
            NotificationSourceGuard.enforce(applicationContext,queue)
        }
        // Keep the bridge promise and consent dialog alive when the SAF picker returns.
        if (hasResumed && !folderPickerReturn) {workApi=WorkApi(vault,BuildConfig.DEBUG,opener=::openWorkOriginal,fileAction=::openWorkDocument);webView?.reload()}
        hasResumed = true
        folderPickerReturn = false
        returningFromNotificationSettings = false
        if (notificationAccess() && !NotificationRuntime.connected && Build.VERSION.SDK_INT >= 27)
            NotificationListenerService.requestRebind(ComponentName(this,
                BusinessNotificationListener::class.java))
    }

    private fun sendReply(command: BridgeCommand, reply: JavaScriptReplyProxy,
        ok: Boolean, result: String) {
        reply.postMessage(buildJsonObject {
            put("bridgeVersion",1)
            put("requestId",command.requestId)
            put("method",command.method)
            put("ok",ok)
            put("result",result)
        }.toString())
    }

    private fun openFolderPicker(command: BridgeCommand, reply: JavaScriptReplyProxy) {
        if (pendingFolderReply != null) {
            sendReply(command,reply,false,"picker_already_open")
            return
        }
        pendingFolderReply = command to reply
        folderPickerReturn = true
        try {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                if(command.argument=="call_recording") putExtra(DocumentsContract.EXTRA_INITIAL_URI,DocumentsContract.buildDocumentUri("com.android.externalstorage.documents","primary:Recordings/Call"))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            },folderPickerRequest)
        } catch (_: Exception) {
            pendingFolderReply = null
            folderPickerReturn = false
            sendReply(command,reply,false,"folder_picker_unavailable")
        }
    }

    @Deprecated("Activity result retained while the app has no AndroidX Activity dependency")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode,resultCode,data)
        if(requestCode==workFileRequest){
            val reply=workFileReply;workFileReply=null
            val camera=workPhotos.find(workCameraName);workCameraName=null
            val cameraUri=camera?.let{androidx.core.content.FileProvider.getUriForFile(this,BuildConfig.APPLICATION_ID+".capture",it)}
            if(cameraUri!=null)revokeUriPermission(cameraUri,Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            val selected=if(resultCode!=RESULT_OK)null else if(camera!=null&&camera.length()>0L)arrayOf(cameraUri!!) else android.webkit.WebChromeClient.FileChooserParams.parseResult(resultCode,data)
            if(selected==null)workPhotos.cancel(camera)
            reply?.onReceiveValue(selected)
            return
        }
        if (requestCode == photoCaptureRequest) { photoCaptureOpen=false; return }
        if (requestCode != folderPickerRequest) return
        val pending = pendingFolderReply
        pendingFolderReply = null
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null || uri.scheme != "content" ||
            !DocumentsContract.isTreeUri(uri)) {
            pending?.let { sendReply(it.first,it.second,false,"folder_not_selected") }
            return
        }
        val command=pending?.first ?: return
        FolderSetup(this,application as SigongnoteApp) { ok,message ->
            if (!isFinishing && !isDestroyed) {
                sendReply(command,pending.second,ok,message)
            }
        }.show(uri,data.flags,command.argument ?: "folder")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (needsSetupPage(intent)) webView?.loadUrl("${BridgePolicy.trustedOrigin}/assets/index.html")
        openRequestedSmsSetup(intent)
        receiveShare(intent)
    }

    private fun needsSetupPage(value:Intent):Boolean = value.action==Intent.ACTION_SEND || value.action==Intent.ACTION_SEND_MULTIPLE || value.getBooleanExtra("request_sms_setup",false)
    private fun startPage(value:Intent)= "${BridgePolicy.trustedOrigin}/assets/" + if(needsSetupPage(value)) "index.html" else "work/index.html"

    private fun openRequestedSmsSetup(value: Intent) {
        if (packageName.endsWith(".smsrole") && value.getBooleanExtra("request_sms_setup",false) &&
            applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            value.removeExtra("request_sms_setup")
            startActivity(Intent().setClassName(packageName,"com.sigongnote.app.SmsPermissionActivity")
                .putExtra("request_now",true))
        }
    }

    private fun markSetupAttempt(kind: String) {
        setupAttempted.add(kind)
        getSharedPreferences("permission_setup",MODE_PRIVATE).edit()
            .putStringSet("attempted",setupAttempted.toSet()).apply()
    }

    override fun onSaveInstanceState(out: Bundle) {
        out.putStringArrayList("setup_attempted",ArrayList(setupAttempted))
        out.putBoolean("photo_capture_open",photoCaptureOpen)
        out.putString("work_camera_name",workCameraName)
        super.onSaveInstanceState(out)
    }

    private fun networkConnected(): Boolean = try {
        val manager = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
        capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    } catch (_: Exception) { false }

    private fun receiveShare(incoming: Intent?) {
        if (incoming == null || !ShareIntentPolicy.shouldReceive(incoming.action,false,incoming.flags)) return
        setIntent(Intent(Intent.ACTION_MAIN))
        io.execute {
            try {
                ShareReceiver(contentResolver,queue.shareInboxDao(),
                    ShareCopyWriter(ShareCopyKey().get(), java.io.File(filesDir,"share-inbox")),
                    java.io.File(filesDir,"share-inbox")).receive(incoming)
                CaptureUploadWork.enqueue(applicationContext)
            } catch (_: Exception) { shareFatal = true }
            runOnUiThread {
                if (!isFinishing && !isDestroyed) webView?.reload()
            }
        }
    }

    private fun handleBack() { val view=webView;if(view?.canGoBack()==true) view.goBack() else finish() }
    @Deprecated("Activity back navigation")
    override fun onBackPressed() { handleBack() }

    override fun onRequestPermissionsResult(requestCode:Int,permissions:Array<out String>,grantResults:IntArray){
        super.onRequestPermissionsResult(requestCode,permissions,grantResults)
        if(requestCode==1711){val request=audioPermission;audioPermission=null;if(grantResults.firstOrNull()==android.content.pm.PackageManager.PERMISSION_GRANTED)request?.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE))else request?.deny()}
        if(requestCode==VoiceInput.permissionRequest)voice.permissionResult(grantResults.firstOrNull()==android.content.pm.PackageManager.PERMISSION_GRANTED)
    }
    override fun onStop(){voice.cancel();audioPermission?.deny();audioPermission=null;super.onStop()}
    override fun onDestroy() {
        workFileReply?.onReceiveValue(null);workFileReply=null
        voice.cancel()
        if (NotificationRuntime.onChange === notificationRefresh) NotificationRuntime.onChange = null
        webView?.destroy()
        io.shutdown()
        workIo.shutdownNow()
        super.onDestroy()
    }
}
