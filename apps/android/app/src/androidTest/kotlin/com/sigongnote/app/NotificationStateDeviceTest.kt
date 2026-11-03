package com.sigongnote.app

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sigongnote.contracts.IngestionReceiptResponse
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NotificationStateDeviceTest {
    @Test fun serverReceiptClosesPartialSnapshotAndSevenDayCleanupLeavesMetadata() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val id = "77777777-7777-4777-8777-777777777777"
            val vault = NotificationVault()
            db.notificationDao().insertSnapshot(NotificationSnapshot(id,"com.example.work",
                vault.hash("key"),vault.hash("conversation"),vault.hash("body"),1,
                vault.seal("업무", "입금했어요"),1,null,"approved_local"))
            val item = CaptureQueueItem(id,id,id,id,id,1,"uploading",null,"a".repeat(64),
                20,1,1)
            db.queueDao().insert(item)
            val receipt = IngestionReceiptResponse(id,"queued",id,id,id,false)
            assertTrue(CaptureReceiptAcker(db).acknowledge(item,"notifications",receipt,null))
            assertEquals("acknowledged",db.notificationDao().snapshot(id)?.state)
            val afterWeek = System.currentTimeMillis() + 8L * 24 * 60 * 60 * 1000
            assertEquals(1,AcknowledgedNotificationRetention(db).purgeExpired(afterWeek))
            assertNull(db.notificationDao().snapshot(id)?.encryptedPayload)
            assertEquals("acknowledged",db.notificationDao().snapshot(id)?.state)
        } finally { db.close() }
    }

    @Test fun approvedSnapshotUploadsOnlyForItsAccountAndRevocationStopsItsQueue() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val dao = db.notificationDao()
            val vault = NotificationVault()
            val tenant = "11111111-1111-4111-8111-111111111111"
            val user = "22222222-2222-4222-8222-222222222222"
            val device = "33333333-3333-4333-8333-333333333333"
            val otherUser = "44444444-4444-4444-8444-444444444444"
            val source = "55555555-5555-4555-8555-555555555555"
            val id = "66666666-6666-4666-8666-666666666666"
            val conversation = vault.hash("work-conversation")
            dao.putSource(NotificationSource("com.example.work","selected",1,null))
            dao.insertSnapshot(NotificationSnapshot(id,"com.example.work",vault.hash("os-key"),
                conversation,vault.hash("version"),1,vault.seal("작업", "창틀 도착"),
                11,86_400_011,"candidate_local"))
            dao.insertScope(NotificationScope("com.example.work",conversation,12,
                vault.seal("작업",null),tenant,user,device))
            assertEquals(1,dao.approveCandidatesBound("com.example.work",conversation,10,
                tenant,user,device))
            assertEquals(1,dao.holdApprovedForLogout())
            assertEquals(1,dao.removeScope("com.example.work",conversation))
            dao.insertSnapshot(NotificationSnapshot("pre-connection","com.example.work",
                vault.hash("old-key"),conversation,vault.hash("old-version"),1,
                vault.seal("개인", "이전 알림"),5,86_400_005,"candidate_local"))
            dao.insertScope(NotificationScope("com.example.work",conversation,100,
                vault.seal("작업",null),tenant,user,device))
            assertEquals(1,dao.approveCandidatesBound("com.example.work",conversation,100,
                tenant,user,device))
            assertEquals("candidate_local",dao.snapshot("pre-connection")?.state)
            assertEquals(1,dao.uploadable(tenant,user,device).size)
            assertTrue(dao.uploadable(tenant,otherUser,device).isEmpty())
            val snapshot = dao.snapshot(id)!!
            val payload = NotificationUploadPayload.encode(snapshot,vault)
            assertTrue(String(payload).contains("\"partial\":true"))
            assertTrue(String(payload).contains("창틀 도착"))
            assertFalse(String(payload).contains("os-key"))
            db.queueDao().insert(CaptureQueueItem(id,tenant,user,device,source,1,"ready",
                null,NotificationUploadPayload.sha256(payload),payload.size.toLong(),11,12))
            db.runInTransaction {
                assertEquals(1,db.queueDao().stopForNotificationScope(
                    "com.example.work",conversation,13))
                assertEquals(1,dao.removeScope("com.example.work",conversation))
                assertEquals(2,dao.purgeConversation("com.example.work",conversation))
            }
            assertEquals("revoked_pending_purge",db.queueDao().get(id)?.state)
            assertEquals("revoked_purged",dao.snapshot(id)?.state)
            assertNull(dao.snapshot(id)?.encryptedPayload)
            assertTrue(dao.uploadable(tenant,user,device).isEmpty())
        } finally { db.close() }
    }

    @Test fun candidateRequiresExplicitStableConversationScopeAndExpires() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val dao = db.notificationDao()
            val vault = NotificationVault()
            val pkg = "com.example.work"
            val key = vault.hash("OS-key")
            val conversation = vault.hash("shortcut-1")
            val payload = vault.seal("업무 대화","창틀 도착")
            assertFalse(payload.contains("창틀"))
            assertEquals("업무 대화",vault.title(payload))
            dao.putSource(NotificationSource(pkg,"selected",1,null))
            val candidate = NotificationSnapshot("one",pkg,key,conversation,
                vault.hash("first"),1,payload,1,86_400_001,"candidate_local")
            assertTrue(dao.insertSnapshot(candidate) > 0)
            assertEquals(-1,dao.insertSnapshot(candidate.copy(snapshotId = "duplicate")))
            assertEquals(1,dao.candidateCount())
            assertEquals(0,dao.hasScope(pkg,conversation))
            assertEquals(1,dao.scopeCandidates(pkg).size)
            dao.insertScope(NotificationScope(pkg,conversation,2,
                vault.seal("업무 대화",null)))
            assertEquals(1,dao.approveCandidates(pkg,conversation))
            assertEquals(1,dao.hasScope(pkg,conversation))
            assertEquals("approved_local",dao.snapshot("one")?.state)
            dao.insertSnapshot(candidate.copy(snapshotId = "two",updateIndex = 2,
                contentFingerprint = vault.hash("second"),state = "approved_local",
                observedAtEpochMs = 2,expiresAtEpochMs = null))
            assertEquals(2,dao.approvedCount())
            db.runInTransaction {
                assertEquals(1,dao.removeScope(pkg,conversation))
                assertEquals(2,dao.purgeConversation(pkg,conversation))
            }
            assertEquals(0,dao.hasScope(pkg,conversation))
            assertEquals(0,dao.approvedCount())
            assertNull(dao.snapshot("one")?.encryptedPayload)
            assertNull(dao.snapshot("two")?.encryptedPayload)
            assertEquals("revoked_purged",dao.snapshot("two")?.state)
            dao.insertSnapshot(candidate.copy(snapshotId = "after-revoke",updateIndex = 3,
                contentFingerprint = vault.hash("third"),observedAtEpochMs = 3,
                expiresAtEpochMs = 86_400_100))
            assertEquals("candidate_local",dao.snapshot("after-revoke")?.state)
            assertEquals(0,dao.purgeExpiredCandidates(86_400_002))
            val unscoped = candidate.copy(snapshotId = "unscoped",keyHash = vault.hash("OS-other"),
                conversationHash = null,observedAtEpochMs = 3,expiresAtEpochMs = 4)
            dao.insertSnapshot(unscoped)
            assertEquals(1,dao.purgeExpiredCandidates(5))
            assertNull(dao.snapshot("unscoped"))
            dao.pause(pkg)
            assertEquals("paused",dao.source(pkg)?.state)
        } finally { db.close() }
    }

    @Test fun sharedNotificationExecutorSerializesCaptureThenRevokeThenCandidate() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context,CaptureQueueDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val dao = db.notificationDao()
            val executor = (context.applicationContext as SigongnoteApp).notificationExecutor
            val pkg = "com.example.work"
            val hash = "a".repeat(64)
            dao.insertScope(NotificationScope(pkg,hash,1,"sealed-label"))
            val captured = executor.submit {
                if (dao.hasScope(pkg,hash) == 1)
                    dao.insertSnapshot(NotificationSnapshot("before",pkg,"b".repeat(64),hash,
                        "c".repeat(64),1,"sealed-body",1,null,"approved_local"))
            }
            val revoked = executor.submit {
                db.runInTransaction {
                    dao.removeScope(pkg,hash)
                    dao.purgeConversation(pkg,hash)
                }
            }
            val arrivedLater = executor.submit {
                val approved = dao.hasScope(pkg,hash) == 1
                dao.insertSnapshot(NotificationSnapshot("after",pkg,"d".repeat(64),hash,
                    "e".repeat(64),1,"sealed-body",2,86_400_002,
                    if (approved) "approved_local" else "candidate_local"))
            }
            captured.get(); revoked.get(); arrivedLater.get()
            assertEquals(0,dao.hasScope(pkg,hash))
            assertEquals(0,dao.approvedCount())
            assertNull(dao.snapshot("before")?.encryptedPayload)
            assertEquals("candidate_local",dao.snapshot("after")?.state)
        } finally { db.close() }
    }
}
