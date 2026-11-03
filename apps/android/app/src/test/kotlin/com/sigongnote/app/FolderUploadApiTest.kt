package com.sigongnote.app

import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class FolderUploadApiTest {
    @Test fun nativeRegistrationCarriesScopeAndRechecksCurrentGrantBeforeBinding() {
        val id="11111111-1111-4111-8111-111111111111"
        val policy=buildJsonObject {
            put("id","local-fixture-v1"); put("purpose","work_records"); put("provider","local_fixture")
            put("processing_location","development_computer"); put("storage_location","development_computer")
            put("retention","until_user_deletes"); put("external_processing",false)
        }
        val source=FolderSource(id,"encrypted-not-a-wire-path",1,"selected",0,null,null,0,0,0,0,null,null,null,1,
            id,id,id,"call_recording","all",null,"work_dedicated","a".repeat(64),true,"local-fixture-v1",
            policy.toString(),null,null,"pending")
        val scope=FolderSourcePolicy.scope(source)
        val response=buildJsonObject {
            put("id",id); put("tenant_id",id); put("device_id",id); put("kind","call_recording")
            put("capability","passive"); put("permission","not_requested"); put("reported_permission",JsonNull)
            put("permission_trust","client_report_only"); put("health","not_started"); put("scope_version",1)
            put("generation",1); put("version",1); put("active",true); put("device_active",true); put("upload_ready",true)
            put("local_selection_consent",true); put("server_upload_consent",true); put("external_ai_consent",false)
            for(key in listOf("permission_checked_at","coverage_from","last_successful_scan_at","last_event_at","last_server_ack_at","last_error_code")) put(key,JsonNull)
            put("scope_fingerprint","a".repeat(64)); put("pending_count",0); put("bytes_pending",0); put("scope",scope); put("processing_policy",policy)
        }
        val binding=buildJsonObject {
            put("id",id); put("source_id",id); put("source_generation",1); put("scope_fingerprint","a".repeat(64))
            put("scope_mode","company_common"); put("project_id",JsonNull); put("version",1)
        }
        MockWebServer().use { server ->
            server.start()
            val base=server.url("/").toString()
            val api=UploadApi(UploadSession(base,base,base,"fixture","fixture","fixture",Long.MAX_VALUE,id,id,id,id,1,1))
            for(body in listOf(policy,response,buildJsonObject { put("sources",buildJsonArray { add(response) }) },
                    binding,buildJsonObject { put("bindings",buildJsonArray { add(binding) }) }))
                server.enqueue(MockResponse().setBody(body.toString()))
            val remote=api.registerFolder(source); api.bindFolderProject(source,remote)
            assertEquals("/v1/capture-policy",server.takeRequest().path)
            val create=server.takeRequest(); val payload=Json.parseToJsonElement(create.body.readUtf8()).jsonObject
            assertEquals("/v1/capture-sources",create.path)
            assertEquals("call_recording",payload.getValue("kind").jsonPrimitive.content)
            assertEquals(policy,payload["processing_policy"])
            assertEquals(scope,payload["scope"]); assertFalse(payload.toString().contains("encrypted-not-a-wire-path"))
            assertEquals(FolderSourcePolicy.requestKey(id,"source"),create.getHeader("Idempotency-Key"))
            assertEquals("/v1/capture-sources",server.takeRequest().path)
            assertEquals("/v1/site-folder-bindings",server.takeRequest().path)
            assertEquals("/v1/site-folder-bindings",server.takeRequest().path)
            server.enqueue(MockResponse().setBody(policy.toString()))
            server.enqueue(MockResponse().setBody(response.toString()))
            server.enqueue(MockResponse().setBody("{\"sources\":[]}"))
            try { api.registerFolder(source); fail("Old idempotent receipt is not current permission") }
            catch(error:UploadApi.Fault) { assertEquals("SOURCE_EXPIRED",error.code) }
            repeat(3) { server.takeRequest() }
            server.enqueue(MockResponse().setBody(buildJsonObject { put("sources",buildJsonArray { add(response) }) }.toString()))
            server.enqueue(MockResponse().setBody("{}"))
            api.revokeFolder(source)
            assertEquals("/v1/capture-sources",server.takeRequest().path)
            val revoke=server.takeRequest()
            assertEquals("/v1/capture-sources/$id/revoke",revoke.path)
            assertEquals("\"1\"",revoke.getHeader("If-Match"))
            val aiPolicy=JsonObject(policy + mapOf("id" to JsonPrimitive("anthropic-work-records-v1"),"provider" to JsonPrimitive("anthropic"),"external_processing" to JsonPrimitive(true),"processors" to buildJsonArray{add(buildJsonObject{put("purpose","long_stt");put("provider","openai");put("processing_location","US transcription");put("storage_location","provider transient");put("retention","delete after transcription")})}))
            val handle=FolderCaptureHandle("content://synthetic.provider/tree/call","call","company_common",externalAiConsent=true)
            val aiSource=source.copy(scopeVersion=2,processingPolicyId="anthropic-work-records-v1",processingPolicySnapshot=aiPolicy.toString())
            val aiResponse=JsonObject(response + mapOf("external_ai_consent" to JsonPrimitive(true),"processing_policy" to aiPolicy,"scope" to FolderSourcePolicy.scope(aiSource)))
            val aiApi=UploadApi(UploadSession(base,base,base,"fixture","fixture","fixture",Long.MAX_VALUE,id,id,id,id,1,1),openFolderHandle={handle.encode()})
            for(body in listOf(aiPolicy,aiResponse,buildJsonObject { put("sources",buildJsonArray { add(aiResponse) }) })) server.enqueue(MockResponse().setBody(body.toString()))
            aiApi.registerFolder(aiSource)
            server.takeRequest()
            val aiRequest=Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            assertTrue(aiRequest.getValue("external_ai_consent").jsonPrimitive.boolean)
            assertEquals(aiPolicy,aiRequest["processing_policy"])
            assertFalse(aiRequest.toString().contains("content://"))
            server.takeRequest()
            val changedPolicy=JsonObject(aiPolicy + ("processors" to buildJsonArray{add(JsonObject(aiPolicy.getValue("processors").jsonArray.single().jsonObject + ("retention" to JsonPrimitive("changed same-ID retention"))))}))
            server.enqueue(MockResponse().setBody(changedPolicy.toString()))
            try{aiApi.registerFolder(aiSource);fail("Same policy ID cannot authorize changed processor terms")}
            catch(error:UploadApi.Fault){assertEquals("SOURCE_EXPIRED",error.code)}
            assertEquals("/v1/capture-policy",server.takeRequest().path)
        }
    }
}
