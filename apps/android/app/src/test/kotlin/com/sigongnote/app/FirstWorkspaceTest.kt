package com.sigongnote.app

import java.io.IOException
import java.util.UUID
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test

class FirstWorkspaceTest {
    private val user="10000000-0000-4000-8000-000000000002"
    private val tenant="10000000-0000-4000-8000-000000000001"
    private val config=CloudAccountConfig("https://api.example.test","https://auth.example.test","public")
    private val login=AccountLogin("access","refresh",user,System.currentTimeMillis()+3_600_000)
    @Test fun lostResponseRestoresFirstCompanyWithoutAnotherWrite() {
        var created=false;var writes=0
        val draft=WorkspaceDraft(user,config.api,UUID.randomUUID().toString(),"합성 회사")
        assertEquals(draft,WorkspaceDraft.decode(draft.encode()))
        val client=OkHttpClient.Builder().addInterceptor {chain->
            val request=chain.request();assertNull(request.header("X-Tenant-Id"));assertEquals("Bearer access",request.header("Authorization"))
            if(request.method=="POST") {writes++;assertEquals(draft.key,request.header("Idempotency-Key"));created=true;throw IOException("synthetic lost acknowledgement")}
            val list=if(created) """[{"tenant_id":"$tenant","tenant_name":"합성 회사","role":"owner"}]""" else "[]"
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK").body("""{"user_id":"$user","memberships":$list}""".toResponseBody()).build()
        }.build()
        assertThrows(IOException::class.java) {FirstWorkspace(config,client).create(login,draft)}
        assertEquals(tenant,FirstWorkspace(config,client).create(login,WorkspaceDraft.decode(draft.encode())).single().id)
        assertEquals(1,writes)
    }
    @Test fun formerMembershipRequestsInvitationAndNeverSendsClaimedRole() {
        val client=OkHttpClient.Builder().addInterceptor {chain->
            val request=chain.request();val isPost=request.method=="POST"
            if(isPost) {val buffer=okio.Buffer();request.body!!.writeTo(buffer);assertEquals("""{"display_name":"회사"}""",buffer.readUtf8())}
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(if(isPost)403 else 200).message("fixture")
                .body((if(isPost) "{}" else """{"user_id":"$user","memberships":[]}""").toResponseBody()).build()
        }.build()
        assertThrows(WorkspaceInvitationRequired::class.java) {FirstWorkspace(config,client).create(login,WorkspaceDraft(user,config.api,UUID.randomUUID().toString(),"회사"))}
    }
    @Test fun damagedDraftIsDiscardedAndExistingCompanyRecovered() {
        var cleared=false
        assertNull(recoverWorkspaceDraft({throw java.security.GeneralSecurityException("fixture")},{cleared=true}))
        assertTrue(cleared)
        val client=OkHttpClient.Builder().addInterceptor {chain->
            assertEquals("GET",chain.request().method)
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("""{"user_id":"$user","memberships":[{"tenant_id":"$tenant","tenant_name":"fixture","role":"owner"}]}""".toResponseBody()).build()
        }.build()
        assertEquals(tenant,FirstWorkspace(config,client).create(login,WorkspaceDraft(user,config.api,UUID.randomUUID().toString(),"회사")).single().id)
    }
    @Test fun changedAccountDuringReadNeverCreatesCompany() {
        var current=true
        val client=OkHttpClient.Builder().addInterceptor {chain->
            assertEquals("GET",chain.request().method);current=false
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").body("""{"user_id":"$user","memberships":[]}""".toResponseBody()).build()
        }.build()
        assertThrows(WorkspaceLoginExpired::class.java) {FirstWorkspace(config,client).create(login,WorkspaceDraft(user,config.api,UUID.randomUUID().toString(),"회사")){current}}
    }

}
