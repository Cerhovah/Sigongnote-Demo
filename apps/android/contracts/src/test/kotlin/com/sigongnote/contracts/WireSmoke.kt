package com.sigongnote.contracts
import java.io.File
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

fun main(args: Array<String>) {
 for (fixture in Json.parseToJsonElement(File(args.single()).readText()).jsonArray) {
  val name = fixture.jsonObject.getValue("name").jsonPrimitive.content
  val value = fixture.jsonObject.getValue("value").toString()
  val output = when(name) {
   "WorkRequest" -> Json.encodeToString(Json.decodeFromString<WorkRequest>(value))
   "CaptureStorageUsage" -> Json.encodeToString(Json.decodeFromString<CaptureStorageUsage>(value))
   "WorkspaceCreateRequest" -> Json.encodeToString(Json.decodeFromString<WorkspaceCreateRequest>(value))
   "WorkspaceResponse" -> Json.encodeToString(Json.decodeFromString<WorkspaceResponse>(value))
   "CaptureScope" -> Json.encodeToString(Json.decodeFromString<CaptureScope>(value))
   "Money" -> Json.encodeToString(Json.decodeFromString<Money>(value))
   "Quantity" -> Json.encodeToString(Json.decodeFromString<Quantity>(value))
   "SourceDate" -> Json.encodeToString(Json.decodeFromString<SourceDate>(value))
   "ApiError" -> Json.encodeToString(Json.decodeFromString<ApiError>(value))
   "BridgeRequest" -> Json.encodeToString(Json.decodeFromString<BridgeRequest>(value))
   "ProjectCreateRequest" -> Json.encodeToString(Json.decodeFromString<ProjectCreateRequest>(value))
   "SiteFolderBindingRequest" -> Json.encodeToString(Json.decodeFromString<SiteFolderBindingRequest>(value))
   "SiteFolderBindingResponse" -> Json.encodeToString(Json.decodeFromString<SiteFolderBindingResponse>(value))
   else -> error("Unknown fixture type")
  }
  println(JsonObject(mapOf("name" to JsonPrimitive(name), "value" to Json.parseToJsonElement(output))))
 }
}
