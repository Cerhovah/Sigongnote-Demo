package com.sigongnote.app
import org.junit.Test
import org.junit.Assert.*
import java.nio.file.Files
import java.io.File
import kotlinx.serialization.json.*
class OutgoingDocumentTest {
 @Test fun resumesIdenticalBytesAndPreservesEdits(){
  val root=Files.createTempDirectory("synthetic-outgoing").toFile()
  val bytes="%PDF synthetic".toByteArray()
  fun payload(name:String="합성.pdf",sha:String=OutgoingDocument.hash(bytes))=buildJsonObject{put("name",name);put("sha256",sha);put("base64",java.util.Base64.getEncoder().encodeToString(bytes))}.toString()
  try{
   val file=OutgoingDocument.prepare(root,"synthetic-company:user","pdf",payload())
   assertArrayEquals(bytes,file.readBytes());assertEquals(file,OutgoingDocument.prepare(root,"synthetic-company:user","pdf",payload()))
   assertThrows(IllegalArgumentException::class.java){OutgoingDocument.prepare(root,"scope","pdf",payload("../escape.pdf"))}
   assertThrows(IllegalArgumentException::class.java){OutgoingDocument.prepare(root,"scope","pdf",payload(sha="0".repeat(64)))}
   file.writeText("user edit");assertThrows(IllegalStateException::class.java){OutgoingDocument.prepare(root,"synthetic-company:user","pdf",payload())};assertEquals("user edit",file.readText())
  }finally{root.deleteRecursively()}
 }
 @Test fun onlyKnownOutcomeAndAction(){
  val id="0f8fad5b-d9cb-469f-a165-70867728950e"
  fun route(outcome:String)=Json.parseToJsonElement("""{"route":"documents.shareOutcome","id":"$id","intent_id":"$id","client_command_id":"$id","outcome":"$outcome"}""").jsonObject
  assertNotNull(WorkRoutes.decode(route("user_confirmed")));assertNull(WorkRoutes.decode(route("provider_confirmed")))
 }
}
