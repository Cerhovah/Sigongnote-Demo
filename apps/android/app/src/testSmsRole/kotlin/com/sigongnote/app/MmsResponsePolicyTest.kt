package com.sigongnote.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MmsResponsePolicyTest {
    @Test fun defaultMmscUsedWhenCarrierDoesNotEnableWapReply() {
        assertNull(MmsResponsePolicy.locationUrl(false,"http://carrier.example/retrieve"))
    }

    @Test fun carrierWapLocationUsedOnlyWhenEnabled() {
        assertEquals("http://carrier.example/retrieve",
            MmsResponsePolicy.locationUrl(true,"http://carrier.example/retrieve"))
    }
}
