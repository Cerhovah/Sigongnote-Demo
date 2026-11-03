package com.sigongnote.app

import android.content.Context
import android.content.Intent
import android.content.ClipData
import androidx.core.content.FileProvider
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.*

object OutgoingDocument {
    fun hash(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
    fun prepare(root:File,scope:String,format:String,json:String):File {
        require(format in setOf("pdf","xlsx"))
        val data=Json.parseToJsonElement(json).jsonObject
        val name=data.getValue("name").jsonPrimitive.content
        require(name.length in 1..160&&name.endsWith(".$format")&&!Regex("[\\\\/:*?\"<>|\\x00-\\x1f]").containsMatchIn(name))
        val bytes=java.util.Base64.getDecoder().decode(data.getValue("base64").jsonPrimitive.content)
        val sha=data.getValue("sha256").jsonPrimitive.content
        require(bytes.size in 4..5242880&&hash(bytes)==sha&&if(format=="pdf")bytes.take(4)=="%PDF".toByteArray().toList() else bytes[0]==80.toByte()&&bytes[1]==75.toByte())
        val canonicalRoot=root.canonicalFile
        val folder=File(canonicalRoot,"${hash(scope.toByteArray())}/$sha");check(folder.mkdirs()||folder.isDirectory)
        val target=File(folder,name);check(target.canonicalPath==target.absolutePath)
        if(target.exists()){check(hash(target.readBytes())==sha);return target}
        val temp=File.createTempFile("download-",".tmp",folder)
        try{temp.outputStream().use{it.write(bytes);it.fd.sync()};check(temp.renameTo(target))}finally{temp.delete()}
        return target
    }
    fun intent(context:Context,file:File,format:String,action:String):Intent {
        val uri=FileProvider.getUriForFile(context,context.packageName+".outgoing",file)
        val mime=if(format=="pdf")"application/pdf" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        val inner=if(action=="open")Intent(Intent.ACTION_VIEW).setDataAndType(uri,mime) else Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM,uri)
        inner.clipData=ClipData.newRawUri(file.name,uri);inner.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return Intent.createChooser(inner,if(action=="open")"문서 열기" else "문서 공유 · 저장할 앱 선택")
    }
}
