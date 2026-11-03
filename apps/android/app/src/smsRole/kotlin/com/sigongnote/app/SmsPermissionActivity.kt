package com.sigongnote.app

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.provider.Telephony
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Permission setup never reads a message, sends one, or approves a business scope. */
class SmsPermissionActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var action: Button
    private lateinit var purpose: TextView
    private var requesting = false
    private val preferences by lazy { getSharedPreferences("sms_permission_setup", MODE_PRIVATE) }
    private val required = listOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS,
        Manifest.permission.RECEIVE_SMS, Manifest.permission.RECEIVE_MMS,
        Manifest.permission.RECEIVE_WAP_PUSH)

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        requesting = state?.getBoolean("requesting") ?: false
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24.dp, 36.dp, 24.dp, 24.dp)
        }
        fun text(value: String, size: Float = 20f) = TextView(this).apply {
            text = value; textSize = size; setPadding(0, 10.dp, 0, 14.dp); root.addView(this)
        }
        fun button(label: String, clicked: () -> Unit) = Button(this).apply {
            text = label; textSize = 20f; minHeight = 60.dp
            root.addView(this); setOnClickListener { clicked() }
        }
        text("문자를 사용할 준비", 28f)
        purpose = text("", 18f)
        status = text("현재 허용 여부를 확인하고 있습니다")
        action = button("허용 화면 열기") { requestNext() }
        button("나중에 할게요") { finish() }
        button("원래 문자앱 고르기") {
            launch(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
        }
        text("업무 번호와 기간은 따로 골라요. 문자 원문은 서버로 보내지 않아요.", 18f)
        setContentView(ScrollView(this).apply { addView(root) })
        refresh()
        // Explicit operator request in a debug build opens the official OS dialog only.
        if (state == null && intent.getBooleanExtra("request_now", false) &&
            applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
            action.post { requestNext() }
    }

    private val Int.dp: Int get() = (this * resources.displayMetrics.density).toInt()
    private fun missing() = required.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    private fun next(): SmsPermissionStep = SmsPermissionStep.decide(
        SmsRoleRuntime.isAvailable(this), SmsRoleRuntime.isDefault(this), missing().isEmpty(),
        missing().any { preferences.getBoolean(it, false) && !shouldShowRequestPermissionRationale(it) },
        MessageNotificationReadiness.ready(this))

    private fun refresh() {
        val step = next()
        purpose.text=when(step) {
            SmsPermissionStep.ROLE -> "선택 사항이에요. 기본 문자앱이 바뀌어요. 채팅+·스팸 차단은 지원하지 않아요. 사진 문자 받기는 확인 중이에요. 원래 앱은 ‘설정 → 기본 앱 → SMS 앱’에서 고를 수 있어요."
            SmsPermissionStep.PERMISSIONS, SmsPermissionStep.SETTINGS -> "이 휴대폰의 문자를 읽고 보낼 수 있도록 허용해요. 거절해도 다른 자료는 사용할 수 있어요."
            SmsPermissionStep.NOTIFICATIONS -> "새 문자가 왔을 때 알려드려요. 꺼져 있으면 중요한 문자를 놓칠 수 있어요."
            else -> "허용한 기능만 사용해요. 언제든 휴대폰 설정에서 바꿀 수 있어요."
        }
        status.text = when (step) {
            SmsPermissionStep.UNAVAILABLE -> "이 기기는 문자 기능을 지원하지 않습니다. 필요한 자료를 공유해서 보낼 수 있습니다."
            SmsPermissionStep.ROLE -> "기본 문자앱 선택이 필요합니다."
            SmsPermissionStep.PERMISSIONS -> "문자 접근을 허용해 주세요. 거절해도 다른 자료는 사용할 수 있습니다."
            SmsPermissionStep.SETTINGS -> "문자 권한이 꺼져 있습니다. 앱 설정의 ‘권한 → SMS’에서 허용할 수 있습니다."
            SmsPermissionStep.NOTIFICATIONS -> "새 문자 도착 알림을 허용해 주세요."
            SmsPermissionStep.READY -> "문자 권한이 준비됐어요. 사진 문자 받기는 아직 확인 중이에요."
        }
        action.text = when (step) {
            SmsPermissionStep.ROLE -> "기본 문자앱 선택 화면 열기"
            SmsPermissionStep.PERMISSIONS -> "문자 접근 허용하기"
            SmsPermissionStep.SETTINGS -> "앱 권한 설정 열기"
            SmsPermissionStep.NOTIFICATIONS -> "새 문자 도착 알림 허용하기"
            SmsPermissionStep.READY -> "문자함 열기"
            else -> "돌아가기"
        }
        action.isEnabled = !requesting
    }

    @Suppress("DEPRECATION")
    private fun requestNext() {
        if (requesting) return
        when (next()) {
            SmsPermissionStep.ROLE -> {
                val picker = if (Build.VERSION.SDK_INT >= 29)
                    getSystemService(RoleManager::class.java).createRequestRoleIntent(RoleManager.ROLE_SMS)
                else Intent(Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT).putExtra(
                    Telephony.Sms.Intents.EXTRA_PACKAGE_NAME, packageName)
                requesting = true; refresh()
                try { startActivityForResult(picker, 1801) }
                catch (_: Exception) { requesting = false; refresh(); status.text = "휴대폰 기본 앱 설정에서 시공노트를 선택해 주세요." }
            }
            SmsPermissionStep.PERMISSIONS -> {
                val permissions = missing()
                preferences.edit().apply { permissions.forEach { putBoolean(it, true) } }.apply()
                requesting = true; refresh()
                requestPermissions(permissions.toTypedArray(), 1802)
            }
            SmsPermissionStep.SETTINGS -> launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName")))
            SmsPermissionStep.NOTIFICATIONS -> requestNotifications()
            SmsPermissionStep.READY -> { startActivity(Intent(this,SmsRoleActivity::class.java));finish() }
            else -> finish()
        }
    }

    private fun launch(value: Intent) {
        try { startActivity(value) } catch (_: Exception) { status.text = "휴대폰 설정에서 시공노트 권한을 확인해 주세요." }
    }

    private fun requestNotifications() {
        if (!SmsRoleRuntime.isDefault(this)) {
            status.text = "먼저 기본 문자앱을 선택해 주세요."
        } else if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            (!preferences.getBoolean("notification_asked",false) ||
                shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
            preferences.edit().putBoolean("notification_asked",true).apply()
            requesting = true; refresh()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS),1803)
        } else launch(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,packageName))
    }

    @Deprecated("Platform role callback")
    override fun onActivityResult(code: Int, result: Int, data: Intent?) {
        super.onActivityResult(code, result, data)
        if (code != 1801) return
        requesting = false; refresh()
        // A successful Activity result alone is never treated as a granted role.
        if (SmsRoleRuntime.isDefault(this) && next() in setOf(SmsPermissionStep.PERMISSIONS, SmsPermissionStep.NOTIFICATIONS)) requestNext()
    }

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == 1802 || code == 1803) {
            requesting = false; refresh()
            if (code == 1802 && next() == SmsPermissionStep.NOTIFICATIONS) requestNext()
        }
    }
    override fun onResume() { super.onResume(); if (::status.isInitialized) refresh() }
    override fun onSaveInstanceState(out: Bundle) {
        out.putBoolean("requesting", requesting); super.onSaveInstanceState(out)
    }
}

enum class SmsPermissionStep {
    UNAVAILABLE, ROLE, PERMISSIONS, SETTINGS, NOTIFICATIONS, READY;
    companion object {
        fun decide(available: Boolean, role: Boolean, granted: Boolean, deniedPermanently: Boolean,
            notifications: Boolean = true) = when {
            !available -> UNAVAILABLE
            !role -> ROLE
            granted -> if (notifications) READY else NOTIFICATIONS
            deniedPermanently -> SETTINGS
            else -> PERMISSIONS
        }
    }
}
