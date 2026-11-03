package com.sigongnote.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.MediaStore
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.Executors

/** Camera output is retained until the exact encrypted inbox copy has been read back. */
class PhotoCaptureActivity:Activity(){
    private var cameraName:String?=null
    private lateinit var status:TextView
    private lateinit var retryButton:Button
    private val controls=mutableListOf<Button>()
    private val io=Executors.newSingleThreadExecutor()
    private val photos by lazy { PendingPhotos(File(filesDir,"camera-pending"),File(cacheDir,"camera")) }
    override fun onCreate(state:Bundle?){super.onCreate(state);cameraName=state?.getString("camera")
        val layout=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(28,40,28,28)}
        status=TextView(this).apply{text="현장 사진";textSize=22f};layout.addView(status)
        fun action(label:String,run:()->Unit):Button=Button(this).apply{text=label;textSize=20f;minHeight=80;setOnClickListener{try{run()}catch(_:Exception){photos.cancel(photos.find(cameraName));cameraName=null;status.text="사진 앱을 열지 못했어요. 보관 대기 사진은 남아 있어요.";refreshPending()}};layout.addView(this);controls.add(this)}
        val cameraButton=action("사진 찍기"){
            val file=photos.create();cameraName=file.name
            val uri=FileProvider.getUriForFile(this,BuildConfig.APPLICATION_ID+".capture",file)
            startActivityForResult(Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION).apply{clipData=android.content.ClipData.newRawUri("photo",uri)},1801)
        }
        action("갤러리에서 고르기"){startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true).putExtra(Intent.EXTRA_MIME_TYPES,arrayOf("image/jpeg","image/png")),1802)}
        retryButton=action("보관 대기 사진 다시 보관"){save(photos.pending().filter{it.name!=cameraName},null)}
        action("업무 화면으로"){finish()};setContentView(layout);refreshPending()
        // The menu opens the system camera once; rotation/restoration must not launch it again.
        if(state==null&&intent.getBooleanExtra("openCamera",false))cameraButton.performClick()
    }
    private fun refreshPending(){val count=photos.pending().count{it.name!=cameraName};retryButton.visibility=if(count>0)android.view.View.VISIBLE else android.view.View.GONE;if(count>0)status.text="보관 대기 사진 ${count}개가 이 기기에 남아 있어요. 다시 보관해 주세요."}
    override fun onSaveInstanceState(out:Bundle){out.putString("camera",cameraName);super.onSaveInstanceState(out)}
    @Deprecated("Activity result is kept with the existing native lifecycle")
    override fun onActivityResult(request:Int,result:Int,data:Intent?){super.onActivityResult(request,result,data);if(request !in setOf(1801,1802))return
        val camera=if(request==1801)photos.find(cameraName) else null
        if(request==1801){camera?.let{revokeUriPermission(FileProvider.getUriForFile(this,BuildConfig.APPLICATION_ID+".capture",it),Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)};cameraName=null}
        if(result!=RESULT_OK){photos.cancel(camera);status.text="촬영 취소";refreshPending();if(intent.getBooleanExtra("openCamera",false))finish();return}
        if(request==1801){if(camera==null||camera.length()==0L){photos.cancel(camera);status.text="촬영 결과를 확인하지 못했어요. 다시 찍어 주세요.";return};save(listOf(camera),null)}
        else save(emptyList(),Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*").apply{clipData=data?.clipData;this.data=data?.data})
    }
    private fun save(cameras:List<File>,gallery:Intent?){
        controls.forEach{it.isEnabled=false};status.text="사진을 보관하고 있어요…"
        io.execute{
            val copied=runCatching{
                val dir=File(filesDir,"share-inbox");val dao=(application as SigongnoteApp).queue.shareInboxDao();val key=ShareCopyKey().get()
                val verify:(ShareInboxItem)->Boolean={item->runCatching{
                    val name=item.encryptedCopyName?:error("Missing copy");require(Regex("[a-f0-9-]{36}\\.sealed").matches(name))
                    File(dir,name).inputStream().use{ShareCopyReader(key).unseal(it,object:OutputStream(){override fun write(value:Int){};override fun write(bytes:ByteArray,offset:Int,length:Int){}},item.sha256!!,item.byteLength!!)}
                }.isSuccess}
                val receiver=ShareReceiver(contentResolver,dao,ShareCopyWriter(key,dir),dir,verify)
                if(gallery!=null)receiver.receive(gallery) else cameras.count{camera->runCatching{photos.preserve(camera){file,sha,length->
                    val captureId=UUID.nameUUIDFromBytes((file.name+":"+sha).toByteArray(Charsets.UTF_8)).toString()
                    receiver.receive(Intent(Intent.ACTION_SEND).setType("image/jpeg").putExtra(Intent.EXTRA_STREAM,FileProvider.getUriForFile(this,BuildConfig.APPLICATION_ID+".capture",file)),captureId)
                    dao.findExactStaged(sha,length)?.let(dao::item)?.let(verify)==true
                }}.getOrDefault(false)}
            }.getOrDefault(0)
            if(copied>0)CaptureUploadWork.enqueue(applicationContext)
            runOnUiThread{if(!isFinishing&&!isDestroyed){controls.forEach{it.isEnabled=true};status.text=if(copied>0)"사진 ${copied}개 보관 · 전송 대기" else "사진 보관 확인 필요";refreshPending();if(copied>0&&intent.getBooleanExtra("openCamera",false)){Toast.makeText(applicationContext,status.text,Toast.LENGTH_LONG).show();finish()}}}
        }
    }
    override fun onDestroy(){io.shutdown();super.onDestroy()}
}
