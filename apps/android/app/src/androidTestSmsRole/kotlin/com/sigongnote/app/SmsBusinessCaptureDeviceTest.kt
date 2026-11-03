package com.sigongnote.app

import android.content.ContentValues
import android.os.Build
import android.provider.Telephony
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SmsBusinessCaptureDeviceTest {
    private fun session(tenant: String): UploadSession = UploadSession(
        "https://example.test","https://example.test","https://example.test",
        "fixture","fixture","fixture",System.currentTimeMillis() + 60_000,
        tenant,UUID.randomUUID().toString(),UUID.randomUUID().toString(),
        UUID.randomUUID().toString(),1,System.currentTimeMillis())

    @Test fun approvedPhoneAndAccountOnlyThenRevocationStopsNewCapture() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertTrue("Only a disposable emulator may change default SMS role in this test",
            Build.PRODUCT.startsWith("sdk_") ||
                Build.FINGERPRINT.contains("emulator",ignoreCase = true))
        assertTrue("Emulator must grant the target app SMS role",SmsRoleRuntime.canRead(context))
        val one = session(UUID.randomUUID().toString())
        val two = session(UUID.randomUUID().toString())
        val address = "01077770001"
        val otherAddress = "01077770002"
        val capture = SmsBusinessCapture(context)
        val since = System.currentTimeMillis() - 60_000
        capture.approve(address,since,one)
        val inserted = mutableListOf<android.net.Uri>()
        fun message(number: String): Long {
            val uri = context.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI,
                ContentValues().apply {
                    put(Telephony.Sms.ADDRESS,number)
                    put(Telephony.Sms.BODY,"fixture message")
                    put(Telephony.Sms.DATE,System.currentTimeMillis())
                    put(Telephony.Sms.TYPE,Telephony.Sms.MESSAGE_TYPE_INBOX)
                }) ?: error("fixture provider insert failed")
            inserted.add(uri)
            return android.content.ContentUris.parseId(uri)
        }
        try {
            val approved = message(address)
            val unapproved = message(otherAddress)
            assertTrue(capture.captureSms(approved,one))
            assertFalse(capture.captureSms(unapproved,one))
            assertEquals(1,capture.observationCount(one))
            capture.approve(address,since,two)
            assertEquals(0,capture.observationCount(two))
            assertTrue(capture.revoke(address,one))
            assertFalse(capture.captureSms(message(address),one))
            assertEquals(1,SmsBusinessCapture(context).observationCount(one))
        } finally {
            inserted.forEach { context.contentResolver.delete(it,null,null) }
        }
    }
}
