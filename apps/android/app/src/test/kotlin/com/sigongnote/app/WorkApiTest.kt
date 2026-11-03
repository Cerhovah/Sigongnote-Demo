package com.sigongnote.app
import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
class WorkApiTest {
 @Test fun currentEventsLearningAndDraftRoutesReachTheActualHttpAdapterWithoutDroppingFields(){
  val id="0f8fad5b-d9cb-469f-a165-70867728950e"
  val requests=listOf(
   """{"route":"events.list","project_id":"$id","limit":100}""" to "/v1/work/events?project_id=$id&limit=100",
   """{"route":"events.read","id":"$id"}""" to "/v1/work/events/$id",
   """{"route":"context-learning.list"}""" to "/v1/context-learning",
   """{"route":"context-learning.command","command":"{\"action\":\"procedure.evaluate\",\"id\":\"$id\",\"version\":1,\"command_id\":\"$id\"}"}""" to "/v1/context-learning/commands",
   """{"route":"documents.prepare","project_id":"$id","type":"estimate","client_command_id":"$id"}""" to "/v1/document-drafts",
   """{"route":"documents.complete","id":"$id","client_command_id":"$id","lines":"[{\"id\":\"$id\",\"quantity\":\"12\",\"unit_price\":\"12500\"}]"}""" to "/v1/document-drafts/$id/complete")
  MockWebServer().use{server->server.start();val base=server.url("/").toString()
   val vault=object:UploadCredentialStore{var raw:String?=UploadSession(base,base,base,"fixture-public","fixture-access","fixture-refresh",Long.MAX_VALUE,id,id,id,id,1,1).encode();override fun read()=raw;override fun store(value:String){raw=value};override fun clear(){raw=null};override fun clearSession(){raw=null}}
   val api=WorkApi(vault,true)
   for((raw,path) in requests){
    val payload=Json.parseToJsonElement(raw).jsonObject;val route=requireNotNull(WorkRoutes.decode(payload))
    val envelope=buildJsonObject{put("bridgeVersion",1);put("requestId",id);put("method","workRequest");put("payload",payload)}.toString()
    assertNotNull(route.route,BridgePolicy.decode(BridgePolicy.trustedOrigin,true,envelope))
    server.enqueue(MockResponse().setBody("{\"ok\":true}"));api.request(payload)
    val sent=server.takeRequest();assertEquals(path,sent.path);assertEquals("Bearer fixture-access",sent.getHeader("Authorization"));assertEquals(id,sent.getHeader("X-Tenant-ID"))
    val body=WorkRoutes.body(route);assertEquals(if(route.route in setOf("events.list","events.read","context-learning.list"))"GET" else "POST",sent.method)
    if(body!=null){val actual=Json.parseToJsonElement(sent.body.readUtf8()).jsonObject;assertEquals(Json.parseToJsonElement(body),actual);if(route.route=="documents.complete")assertEquals(payload["lines"],actual["lines"]);if(route.route=="context-learning.command")assertEquals(id,actual.getValue("command_id").jsonPrimitive.content)}
   }
  }
  for(raw in listOf("""{"route":"events.list","limit":101}""","""{"route":"events.read","id":"invalid"}""","""{"route":"events.list","project_id":"invalid"}""","""{"route":"context-learning.list","tenant_id":"$id"}""","""{"route":"context-learning.command","command":"x"}""","""{"route":"documents.prepare","project_id":"$id","client_command_id":"$id","type":"invoice"}"""))assertNull(decode(raw))
 }
 @Test fun companyAiConsentCarriesTheSeenFullPolicyOnTheFixedNativeRoute(){
  val id="0f8fad5b-d9cb-469f-a165-70867728950e"
  val policy="""{"id":"anthropic-work-records-v1","purpose":"work_records","provider":"anthropic","processing_location":"US","storage_location":"KR","retention":"until_user_deletes","external_processing":true,"processors":[{"purpose":"long_stt","provider":"openai","processing_location":"US transcription","storage_location":"provider transient","retention":"delete after transcription"}]}"""
  val raw="""{"route":"ai.consent","allowed":true,"expected_version":0,"client_command_id":"$id","processing_policy":$policy}"""
  val request=requireNotNull(decode(raw));assertEquals("v1/local-journal/ai-consent",WorkRoutes.path(request))
  val body=Json.parseToJsonElement(requireNotNull(WorkRoutes.body(request))).jsonObject
  assertEquals(Json.parseToJsonElement(policy),body["processing_policy"])
  assertEquals(0,body.getValue("expected_version").jsonPrimitive.int)
  for(invalid in listOf(raw.replace("\"expected_version\":0","\"expected_version\":-1"),raw.replace(id,"invalid"),raw.replace("\"long_stt\"","\"sms\""),raw.replace("\"external_processing\":true","\"external_processing\":false"),raw.dropLast(1)+",\"tenant_id\":\"$id\"}"))assertNull(decode(invalid))
  assertNotNull(decode("""{"route":"ai.consent","allowed":false,"expected_version":1,"client_command_id":"$id"}"""))
 }
 @Test fun businessFormPassesThroughTheRealNativeRoute(){
  val id=java.util.UUID.randomUUID().toString()
  val raw=Json.parseToJsonElement("""{"route":"documents.complete","id":"$id","client_command_id":"$id","form":{"issuer":{"name":"합성업체","business_number":"000-00-00000"},"note":"가상시험"}}""").jsonObject
  val request=requireNotNull(WorkRoutes.decode(raw))
  val body=Json.parseToJsonElement(requireNotNull(WorkRoutes.body(request))).jsonObject
  assertEquals(raw["form"],body["form"]);assertEquals("v1/document-drafts/$id/complete",WorkRoutes.path(request))
 }

