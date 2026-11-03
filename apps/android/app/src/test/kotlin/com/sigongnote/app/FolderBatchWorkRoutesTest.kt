package com.sigongnote.app

import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class FolderBatchWorkRoutesTest {
    @Test fun oneBatchCommandPassesThroughTheNativeWorkBridgeWithoutExtraFields() {
        val command="{\"client_command_id\":\"11111111-1111-4111-8111-111111111111\",\"changes\":[]}"
        val route=WorkRoutes.decode(buildJsonObject{put("route","folders.correct");put("command",command)})!!
        assertEquals("v1/site-folder-bindings/batch",WorkRoutes.path(route));assertEquals(command,WorkRoutes.body(route))
        val read=WorkRoutes.decode(buildJsonObject{put("route","folders.read")})!!
        assertEquals("v1/site-folder-bindings",WorkRoutes.path(read));assertNull(WorkRoutes.body(read))
        assertNull(WorkRoutes.decode(buildJsonObject{put("route","folders.read");put("raw_path","forbidden")}))
    }
    @Test fun unassignedChildBindingKeepsItsScopeAndNeverSendsLocalParentOrProviderId() {
        val id="11111111-1111-4111-8111-111111111111"
        val protected=FolderCaptureHandle("content://synthetic.provider/tree/private-parent","private-child","unassigned","private-parent").encode()
        val source=FolderSource(id,"sealed-handle",2,"selected",0,null,null,0,0,0,0,null,null,null,1,
            id,id,id,"folder","all",null,"work_dedicated","a".repeat(64),true,"policy","{}",null,null,"pending")
        val binding=buildJsonObject{put("id",id);put("source_id",id);put("source_generation",1);put("scope_fingerprint","a".repeat(64));put("scope_mode","unassigned");put("project_id",JsonNull)}
        MockWebServer().use{server->
            server.start();val base=server.url("/").toString()
            val api=UploadApi(UploadSession(base,base,base,"fixture","fixture","fixture",Long.MAX_VALUE,id,id,id,id,1,1),OkHttpClient()){protected}
            server.enqueue(MockResponse().setBody(binding.toString()))
            server.enqueue(MockResponse().setBody(buildJsonObject{put("bindings",buildJsonArray{add(binding)})}.toString()))
            api.bindFolderProject(source,UploadApi.ReadySource(id,1))
            val post=server.takeRequest();val text=post.body.readUtf8()
            assertEquals("unassigned",Json.parseToJsonElement(text).jsonObject.getValue("scope_mode").jsonPrimitive.content)
            assertFalse(text.contains("private-parent"));assertFalse(text.contains("private-child"));assertFalse(text.contains("sealed-handle"))
            assertEquals(FolderSourcePolicy.requestKey(id,"binding"),post.getHeader("Idempotency-Key"))
            assertEquals("/v1/site-folder-bindings",server.takeRequest().path)
        }
    }
}
