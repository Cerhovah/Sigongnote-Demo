package com.sigongnote.app

import org.junit.Assert.assertFalse
import org.junit.Test

class SmsPolicyGateTest {
    @Test fun groupMmsCannotBeCapturedBySingleRecipientConsent() {
        org.junit.Assert.assertTrue(soleMmsRecipient(1,0,0))
        assertFalse(soleMmsRecipient(2,0,0))
        assertFalse(soleMmsRecipient(1,1,0))
        assertFalse(soleMmsRecipient(1,0,1))
    }
    @Test fun playApprovalCannotBeInferredFromDefaultRoleOrLocalScope() {
        assertFalse(SmsPolicyGate.canUploadSms(roleHeld = true,scopeApproved = true))
        assertFalse(SmsPolicyGate.callLogAccessApproved)
    }

    @Test fun roleOrScopeLossAlwaysStopsUpload() {
        assertFalse(SmsPolicyGate.canUploadSms(roleHeld = false,scopeApproved = true))
        assertFalse(SmsPolicyGate.canUploadSms(roleHeld = true,scopeApproved = false))
    }
}