    @Test fun journalRoutesKeepDateAndProjectScope(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        val r=decode("""{"route":"journal.list","project_id":"$id","q":"2026-10-05","cursor":"$id","category":"agreement"}""")!!
        assertTrue(WorkRoutes.path(r).startsWith("v1/work/journal?"));assertTrue(WorkRoutes.path(r).contains("q=2026-10-05"));assertNull(WorkRoutes.body(r))
        assertNull(decode("""{"route":"journal.list","project_id":"other"}"""))
    }

    @Test fun ledgerRoutesKeepProjectCategoryAndHistoryCursorBounded(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        for(raw in listOf("""{"route":"ledger.list","project_id":"$id","category":"delivery_work","cursor":"YWJj"}""","""{"route":"ledger.read","id":"$id","cursor":"$id"}""","""{"route":"agenda.read"}""")){val r=decode(raw)!!;assertTrue(WorkRoutes.path(r).startsWith("v1/work/"));assertNull(WorkRoutes.body(r))}
        for(raw in listOf("""{"route":"ledger.list","cursor":"a&tenant_id=other"}""","""{"route":"ledger.list","project_id":"other"}""","""{"route":"ledger.list","category":"paid"}""","""{"route":"ledger.read","id":"$id","cursor":"../other"}"""))assertNull(decode(raw))
    }
    @Test fun continuationOnlyAcceptsRunIdentity(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        val request=decode("""{"route":"agent.continue","id":"$id"}""")!!
        assertEquals("v1/agent/runs/$id/continue",WorkRoutes.path(request));assertEquals("{}",WorkRoutes.body(request))
        assertNull(decode("""{"route":"agent.continue","id":"../other"}"""))
        assertNull(decode("""{"route":"agent.continue","id":"$id","command":"{}"}"""))
    }
    @Test fun improvementRoutesRemainBounded(){
        assertEquals("v1/improvements",WorkRoutes.path(decode("""{"route":"improvements.list"}""")!!))
        val r=decode("""{"route":"improvements.command","command":"{}"}""")!!
        assertEquals("v1/improvements/commands",WorkRoutes.path(r));assertEquals("{}",WorkRoutes.body(r))
        assertNull(decode("""{"route":"improvements.command","command":${JsonPrimitive("x".repeat(4001))}}"""))
    }
    @Test fun learningRoutesKeepPurposeWritesAndIdentifiersBounded(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        for((payload,path) in listOf("""{"route":"learning.list","cursor":"$id"}""" to "v1/learning?cursor=$id","""{"route":"learning.read","id":"$id"}""" to "v1/learning/$id","""{"route":"learning.command","command":"{}"}""" to "v1/learning/commands")){
            val r=decode(payload)!!;assertEquals(path,WorkRoutes.path(r));assertEquals(if(r.route=="learning.command")"{}" else null,WorkRoutes.body(r))
        }
        assertNull(decode("""{"route":"learning.read","id":"../other"}"""))
        assertNull(decode("""{"route":"learning.list","tenant_id":"other"}"""))
        assertNull(decode("""{"route":"learning.command","command":${JsonPrimitive("x".repeat(4001))}}"""))
    }
    @Test fun revisionFeedIsVersionedAndKeepsNativeBridgeBounded(){
        val request=WorkRoutes.decode(buildJsonObject{put("route","sync.changes");put("sync_version",2)})!!
        assertEquals("v1/sync/changes?sync_version=2",WorkRoutes.path(request))
        assertNull(WorkRoutes.decode(buildJsonObject{put("route","sync.changes");put("sync_version",3)}))
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        assertEquals("v1/sync/changes?kind=photo_sheet&id=$id",WorkRoutes.path(WorkRoutes.decode(buildJsonObject{put("route","sync.item");put("id",id);put("target_kind","photo_sheet")})!!))
    }
    @Test fun captureStatusAndPdfResumeStayBounded(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        val request=WorkRoutes.decode(buildJsonObject{put("route","evidence.resume");put("id",id);put("command","{}")})!!
        assertEquals("v1/evidence/$id/resume",WorkRoutes.path(request));assertEquals("{}",WorkRoutes.body(request))
        assertEquals("v1/capture-status",WorkRoutes.path(WorkRoutes.decode(buildJsonObject{put("route","capture.status")})!!))
        assertNull(WorkRoutes.decode(buildJsonObject{put("route","evidence.resume");put("id",id);put("command","x".repeat(1001))}))
    }
    @org.junit.Test fun partialOrderQuantitiesReachServer(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        val payload=kotlinx.serialization.json.Json.parseToJsonElement("""{"route":"documents.complete","id":"$id","client_command_id":"$id","quantities":"[]"}""") as kotlinx.serialization.json.JsonObject
        val request=WorkRoutes.decode(payload)!!
        org.junit.Assert.assertTrue(WorkRoutes.body(request)!!.contains("quantities"))
    }

