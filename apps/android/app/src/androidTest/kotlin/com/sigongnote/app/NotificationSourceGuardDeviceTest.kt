package com.sigongnote.app

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NotificationSourceGuardDeviceTest {
    @Test fun unavailableOsLookupPreservesWorkDataAndNonDefaultSmsReceiversArePurged() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java).allowMainThreadQueries().build()
        try {
            val work = "com.example.work"
            val sms = "com.example.secondarysms"
            for (pkg in listOf(work,sms)) {
                db.notificationDao().putSource(NotificationSource(pkg,"selected",1,null))
                db.notificationDao().insertSnapshot(NotificationSnapshot(UUID.randomUUID().toString(),pkg,
                    pkg,null,pkg,1,"encrypted",1,null,"candidate_local"))
            }
            NotificationSourceGuard.enforce(context,db) { throw IllegalStateException("unavailable") }
            assertEquals(2,db.notificationDao().selectedCount())
            assertEquals(2,db.notificationDao().candidateCount())
            NotificationSourceGuard.enforce(context,db) { SmsAppInventory(null,setOf(sms)) }
            assertEquals("selected",db.notificationDao().source(work)?.state)
            assertEquals("paused",db.notificationDao().source(sms)?.state)
            assertTrue(db.notificationDao().hasRetainedPackageData(work))
            assertFalse(db.notificationDao().hasRetainedPackageData(sms))
        } finally { db.close() }
    }
    @Test fun currentSmsRoleIsVisibleAndExcludedWithoutRequestingIt() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val current = android.provider.Telephony.Sms.getDefaultSmsPackage(context)
        org.junit.Assume.assumeNotNull(current)
        assertFalse(NotificationSourceGuard.selectable(context,current!!))
        assertTrue(NotificationSourceGuard.selectable(context,"com.example.work"))
    }
    @Test fun oldCandidatesApprovalsAndInflightCopiesAreRevokedWithoutTouchingOtherApps() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        val account = UUID.randomUUID().toString()
        val blocked = "com.samsung.android.messaging"
        try {
            for (pkg in listOf(blocked,"com.example.work")) {
                db.notificationDao().putSource(NotificationSource(pkg,"selected",1,null))
                db.notificationDao().insertScope(NotificationScope(pkg,"conversation",1,"encrypted",
                    account,account,account))
                for (state in listOf("candidate_local","approved_local","paused_logout","acknowledged")) {
                    val id = UUID.randomUUID().toString()
                    db.notificationDao().insertSnapshot(NotificationSnapshot(id,pkg,id,"conversation",id,
                        1,"encrypted",1,null,state,false,account,account,account))
                    if (state != "candidate_local") db.queueDao().insert(CaptureQueueItem(id,account,
                        account,account,account,1,if (state == "acknowledged") state else "uploading",
                        null,"a".repeat(64),9,1,1))
                }
            }
            NotificationSourceGuard.revoke(db,blocked)
            assertEquals("paused",db.notificationDao().source(blocked)?.state)
            assertNull(db.notificationDao().scope(blocked,"conversation"))
            assertEquals(0,db.notificationDao().scopeCandidates(blocked).size)
            assertEquals(2,db.queueDao().revokedPendingCount())
            assertEquals(1,db.notificationDao().uploadable(account,account,account).size)
            assertEquals("selected",db.notificationDao().source("com.example.work")?.state)
            assertEquals(RevokedCapturePurger.Result(2,0),RevokedCapturePurger(db,context.filesDir).purgePending())
            NotificationSourceGuard.revoke(db,blocked)
            assertEquals(0,db.queueDao().revokedPendingCount())
            assertEquals(1,db.notificationDao().scopeCandidates("com.example.work").size)
        } finally { db.close() }
    }
}
