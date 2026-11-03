package com.sigongnote.app

import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

class WorkspaceInvitationRequired:Exception()
class WorkspaceLoginExpired:Exception()
data class WorkspaceDraft(val user:String,val api:String,val key:String,val name:String) {
    fun encode()=buildJsonObject {put("user",user);put("api",api);put("key",key);put("name",name)}.toString()
    companion object {
        fun decode(raw:String):WorkspaceDraft {val j=Json.parseToJsonElement(raw).jsonObject;fun get(k:String)=j.getValue(k).jsonPrimitive.content
            return WorkspaceDraft(get("user"),get("api"),get("key"),get("name"))}
    }
}
/** Does not accept a company ID from the caller; the authenticated API creates the first one. */
class FirstWorkspace(private val config:CloudAccountConfig,private val http:OkHttpClient=OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false).callTimeout(20,TimeUnit.SECONDS).build()) {
    init {config.validate()}
    fun create(login:AccountLogin,draft:WorkspaceDraft,current:()->Boolean={true}):List<AccountCompany> {
        if(login.expires<=System.currentTimeMillis() || !current())throw WorkspaceLoginExpired()
        require(draft.user==login.user && draft.api==config.api && draft.name.trim().length in 1..120)
        require(UUID.fromString(draft.key).toString()==draft.key && login.expires>System.currentTimeMillis())
        val account=CloudAccount(config,http)
        val existing=account.companies(login);if(!current())throw WorkspaceLoginExpired();if(existing.isNotEmpty())return existing
        val request=Request.Builder().url(config.api.trimEnd('/')+"/v1/workspaces")
            .header("Authorization","Bearer ${login.access}").header("Idempotency-Key",draft.key)
            .post(buildJsonObject {put("display_name",draft.name.trim())}.toString().toRequestBody("application/json".toMediaType())).build()
        http.newCall(request).execute().use {response->
            if(response.code==401)throw WorkspaceLoginExpired()
            if(response.code==403)throw WorkspaceInvitationRequired()
            check(response.code in setOf(201,409)){"WORKSPACE_REQUEST_FAILED"}
        }
        return account.companies(login).also {if(!current())throw WorkspaceLoginExpired();if(it.isEmpty())throw WorkspaceInvitationRequired()}
    }
}

internal fun recoverWorkspaceDraft(read:()->String?,clear:()->Unit):WorkspaceDraft? = try {
    read()?.let {WorkspaceDraft.decode(it)}?.also {require(UUID.fromString(it.key).toString()==it.key && it.name.trim().length in 1..120)}
} catch(_:Exception) {clear();null}
