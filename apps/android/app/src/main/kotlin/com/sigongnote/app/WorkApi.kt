package com.sigongnote.app

import com.sigongnote.contracts.WorkRequest
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

object WorkRoutes {
    fun decode(payload:JsonObject):WorkRequest? { return try {
        val value=Json.decodeFromString<WorkRequest>(payload.toString())
        if(value.route in setOf("events.list","events.read","context-learning.list","context-learning.command","documents.prepare")){
            fun uuid(s:String?)=s!=null&&runCatching{UUID.fromString(s).toString()==s}.getOrDefault(false)
            val keys=when(value.route){"events.list"->setOf("route","project_id","limit");"events.read"->setOf("route","id");"context-learning.list"->setOf("route");"context-learning.command"->setOf("route","command");else->setOf("route","project_id","type","client_command_id")}
            if(!keys.containsAll(payload.keys)||payload.values.any{it is JsonNull})return null
            if(value.route=="events.list"&&(value.project_id?.let{!uuid(it)}==true||value.limit?.let{it !in 1..100}==true))return null
            if(value.route=="events.read"&&!uuid(value.id))return null
            if(value.route=="context-learning.command"&&(value.command?.length?:0) !in 2..16000)return null
            if(value.route=="documents.prepare"&&(!uuid(value.project_id)||!uuid(value.client_command_id)||value.type!="estimate"))return null
            return value
        }
        if(value.route=="ai.consent"){
            val expected=value.expected_version?:return null
            if(!setOf("route","allowed","expected_version","client_command_id","processing_policy").containsAll(payload.keys)||payload.values.any{it is JsonNull}||value.allowed==null||expected !in 0L..9007199254740991L||runCatching{UUID.fromString(value.client_command_id).toString()==value.client_command_id}.getOrDefault(false).not())return null
            if(payload["processing_policy"]?.let{!CapturePolicyNotice.validSnapshot(it)}==true)return null
            return value
        }
        if((value.route.startsWith("photos.")||value.route.startsWith("sheets.")||value.route.startsWith("deliveries.")))return PhotoWorkRoutes.decode(value,payload)
        val keys=when(value.route){"archive.status","journal.tasks","setup.read"->setOf("route");"archive.command","journal.command","setup.command","setup.capture"->setOf("route","command");"agenda.read"->setOf("route");"ledger.read"->setOf("route","id","cursor");"ledger.list"->setOf("route","project_id","category","cursor");"improvements.list"->setOf("route");"improvements.command"->setOf("route","command");"learning.list"->setOf("route","cursor");"learning.read"->setOf("route","id");"learning.command"->setOf("route","command");"agent.start"->setOf("route","command");"agent.read","agent.cancel","agent.continue"->setOf("route","id");"capture.status"->setOf("route");"evidence.resume"->setOf("route","id","command");"folders.read"->setOf("route");"folders.correct"->setOf("route","command");"evidence.chunks"->setOf("route","id","cursor");"activity.delete"->setOf("route");"activity.status"->setOf("route");"activity.consent"->setOf("route","allowed");"activity.append"->setOf("route","command");"activity.list"->setOf("route","cursor","q");"maintenance.status"->setOf("route");"policies.list"->setOf("route");"audio.correct","policies.command","work.reply"->setOf("route","command");"questions.list"->setOf("route");"work.command"->setOf("route","command");"sync.item"->setOf("route","id","target_kind");"sync.changes"->setOf("route","cursor","sync_version");"documents.share"->setOf("route","id","format","client_command_id");"documents.shareOutcome"->setOf("route","id","intent_id","client_command_id","outcome");"documents.list"->setOf("route");"documents.issued"->setOf("route","id");"documents.file"->setOf("route","id","format","action");"documents.retry"->setOf("route","id","client_command_id");"documents.cancel"->setOf("route","id","client_command_id","expected_hash");"documents.issue"->setOf("route","id","client_command_id","basis_hash","recipient_confirmation","amount_minor","replacement_id","expected_hash");"documents.complete"->setOf("route","id","client_command_id","recipient","margin_bps","tax_mode","tax_bps","quantities","lines","form");"voice.status"->setOf("route");"voice.consent"->setOf("route","allowed","consent_version");"voice.result","voice.cancel"->setOf("route","id");"voice.transcribe"->setOf("route","id","mime","audio","consent_version");"context"->setOf("route");"journal.list","materials.list"->setOf("route","q","cursor","category","project_id");"documents.read","materials.detail","materials.message","materials.original","conversation.read"->setOf("route","id");"conversation.turn"->setOf("route","id","client_turn_id","text","selected_project_id","input_kind");"organization.answer"->setOf("route","id","project_id","version");"guide.read"->setOf("route");"guide.save"->setOf("route","step","completed");else->return null}
        if(!keys.containsAll(payload.keys) || payload.values.any {it is JsonNull} || (value.q?.length ?: 0) > 80) return null
        if(value.route in setOf("archive.command","journal.command","setup.command","setup.capture","evidence.resume","agent.start","work.command","audio.correct","work.reply","policies.command","folders.correct")&&(value.command==null||value.command!!.length !in 2..(if(value.route=="folders.correct")64000 else if(value.route=="evidence.resume")1000 else 16000)))return null
        if(value.route=="activity.append"&&(value.command==null||value.command!!.length !in 2..120000)||value.route=="activity.consent"&&value.allowed==null)return null
        if(value.route in setOf("learning.command","improvements.command")&&(value.command==null||value.command!!.length !in 2..4000))return null
        fun uuid(s:String)=runCatching {UUID.fromString(s).toString()==s}.getOrDefault(false)
        if(value.route in setOf("ledger.read","learning.read","evidence.resume","agent.read","agent.cancel","agent.continue","evidence.chunks","documents.share","documents.shareOutcome","documents.issue","documents.issued","documents.file","documents.retry","documents.cancel","documents.complete","documents.read","voice.transcribe","voice.result","voice.cancel","materials.detail","materials.message","materials.original","conversation.read","conversation.turn","organization.answer") && value.id?.let(::uuid)!=true)return null
        if(value.route!="ledger.list"&&value.route!="sync.changes"&&value.route!="evidence.chunks"&&value.cursor?.let { !uuid(it) }==true)return null
        if(value.route in setOf("journal.list","materials.list","ledger.list")&&value.project_id?.let{!uuid(it)}==true)return null
        if(value.route=="ledger.list"&&value.cursor?.let{!Regex("^[A-Za-z0-9_-]{1,200}$").matches(it)}==true)return null
        if(value.category!=null&&value.category !in setOf("agreement","drawing_material","delivery_work","billing_payment","inspection_defect"))return null
        if(value.route=="conversation.turn"&&(value.input_kind?.let{it !in setOf("text","voice")}==true||value.client_turn_id?.let(::uuid)!=true||value.text?.trim().isNullOrEmpty()||(value.text?.length?:0)>2000||value.selected_project_id?.let{!uuid(it)}==true))return null
        if(value.route=="organization.answer"&&(value.project_id?.let(::uuid)!=true||(value.version?:0)<1))return null
        if(value.route=="guide.save"&&(value.step !in 0..2||value.completed==null))return null
        if(value.route in setOf("voice.consent","voice.transcribe")&&value.consent_version!="short-voice-v1")return null
        if(value.route=="voice.consent"&&value.allowed==null)return null
        val audio=value.audio
        if(value.route=="voice.transcribe"&&(value.mime !in setOf("audio/webm","audio/ogg","audio/wav")||audio==null||audio.length !in 24..1048576||!Regex("[A-Za-z0-9+/]+={0,2}").matches(audio)))return null
        if(value.route=="documents.complete"&&(value.quantities?.let{it.length !in 2..16000}==true||value.lines?.let{it.length !in 2..64000}==true||value.client_command_id?.let(::uuid)!=true||value.recipient?.let{it.isBlank()||it.length>120}==true||value.margin_bps?.let{it !in 0..9999}==true||value.tax_bps?.let{it !in 0..10000}==true||value.tax_mode?.let{it !in setOf("exclusive","inclusive","not_applicable")}==true))return null
        fun hash(v:String?)=v?.let{Regex("[a-f0-9]{64}").matches(it)}==true
        if(value.route in setOf("documents.issue","documents.retry","documents.cancel")&&value.client_command_id?.let(::uuid)!=true)return null
        if(value.route=="documents.file"&&value.format !in setOf("pdf","xlsx"))return null
        if(value.route=="documents.cancel"&&!hash(value.expected_hash))return null
        if(value.route=="documents.issue"&&(!hash(value.basis_hash)||value.recipient_confirmation.isNullOrBlank()||(value.recipient_confirmation?.length?:0)>120||value.amount_minor?.let{!Regex("[1-9][0-9]{0,14}").matches(it)}==true||value.replacement_id?.let{!uuid(it)||!hash(value.expected_hash)}==true))return null
        if(value.route in setOf("documents.share","documents.shareOutcome")&&value.client_command_id?.let(::uuid)!=true)return null
        if(value.route=="documents.share"&&value.format !in setOf("pdf","xlsx"))return null
        if(value.route=="documents.shareOutcome"&&(value.intent_id?.let(::uuid)!=true||value.outcome !in setOf("cancelled","unknown","user_confirmed")))return null
        if(value.action!=null&&value.action !in setOf("open","save","share"))return null
        if(value.route=="evidence.chunks"&&value.cursor?.let{!Regex("[A-Za-z0-9_-]{1,240}").matches(it)}==true)return null
        if(value.route=="sync.changes"&&value.sync_version !in setOf(null,2))return null
        if(value.route=="sync.changes"&&value.cursor?.let{!Regex("[a-f0-9-]{36}:[a-f0-9-]{36}:[0-9]{1,19}").matches(it)}==true)return null
        if(value.route=="sync.item"&&(value.id?.let(::uuid)!=true||value.target_kind !in setOf("material","document","photo_sheet")))return null
        value
    }catch(_:Exception){null}
    }
    fun path(value:WorkRequest):String {
        require(decode(Json.parseToJsonElement(Json.encodeToString(value)).jsonObject)!=null)
        when(value.route){
            "events.list"->return "v1/work/events?"+listOfNotNull(value.project_id?.let{"project_id=$it"},value.limit?.let{"limit=$it"}).joinToString("&")
            "events.read"->return "v1/work/events/${value.id}"
            "context-learning.list"->return "v1/context-learning"
            "context-learning.command"->return "v1/context-learning/commands"
            "documents.prepare"->return "v1/document-drafts"
        }
        if(value.route=="ai.consent")return "v1/local-journal/ai-consent"
        if((value.route.startsWith("photos.")||value.route.startsWith("sheets.")||value.route.startsWith("deliveries.")))return PhotoWorkRoutes.path(value)
        return when(value.route){"archive.status","archive.command"->"v1/work/archive";"setup.read","setup.command"->"v1/work/setup";"setup.capture"->"v1/work/setup/capture";"journal.tasks"->"v1/work/journal/tasks";"journal.command"->"v1/work/journal/commands";"journal.list"->"v1/work/journal?"+(value.q?.let{"q=${URLEncoder.encode(it,"UTF-8")}&"}?:"")+(value.cursor?.let{"cursor=$it&"}?:"")+(value.category?.let{"category=$it&"}?:"")+(value.project_id?.let{"project_id=$it"}?:"");"agenda.read"->"v1/work/agenda";"ledger.read"->"v1/work/ledger/${value.id}"+(value.cursor?.let{"?cursor=$it"}?:"");"ledger.list"->"v1/work/ledger?"+(value.project_id?.let{"project_id=$it&"}?:"")+(value.category?.let{"category=$it&"}?:"")+(value.cursor?.let{"cursor=$it"}?:"");"improvements.list"->"v1/improvements";"improvements.command"->"v1/improvements/commands";"learning.list"->"v1/learning"+(value.cursor?.let{"?cursor=$it"}?:"");"learning.read"->"v1/learning/${value.id}";"learning.command"->"v1/learning/commands";"agent.start"->"v1/agent/runs";"agent.read"->"v1/agent/runs/${value.id}";"agent.cancel"->"v1/agent/runs/${value.id}/cancel";"agent.continue"->"v1/agent/runs/${value.id}/continue";"capture.status"->"v1/capture-status";"evidence.resume"->"v1/evidence/${value.id}/resume";"folders.read"->"v1/site-folder-bindings";"folders.correct"->"v1/site-folder-bindings/batch";"evidence.chunks"->"v1/evidence/${value.id}/chunks"+(value.cursor?.let{"?cursor="+URLEncoder.encode(it,"UTF-8") }?:"");"activity.delete"->"v1/work/activity/delete";"activity.status"->"v1/work/activity/status";"activity.consent"->"v1/work/activity/consent";"activity.append"->"v1/work/activity/events";"activity.list"->"v1/work/activity?q=${URLEncoder.encode(value.q.orEmpty(),"UTF-8")}"+(value.cursor?.let{"&cursor=$it"}?:"");"audio.correct"->"v1/work/audio/corrections";"maintenance.status"->"v1/work/maintenance";"policies.list"->"v1/owner-policies";"policies.command"->"v1/owner-policies/commands";"work.reply"->"v1/work/replies";"questions.list"->"v1/work/questions";"work.command"->"v1/work-commands";"sync.item"->"v1/sync/changes?kind=${value.target_kind}&id=${value.id}";"sync.changes"->"v1/sync/changes"+(if(value.sync_version==null) "" else "?sync_version=2")+(value.cursor?.let{(if(value.sync_version==null) "?" else "&")+"cursor="+URLEncoder.encode(it,"UTF-8")}?:"");"documents.share"->"v1/documents/${value.id}/share-intents";"documents.shareOutcome"->"v1/documents/${value.id}/share-intents/${value.intent_id}/outcomes";"documents.list"->"v1/documents";"documents.issued"->"v1/documents/${value.id}";"documents.file"->"v1/documents/${value.id}/files/${value.format}";"documents.retry"->"v1/documents/${value.id}/render-retry";"documents.cancel"->"v1/documents/${value.id}/cancel";"documents.issue"->if(value.replacement_id==null)"v1/documents/issue" else "v1/documents/${value.replacement_id}/cancel";"documents.complete"->"v1/document-drafts/${value.id}/complete";"documents.read"->"v1/document-drafts/${value.id}";"voice.status"->"v1/voice/status";"voice.consent"->"v1/voice/consent";"voice.transcribe"->"v1/voice/transcribe";"voice.result"->"v1/voice/${value.id}";"voice.cancel"->"v1/voice/${value.id}/cancel";"context"->"v1/work/context";"materials.message"->"v1/work/materials/${value.id}/message";"materials.detail"->"v1/work/materials/${value.id}";"materials.original"->"v1/work/materials/${value.id}/original";"organization.answer"->"v1/work/materials/${value.id}/organization";"conversation.turn","conversation.read"->"v1/conversations/${value.id}/turns";"guide.read","guide.save"->"v1/work/guide";else->"v1/work/materials?q=${URLEncoder.encode(value.q.orEmpty(),"UTF-8")}"+(value.cursor?.let{"&cursor=$it"}?:"")+(value.category?.let{"&category=$it"}?:"")+(value.project_id?.let{"&project_id=$it"}?:"")}
    }
    fun body(value:WorkRequest):String? = when(value.route){
        "documents.prepare"->buildJsonObject{put("project_id",value.project_id);put("type",value.type);put("client_command_id",value.client_command_id)}.toString()
        "context-learning.command"->value.command
        "ai.consent"->buildJsonObject{put("allowed",value.allowed);put("expected_version",value.expected_version);put("client_command_id",value.client_command_id);value.processing_policy?.let{put("processing_policy",Json.encodeToJsonElement(it))}}.toString()
        "activity.delete"->"{}"
        "activity.consent"->buildJsonObject{put("allowed",value.allowed)}.toString()
        "archive.command","journal.command","setup.command","setup.capture","improvements.command","learning.command","evidence.resume","activity.append","work.command","audio.correct","policies.command","work.reply","folders.correct"->value.command
        "documents.issue"->buildJsonObject{
            val issue=buildJsonObject{put("client_command_id",value.client_command_id);put("recipient_confirmation",value.recipient_confirmation);put("drafts",buildJsonArray{add(buildJsonObject{put("id",value.id);put("basis_hash",value.basis_hash);value.amount_minor?.let{put("amount_minor",it)}})})}
            if(value.replacement_id==null)issue.forEach{(k,v)->put(k,v)} else {put("client_command_id",value.client_command_id);put("expected_hash",value.expected_hash);put("replacement",issue)}
        }.toString()
        "documents.share"->buildJsonObject{put("client_command_id",value.client_command_id);put("format",value.format)}.toString()
        "documents.shareOutcome"->buildJsonObject{put("client_command_id",value.client_command_id);put("outcome",value.outcome)}.toString()
        "documents.retry"->buildJsonObject{put("client_command_id",value.client_command_id)}.toString()
        "documents.cancel"->buildJsonObject{put("client_command_id",value.client_command_id);put("expected_hash",value.expected_hash)}.toString()
        "voice.consent"->buildJsonObject{put("allowed",value.allowed);put("consent_version",value.consent_version)}.toString()
        "voice.transcribe"->buildJsonObject{put("id",value.id);put("audio",value.audio);put("mime",value.mime);put("consent_version",value.consent_version)}.toString()
        "documents.complete"->buildJsonObject{value.form?.let{put("form",Json.encodeToJsonElement(it))};put("client_command_id",value.client_command_id);value.recipient?.let{put("recipient",it)};value.margin_bps?.let{put("margin_bps",it)};value.tax_mode?.let{put("tax_mode",it)};value.tax_bps?.let{put("tax_bps",it)};value.quantities?.let{put("quantities",it)};value.lines?.let{put("lines",it)}}.toString()
        "sheets.share","deliveries.prepare","deliveries.authorize","deliveries.cancel","sheets.prepare","photos.command","agent.start"->value.command
        "agent.cancel","agent.continue","voice.cancel"->"{}"

        "conversation.turn"->buildJsonObject{put("client_turn_id",value.client_turn_id);put("text",value.text);value.input_kind?.let{put("input_kind",it)};value.selected_project_id?.let{put("selected_project_id",it)};put("attachment_refs",JsonArray(emptyList()))}.toString()
        "organization.answer"->buildJsonObject{put("project_id",value.project_id);put("version",value.version)}.toString()
        "guide.save"->buildJsonObject{put("step",value.step);put("completed",value.completed)}.toString()
        else->null
    }

}
class WorkAccessException(val code:String):Exception(code)
class WorkApi(private val vault:UploadCredentialStore,private val allowLocal:Boolean,
    private val http:OkHttpClient=OkHttpClient.Builder().followRedirects(false).callTimeout(30,TimeUnit.SECONDS).build(),private val opener:((String)->Unit)?=null,private val fileAction:((String,String,String,String)->String)?=null) {
    private val sessions=UploadSessionManager(vault,allowLocal,http)
    private var bound:IdentityLinkTarget?=null
    fun request(payload:JsonObject):String {
        val route=WorkRoutes.decode(payload) ?: error("INVALID_WORK_ROUTE")
        var session=sessions.current()
        val target=synchronized(this){val expected=bound?:IdentityLinkTarget.from(session).also{bound=it};if(!expected.matches(session))throw WorkAccessException("account_changed");expected}
        repeat(2){attempt->
            if(!target.matches(session))throw WorkAccessException("account_changed")
            val builder=Request.Builder().url(session.apiBaseUrl.trimEnd('/')+"/"+WorkRoutes.path(route))
                .header("Authorization","Bearer ${session.accessToken}").header("X-Tenant-ID",session.tenantId)
            WorkRoutes.body(route)?.let{builder.post(it.toRequestBody("application/json".toMediaType()))}
            route.client_turn_id?.let{builder.header("Idempotency-Key",it)}
            val request=builder.build()
            http.newCall(request).execute().use {response->
                if(response.code==401 && attempt==0){session=sessions.forceRefresh(session.accessToken);return@repeat}
                if(response.code==401||response.code==403)throw WorkAccessException("login_required")
                if(response.code==409)throw WorkAccessException("VERSION_CONFLICT")
                if(response.code==410&&route.route=="ai.consent")throw WorkAccessException("SOURCE_EXPIRED")
                if(response.code==422||response.code==400)throw WorkAccessException("DOMAIN_INVARIANT")
                check(response.code==200||response.code==201)
                val source=response.body?.source() ?: error("WORK_UNAVAILABLE")
                val limit=if(route.route in setOf("documents.file","sheets.file","materials.message"))8_388_608L else 4_194_304L
                source.request(limit+1);check(source.buffer.size<=limit)
                val body=source.readUtf8();Json.parseToJsonElement(body)
                val current=vault.read()?.let {UploadSession.decode(it,allowLocal)} ?: throw WorkAccessException("account_changed")
                if(!target.matches(current))throw WorkAccessException("account_changed")
                if(route.route=="materials.original"&&opener!=null){
                    val url=Json.parseToJsonElement(body).jsonObject.getValue("url").jsonPrimitive.content
                    val u=java.net.URI(url);val origin=java.net.URI(current.storageOrigin)
                    check(u.scheme==origin.scheme&&u.host==origin.host&&u.port==origin.port&&u.userInfo==null&&u.path.startsWith("/storage/v1/object/sign/sigongnote-originals/"))
                    opener.invoke(url);return "{\"opened\":true}"
                }
                if(route.route in setOf("documents.file","sheets.file","materials.message")&&route.action!=null&&fileAction!=null)return fileAction.invoke(body,route.format!!,route.action!!,current.tenantId+":"+current.userId)
                return body
            }
        }
        error("WORK_UNAVAILABLE")
    }
}
