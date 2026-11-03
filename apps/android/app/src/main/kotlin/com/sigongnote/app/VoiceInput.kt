package com.sigongnote.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.*
import kotlinx.serialization.json.*

/** One foreground request. No audio file, continuous listener or product API key lives here. */
class VoiceInput(private val activity:Activity) {
    companion object {const val permissionRequest=1710}
    private val handler=Handler(Looper.getMainLooper())
    private var active:String?=null
    private var send:((String)->Unit)?=null
    private var recognizer:SpeechRecognizer?=null
    private var disclosure:AlertDialog?=null
    private var onDevice=false
    fun start(id:String,reply:(String)->Unit){
        check(Looper.myLooper()==Looper.getMainLooper());cancel()
        active=id;send=reply
        onDevice=Build.VERSION.SDK_INT>=31&&SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)
        if(!onDevice&&!SpeechRecognizer.isRecognitionAvailable(activity)){finish("error",code="voice_unavailable");return}
        val provider=Settings.Secure.getString(activity.contentResolver,"voice_recognition_service").orEmpty()
        val prefs=activity.getSharedPreferences("short_voice",Context.MODE_PRIVATE)
        if(!onDevice&&prefs.getString("disclosed_service",null)!=provider){
            disclosure=AlertDialog.Builder(activity).setTitle("말로 요청하기")
                .setMessage("마이크를 누를 때만 짧게 듣습니다. 휴대폰의 음성 서비스가 음성을 서버로 보내 한국어로 바꿀 수 있어요. 인식한 글은 수정할 수 있습니다.")
                .setPositiveButton("동의하고 말하기"){_,_->if(active==id){prefs.edit().putString("disclosed_service",provider).apply();permission(id)}}
                .setNegativeButton("글로 입력"){_,_->if(active==id)finish("error",code="cancelled")}
                .setOnCancelListener{if(active==id)finish("error",code="cancelled")}.show()
        }else permission(id)
    }
    private fun permission(id:String){
        if(active!=id)return
        if(activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO),permissionRequest);return}
        listen(id)
    }
    fun permissionResult(granted:Boolean){val id=active?:return;if(granted)listen(id)else finish("error",code="permission_denied")}
    private fun listen(id:String){
        if(active!=id)return
        try{
            val speech=if(onDevice&&Build.VERSION.SDK_INT>=31)SpeechRecognizer.createOnDeviceSpeechRecognizer(activity)else SpeechRecognizer.createSpeechRecognizer(activity)
            recognizer=speech
            speech.setRecognitionListener(object:RecognitionListener{
                override fun onReadyForSpeech(params:Bundle?){emit("partial","")}
                override fun onBeginningOfSpeech(){}
                override fun onRmsChanged(rmsdB:Float){}
                override fun onBufferReceived(buffer:ByteArray?){}
                override fun onEndOfSpeech(){}
                override fun onError(error:Int){if(active==id)finish("error",code=if(error==SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS)"permission_denied" else if(error==SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED||error==SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)"language_unavailable" else "recognition_failed")}
                override fun onResults(results:Bundle?){if(active!=id)return;val text=results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty();if(text.isEmpty()||text.length>2000)finish("error",code="recognition_failed")else finish("final",text)}
                override fun onPartialResults(results:Bundle?){if(active==id)emit("partial",results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.take(2000).orEmpty())}
                override fun onEvent(eventType:Int,params:Bundle?){}
            })
            val intent=Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE,"ko-KR").putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS,true).putExtra(RecognizerIntent.EXTRA_MAX_RESULTS,1)
            handler.postDelayed({if(active==id)finish("error",code="recognition_timeout")},40000)
            fun begin(){if(active!=id)return;runCatching{speech.startListening(intent);handler.postDelayed({if(active==id)runCatching{speech.stopListening()}},29000)}.onFailure{if(active==id)finish("error",code="recognition_failed")}}
            if(Build.VERSION.SDK_INT>=33){speech.checkRecognitionSupport(intent,activity.mainExecutor,object:RecognitionSupportCallback{
                override fun onSupportResult(support:RecognitionSupport){if(active!=id)return;val languages=if(onDevice)support.installedOnDeviceLanguages else support.onlineLanguages+support.installedOnDeviceLanguages;if(languages.any{it=="ko"||it.startsWith("ko-")})begin()else finish("error",code="language_unavailable")}
                override fun onError(error:Int){if(active==id)finish("error",code="language_unavailable")}
            })}else{
                activity.sendOrderedBroadcast(Intent(RecognizerIntent.ACTION_GET_LANGUAGE_DETAILS),null,object:BroadcastReceiver(){
                    override fun onReceive(context:Context?,intent:Intent?){if(active!=id)return;val languages=getResultExtras(true)?.getStringArrayList(RecognizerIntent.EXTRA_SUPPORTED_LANGUAGES).orEmpty();if(languages.any{it=="ko"||it.startsWith("ko-")})begin()else finish("error",code="language_unavailable")}
                },handler,Activity.RESULT_OK,null,null)
            }
        }catch(_:Exception){if(active==id)finish("error",code="voice_unavailable")}
    }
    private fun emit(phase:String,text:String="",code:String="") {send?.invoke(buildJsonObject{put("phase",phase);if(text.isNotEmpty())put("text",text);if(code.isNotEmpty())put("code",code)}.toString())}
    private fun finish(phase:String,text:String="",code:String=""){val reply=send;cancel();reply?.invoke(buildJsonObject{put("phase",phase);if(text.isNotEmpty())put("text",text);if(code.isNotEmpty())put("code",code)}.toString())}
    fun cancel(id:String?=null){if(id!=null&&active!=id)return;active=null;send=null;handler.removeCallbacksAndMessages(null);disclosure?.dismiss();disclosure=null;runCatching{recognizer?.cancel();recognizer?.destroy()};recognizer=null}
}
