package com.sigongnote.app

import com.sigongnote.contracts.CapturePolicy
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class CapturePolicyConsentTest {
    private val id="11111111-1111-4111-8111-111111111111"
    private val policy=Json.parseToJsonElement("""{"id":"anthropic-work-records-v1","purpose":"work_records","provider":"anthropic","processing_location":"US primary","storage_location":"KR company","retention":"until_user_deletes","external_processing":true,"processors":[{"purpose":"long_stt","provider":"openai","processing_location":"US transcription","storage_location":"provider transient","retention":"delete after transcription"}]}""").jsonObject
    private fun source(snapshot:JsonObject)=buildJsonObject{
        put("id",id);put("tenant_id",id);put("device_id",id);put("kind","sms")
        put("capability","passive");put("permission","not_requested");put("reported_permission",JsonNull)
        put("permission_trust","client_report_only");put("health","not_started");put("scope_version",1)
        put("generation",1);put("version",1);put("active",true);put("device_active",true);put("upload_ready",false)
        put("local_selection_consent",true);put("server_upload_consent",true);put("external_ai_consent",true)
        for(key in listOf("permission_checked_at","coverage_from","last_successful_scan_at","last_event_at","last_server_ack_at","last_error_code"))put(key,JsonNull)
        put("scope_fingerprint","a".repeat(64));put("pending_count",0);put("bytes_pending",0);put("processing_policy",snapshot)
    }

    @Test fun reopeningPreservesEveryProcessorTermAndObjectKeyOrderDoesNotChangeConsent(){
        val reopened=Json.decodeFromJsonElement<CapturePolicy>(policy)
        assertEquals(policy,CapturePolicyNotice.snapshot(reopened))
        val reordered=JsonObject(policy.entries.reversed().associate{it.toPair()})
        assertEquals(CapturePolicyNotice.snapshot(reopened),CapturePolicyNotice.snapshot(Json.decodeFromJsonElement<CapturePolicy>(reordered)))
        val notice=CapturePolicyNotice.text(reopened)
        for(expected in listOf("현장·업무 정리: Anthropic Claude","US primary","KR company","직접 삭제할 때까지","긴 녹음 전사: OpenAI","US transcription","provider transient","delete after transcription"))assertTrue(expected,notice.contains(expected))
        val legacy=JsonObject(policy - "processors")
        assertEquals(legacy,CapturePolicyNotice.snapshot(Json.decodeFromJsonElement<CapturePolicy>(legacy)))
        assertFalse(CapturePolicyNotice.text(Json.decodeFromJsonElement<CapturePolicy>(legacy)).contains("OpenAI"))
    }

    @Test fun smsRegistrationCarriesTheSeenSnapshotAndCannotUpgradeAnExistingSourceImplicitly(){
        MockWebServer().use{server->
            server.start();val base=server.url("/").toString()
            val api=UploadApi(UploadSession(base,base,base,"fixture","fixture","fixture",Long.MAX_VALUE,id,id,id,id,1,1))
            val seen=Json.decodeFromJsonElement<CapturePolicy>(policy)
            for(body in listOf(policy,buildJsonObject{put("sources",buildJsonArray{})},source(policy)))server.enqueue(MockResponse().setBody(body.toString()))
            api.registerSms("a".repeat(64),1000,seen,true)
            assertEquals("/v1/capture-policy",server.takeRequest().path)
            assertEquals("/v1/capture-sources",server.takeRequest().path)
            val create=server.takeRequest();assertEquals("POST",create.method)
            assertEquals(policy,Json.parseToJsonElement(create.body.readUtf8()).jsonObject["processing_policy"])

            val changed=JsonObject(policy + ("processors" to buildJsonArray{add(JsonObject(policy.getValue("processors").jsonArray.single().jsonObject + ("storage_location" to JsonPrimitive("changed same-ID storage"))))}))
            server.enqueue(MockResponse().setBody(changed.toString()))
            try{api.registerSms("a".repeat(64),1000,seen,true);fail("A stale same-ID policy cannot register")}
            catch(error:UploadApi.Fault){assertEquals("SOURCE_EXPIRED",error.code)}
            assertEquals("GET",server.takeRequest().method);assertEquals(4,server.requestCount)

            val old=JsonObject(policy - "processors")
            server.enqueue(MockResponse().setBody(policy.toString()))
            server.enqueue(MockResponse().setBody(buildJsonObject{put("sources",buildJsonArray{add(source(old))})}.toString()))
            try{api.registerSms("a".repeat(64),1000,seen,true);fail("Existing source consent cannot gain a processor automatically")}
            catch(error:UploadApi.Fault){assertEquals("SOURCE_EXPIRED",error.code)}
            repeat(2){assertEquals("GET",server.takeRequest().method)};assertEquals(6,server.requestCount)
        }
    }
}
