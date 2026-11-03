package com.sigongnote.app

import org.junit.Assert.assertEquals
import org.junit.Test

class SmsScreenTest {
    @Test fun attachmentBoundaryIsCheckedBeforeSendConfirmation() {
        org.junit.Assert.assertTrue(MmsAttachmentPolicy.fits(1024*1024))
        org.junit.Assert.assertFalse(MmsAttachmentPolicy.fits(1024*1024+1))
        org.junit.Assert.assertFalse(MmsAttachmentPolicy.fits(0))
        org.junit.Assert.assertFalse(MmsAttachmentPolicy.fits(-1))
    }
    @Test fun backReturnsToConversationOrInboxWithoutSending() {
        assertEquals(SmsScreen.THREAD,SmsScreen.back(SmsScreen.COMPOSE,true))
        assertEquals(SmsScreen.INBOX,SmsScreen.back(SmsScreen.COMPOSE,false))
        assertEquals(SmsScreen.INBOX,SmsScreen.back(SmsScreen.THREAD,true))
        assertEquals(SmsScreen.SETTINGS,SmsScreen.back(SmsScreen.BUSINESS,true))
        assertEquals(SmsScreen.SETTINGS,SmsScreen.back(SmsScreen.HELP,false))
    }
}
