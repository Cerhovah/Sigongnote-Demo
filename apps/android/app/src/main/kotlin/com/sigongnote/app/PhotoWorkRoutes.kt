package com.sigongnote.app
import com.sigongnote.contracts.WorkRequest
import kotlinx.serialization.json.*
import java.util.UUID
object PhotoWorkRoutes {
 fun decode(v:WorkRequest,p:JsonObject):WorkRequest?{
  fun uuid(s:String?)=s!=null&&runCatching{UUID.fromString(s).toString()==s}.getOrDefault(false)
  val keys=when(v.route){"deliveries.list"->setOf("route","source_kind","source_id");"deliveries.read"->setOf("route","id");"deliveries.prepare","deliveries.authorize","deliveries.cancel","sheets.share"->setOf("route","command");"sheets.prepare"->setOf("route","command");"sheets.read"->setOf("route","id");"sheets.file"->setOf("route","id","format","action");"photos.list"->setOf("route","project_id","cursor");"photos.group","photos.preview"->setOf("route","id");"photos.command"->setOf("route","command");else->return null}
  if(!keys.containsAll(p.keys)||p.values.any{it is JsonNull})return null
  if(v.route=="deliveries.list"&&(!uuid(v.source_id)||v.source_kind !in setOf("document","photo_sheet")))return null
  if(v.route=="deliveries.read"&&!uuid(v.id))return null
  if(v.route in setOf("deliveries.prepare","deliveries.authorize","deliveries.cancel","sheets.share")&&(v.command?.length?:0) !in 2..3000)return null
  if(v.route=="sheets.prepare"&&(v.command?.length?:0)>2000)return null
  if(v.route=="sheets.file"&&(v.format!="pdf"||v.action!=null&&v.action !in setOf("open","save","share")))return null
  if(v.route in setOf("photos.command","sheets.prepare")&&(v.command==null||v.command!!.length !in 2..12000))return null
  if(v.route in setOf("photos.group","photos.preview","sheets.read","sheets.file")&&!uuid(v.id))return null
  if(v.route=="photos.list"&&(!uuid(v.project_id)||v.cursor!=null&&!uuid(v.cursor)))return null
  return v
 }
 fun path(v:WorkRequest)=when(v.route){"deliveries.list"->"v1/deliveries?source_kind=${v.source_kind}&source_id=${v.source_id}";"deliveries.read"->"v1/deliveries/${v.id}";"deliveries.prepare"->"v1/deliveries/prepare";"deliveries.authorize"->"v1/deliveries/authorize";"deliveries.cancel"->"v1/deliveries/cancel";"sheets.share"->"v1/photo-sheets/share";"sheets.prepare"->"v1/photo-sheets";"sheets.read"->"v1/photo-sheets/${v.id}";"sheets.file"->"v1/photo-sheets/${v.id}/file";"photos.list"->"v1/photos?project_id=${v.project_id}"+(v.cursor?.let{"&cursor=$it"}?:"");"photos.group"->"v1/photos/groups/${v.id}";"photos.preview"->"v1/photos/${v.id}/preview";"photos.command"->"v1/photos/groups";else->error("INVALID_WORK_ROUTE")}
}
