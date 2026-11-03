package com.sigongnote.app

import org.junit.Assert.assertEquals
import org.junit.Test

class SmsPermissionStepTest {
    @Test fun roleMustPrecedePermissionAndRevocationOverridesOldGrant() {
        assertEquals(SmsPermissionStep.ROLE, SmsPermissionStep.decide(true, false, true, false))
        assertEquals(SmsPermissionStep.PERMISSIONS, SmsPermissionStep.decide(true, true, false, false))
        assertEquals(SmsPermissionStep.READY, SmsPermissionStep.decide(true, true, true, true))
        assertEquals(SmsPermissionStep.ROLE, SmsPermissionStep.decide(true, false, true, true))
    }
    @Test fun deniedAndUnavailableDoNotAutomaticallyReopenDialogs() {
        assertEquals(SmsPermissionStep.SETTINGS, SmsPermissionStep.decide(true, true, false, true))
        assertEquals(SmsPermissionStep.UNAVAILABLE, SmsPermissionStep.decide(false, false, false, false))
    }
    @Test fun grantedSmsWithMutedNotificationsIsNotReady() {
        assertEquals(SmsPermissionStep.NOTIFICATIONS, SmsPermissionStep.decide(true, true, true, false, false))
        assertEquals(SmsPermissionStep.ROLE, SmsPermissionStep.decide(true, false, true, false, false))
        assertEquals(SmsPermissionStep.SETTINGS, SmsPermissionStep.decide(true, true, false, true, false))
    }
}