    @Test fun activityRoutesRejectAuthorityAndOversizedBatches(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        val batch=buildJsonObject{put("route","activity.append");put("command","가".repeat(20000))}
        val bridge=buildJsonObject{put("bridgeVersion",1);put("requestId",id);put("method","workRequest");put("payload",batch)}.toString()
        assertNotNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,true,bridge))
        assertNull(BridgePolicy.decode("https://foreign.example",true,bridge))
        val consent=decode("""{"route":"activity.consent","allowed":true}""")!!
        assertEquals("v1/work/activity/consent",WorkRoutes.path(consent))
        assertEquals("{}",WorkRoutes.body(decode("""{"route":"activity.append","command":"{}"}""")!!))
        assertNull(decode("""{"route":"activity.append","command":${JsonPrimitive("x".repeat(120001))}}"""))
        assertNull(decode("""{"route":"activity.list","tenant_id":"other"}"""))
    }

    @Test fun materialSiteScopeReachesTheServer(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        val raw="""{"route":"materials.list","project_id":"$id","category":"agreement"}"""
        assertTrue(WorkRoutes.path(decode(raw)!!).contains("&project_id=$id"))
        assertNull(decode(raw.replace(id,"invalid")))
    }
    @Test fun voiceBridgeAllowsOnlyBoundedAudioAndKnownCommands(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        val audio="A".repeat(20000)
        val payload="""{"route":"voice.transcribe","id":"$id","mime":"audio/webm","audio":"$audio","consent_version":"short-voice-v1"}"""
        assertEquals("v1/voice/transcribe",WorkRoutes.path(decode(payload)!!))
        val raw="""{"bridgeVersion":1,"requestId":"$id","method":"workRequest","payload":$payload}"""
        assertNotNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,true,raw))
        assertNull(BridgePolicy.decode("https://other.test",true,raw))
        assertNull(decode(payload.replace("audio/webm","text/plain")))
        assertNull(decode(payload.replace("short-voice-v1","unknown")))
        assertNotNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,true,"""{"bridgeVersion":1,"requestId":"$id","method":"cancelVoiceInput","payload":{"voice_request_id":"$id"}}"""))
    }
    @Test fun documentIssueAndReplacementKeepHashAmountAndCommand(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e";val hash="a".repeat(64)
        val raw="""{"route":"documents.issue","id":"$id","client_command_id":"$id","basis_hash":"$hash","recipient_confirmation":"합성업체","amount_minor":"550000","replacement_id":"$id","expected_hash":"$hash"}"""
        val request=decode(raw)!!;assertEquals("v1/documents/$id/cancel",WorkRoutes.path(request))
        val body=Json.parseToJsonElement(WorkRoutes.body(request)!!).jsonObject
        assertEquals("550000",body["replacement"]!!.jsonObject["drafts"]!!.jsonArray[0].jsonObject["amount_minor"]!!.jsonPrimitive.content)
        assertNull(decode(raw.replace("550000","-1")));assertNull(decode(raw.replace("550000","1234567890123456")))
    }
    private fun decode(raw:String)=WorkRoutes.decode(Json.parseToJsonElement(raw).jsonObject)
    @Test fun onlyTypedReadRoutesCanUseTheNativeSession(){
        assertEquals("v1/work/context",WorkRoutes.path(decode("""{"route":"context"}""")!!))
        assertNull(decode("""{"route":"materials.list","url":"https://evil.example"}"""))
        assertNull(decode("""{"route":"materials.detail","id":"../../auth"}"""))
        assertNull(decode("""{"route":"context","tenant_id":"other"}"""))
        assertNull(decode("""{"route":"materials.list","q":${JsonPrimitive("가".repeat(81))}}"""))
        val raw="""{"bridgeVersion":1,"requestId":"0f8fad5b-d9cb-469f-a165-70867728950e","method":"workRequest","payload":{"route":"materials.list","q":"석고"}}"""
        assertNotNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,true,raw))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,false,raw))
        assertNull(BridgePolicy.decode("https://evil.example",true,raw))
    }
    @Test fun conversationAndGuideUseBoundedTypedWrites(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        val turn=decode("""{"route":"conversation.turn","id":"$id","client_turn_id":"$id","text":"납품 찾아줘"}""")!!
        assertEquals("v1/conversations/$id/turns",WorkRoutes.path(turn))
        assertEquals("납품 찾아줘",Json.parseToJsonElement(WorkRoutes.body(turn)!!).jsonObject["text"]!!.jsonPrimitive.content)
        assertNull(decode("""{"route":"guide.save","step":3,"completed":true}"""))
        assertNull(decode("""{"route":"organization.answer","id":"$id","project_id":"$id","version":0}"""))
        assertNull(decode("""{"route":"materials.list","category":"other"}"""))
        assertNotNull(decode("""{"route":"materials.original","id":"$id"}"""))
    }
    @Test fun agentResumeCancelAreFixedRoutes(){
        val id="11111111-1111-4111-8111-111111111111"
        for(route in listOf("agent.read","agent.cancel")){
            val r=decode("""{"route":"$route","id":"$id"}""")!!
            assertEquals("v1/agent/runs/$id"+(if(route=="agent.cancel")"/cancel" else ""),WorkRoutes.path(r))
            assertEquals(if(route=="agent.cancel")"{}" else null,WorkRoutes.body(r))
        }
    }
    @Test fun ownerMemoryAndAnswersStayOnFixedNativeRoutes(){
        for((route,path) in listOf("journal.command" to "v1/work/journal/commands","agent.start" to "v1/agent/runs","audio.correct" to "v1/work/audio/corrections","work.reply" to "v1/work/replies","policies.command" to "v1/owner-policies/commands")){
            val r=decode("""{"route":"$route","command":"{}"}""")!!;assertEquals(path,WorkRoutes.path(r));assertEquals("{}",WorkRoutes.body(r))
            assertNull(decode("""{"route":"$route","command":${JsonPrimitive("x".repeat(16001))}}"""))
            assertNull(decode("""{"route":"$route","command":"{}","tenant_id":"other"}"""))
        }
    }
}
