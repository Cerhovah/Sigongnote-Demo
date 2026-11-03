package com.sigongnote.app

import org.junit.Assert.*
import org.junit.Test

class BridgePolicyTest {
    private val id = "0f8fad5b-d9cb-469f-a165-70867728950e"
    private val sourceId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"

    private fun command(method: String, payload: String = "{}") =
        """{"bridgeVersion":1,"requestId":"$id","method":"$method","payload":$payload}"""

    @Test fun trustedMainFrameOnly() {
        val valid = command("getConnectionState")
        assertNotNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true, valid))
        assertNull(BridgePolicy.decode("https://evil.example", true, valid))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, false, valid))
        assertNull(BridgePolicy.decode("https://appassets.androidplatform.net.evil.example", true, valid))
    }

    @Test fun strictAllowlistAndPayload() {
        assertNotNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true, command("openPhotoCapture")))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true, command("openPhotoCapture", """{"path":"private"}""")))
        assertNotNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true, command("openSmsInbox")))
        assertNull(BridgePolicy.decode("https://evil.example", true, command("openSmsInbox")))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, false, command("openSmsInbox")))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true, command("openSmsInbox", """{"recipient":"private"}""")))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true, command("eval")))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true,
            command("getConnectionState", """{"token":"leak"}""")))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true,
            command("pauseSource", """{"source_id":"bad"}""")))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true,
            command("pauseSource", """{"source_id":"${sourceId.uppercase()}"}""")))
        assertEquals(sourceId, BridgePolicy.decode(BridgePolicy.trustedOrigin, true,
            command("pauseSource", """{"source_id":"$sourceId"}"""))?.argument)
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true,
            command("connectSource", """{"kind":"contacts"}""")))
    }

    @Test fun rejectsMalformedAndOversized() {
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true, "{") )
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true,
            command("getConnectionState") + " ".repeat(16_385)))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true,
            """{"bridgeVersion":1,"requestId":"$id","method":"logout","payload":{},"secret":1}"""))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin, true,
            """{"bridgeVersion":"1","requestId":"$id","method":"logout","payload":{}}"""))
    }
    @Test fun currentDocumentAndLearningBoundsSurviveWorstCaseJsonEscapingWithoutWideningOtherRoutes(){
        fun envelope(route:String,lines:String?=null,quantities:String?=null,command:String?=null,form:kotlinx.serialization.json.JsonObject?=null,recipient:String?=null)=kotlinx.serialization.json.buildJsonObject{
            put("bridgeVersion",kotlinx.serialization.json.JsonPrimitive(1));put("requestId",kotlinx.serialization.json.JsonPrimitive(id));put("method",kotlinx.serialization.json.JsonPrimitive("workRequest"))
            put("payload",kotlinx.serialization.json.buildJsonObject{put("route",kotlinx.serialization.json.JsonPrimitive(route));if(route=="documents.complete"){put("id",kotlinx.serialization.json.JsonPrimitive(id));put("client_command_id",kotlinx.serialization.json.JsonPrimitive(id))};lines?.let{put("lines",kotlinx.serialization.json.JsonPrimitive(it))};quantities?.let{put("quantities",kotlinx.serialization.json.JsonPrimitive(it))};command?.let{put("command",kotlinx.serialization.json.JsonPrimitive(it))};form?.let{put("form",it)};recipient?.let{put("recipient",kotlinx.serialization.json.JsonPrimitive(it))}})
        }.toString()
        val fullForm=kotlinx.serialization.json.buildJsonObject{
            for(party in listOf("issuer","recipient"))put(party,kotlinx.serialization.json.buildJsonObject{
                put("business_number",kotlinx.serialization.json.JsonPrimitive("000-00-00000"));if(party=="issuer")put("name",kotlinx.serialization.json.JsonPrimitive("\u0001".repeat(180)))
                for((field,size) in mapOf("representative" to 60,"address" to 180,"business_type" to 60,"business_item" to 60,"contact" to 100))put(field,kotlinx.serialization.json.JsonPrimitive("\u0001".repeat(size)))
            })
            for(field in listOf("valid_until","delivery_date"))put(field,kotlinx.serialization.json.JsonPrimitive("2026-10-21"))
            for((field,size) in mapOf("delivery_place" to 180,"payment_terms" to 180,"payment_account" to 180,"note" to 300))put(field,kotlinx.serialization.json.JsonPrimitive("\u0001".repeat(size)))
        }
        val large=envelope("documents.complete",lines="\u0001".repeat(64000),quantities="\u0001".repeat(16000),form=fullForm,recipient="\u0001".repeat(120))
        assertTrue(large.toByteArray().size in 492000..500000);assertNotNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,true,large))
        assertNull(BridgePolicy.decode("https://untrusted.invalid",true,large));assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,false,large))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,true,envelope("documents.complete",lines="x".repeat(64001))))
        val learning=envelope("context-learning.command",command="\u0001".repeat(16000))
        assertTrue(learning.toByteArray().size in 96000..100000);assertNotNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,true,learning))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,true,envelope("context-learning.command",command="x".repeat(16001))))
        assertNull(BridgePolicy.decode(BridgePolicy.trustedOrigin,true,envelope("journal.command",command="\u0001".repeat(16000))))
    }
}
