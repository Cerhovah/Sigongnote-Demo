package com.sigongnote.app

import org.junit.Assert.*
import org.junit.Test

class NotificationCapturePolicyTest {
    @Test fun smsReceiverInventoryAndLookupFailureAreDifferentDecisions() {
        assertEquals(NotificationPackageDecision.BLOCK,NotificationSourceGuard.decide("com.example.sms") {
            SmsAppInventory("com.example.other",setOf("com.example.sms"))
        })
        assertEquals(NotificationPackageDecision.UNAVAILABLE,NotificationSourceGuard.decide("com.example.work") {
            throw IllegalStateException("service unavailable")
        })
        assertEquals(NotificationPackageDecision.BLOCK,NotificationSourceGuard.decide("com.android.messaging") {
            throw IllegalStateException("service unavailable")
        })
    }
    @Test fun smsAppsStayExcludedWhenDefaultChangesWithoutBlockingWorkApps() {
        for (app in listOf("com.samsung.android.messaging","com.google.android.apps.messaging","com.android.mms")) {
            assertFalse(NotificationCapturePolicy.packageSelectable(app))
            assertFalse(NotificationCapturePolicy.accept(ordinary.copy(packageName = app)))
        }
        assertTrue(NotificationCapturePolicy.packageSelectable("com.example.work"))
        assertFalse(NotificationCapturePolicy.packageSelectable("com.example.work","com.example.work"))
        assertFalse(NotificationCapturePolicy.accept(ordinary,"com.example.work"))
        assertTrue(NotificationCapturePolicy.accept(ordinary,"com.example.other"))
        assertTrue(NotificationCapturePolicy.packageSelectable("com.samsung.android.messaging.partner"))
    }
    private val ordinary = NotificationEnvelope("com.example.work","key","conversation-1",
        "김 기사","창틀 도착했습니다",1,false)

    @Test fun sensitiveAndSummaryNotificationsNeverBecomeCandidates() {
        assertTrue(NotificationCapturePolicy.accept(ordinary))
        assertFalse(NotificationCapturePolicy.accept(ordinary.copy(groupSummary = true)))
        assertFalse(NotificationCapturePolicy.accept(ordinary.copy(body = "인증번호 123456")))
        assertFalse(NotificationCapturePolicy.accept(ordinary.copy(body = "주민등록번호 900101-1234567")))
        assertFalse(NotificationCapturePolicy.accept(ordinary.copy(packageName = "com.kbstar.bank")))
        assertFalse(NotificationCapturePolicy.packageSelectable("com.toss.app"))
        assertFalse(NotificationCapturePolicy.accept(ordinary.copy(body = "가".repeat(30_000))))
    }

    @Test fun missingBodyIsPartialRatherThanInventedMessage() {
        assertTrue(NotificationCapturePolicy.accept(ordinary.copy(body = null)))
        assertEquals(24L * 60 * 60 * 1000,NotificationCapturePolicy.candidateLifetimeMs)
    }

    @Test fun disconnectAndProcessRestartLeaveVisibleGapHistory() {
        val first = NotificationHealthTracker.connected(null,100,false)
        assertEquals(0,first.gapCount)
        val disconnected = NotificationHealthTracker.disconnected(first,200)
        assertEquals(1,disconnected.gapCount)
        assertEquals(200L,disconnected.lastGapStartAtEpochMs)
        val reconnected = NotificationHealthTracker.connected(disconnected,300,false)
        assertEquals(1,reconnected.gapCount)
        assertEquals(300L,reconnected.lastGapEndAtEpochMs)
        val restart = NotificationHealthTracker.connected(reconnected,400,false)
        assertEquals(2,restart.gapCount)
        assertEquals(300L,restart.lastGapStartAtEpochMs)
    }
}
