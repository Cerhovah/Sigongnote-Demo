package com.sigongnote.app

import com.sigongnote.contracts.CapturePolicy
import kotlinx.serialization.json.*

/** The same complete policy is shown before consent and retained in the local source snapshot. */
object CapturePolicyNotice {
    private fun provider(name:String)=when(name){"anthropic"->"Anthropic Claude";"openai"->"OpenAI";"clova_speech"->"NAVER CLOVA Speech";"local_fixture"->"개발 PC";else->name}
    private fun retention(value:String)=if(value=="until_user_deletes")"직접 삭제할 때까지" else value
    fun text(policy:CapturePolicy):String=buildString {
        append(if(policy.external_processing)"현장·업무 정리: ${provider(policy.provider)}" else "외부 AI 전송 없이 처리")
        append("\n처리 위치: ${policy.processing_location}\n저장 위치: ${policy.storage_location}\n보존: ${retention(policy.retention)}")
        for(processor in policy.processors.orEmpty()){
            append("\n긴 녹음 전사: ${provider(processor.provider)}")
            append("\n처리 위치: ${processor.processing_location}\n저장 위치: ${processor.storage_location}\n보존: ${retention(processor.retention)}")
        }
    }
    /** JSON object order is irrelevant; nested processors and every declared value participate. */
    fun snapshot(policy:CapturePolicy):JsonElement=Json.encodeToJsonElement(policy)
    fun validSnapshot(wire:JsonElement):Boolean=runCatching {
        val policy=Json.decodeFromJsonElement<CapturePolicy>(wire)
        require(policy.id.matches(Regex("[a-z0-9-]{1,64}"))&&policy.purpose=="work_records")
        require(policy.provider.length in 1..80&&policy.processing_location.length in 1..100&&policy.storage_location.length in 1..100&&policy.retention=="until_user_deletes")
        policy.processors?.let{processors->
            require(policy.external_processing&&processors.size==1)
            for(processor in processors)require(processor.purpose=="long_stt"&&processor.provider in setOf("openai","clova_speech")&&listOf(processor.processing_location,processor.storage_location,processor.retention).all{it.trim().length in 1..200})
        }
    }.isSuccess
}
