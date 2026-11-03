package com.sigongnote.app
import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.*
class EvidenceWorkApiTest {
    @Test fun evidencePagesKeepBoundedOpaqueCursorsAndReadOnlyPath(){
        val id="0f8fad5b-d9cb-469f-a165-70867728950e"
        val value=WorkRoutes.decode(buildJsonObject{put("route","evidence.chunks");put("id",id);put("cursor","abc_123-")})!!
        assertEquals("v1/evidence/$id/chunks?cursor=abc_123-",WorkRoutes.path(value))
        assertNull(WorkRoutes.body(value))
        for(cursor in listOf("x".repeat(241),"../../secret",""))assertNull(WorkRoutes.decode(buildJsonObject{put("route","evidence.chunks");put("id",id);put("cursor",cursor)}))
        assertNull(WorkRoutes.decode(buildJsonObject{put("route","evidence.chunks");put("id",id);put("tenant_id","other")}))
    }
}
