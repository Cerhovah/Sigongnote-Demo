package com.sigongnote.app
import android.content.Intent
import android.view.accessibility.AccessibilityEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import kotlinx.serialization.json.*
import java.io.File
@RunWith(AndroidJUnit4::class)
class OutgoingDocumentDeviceTest {
 @Test fun actualAppDirectoryCreatesReadableContentUriAndOpensChooser(){
  val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
  check(context.packageName=="com.sigongnote.app.devtest")
  val bytes="%PDF synthetic provider fixture".toByteArray()
  val payload=buildJsonObject{put("name","합성공유.pdf");put("sha256",OutgoingDocument.hash(bytes));put("base64",java.util.Base64.getEncoder().encodeToString(bytes))}.toString()
  val file=OutgoingDocument.prepare(File(context.filesDir,"outgoing"),"synthetic-device-test","pdf",payload)
  val chooser=OutgoingDocument.intent(context,file,"pdf","share").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  @Suppress("DEPRECATION") val send=chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
  @Suppress("DEPRECATION") val uri=send.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM)!!
  assertEquals("content",uri.scheme);assertEquals(context.packageName+".outgoing",uri.authority)
  assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION!=0)
  assertArrayEquals(bytes,context.contentResolver.openInputStream(uri)!!.use{it.readBytes()})
  instrumentation.runOnMainSync{context.startActivity(chooser)}
  Thread.sleep(600)
  assertTrue(file.exists()) // Recipient access must survive return from the chooser.
  instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
 }
}
