package com.sigongnote.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** Only the native process reads tokens; WebView messages never expose them. */
class TokenVault(context: Context) : UploadCredentialStore {
    private companion object { val credentialLock = Any() }
    private val preferences = context.getSharedPreferences("native_credentials", Context.MODE_PRIVATE)
    private val alias = "sigongnote.auth.v1"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(alias, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build())
        return generator.generateKey()
    }

    override fun store(value: String) = synchronized(credentialLock) {
        storeValue("session",value)
    }

    private fun sealed(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val payload = byteArrayOf(1) + cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    private fun storeValue(name: String, value: String) {
        val editor = preferences.edit()
        if (name == "session") {
            val previous = try { readValue("session") ?: readValue("principal_marker") }
                catch (_: Exception) { null }
            val nextPrincipal = principal(value)
            if (previous != null && principal(previous) != nextPrincipal) {
                preferences.all.keys.filter { it.startsWith("tus_") }.forEach(editor::remove)
            }
            if (nextPrincipal != null) editor.putString("principal_marker",sealed(buildJsonObject {
                put("tenantId",nextPrincipal[0]); put("userId",nextPrincipal[1])
                put("deviceId",nextPrincipal[2])
            }.toString()))
        }
        check(editor.putString(name, sealed(value)).commit()) {
            "Credential write failed"
        }
    }

    private fun principal(value: String): List<String>? = try {
        val objectValue = Json.parseToJsonElement(value).jsonObject
        listOf("tenantId","userId","deviceId").map {
            objectValue.getValue(it).jsonPrimitive.content
        }
    } catch (_: Exception) { null }

    override fun read(): String? = synchronized(credentialLock) {readValue("session")}
    override fun replaceIfUnchanged(expected:String,replacement:String):Boolean=synchronized(credentialLock) {
        if(readValue("session")!=expected)false else {storeValue("session",replacement);true}
    }

    fun saveLoginFlow(flow: GoogleLoginFlow) = synchronized(credentialLock) {
        storeValue("google_flow",buildJsonObject {
            flow.linkTarget?.let {put("linkTarget",it.encode())}
            put("verifier",flow.verifier);put("state",flow.state);put("createdAt",flow.createdAt);put("provider",flow.provider)
        }.toString())
    }
    fun hasPendingIdentityLink():Boolean=synchronized(credentialLock) {
        runCatching {
            val j=Json.parseToJsonElement(readValue("google_flow") ?: return@synchronized false).jsonObject
            j.containsKey("linkTarget") && System.currentTimeMillis()-j.getValue("createdAt").jsonPrimitive.content.toLong() in 0..600_000
        }.getOrDefault(false)
    }
    fun consumeLoginFlow(returned: String,callback: String): Pair<GoogleLoginFlow,String> = synchronized(credentialLock) {
        val j=Json.parseToJsonElement(requireNotNull(readValue("google_flow"))).jsonObject
        fun field(name: String)=j.getValue(name).jsonPrimitive.content
        val flow=GoogleLoginFlow(field("verifier"),field("state"),field("createdAt").toLong(),j["provider"]?.jsonPrimitive?.content ?: "google",j["linkTarget"]?.jsonPrimitive?.content?.let {IdentityLinkTarget.decode(it)})
        val code=flow.code(returned,callback,System.currentTimeMillis())
        check(preferences.edit().remove("google_flow").commit())
        flow to code
    }
    fun savePendingLogin(login: AccountLogin)=synchronized(credentialLock) {storeValue("account_pending",login.encode())}
    fun pendingLogin(): AccountLogin? = readValue("account_pending")?.let {AccountLogin.decode(it)}
    fun clearPendingLogin()=synchronized(credentialLock) {
        check(preferences.edit().remove("account_pending").remove("google_flow").commit())
    }
    fun workspaceDraft(login:AccountLogin,api:String,name:String):WorkspaceDraft=synchronized(credentialLock) {
        val old=readWorkspaceDraft()
        if(old?.user==login.user && old.api==api)old else WorkspaceDraft(login.user,api,UUID.randomUUID().toString(),name.trim()).also {storeValue("workspace_draft",it.encode())}
    }
    private fun readWorkspaceDraft():WorkspaceDraft?=recoverWorkspaceDraft({readValue("workspace_draft")},::clearWorkspaceDraft)
    fun hasWorkspaceDraft(login:AccountLogin,api:String):Boolean=synchronized(credentialLock) {readWorkspaceDraft()?.let {it.user==login.user && it.api==api} ?: false}
    fun workspaceName(login:AccountLogin,api:String):String=synchronized(credentialLock) {readWorkspaceDraft()?.takeIf {it.user==login.user && it.api==api}?.name ?: "우리 회사"}
    fun clearWorkspaceDraft()=synchronized(credentialLock) {check(preferences.edit().remove("workspace_draft").commit())}
    fun enrollmentKey(scope: String): String = synchronized(credentialLock) {
        val name="enroll_"+java.security.MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") {"%02x".format(it)}
        readValue(name) ?: UUID.randomUUID().toString().also {storeValue(name,it)}
    }

    private fun readValue(name: String): String? {
        val encoded = preferences.getString(name, null) ?: return null
        val payload = Base64.decode(encoded, Base64.NO_WRAP)
        require(payload.size >= 29 && payload[0] == 1.toByte()) { "Credential record damaged" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(),
            javax.crypto.spec.GCMParameterSpec(128, payload.copyOfRange(1, 13)))
        return String(cipher.doFinal(payload.copyOfRange(13, payload.size)), Charsets.UTF_8)
    }

    private fun progressName(captureId: String): String {
        require(UUID.fromString(captureId).toString() == captureId)
        return "tus_$captureId"
    }

    fun storeProgress(captureId: String, value: String) = synchronized(credentialLock) {
        check(preferences.contains("session")) { "Upload session disconnected" }
        storeValue(progressName(captureId),value)
    }
    fun readProgress(captureId: String): String? = readValue(progressName(captureId))
    fun clearProgress(captureId: String) {
        check(preferences.edit().remove(progressName(captureId)).commit())
    }

    override fun clearSession() = synchronized(credentialLock) {
        check(preferences.edit().remove("session").commit()) { "Credential clear failed" }
    }

    /** Logout drops bearer and signed TUS URL, retaining only replay keys for re-login. */
    fun logout() = synchronized(credentialLock) {
        val editor = preferences.edit().remove("session").remove("account_pending").remove("google_flow").remove("workspace_draft")
        preferences.all.keys.filter { it.startsWith("tus_") }.forEach { name ->
            val safe = try {
                readValue(name)?.let { UploadAttempt.decode(it).copy(receipt=null,location=null) }
            } catch (_: Exception) { null }
            if (safe == null) editor.remove(name)
            else editor.putString(name,sealed(safe.encode()))
        }
        check(editor.commit()) { "Credential logout failed" }
    }

    override fun clear() = synchronized(credentialLock) {
        val editor = preferences.edit().remove("session").remove("principal_marker").remove("account_pending").remove("google_flow").remove("workspace_draft")
        preferences.all.keys.filter { it.startsWith("tus_") }.forEach(editor::remove)
        check(editor.commit()) { "Credential clear failed" }
    }
}
